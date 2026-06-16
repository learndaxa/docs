---
title: Finishing up
description: Finishing up
slug: "tutorial/drawing-a-triangle/finishing-up"
---

## Implementing the main loop

With recording and submission in place, there are two remaining pieces to complete the frame loop: handling window resizes before acquiring an image, and reclaiming GPU resources at the end of each frame.

```diff lang="cpp"
// src/main.cpp
    while (!window.should_close())
    {
        window.update();

+        if (window.swapchain_out_of_date)
+        {
+            swapchain.resize();
+            window.swapchain_out_of_date = false;
+        }
+
        daxa::ImageId swapchain_image = swapchain.acquire_next_image();
        if (swapchain_image.is_empty())
        {
            continue;
        }

        // ... recording and submission ...

        device.present_frame({
            .wait_binary_semaphores = std::array{swapchain.current_present_semaphore()},
            .swapchain = swapchain,
        });

+        // The device performs all memory reclaiming in the collect_garbage call.
+        // It's best to call it once at the end of each frame.
+        device.collect_garbage();
    }
```

:::tip[Learn more]
See [Swapchain](/wiki/swapchain/) for what `acquire_next_image()`/`resize()` actually do, frames-in-flight, and a fully annotated version of this loop.
:::

## Cleaning up

Finally, we can clean up!

```diff lang="cpp"
// src/main.cpp
        device.collect_garbage();
    }

+    device.destroy_buffer(buffer_id);
+
+    device.wait_idle();
+    device.collect_garbage();

    return 0;
}
```

