---
title: Command Recording & Submission
description: How to record commands into command lists and submit them to the device in Daxa
slug: wiki/command-recording
---

## Description

In Daxa, all GPU work - copies, compute dispatches, draws, ray tracing, acceleration structure builds - is recorded into a `daxa::CommandRecorder`. Once recording is finished, the recorder is turned into a `daxa::ExecutableCommandList`, which is then handed to `device.submit_commands(...)` to actually run on the GPU.

> If you'd rather not record and synchronize commands by hand, [TaskGraph](/wiki/taskgraph/) builds a `CommandRecorder` for you each frame and inserts barriers/semaphores automatically based on declared task resource usages.

`daxa::CommandRecorder` is created from a `daxa::Device` - see [Initialization and Device](/wiki/initialization-and-device/) for how a device is created.

```cpp
daxa::CommandRecorder recorder = device.create_command_recorder({.name = "my command recorder"});

// ... record commands ...

daxa::ExecutableCommandList cmd_list = recorder.complete_current_commands();

device.submit_commands({
    .command_lists = std::array{cmd_list},
});
```

Per default, command recorders are created for Daxa's main queue, which supports every command type (transfer, compute, raster, ray tracing).

## Why command lists?

In immediate-mode APIs like OpenGL, every call (`glBindBuffer`, `glBindTexture`, `glUniform...`, `glDrawArrays`, ...) mutates one big implicit global state machine. The driver has to validate and synchronize this state on essentially every call, which has a few consequences:

- All of that validation/synchronization work happens invisibly, smeared across every single state-setting call, right on your hot path.
- The global state machine makes it very hard to record work from multiple threads - there is only one context per thread, and sharing/synchronizing contexts is notoriously painful.
- Code far away from your draw call can leave the global context in a state that subtly breaks your rendering (wrong bound buffer, leftover blend state, etc.), and you only find out at runtime.

Command recorders flip this around:

- A `CommandRecorder` is a self-contained object. Recording commands into it doesn't touch any global state, so multiple recorders can be built on multiple threads completely independently.
- The expensive driver-side work happens at well-defined points: while recording, and when calling `complete_current_commands()` - not hidden inside every small state-setting call.
- Submission (`device.submit_commands`) is its own explicit step where synchronization (semaphores, queues) is spelled out in your code, instead of being inferred implicitly by the driver.
- Because all relevant state (bound pipeline, current renderpass, push constants, ...) lives on the recorder itself, there is no shared global context for unrelated code to corrupt.
- Daxa goes a step further with types: `begin_renderpass` consumes a `CommandRecorder` and returns a `RenderCommandRecorder`, and `end_renderpass` consumes that and gives the `CommandRecorder` back. This makes it a **compile-time error** to issue a `dispatch` inside a renderpass, or a `draw` outside of one - no more invalid-call errors at runtime.

## Recording commands

### Copy

Buffers and images can be copied to/from each other or cleared directly on the command recorder. A typical upload from a host-visible staging buffer to a device-local buffer looks like this:

```cpp
daxa::CommandRecorder recorder = device.create_command_recorder({.name = "upload recorder"});

// Make sure the host writes to the staging buffer are visible to the copy.
recorder.pipeline_barrier({
    .src_access = daxa::AccessConsts::HOST_WRITE,
    .dst_access = daxa::AccessConsts::TRANSFER_READ,
});

recorder.copy_buffer_to_buffer({
    .src_buffer = staging_buffer,
    .dst_buffer = device_buffer,
    .size = sizeof(MyData),
});

daxa::ExecutableCommandList cmd_list = recorder.complete_current_commands();

device.submit_commands({
    .command_lists = std::array{cmd_list},
});
```

Daxa also provides `copy_buffer_to_image`, `copy_image_to_buffer`, `copy_image_to_image`, `blit_image_to_image`, `clear_buffer`, and `clear_image` for the other common cases.

See [Buffer/Texture Upload & Mip Map Generation](/wiki/buffer-texture-upload-and-mipmaps/) for a complete staging-buffer upload pattern (including the barriers above) and mip-chain generation with `blit_image_to_image`, and [Buffers, Images & Acceleration Structures](/wiki/buffers-images-acceleration-structures/) for creating the buffers/images being copied.

### Compute dispatch

Compute pipelines are bound and dispatched directly on the `CommandRecorder` - no renderpass is needed:

```cpp
daxa::CommandRecorder recorder = device.create_command_recorder({.name = "compute recorder"});

recorder.set_pipeline(*compute_pipeline);

recorder.push_constant(MyComputePush{
    .image = image.default_view(),
    .image_size = {1024, 1024},
});

recorder.dispatch({.x = 1024 / 8, .y = 1024 / 8, .z = 1});

daxa::ExecutableCommandList cmd_list = recorder.complete_current_commands();

device.submit_commands({
    .command_lists = std::array{cmd_list},
});
```

`dispatch_indirect` is also available for dispatches whose size is computed on the GPU.

