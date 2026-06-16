---
title: Recording and submitting commands
description: Recording and submitting commands
slug: "tutorial/drawing-a-triangle/recording-and-submitting-commands"
---

## Why record first, then submit?

GPUs don't execute commands the moment you call a function — they work through a *command buffer* you build up on the CPU and hand off all at once. Separating recording from submission has two key benefits:

- **Batching reduces overhead.** Submitting one complete list of work is far more efficient than flushing after every draw or dispatch. Validation and driver-side optimization happen once at submission time, not scattered across every recording call.
- **CPU/GPU parallelism.** Once submitted, the GPU processes the command list independently. Your CPU is free to record the *next* frame's commands while the GPU is still executing the *current* frame — neither side sits idle waiting for the other.

:::tip[Learn more]
[Command Recording & Submission](/wiki/command-recording/#why-command-lists) goes deeper into this model and compares it to immediate-mode APIs like OpenGL.
:::

## Recording

### Acquiring the swapchain image

Before recording any commands, we need to know which swapchain image to render into. `acquire_next_image` waits until a frame-in-flight slot is free and then reserves the next image. If the swapchain is unavailable (e.g. the window is minimized), it returns an empty `ImageId` and we skip the frame.

```diff lang="cpp"
// src/main.cpp
    while (!window.should_close())
    {
        window.update();

+        daxa::ImageId swapchain_image = swapchain.acquire_next_image();
+        if (swapchain_image.is_empty())
+        {
+            continue;
+        }
    }
```

### Creating the recorder and transitioning the image

We create a `CommandRecorder` and immediately issue an image barrier to transition the swapchain image into `GENERAL` layout. Daxa uses `GENERAL` for all rendering; the only two transitions you ever need to issue explicitly are the initial one here and the final `TO_PRESENT_SRC` before presentation.

```diff lang="cpp"
// src/main.cpp
        daxa::ImageId swapchain_image = swapchain.acquire_next_image();
        if (swapchain_image.is_empty())
        {
            continue;
        }

+        daxa::CommandRecorder recorder = device.create_command_recorder({.name = "Main Loop Cmd Recorder"});
+
+        daxa::ImageInfo swapchain_image_info = device.image_info(swapchain_image).value();
+
+        recorder.pipeline_image_barrier({
+            .dst_access = daxa::AccessConsts::COLOR_ATTACHMENT_OUTPUT_READ_WRITE,
+            .image = swapchain_image,
+            .layout_operation = daxa::ImageLayoutOperation::TO_GENERAL,
+        });
    }
```

:::tip[Learn more]
[Synchronization](/wiki/synchronization/#image-barriers) explains `pipeline_image_barrier`, the `GENERAL` layout, and why exactly these two `TO_GENERAL`/`TO_PRESENT_SRC` transitions are needed.
:::

### Render pass

`begin_renderpass` consumes the `CommandRecorder` and returns a `RenderCommandRecorder`, which only exposes commands that are valid inside a render pass. This is enforced at compile time — you cannot accidentally call a compute dispatch or copy inside a renderpass, or a draw outside of one.

```diff lang="cpp"
// src/main.cpp
        recorder.pipeline_image_barrier({
            .dst_access = daxa::AccessConsts::COLOR_ATTACHMENT_OUTPUT_READ_WRITE,
            .image = swapchain_image,
            .layout_operation = daxa::ImageLayoutOperation::TO_GENERAL,
        });

+        daxa::RenderCommandRecorder render_recorder = std::move(recorder).begin_renderpass({
+            .color_attachments = std::array{
+                daxa::RenderAttachmentInfo{
+                    .image_view = swapchain_image.default_view(),
+                    .load_op = daxa::AttachmentLoadOp::CLEAR,
+                    .clear_value = std::array<daxa::f32, 4>{0.1f, 0.0f, 0.5f, 1.0f},
+                },
+            },
+            .render_area = {.width = swapchain_image_info.size.x, .height = swapchain_image_info.size.y},
+        });
    }
```

### Drawing

With the pipeline and push constant set, a single `draw` call records the triangle. Afterwards, `end_renderpass` consumes the `RenderCommandRecorder` and hands back the original `CommandRecorder` so we can record commands outside the pass again.

```diff lang="cpp"
// src/main.cpp
        daxa::RenderCommandRecorder render_recorder = std::move(recorder).begin_renderpass({ ... });

+        render_recorder.set_pipeline(*pipeline);
+        render_recorder.push_constant(MyPushConstant{.vertices = device.device_address(buffer_id).value()});
+        render_recorder.draw({.vertex_count = 3});
+
+        recorder = std::move(render_recorder).end_renderpass();
    }
```

### Transitioning to present

Before submission the image must be transitioned from `GENERAL` to `PRESENT_SRC` so the presentation engine can consume it.

```diff lang="cpp"
// src/main.cpp
        recorder = std::move(render_recorder).end_renderpass();

+        recorder.pipeline_image_barrier({
+            .src_access = daxa::AccessConsts::COLOR_ATTACHMENT_OUTPUT_READ_WRITE,
+            .image = swapchain_image,
+            .layout_operation = daxa::ImageLayoutOperation::TO_PRESENT_SRC,
+        });
    }
```

## Submitting

`complete_current_commands` finalizes the recorder into an `ExecutableCommandList`. `submit_commands` hands it to the GPU, chaining the swapchain semaphores so the GPU waits for the image to be acquired before starting and signals when it is done so presentation can proceed.

```diff lang="cpp"
// src/main.cpp
        recorder.pipeline_image_barrier({
            .src_access = daxa::AccessConsts::COLOR_ATTACHMENT_OUTPUT_READ_WRITE,
            .image = swapchain_image,
            .layout_operation = daxa::ImageLayoutOperation::TO_PRESENT_SRC,
        });

+        daxa::ExecutableCommandList cmd_list = recorder.complete_current_commands();
+
+        device.submit_commands({
+            .command_lists = std::array{cmd_list},
+            .wait_binary_semaphores = std::array{swapchain.current_acquire_semaphore()},
+            .signal_binary_semaphores = std::array{swapchain.current_present_semaphore()},
+            .signal_timeline_semaphores = std::array{swapchain.current_timeline_pair()},
+        });
+
+        device.present_frame({
+            .wait_binary_semaphores = std::array{swapchain.current_present_semaphore()},
+            .swapchain = swapchain,
+        });
    }
```

:::tip[Learn more]
- [Command Recording & Submission](/wiki/command-recording/#raster-pass) covers `CommandRecorder`/`RenderCommandRecorder`, `begin_renderpass`/`end_renderpass`, and `submit_commands`/`present_frame` in full.
- [Swapchain](/wiki/swapchain/) covers what `acquire_next_image()` actually does and how frames-in-flight work.
:::
