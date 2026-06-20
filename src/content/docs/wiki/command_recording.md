---
title: Command Recording & Submission
description: How to record commands into command lists and submit them to the device in Daxa
slug: wiki/command-recording
---

## Description

In Daxa, all GPU work - copies, compute dispatches, draws, ray tracing, acceleration structure builds - is recorded into a `daxa::CommandRecorder`. Once recording is finished, the recorder is turned into a `daxa::ExecutableCommandList`, which is then handed to `device.submit_commands(...)` to actually run on the GPU.

> If you'd rather not record and synchronize commands by hand, [TaskGraph](/wiki/taskgraph-bottom-up/) builds a `CommandRecorder` for you each frame and inserts barriers/semaphores automatically based on declared task resource usages.

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

See [Pipelines](/wiki/pipelines/#compute-pipelines) for creating `compute_pipeline`, and [Shader Integration](/wiki/shader-integration/#push-constants) for how `MyComputePush` and bindless image/buffer handles are declared and read on the shader side.

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

Only `RenderCommandRecorder` exposes draw-related functions, and only `CommandRecorder` exposes copies, barriers, and dispatches — the type system enforces where each command is legal.

#### Renderpass attachments

`begin_renderpass` takes a `RenderPassBeginInfo`:

```cpp
struct RenderAttachmentInfo
{
    ImageViewId image_view = {};
    AttachmentLoadOp load_op = AttachmentLoadOp::DONT_CARE;
    AttachmentStoreOp store_op = AttachmentStoreOp::STORE;
    ClearValue clear_value = {};
    Optional<AttachmentResolveInfo> resolve = {};
};

struct RenderPassBeginInfo
{
    FixedList<RenderAttachmentInfo, 8> color_attachments = {};
    Optional<RenderAttachmentInfo> depth_attachment = {};
    Optional<RenderAttachmentInfo> stencil_attachment = {};
    Rect2D render_area = {};
};
```

- `.color_attachments`: up to 8 color attachments, each an `ImageViewId` plus load/store behavior. `.depth_attachment` / `.stencil_attachment` use the same struct for depth/stencil images.
- `.load_op`: what happens to the attachment's existing contents at the start of the renderpass.
  - `LOAD` - keep whatever is already in the image.
  - `CLEAR` - clear to `.clear_value` before any drawing.
  - `DONT_CARE` - contents are undefined at the start; use this when the renderpass is guaranteed to fully overwrite the attachment, to avoid a wasted clear/load.
- `.store_op`: what happens to the contents at the end of the renderpass.
  - `STORE` - write the rendered contents back to the image (the normal case).
  - `DONT_CARE` - discard the contents; useful for transient attachments (e.g. an MSAA attachment that's immediately resolved and never needed afterwards).
- `.clear_value`: a `Variant<std::array<f32,4>, std::array<i32,4>, std::array<u32,4>, DepthValue>` — pick the variant matching the attachment's format (float/sint/uint color, or `DepthValue{.depth, .stencil}` for depth/stencil attachments). Only used when `.load_op == CLEAR`.
- `.resolve`: `Optional<AttachmentResolveInfo>` — for MSAA attachments, an additional single-sample image view that the multisampled result is resolved into at the end of the renderpass, plus a `ResolveMode` (`SAMPLE_ZERO`, `AVERAGE`, `MIN`, `MAX`) controlling how the samples are combined.
- `.render_area`: a `Rect2D` (`.x`, `.y`, `.width`, `.height`) defining the region of the attachments that's rendered to.

```cpp
daxa::RenderCommandRecorder render_recorder = std::move(recorder).begin_renderpass({
    .color_attachments = std::array{
        daxa::RenderAttachmentInfo{
            .image_view = swapchain_image.default_view(),
            .load_op = daxa::AttachmentLoadOp::CLEAR,
            .clear_value = std::array<f32, 4>{0.1f, 0.1f, 0.1f, 1.0f},
        },
    },
    .depth_attachment = daxa::RenderAttachmentInfo{
        .image_view = depth_view,
        .load_op = daxa::AttachmentLoadOp::CLEAR,
        .clear_value = daxa::DepthValue{.depth = 1.0f, .stencil = 0},
    },
    .render_area = {.x = 0, .y = 0, .width = size_x, .height = size_y},
});
```

#### Draw commands

Inside a renderpass, `RenderCommandRecorder` exposes:

- `set_pipeline(pipeline)` — bind a raster pipeline.
- `push_constant(data)` — upload push constant data.
- `set_viewport(ViewportInfo{...})` / `set_scissor(Rect2D{...})` — set the viewport and scissor rectangles. These are always dynamic and not baked into `RasterPipelineInfo`.
- `set_depth_bias(DepthBiasInfo{...})` — override the pipeline's depth bias values dynamically per draw.
- `set_index_buffer(SetIndexBufferInfo{...})` — bind an index buffer before `draw_indexed`.
- `draw(DrawInfo{...})` — non-indexed draw.
- `draw_indexed(DrawIndexedInfo{...})` — indexed draw.
- `draw_indirect(DrawIndirectInfo{...})` / `draw_indirect_count(DrawIndirectCountInfo{...})` — draw with parameters from a GPU buffer, optionally with the draw count also on the GPU.
- `draw_mesh_tasks(DrawMeshTasksInfo{.x, .y, .z})` / `draw_mesh_tasks_indirect` / `draw_mesh_tasks_indirect_count` — mesh shader draw variants.

See [Pipelines](/wiki/pipelines/#raster-pipelines) for `RasterPipelineInfo`, color attachment formats, blending, depth testing, and rasterizer state, and [Buffers, Images & Acceleration Structures](/wiki/buffers-images-acceleration-structures/) for creating the resources used as attachments and vertex buffers.

### Debug labels

Debug labels annotate a command buffer with named, colored regions that appear in GPU debugging and profiling tools such as RenderDoc, NSight, and PIX. They have no measurable runtime cost outside of a validation/debug context.

```cpp
recorder.begin_label({
    .label_name = "Shadow Pass",
    .label_color = {1.0f, 0.5f, 0.0f, 1.0f},
});

// ... shadow pass commands ...

recorder.end_label();
```

Labels can be nested — each `begin_label` must be matched by an `end_label` before the command list is completed. To drop a single named marker with no extent, use `insert_label`:

```cpp
recorder.insert_label({
    .label_name = "Upload complete",
    .label_color = {0.0f, 1.0f, 0.0f, 1.0f},
});
```

`label_color` is an RGBA `f32` vec4. Labels are backed by `VK_EXT_debug_utils` and are silently ignored when the extension is not loaded.

### Timestamp queries

Timestamp queries let you record GPU timestamps at specific pipeline stages and read them back on the CPU to measure how long sections of GPU work took.

First, create a `TimelineQueryPool` and reset it before writing:

```cpp
daxa::TimelineQueryPool query_pool = device.create_timeline_query_pool({
    .query_count = 2,
    .name = "frame timings",
});

recorder.reset_timestamps({
    .query_pool = query_pool,
    .start_index = 0,
    .count = 2,
});
```

Write timestamps around the work you want to measure:

```cpp
recorder.write_timestamp({
    .query_pool = query_pool,
    .pipeline_stage = daxa::PipelineStageFlagBits::TOP_OF_PIPE,
    .query_index = 0,
});

// ... work to measure ...

recorder.write_timestamp({
    .query_pool = query_pool,
    .pipeline_stage = daxa::PipelineStageFlagBits::BOTTOM_OF_PIPE,
    .query_index = 1,
});
```

After the frame (once the GPU has finished — e.g. after `collect_garbage`), read the results back:

```cpp
std::array<u64, 2> timestamps = {};
query_pool.get_query_results(0, 2, timestamps.data());

float ms = float(timestamps[1] - timestamps[0])
         * device.properties().limits.timestamp_period
         / 1e6f;
```

`timestamp_period` is a device-specific constant — the number of nanoseconds per raw timestamp tick. It varies between GPU vendors and models, so it must be queried from the device rather than assumed. Dividing by `1e6` then converts nanoseconds to milliseconds. Use `TOP_OF_PIPE`/`BOTTOM_OF_PIPE` for the widest bracket; narrow it to specific stages (e.g. `COMPUTE_SHADER`, `COLOR_ATTACHMENT_OUTPUT`) when you want to isolate a particular stage's contribution.

### Events

Events are a fine-grained synchronization primitive that splits a pipeline barrier into two halves — a **signal** half (`set_event`) and a **wait** half (`wait_event`) — that can be placed at different points in the same command buffer. Work recorded between the signal and the wait is free to execute on the GPU as long as it doesn't depend on the signaled resource.

This is useful when a dependency is partial: for example, a compute shader writes two separate buffer regions, and a subsequent copy only depends on the first. A regular pipeline barrier would stall until all of the compute is done. An event signals as soon as the first region is written, allowing the copy and the rest of the compute to overlap.

```cpp
daxa::Event event = device.create_event({.name = "compute region 0 done"});

// Reset before use (required before each signal/wait cycle).
recorder.reset_event({
    .event = event,
    .stage = daxa::PipelineStageFlagBits::ALL_COMMANDS,
});

recorder.dispatch({...}); // compute that writes region 0

// Signal after the compute stage — the event is set once the GPU
// reaches this point in the command stream.
recorder.signal_event({
    .event = event,
    .src_access = daxa::AccessConsts::COMPUTE_SHADER_WRITE,
});

// Other work that doesn't need region 0 can go here and will
// overlap with downstream copies that do.

// Wait before anything that reads region 0.
recorder.wait_event({
    .event = event,
    .dst_access = daxa::AccessConsts::TRANSFER_READ,
});

recorder.copy_buffer_to_buffer({...}); // reads region 0
```

Events operate strictly within a single queue — they cannot synchronize across queues. For cross-queue dependencies, use timeline semaphores (see [Synchronization](/wiki/synchronization/#timeline-semaphores)).

## Pipeline barriers

Daxa keeps all resources in image layout `GENERAL`. The only layout transitions you have to do explicitly are the initial transition to `GENERAL` and the transition to `PRESENT_SRC` before presenting a swapchain image (see `daxa::ImageLayoutOperation`). All synchronization WITHIN a command list is expressed with `pipeline_barrier`/`pipeline_image_barrier` and `daxa::Access`/`daxa::AccessConsts`, describing which pipeline stages read/write a resource before and after the barrier. Successive barrier calls are batched together and flushed as a single `vkCmdPipelineBarrier2` once a non-barrier command is recorded.

## Completing a command list

`complete_current_commands()` finalizes the recorded commands into a ready-to-submit `daxa::ExecutableCommandList` (this corresponds to ending the underlying `VkCommandBuffer`). This does significant driver-side CPU work, so it's best not to call it immediately before submitting on a time-critical thread - for example, when recording on worker threads, complete each command list as soon as it's done, and only hand the resulting `ExecutableCommandList`s to the submitting thread.

## Deferred resource destruction

While recording, you can hand a resource to the `CommandRecorder` and ask it to destroy that resource once the command list has finished executing on the GPU:

```cpp
daxa::BufferId staging = device.create_buffer({
    .size = upload_size,
    .memory_flags = daxa::MemoryFlagBits::HOST_ACCESS_SEQUENTIAL_WRITE,
    .name = "upload staging",
});

// ... write data into staging, record the copy ...

recorder.destroy_buffer_deferred(staging);

daxa::ExecutableCommandList cmd_list = recorder.complete_current_commands();
device.submit_commands({.command_lists = std::array{cmd_list}});
// staging will be destroyed automatically once the GPU finishes cmd_list
```

The same exists for `destroy_image_deferred`, `destroy_image_view_deferred`, and `destroy_sampler_deferred`.

This is particularly useful for **one-shot resources** — staging buffers, scratch buffers, temporary images — where the resource only needs to live long enough for the command list that uses it to finish. Without deferred destruction, you would have to return the ID to the caller, thread it through whatever code issues the submit, check when the submit is done, and then call `device.destroy_buffer` at exactly the right time. That's a lot of plumbing for something that has a completely predictable lifetime. Deferred destruction collapses all of it into a single call at the recording site.

> This is a convenience for resources with a clear, short lifetime tied to a specific command list. For long-lived resources or anything accessed across multiple frames, use normal `device.destroy_*` calls — deferring everything would obscure lifetimes and make memory management harder to reason about.

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

## Best practices

Creating a `daxa::CommandRecorder` is not free on the CPU - it allocates and begins a `VkCommandBuffer`, which involves driver-side bookkeeping. Likewise, every `complete_current_commands()` call does real driver-side work to finalize the command buffer, and every `command_lists` switch on the GPU (ending one `VkCommandBuffer` and beginning the next) has its own cost as the GPU's command processor has to flush and reload state between lists. `submit_commands` itself is more expensive still, on both the CPU and the GPU.

Because of this, batch as much work as possible into each recorder, list, and submit, rather than creating a new one for every small piece of work - a frame with dozens of tiny recorders/lists/submits pays that fixed overhead dozens of times for no benefit. Since a `CommandRecorder` only needs to live as long as it takes to build the `ExecutableCommandList`s for one submit, the ideal number of command recorders in a frame is roughly the number of submits. Keep submits below 4 per frame where possible - a simple, common split is one submit for uploads and one for the main frame's work - and let the recorder count follow from that. As a rule of thumb, a frame should ideally use less than 8 command recorders.

Going beyond that can be justified once you reach async compute/transfer, where extra submits on separate queues let unrelated work overlap with the main queue - but that's an advanced topic, and not something to reach for by default.
