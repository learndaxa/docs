---
title: Creating a pipeline
description: Creating a pipeline
slug: "tutorial/drawing-a-triangle/creating-a-pipeline"
---

## Pipeline manager

In this tutorial, we will be using the pipeline manager, which is an additional Daxa feature that has to be explicitly imported with the header `<daxa/utils/pipeline_manager.hpp>` and also has to be enabled in our Vcpkg manifest. Both of these steps are already done in the sample code.

A pipeline manager is responsible for managing and executing different render pipelines which we will define later on. This replaces the traditional command recording.

We have to provide the pipeline manager with the device we want to use, our shader directories as well as the shader language. In this tutorial, we will be using GLSL.

```cpp
auto pipeline_manager = daxa::PipelineManager({
    .device = device,
    .root_paths = {
        DAXA_SHADER_INCLUDE_DIR,
        "./src/shader",
    },
    .default_language = daxa::ShaderLanguage::GLSL,
    .default_enable_debug_info = true,
    .name = "my pipeline manager",
});
```

## Rasterization Pipeline

We now can create our first pipeline. For a rasterization pipeline, we need to provide the shaders we want to use, the color attachments (Similar to the [OpenGL g-buffers](https://learnopengl.com/Advanced-Lighting/Deferred-Shading)) and rasterizer settings.

```cpp
std::shared_ptr<daxa::RasterPipeline> pipeline;
{
    auto result = pipeline_manager.add_raster_pipeline2({
        .vertex_shader_info = daxa::ShaderCompileInfo2{.source = daxa::ShaderFile{"main.glsl"}},
        .fragment_shader_info = daxa::ShaderCompileInfo2{.source = daxa::ShaderFile{"main.glsl"}},
        .color_attachments = {{.format = swapchain.get_format()}},
        .raster = {},
        .name = "my pipeline",
    });
    if (result.is_err())
    {
        std::cerr << result.message() << std::endl;
        return -1;
    }
    pipeline = result.value();
}
```

Note that we don't need to specify `.push_constant_size` here - it defaults to `DAXA_MAX_PUSH_CONSTANT_BYTE_SIZE`, which is large enough for our `MyPushConstant` struct. You can set it explicitly if you want to constrain it.