:::tip[Learn more]
See [Buffers, Images & Acceleration Structures](/wiki/buffers-images-acceleration-structures/#deferred-destruction---zombies) for what `destroy_buffer` actually does (it's deferred - the buffer becomes a "zombie" until `collect_garbage` after `wait_idle` confirms the GPU is done with it).
:::

## Running the code

You have now completed the Daxa tutorial! If you now run the code, you should have a triangle appearing in the window!
Running the code with the VSCode debugger should be as simple as pressing the debug button, though you may need to create a launch.json if the working directory is wrong.

Otherwise, you can manually run the CMake commands to configure, build, and then run the executable directly like so:

```shell
cmake --preset=Debug
cmake --build build/Debug
./build/Debug/learndaxa  # learndaxa.exe on Windows
```

:::caution
The application must be **run from the repo root directory** - shader paths (`./src/shader`) and the include path passed via `DAXA_SHADER_INCLUDE_DIR` are resolved relative to the current working directory, not the executable's location. If your shaders fail to load, check your working directory first (e.g. in a VS Code `launch.json`).
:::

:::tip[Learn more]
See [Building](/wiki/building/) for what the `cl-x86_64-windows-msvc`/`gcc-x86_64-linux-gnu`-style presets used by Daxa itself look like, and how the `DAXA_ENABLE_UTILS_*` CMake options (used here to enable the pipeline manager and TaskGraph) work if you want to enable additional utilities like Dear ImGui in your own project.
:::

## Final Code

```cpp
// src/main.cpp

#include "window.hpp"
#include "shader/shared.inl"

#include <daxa/utils/pipeline_manager.hpp>
#include <iostream>

int main(int argc, char const *argv[])
{
    // Create a window
    auto window = AppWindow("Learn Daxa", 860, 640);

    daxa::Instance instance = daxa::create_instance({});

    daxa::Device device = instance.create_device_2(instance.choose_device({}, {}));

    daxa::Swapchain swapchain = device.create_swapchain({
        .native_window_info = window.get_native_window_info(),
        .surface_format = device.choose_swapchain_surface_format({
            .native_window_info = window.get_native_window_info(),
        }),
        .present_mode = daxa::PresentMode::FIFO,
        .image_usage = daxa::ImageUsageFlagBits::TRANSFER_DST,
        .name = "my swapchain",
    });

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

    // Allocate the vertex buffer in host-visible vram and upload the triangle data directly.
    auto buffer_id = device.create_buffer({
        .size = sizeof(MyVertex) * 3,
        .memory_flags = daxa::MemoryFlagBits::HOST_ACCESS_SEQUENTIAL_WRITE,
        .name = "my vertex data",
    });

    MyVertex * vert_buf_ptr = device.buffer_host_address_as<MyVertex>(buffer_id).value();
    vert_buf_ptr[0] = {.position = {-0.5f, +0.5f, 0.0f}, .color = {1.0f, 0.0f, 0.0f}};
    vert_buf_ptr[1] = {.position = {+0.5f, +0.5f, 0.0f}, .color = {0.0f, 1.0f, 0.0f}};
    vert_buf_ptr[2] = {.position = {+0.0f, -0.5f, 0.0f}, .color = {0.0f, 0.0f, 1.0f}};

    while (!window.should_close())
    {
        window.update();

        if (window.swapchain_out_of_date)
        {
            swapchain.resize();
            window.swapchain_out_of_date = false;
        }

        // acquire_next_image will wait until a frame in flight is available, then attempt to acquire a new swapchain image.
        // If the acquisition fails, it will return a null image id (is_empty() -> true).
        daxa::ImageId swapchain_image = swapchain.acquire_next_image();
        if (swapchain_image.is_empty())
        {
            continue;
        }

        // Record and submit frame gpu commands
        {
            daxa::CommandRecorder recorder = device.create_command_recorder({.name = "Main Loop Cmd Recorder"});

            daxa::ImageInfo swapchain_image_info = device.image_info(swapchain_image).value();

            recorder.pipeline_image_barrier({
                .dst_access = daxa::AccessConsts::COLOR_ATTACHMENT_OUTPUT_READ_WRITE,
                .image = swapchain_image,
                .layout_operation = daxa::ImageLayoutOperation::TO_GENERAL,
            });

            daxa::RenderCommandRecorder render_recorder = std::move(recorder).begin_renderpass({
                .color_attachments = std::array{
                    daxa::RenderAttachmentInfo{
                        .image_view = swapchain_image.default_view(),
                        .load_op = daxa::AttachmentLoadOp::CLEAR,
                        .clear_value = std::array<daxa::f32, 4>{0.1f, 0.0f, 0.5f, 1.0f},
                    },
                },
                .render_area = {.width = swapchain_image_info.size.x, .height = swapchain_image_info.size.y},
            });

            render_recorder.set_pipeline(*pipeline);
            render_recorder.push_constant(MyPushConstant{.vertices = device.device_address(buffer_id).value()});
            render_recorder.draw({.vertex_count = 3});

            // VERY IMPORTANT! A renderpass must be ended after finishing!
            recorder = std::move(render_recorder).end_renderpass();

            recorder.pipeline_image_barrier({
                .src_access = daxa::AccessConsts::COLOR_ATTACHMENT_OUTPUT_READ_WRITE,
                .image = swapchain_image,
                .layout_operation = daxa::ImageLayoutOperation::TO_PRESENT_SRC,
            });

            daxa::ExecutableCommandList cmd_list = recorder.complete_current_commands();

            device.submit_commands({
                .command_lists = std::array{cmd_list},
                .wait_binary_semaphores = std::array{swapchain.current_acquire_semaphore()},
                .signal_binary_semaphores = std::array{swapchain.current_present_semaphore()},
                .signal_timeline_semaphores = std::array{swapchain.current_timeline_pair()},
            });

            device.present_frame({
                .wait_binary_semaphores = std::array{swapchain.current_present_semaphore()},
                .swapchain = swapchain,
            });
        }

        device.collect_garbage();
    }

    device.destroy_buffer(buffer_id);

    device.wait_idle();
    device.collect_garbage();

    return 0;
}
```

```cpp
// src/window.hpp

#pragma once

#include <daxa/daxa.hpp>
using namespace daxa::types;

#include <GLFW/glfw3.h>
#if defined(_WIN32)
#define GLFW_EXPOSE_NATIVE_WIN32
#define GLFW_NATIVE_INCLUDE_NONE
using HWND = void *;
#elif defined(__linux__)
#define GLFW_EXPOSE_NATIVE_X11
#define GLFW_EXPOSE_NATIVE_WAYLAND
#endif
#include <GLFW/glfw3native.h>

struct AppWindow {
    GLFWwindow *glfw_window_ptr;
    u32 width, height;
    bool minimized = false;
    bool swapchain_out_of_date = false;

    explicit AppWindow(char const *window_name, u32 sx = 800, u32 sy = 600) : width{sx}, height{sy} {
        // Initialize GLFW
        glfwInit();

        // Tell GLFW to not include any other API
        glfwWindowHint(GLFW_CLIENT_API, GLFW_NO_API);

        // Tell GLFW to make the window resizable
        glfwWindowHint(GLFW_RESIZABLE, GLFW_TRUE);

        // Create the window
        glfw_window_ptr = glfwCreateWindow(static_cast<i32>(width), static_cast<i32>(height), window_name, nullptr, nullptr);

        // Set the user pointer to this window
        glfwSetWindowUserPointer(glfw_window_ptr, this);

        // When the window is resized, update the width and height and mark the swapchain as out of date
        glfwSetWindowSizeCallback(glfw_window_ptr, [](GLFWwindow *window, int size_x, int size_y) {
            auto *win = static_cast<AppWindow *>(glfwGetWindowUserPointer(window));
            win->width = static_cast<u32>(size_x);
            win->height = static_cast<u32>(size_y);
            win->swapchain_out_of_date = true;
        });
    }

    ~AppWindow() {
        glfwDestroyWindow(glfw_window_ptr);
        glfwTerminate();
    }

    auto get_native_window_info() const -> daxa::NativeWindowInfo {
#if defined(_WIN32)
        return daxa::NativeWindowInfoWin32{glfwGetWin32Window(glfw_window_ptr)};
#elif defined(__linux__)
        switch (glfwGetPlatform()) {
        case GLFW_PLATFORM_WAYLAND:
            return daxa::NativeWindowInfoWayland{
                .display = glfwGetWaylandDisplay(),
                .surface = glfwGetWaylandWindow(glfw_window_ptr),
                .width = width,
                .height = height,
            };
        case GLFW_PLATFORM_X11:
        default:
            return daxa::NativeWindowInfoXlib{
                .window = reinterpret_cast<void *>(glfwGetX11Window(glfw_window_ptr))
            };
        }
#endif
    }

    inline void set_mouse_capture(bool should_capture) const {
        glfwSetCursorPos(glfw_window_ptr, static_cast<f64>(width / 2.), static_cast<f64>(height / 2.));
        glfwSetInputMode(glfw_window_ptr, GLFW_CURSOR, should_capture ? GLFW_CURSOR_DISABLED : GLFW_CURSOR_NORMAL);
        glfwSetInputMode(glfw_window_ptr, GLFW_RAW_MOUSE_MOTION, should_capture);
    }

    inline bool should_close() const {
        return glfwWindowShouldClose(glfw_window_ptr);
    }

    inline void update() const {
        glfwPollEvents();
        glfwSwapBuffers(glfw_window_ptr);
    }

    inline GLFWwindow *get_glfw_window() const {
        return glfw_window_ptr;
    }
};
```

```cpp
// src/shader/shared.inl

#pragma once

// Includes the Daxa API to the shader
#include <daxa/daxa.inl>
#include <daxa/utils/task_graph.inl>

struct MyVertex
{
    daxa_f32vec3 position;
    daxa_f32vec3 color;
};

// Allows the shader to use pointers to MyVertex
DAXA_DECL_BUFFER_PTR(MyVertex)

struct MyPushConstant
{
    daxa_BufferPtr(MyVertex) vertices;
};
```

```cpp
// src/shader/main.glsl

// Includes the daxa shader API
#include <daxa/daxa.inl>

// Includes our shared types we created earlier
#include <shared.inl>

// Enabled the push constant MyPushConstant we specified in shared.inl
DAXA_DECL_PUSH_CONSTANT(MyPushConstant, push)

// We can define the vertex & fragment shader in one single file
#if DAXA_SHADER_STAGE == DAXA_SHADER_STAGE_VERTEX

layout(location = 0) out daxa_f32vec3 v_col;
void main()
{
    // Daxa provides convenience functions to deref the i'th element for each buffer ptr:
    MyVertex vert = deref_i(push.vertices, gl_VertexIndex);
    gl_Position = daxa_f32vec4(vert.position, 1);
    v_col = vert.color;
}

#elif DAXA_SHADER_STAGE == DAXA_SHADER_STAGE_FRAGMENT

layout(location = 0) in daxa_f32vec3 v_col;
layout(location = 0) out daxa_f32vec4 color;
void main()
{
    color = daxa_f32vec4(v_col, 1);
}

#endif
```
