---
title: Pipeline and shader
description: Pipeline and shader
slug: "tutorial/drawing-a-triangle/pipeline-and-shader"
---

## Push constants

Push constants are a small bank of values, written from the CPU and read by shaders, that don't require creating a buffer or binding a descriptor set. In Daxa they're the standard way to pass per-draw/per-dispatch data - most commonly a handful of `daxa_BufferPtr`/`daxa_ImageId` handles into bindless resources, as we'll do here.

:::tip[Learn more]
See [Shader Integration](/wiki/shader-integration/#push-constants) for how push constants work on the shader side.
:::

To use push constants in our demo project, we need to create a new file: `src/shader/shared.inl` which will be a shared file between our main program and our shader file. Since Glsl is more or less a superset of basic C, we can use some code snippets in both languages.

Since this document is treated as a header file in our C++ code, we can simply insert `#pragma once` at the top to make sure it's only included once. We also need to include the Daxa (Shader) API directly beneath it: `#include <daxa/daxa.inl>`. We'll also include `#include <daxa/utils/task_graph.inl>`, which is needed if you make use of the optional TaskGraph utilities covered later.

We can now start to define common structs, etc. In this case, we need to create a new struct 'MyVertex' that can be pushed to the GPU. Our basic vertices will have a position and color attribute.

```diff lang="cpp"
// src/shader/shared.inl
+#pragma once
+
+// Includes the Daxa API to the shader
+#include <daxa/daxa.inl>
+#include <daxa/utils/task_graph.inl>
+
+struct MyVertex
+{
+    daxa_f32vec3 position;
+    daxa_f32vec3 color;
+};
```

Below this, we have to allow the shader to use pointers to our newly created struct.

```diff lang="cpp"
// src/shader/shared.inl
struct MyVertex
{
    daxa_f32vec3 position;
    daxa_f32vec3 color;
};

+// Allows the shader to use pointers to MyVertex
+DAXA_DECL_BUFFER_PTR(MyVertex)
```

The last step is to create the push constant. The push constant struct needs the attribute 'daxa_BufferPtr' that points to another struct object.

```diff lang="cpp"
// src/shader/shared.inl
DAXA_DECL_BUFFER_PTR(MyVertex)

+struct MyPushConstant
+{
+    daxa_BufferPtr(MyVertex) vertices;
+};
```

To use this file in our main.cpp, we need to include it at the top: `#include "shader/shared.inl"`

## Pipeline manager

In this tutorial, we will be using the pipeline manager, which is an additional Daxa feature that has to be explicitly imported with the header `<daxa/utils/pipeline_manager.hpp>` and also has to be enabled via Daxa's `DAXA_ENABLE_UTILS_PIPELINE_MANAGER_GLSLANG` (or `DAXA_ENABLE_UTILS_PIPELINE_MANAGER_SLANG`) CMake option. Both of these steps are already done in the sample code.

A pipeline manager compiles shader source (with hot-reloading and `#include` tracking) and constructs the underlying `daxa::RasterPipeline`/`daxa::ComputePipeline` objects for us - it's a development convenience layered on top of `device.create_raster_pipeline(...)` / `device.create_compute_pipeline(...)`.

We have to provide the pipeline manager with the device we want to use, our shader directories as well as the shader language. In this tutorial, we will be using GLSL.

```diff lang="cpp"
// src/main.cpp
        .name = "my swapchain",
    });

+    auto pipeline_manager = daxa::PipelineManager({
+        .device = device,
+        .root_paths = {
+            DAXA_SHADER_INCLUDE_DIR,
+            "./src/shader",
+        },
+        .default_language = daxa::ShaderLanguage::GLSL,
+        .default_enable_debug_info = true,
+        .name = "my pipeline manager",
+    });

    while (!window.should_close())
```

:::tip[Learn more]
See [Pipeline Manager](/wiki/pipeline-manager/) for shader source variants (file/string/SPIR-V), hot-reloading via `reload_all()`, and virtual files.
:::

## Writing the shader

Shaders are small programs running on the GPU. Most commonly these are vertex and fragment shaders, which together take buffer data as input and output an image.

Daxa lets you define the vertex and fragment stage in one single file using `DAXA_SHADER_STAGE`. Create `src/shader/main.glsl`:

```diff lang="glsl"
// src/shader/main.glsl
+// Includes the daxa shader API
+#include <daxa/daxa.inl>
+
+// Includes our shared types we created earlier
+#include <shared.inl>
+
+// Enables the push constant MyPushConstant we specified in shared.inl
+DAXA_DECL_PUSH_CONSTANT(MyPushConstant, push)
+
+// We can define the vertex & fragment shader in one single file
+#if DAXA_SHADER_STAGE == DAXA_SHADER_STAGE_VERTEX
+
+layout(location = 0) out daxa_f32vec3 v_col;
+void main()
+{
+    // Daxa provides convenience functions to deref the i'th element for each buffer ptr:
+    MyVertex vert = deref_i(push.vertices, gl_VertexIndex);
+    gl_Position = daxa_f32vec4(vert.position, 1);
+    v_col = vert.color;
+}
+
+#elif DAXA_SHADER_STAGE == DAXA_SHADER_STAGE_FRAGMENT
+
+layout(location = 0) in daxa_f32vec3 v_col;
+layout(location = 0) out daxa_f32vec4 color;
+void main()
+{
+    color = daxa_f32vec4(v_col, 1);
+}
+
+#endif
```

`push.vertices` is the `daxa_BufferPtr(MyVertex)` from the push constant we defined above, and `deref_i` dereferences the i'th `MyVertex` it points to - this is how the vertex shader gets each triangle corner's position and color without any vertex buffer bindings.

:::tip[Learn more]
See [Shader Integration](/wiki/shader-integration/) for how shared types and bindless resource access (`daxa_BufferPtr`, `daxa_ImageId`, ...) work between C++ and GLSL/HLSL/Slang.
:::

## Rasterization pipeline

We now can create our first pipeline. For a rasterization pipeline, we need to provide the shaders we want to use, the color attachments (similar to OpenGL's [g-buffers](https://learnopengl.com/Advanced-Lighting/Deferred-Shading)) and rasterizer settings.

```diff lang="cpp"
// src/main.cpp
        .name = "my pipeline manager",
    });

+    std::shared_ptr<daxa::RasterPipeline> pipeline;
+    {
+        auto result = pipeline_manager.add_raster_pipeline2({
+            .vertex_shader_info = daxa::ShaderCompileInfo2{.source = daxa::ShaderFile{"main.glsl"}},
+            .fragment_shader_info = daxa::ShaderCompileInfo2{.source = daxa::ShaderFile{"main.glsl"}},
+            .color_attachments = {{.format = swapchain.get_format()}},
+            .raster = {},
+            .name = "my pipeline",
+        });
+        if (result.is_err())
+        {
+            std::cerr << result.message() << std::endl;
+            return -1;
+        }
+        pipeline = result.value();
+    }

    while (!window.should_close())
```

Note that we don't need to specify `.push_constant_size` here - it defaults to `DAXA_MAX_PUSH_CONSTANT_BYTE_SIZE`, which is large enough for our `MyPushConstant` struct. You can set it explicitly if you want to constrain it.

Our triangle pipeline only sets `.color_attachments` (with default, disabled blending) and leaves `.raster`/`.depth_test` at their defaults.

:::tip[Learn more]
See [Pipelines](/wiki/pipelines/raster-pipelines) for the full `RasterPipelineInfo` - every blend mode and factor, depth testing, tessellation, and the complete rasterizer state (culling, polygon mode, conservative/line rasterization, MSAA) - as well as compute and ray tracing pipeline creation.
:::
