---
title: Pipeline Manager
description: Pipeline Manager
slug: wiki/pipeline-manager
---

## PipelineManager

As Daxa is designed to be a GPU-driven centric API, we provide some code to be used within your shaders. This is in the form of `.inl` files, such as the core `daxa/daxa.inl` and `daxa/utils/task_graph.inl`.

As such, Daxa provides the PipelineManager util, which is meant to be used in the development phase of your app to iterate on your GPU code very quickly.

PipelineManager is mainly designed on top of [Khronos' glslang library](https://github.com/khronosGroup/glslang), providing GLSL to SPIR-V compilation. Rather than handing you a SPIR-V blob to feed to Daxa's Pipeline API yourself, it compiles *and* manages the pipelines for you. It does this because this way, it can do much more for you, such as:

- Hot reloading (with #include dependency tracking)
- #includes files with line-numbered error messages
- Virtual files

(You can still get the SPIR-V it produces if you want it: set `write_out_spirv` on the manager's info to a directory, and each compiled shader's SPIR-V is written out there.)

### Usage

To use the PipelineManager, include the corresponding util header and construct one with a Daxa device.

```cpp
#include <daxa/utils/pipeline_manager.hpp>

// ...

daxa::PipelineManager pipeline_manager = daxa::PipelineManager({
    .device = device,
    .name = "pipeline_manager",
});
```

Once you have a pipeline manager, you can start making pipelines! The pipeline manager's minimum input is the `.source` field. Let's create a compute pipeline since those are simpler than raster pipelines, and the additional configuration for raster pipelines is identical to what's necessary in the core Daxa API. So, it's not unique to the PipelineManager.

```cpp
auto compilation_result = pipeline_manager.add_compute_pipeline2(/* daxa::ComputePipelineCompileInfo2 */{
    .source = /* ... */,
    .name = "compute_pipeline",
});
```

This `.source` field is a variant. It can be a path to a file `daxa::ShaderFile` or a raw string of code `daxa::ShaderCode`. First, we'll start by just passing in a string of code.

```cpp
auto compilation_result = pipeline_manager.add_compute_pipeline2({
    .source = daxa::ShaderCode{.string = R"glsl(

        layout(local_size_x = 1, local_size_y = 1, local_size_z = 1) in;
        void main()
        {
        }

    )glsl"},
    .name = "compute_pipeline",
});
```

This is the simplest compute shader that will compile in GLSL. Once this compiles, `pipeline_manager` will construct a `daxa::ComputePipeline` for you, store it internally, and return a `daxa::Result<std::shared_ptr<daxa::ComputePipeline>>`. This is wrapped in a result since the compilation may fail, which we may want to check.

```cpp
if (compilation_result.is_err())
{
    std::cerr << "Failed to compile the compute_pipeline!\n";
    std::cerr << compilation_result.message() << std::endl;
    return -1;
}
```

Now, we can store our shared pointer in the compute pipeline and use it however we like!

```cpp
std::shared_ptr<daxa::ComputePipeline> compute_pipeline = compilation_result.value();
```

PipelineManager is the container of all these pipelines, so we only give the user a shared pointer to the underlying object. PipelineManager can modify the pipeline without the user needing to change each pipeline explicitly.

> Note: This design decision is mainly due to pipeline manager being a utility designed around developing your application, not for shipping it!

#### Hot Reloading

The most significant feature of PipelineManager is the hot-reloading. When the shader code is changed and saved, it will recompile the pipeline. You can even `#include` headers in your shaders, and when the code in those files is updated, the PipelineManager will automatically recompile the affected pipelines for you.

To use hot-reloading, we could demonstrate this by adding a `#include` to our `ShaderCode` string. Instead, to show them more directly, we will use real or virtual files. We'll review both in this document, but let's start with the actual files. We'll create a simple Daxa project structured like so:

```text
my_daxa_project/
  |- src/
  |  |- main.cpp
  |  |- main.glsl
  |- CMakeLists.txt
  | ...
```

> Note: We'll also be using the `my_daxa_project/` directory as the CWD when launching the application. This is important since all relative paths will be relative to the CWD. To be extra clear, with this CWD, we can address the CMakeLists.txt file by saying `./CMakeLists.txt`.

Now, to use `main.glsl` as our shader source file, we need to give its path to the `ShaderCompileInfo` when adding a new pipeline, so we'll do that instead. Since we want to use a relative path, we'll say `.source = daxa::ShaderFile{"src/main.glsl"}`. If we didn't specify the full relative path, then our error check from earlier would print the following:

```text
Failed to compile the compute_pipeline!
could not find file :"main.glsl"
```

Alternatively, to provide the entire relative path, we can modify our PipelineManager to use our `src/` folder as a root look-up path for both source files and #includes by filling the `.root_paths` field in the PipelineManager creation info.

```cpp
daxa::PipelineManager pipeline_manager = daxa::PipelineManager({
    .device = device,
    // src is now a root look-up path!
    .root_paths = {
        "src",
    },
    .name = "pipeline_manager",
});

auto compilation_result = pipeline_manager.add_compute_pipeline2({
    //So now we can say
    .source = daxa::ShaderFile{"main.glsl"},
    .name = "compute_pipeline",
});
```

Now that we have a pipeline built on a file, we can look at the hot-reloading. In our application loop, we need to call `.reload_all()` on our PipelineManager.

```cpp
while (true) {
    // ...

    auto reloaded_result = pipeline_manager.reload_all();

    // ...
}
```

This `.reload_all()` function returns a result variant, which you can use to check the reload result. This function doesn't necessarily do anything except check the timestamps of the files in the tracked dependency graph, so it can be the case that it returns a `daxa::NoPipelineChanged` value.

```cpp
if (auto reload_err = daxa::get_if<daxa::PipelineReloadError>(&reloaded_result))
    std::cout << "Failed to reload " << reload_err->message << '\n';
if (auto _ = daxa::get_if<daxa::PipelineReloadSuccess>(&reloaded_result))
    std::cout << "Successfully reloaded!\n";
```

`PipelineReloadResult` is a `daxa::Variant`, not a `std::variant`, so use `daxa::get_if` rather than `std::get_if`.

If we were to modify our `main.glsl` shader file while this application was running, the pipeline manager would automatically recompile `compute_pipeline` for us, with no developer intervention. This is extremely useful for iteration times since you can change your shaders as much as you like while the application runs. If the shader fails to compile, then the pipeline will not be modified and thus will continue to use the old _working_ version.

:::caution[Include tracking only covers the includes present when the pipeline was added]
`reload_all()` keeps the pipeline's original list of watched files when it swaps in the recompiled pipeline, so a header you `#include` **for the first time during a reload** never joins that list - later edits to it do not trigger a recompile. Until this is fixed in Daxa, after adding a new `#include` to a shader, re-save a file that was already tracked to force the reload, or restart the application.
:::

Now is a good time to mention the Daxa shader files, which you can and should #include in your shaders for ease of development. These are in the Daxa include directory, but this can be hard to find when Daxa is pulled in as a CMake dependency (e.g. via `FetchContent` or as a git submodule). To remedy this, Daxa's CMake target provides a C++ #define which has the full path to the Daxa include directory: `DAXA_SHADER_INCLUDE_DIR`. We can add this to our `.root_paths` to allow us to `#include` the Daxa headers in our shaders.

```cpp
.root_paths = {
    DAXA_SHADER_INCLUDE_DIR,
    "src",
},
```

Once we have this root path, we can change our `main.glsl` file like this!

```cpp
#include <daxa/daxa.inl>

layout(local_size_x = 1, local_size_y = 1, local_size_z = 1) in;
void main()
{
}
```

More about Daxa's shader integration (how this header is useful) can be found on [Shader Integration & Bindless](/wiki/shader-integration/).

The last thing to mention for PipelineManager is the ability to register virtual files.

You can call `.add_virtual_file()` on a PipelineManager, providing a name and contents.

```cpp
pipeline_manager.add_virtual_file({
    .name = "my_file",
    .contents = R"glsl(
        // ...
    )glsl",
});
```

To update the virtual file's contents, all you need to do is `.add_virtual_file()` with the exact name string.

Here's what it would look like if we had both a virtual file for the main source file (`my_file`) and a virtual include file (`my_include`)!

```cpp
pipeline_manager.add_virtual_file({
    .name = "my_include",
    .contents = R"glsl(
        #pragma once
        #define MY_INCLUDE_DEFINE
    )glsl",
});

pipeline_manager.add_virtual_file({
    .name = "my_file",
    .contents = R"glsl(
        // Here we can
        #include <my_include>

        #ifndef MY_INCLUDE_DEFINE
        #error This should NOT happen
        #endif

        layout(local_size_x = 1, local_size_y = 1, local_size_z = 1) in;
        void main() {
        }
    )glsl",
});

auto compilation_result = pipeline_manager.add_compute_pipeline2({
    // Here, we supply the path to the file, but our virtual file look-up
    // matches, and so the virtual file is used instead!
    .source = daxa::ShaderFile{"my_file"},
    .name = "compute_pipeline",
});
```