See [Pipelines & Renderpasses](/wiki/pipelines-and-renderpasses/#compute-pipelines) for creating `compute_pipeline`, and [Shader Integration](/wiki/shader-integration/#push-constants) for how `MyComputePush` and bindless image/buffer handles are declared and read on the shader side.

### Raster pass

Drawing requires a renderpass scope. `begin_renderpass` consumes the `CommandRecorder` and returns a `RenderCommandRecorder`; `end_renderpass` consumes the `RenderCommandRecorder` and gives the `CommandRecorder` back:

```cpp
daxa::CommandRecorder recorder = device.create_command_recorder({.name = "raster recorder"});

// Daxa images need an explicit transition to GENERAL before their first use.
recorder.pipeline_image_barrier({
    .dst_access = daxa::AccessConsts::COLOR_ATTACHMENT_OUTPUT_READ_WRITE,
    .image = render_target,
    .layout_operation = daxa::ImageLayoutOperation::TO_GENERAL,
});

daxa::RenderCommandRecorder render_recorder = std::move(recorder).begin_renderpass({
    .color_attachments = std::array{
        daxa::RenderAttachmentInfo{
            .image_view = render_target.default_view(),
            .load_op = daxa::AttachmentLoadOp::CLEAR,
            .clear_value = std::array<daxa::f32, 4>{0.0f, 0.0f, 0.0f, 1.0f},
        },
    },
    .render_area = {.width = render_target_size.x, .height = render_target_size.y},
});

render_recorder.set_pipeline(*raster_pipeline);
render_recorder.push_constant(MyPushConstant{
    .vertices = device.device_address(vertex_buffer).value(),
});
render_recorder.draw({.vertex_count = 3});

// Ending the renderpass returns the underlying CommandRecorder.
recorder = std::move(render_recorder).end_renderpass();

daxa::ExecutableCommandList cmd_list = recorder.complete_current_commands();

device.submit_commands({
    .command_lists = std::array{cmd_list},
});
```

Only `RenderCommandRecorder` exposes draw-related functions (`draw`, `draw_indexed`, `draw_indirect`, `set_viewport`, `set_scissor`, ...), and only `CommandRecorder` exposes copies, barriers, and dispatches - so the type system enforces where each command is legal.

See [Pipelines & Renderpasses](/wiki/pipelines-and-renderpasses/#raster-pipelines--renderpasses) for `RasterPipelineInfo`, render attachments, and depth testing, and [Buffers, Images & Acceleration Structures](/wiki/buffers-images-acceleration-structures/) for creating the `vertex_buffer`/`render_target` resources referenced here.

## Pipeline barriers

Daxa keeps all resources in image layout `GENERAL`. The only layout transitions you have to do explicitly are the initial transition to `GENERAL` and the transition to `PRESENT_SRC` before presenting a swapchain image (see `daxa::ImageLayoutOperation`). All synchronization WITHIN a command list is expressed with `pipeline_barrier`/`pipeline_image_barrier` and `daxa::Access`/`daxa::AccessConsts`, describing which pipeline stages read/write a resource before and after the barrier. Successive barrier calls are batched together and flushed as a single `vkCmdPipelineBarrier2` once a non-barrier command is recorded.

## Completing a command list

`complete_current_commands()` finalizes the recorded commands into a ready-to-submit `daxa::ExecutableCommandList` (this corresponds to ending the underlying `VkCommandBuffer`). This does significant driver-side CPU work, so it's best not to call it immediately before submitting on a time-critical thread - for example, when recording on worker threads, complete each command list as soon as it's done, and only hand the resulting `ExecutableCommandList`s to the submitting thread.

## Submitting commands

`device.submit_commands` takes one or more completed command lists, plus any semaphores needed to synchronize with other submits or the swapchain:

```cpp
u64 submit_index = device.submit_commands({
    .command_lists = std::array{cmd_list},
    .wait_binary_semaphores = std::array{swapchain.current_acquire_semaphore()},
    .signal_binary_semaphores = std::array{swapchain.current_present_semaphore()},
    .signal_timeline_semaphores = std::array{swapchain.current_timeline_pair()},
});
```

Every call to `submit_commands` returns a unique, monotonically increasing submit index. This index can be compared against `device.oldest_pending_submit_index()` to know when the GPU has caught up to a particular point - which is exactly what `device.collect_garbage()` uses to decide when zombified SROs can finally be destroyed.

See [Synchronization](/wiki/synchronization/) for the full picture on `wait_binary_semaphores`/`signal_binary_semaphores`/`signal_timeline_semaphores`, multi-queue submission, and waiting on submit indices from the CPU.

## Presenting

After submitting the commands that render into a swapchain image, present it with `device.present_frame`:

```cpp
device.present_frame({
    .wait_binary_semaphores = std::array{swapchain.current_present_semaphore()},
    .swapchain = swapchain,
});
```

See [Swapchain](/wiki/swapchain/#synchronizing-a-frame) for where `current_acquire_semaphore()`/`current_present_semaphore()`/`current_timeline_pair()` come from, and [Swapchain: Full Example](/wiki/swapchain/#full-example-a-frame-loop) for a complete acquire/render/present frame loop.
