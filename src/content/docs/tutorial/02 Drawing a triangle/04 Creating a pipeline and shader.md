---
title: Creating a pipeline and shader
description: Creating a pipeline and shader
slug: "tutorial/drawing-a-triangle/creating-a-pipeline-and-shader"
---

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

`push.vertices` is the `daxa_BufferPtr(MyVertex)` from [Push constants](/tutorial/drawing-a-triangle/push-constants/), and `deref_i` dereferences the i'th `MyVertex` it points to - this is how the vertex shader gets each triangle corner's position and color without any vertex buffer bindings.

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
See [Pipelines & Renderpasses](/wiki/pipelines-and-renderpasses/) for the full `RasterPipelineInfo` - every blend mode and factor, depth testing, tessellation, and the complete rasterizer state (culling, polygon mode, conservative/line rasterization, MSAA) - as well as compute and ray tracing pipeline creation.
:::
