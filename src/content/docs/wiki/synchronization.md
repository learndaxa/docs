---
title: Synchronization
description: Pipeline barriers, image barriers, semaphores, multi-queue sync, and submit indices in Daxa
slug: wiki/synchronization
---

## Description

GPUs execute work out of order and overlapped across many pipeline stages. Whenever one piece of GPU work depends on the result of another - a shader reading what a previous shader wrote, a copy reading what an upload wrote, a present that must wait for rendering to finish - that dependency has to be expressed explicitly, or the GPU may run the two pieces of work in the wrong order (or at the same time) and produce garbage.

This page covers Daxa's manual synchronization primitives: pipeline barriers, image barriers, binary semaphores, timeline semaphores, and submit indices.

> If you use [TaskGraph](/wiki/taskgraph/), you generally don't need any of this - TaskGraph automatically inserts all required pipeline barriers, image layout transitions, and cross-queue semaphores for you based on how you declare each task's resource usages. This page is useful when you record commands manually, which is in many cases its still easier/ more convenient.

## Pipeline Barriers

A pipeline barrier tells the GPU: "don't let work in `dst_access` start touching this data until work in `src_access` has finished writing/reading it." It's how you fix read-after-write, write-after-read, and write-after-write hazards between commands in the same command list.

```cpp
// A compute shader wrote to a buffer; make sure that write is visible
// before a later fragment shader reads the same buffer.
recorder.pipeline_barrier({
    .src_access = daxa::AccessConsts::COMPUTE_SHADER_WRITE,
    .dst_access = daxa::AccessConsts::FRAGMENT_SHADER_READ,
});
```

```cpp
// A transfer wrote to a buffer; make sure it's visible to a subsequent
// readback copy from that buffer.
recorder.pipeline_barrier({
    .src_access = daxa::AccessConsts::TRANSFER_WRITE,
    .dst_access = daxa::AccessConsts::TRANSFER_READ,
});
```

Successive `pipeline_barrier`/`pipeline_image_barrier` calls are batched together and flushed as a single `vkCmdPipelineBarrier2` as soon as a non-barrier command is recorded - so you can call this as often as needed without worrying about extra driver calls.

## Image Barriers

Images need everything a buffer barrier needs (`src_access`/`dst_access`), plus an image layout transition - GPUs store images in different memory layouts depending on how they're being used (e.g. as a render target vs. a sampled texture vs. a present source), and switching usages can require switching layouts.

```cpp
recorder.pipeline_image_barrier({
    .dst_access = daxa::AccessConsts::COLOR_ATTACHMENT_OUTPUT_READ_WRITE,
    .image = render_target,
    .layout_operation = daxa::ImageLayoutOperation::TO_GENERAL,
});

// ... render into render_target ...

recorder.pipeline_image_barrier({
    .src_access = daxa::AccessConsts::COLOR_ATTACHMENT_OUTPUT_READ_WRITE,
    .image = swapchain_image,
    .layout_operation = daxa::ImageLayoutOperation::TO_PRESENT_SRC,
});
```

### Why the two remaining transitions exist

Even though Daxa images otherwise live in `GENERAL`, `TO_GENERAL` and `TO_PRESENT_SRC` still exist because they reflect real hardware/OS requirements, not leftover Vulkan layout bookkeeping:

- **`TO_GENERAL`**: when an image is created, it starts out in the `UNDEFINED` layout - an invalid state representing uninitialized memory. GPU image hardware needs every image to be initialized once (transitioned out of `UNDEFINED`) before it can be read or written correctly. **This is not a clear operation** - it usually just sets up some internal metadata for the image; the actual pixel data is typically still whatever garbage was already in memory. So after `TO_GENERAL`, the image becomes *usable*, but its contents are still undefined until you write or clear it yourself.
- **`TO_PRESENT_SRC`**: the OS/windowing system requires swapchain images to be in the `PRESENT_SRC` layout before `present_frame` can hand them to the compositor - this is an OS interface format, not a GPU-side optimization, so it can't be skipped. If a presented swapchain image is used again afterwards (e.g. re-acquired next frame), it must be transitioned back to `TO_GENERAL` before that use, exactly like a freshly created image.

### Vulkan analogue

In Vulkan, every usage change of an image typically needs a `VkImageMemoryBarrier2` specifying `oldLayout`, `newLayout`, `srcQueueFamilyIndex`/`dstQueueFamilyIndex`, and a `VkImageSubresourceRange` (aspect mask, mip levels, array layers) on top of the stage/access masks. Keeping track of which layout each image (and each subresource!) is currently in, and picking the "correct" optimal layout for every usage, is a major source of Vulkan bugs.

(As a side note, aspect flags are abstracted away too - Daxa infers the correct aspect mask from the image's format, so you never have to pass `VK_IMAGE_ASPECT_COLOR_BIT`/`DEPTH_BIT`/`STENCIL_BIT` yourself.)

Daxa sidesteps almost all of this by keeping every image in the `GENERAL` layout at all times. `daxa::ImageLayoutOperation` only has two non-trivial values:

- `TO_GENERAL` - the one-time transition every image needs before its first use.
- `TO_PRESENT_SRC` - required before presenting a swapchain image.

`ImageBarrierInfo` is just `BarrierInfo` plus an `ImageId` and one of these two operations - no subresource ranges, no queue family ownership transfers, no layout bookkeeping. This gives up a small amount of the layout-specific optimization Vulkan allows for, in exchange for a synchronization model that's actually tractable to get right.

Note that "no explicit layouts" doesn't mean the GPU stores image data identically regardless of usage - modern GPUs still keep e.g. render targets and sampled textures in different, usage-specific (often compressed) memory representations internally. The difference is that current hardware can convert between these representations on the fly, without the driver needing an explicit transition command. Nvidia and Intel GPUs never really needed Vulkan's layout transitions for this, and most modern AMD GPUs (RDNA4 and later) handle it automatically in hardware too now. Since the hardware has caught up, Daxa opted to drop explicit layouts entirely rather than keep modeling a restriction that's increasingly just a historical artifact.

## Binary Semaphores

Binary semaphores are a GPU-to-GPU sync primitive: one submission *signals* them when it finishes, another *waits* on them before it starts. They live entirely on the GPU timeline - the CPU can't query or wait on their state.

```cpp
daxa::BinarySemaphore transfer_done = device.create_binary_semaphore({.name = "transfer done"});

device.submit_commands({
    .command_lists = std::array{upload_cmd_list},
    .signal_binary_semaphores = std::array{transfer_done},
});

device.submit_commands({
    .command_lists = std::array{compute_cmd_list},
    .wait_binary_semaphores = std::array{transfer_done},
});
```

A binary semaphore must be waited on exactly once after being signaled before it can be signaled again - this makes them awkward for anything beyond simple one-shot hand-offs, which is exactly what timeline semaphores are for.

## Timeline Semaphores

A timeline semaphore is a monotonically increasing 64-bit counter. Submissions signal it to a specific value, and other submissions (or the CPU) wait until it *reaches* a value:

```cpp
daxa::TimelineSemaphore timeline = device.create_timeline_semaphore({
    .initial_value = 0,
    .name = "render timeline",
});

device.submit_commands({
    .command_lists = std::array{cmd_list},
    .signal_timeline_semaphores = std::array{std::pair{timeline, u64{1}}},
});

// The CPU can wait on it too:
timeline.wait_for_value(1);
```

Unlike binary semaphores, a timeline semaphore can be signaled and waited on any number of times for increasing values, can represent multiple in-flight frames at once, and can be inspected/waited on from the CPU (`value()`, `wait_for_value()`).

### Why binary semaphores still exist

Given how much more flexible timeline semaphores are, you might wonder why Daxa has binary semaphores at all. The reason is a Vulkan restriction: `vkAcquireNextImageKHR` and `vkQueuePresentKHR` only accept binary semaphores (and fences) - not timeline semaphores. Since acquiring and presenting swapchain images is unavoidable, Daxa's `Swapchain` exposes `current_acquire_semaphore()` and `current_present_semaphore()` as binary semaphores for exactly these two calls, alongside `current_timeline_pair()` (a timeline semaphore + target value) for synchronizing everything else with the rest of your frame.

## Multi-Queue Sync with Timeline Semaphores

Daxa exposes a main queue plus several compute and transfer queues (`daxa::QUEUE_MAIN`, `QUEUE_COMPUTE_0`..`QUEUE_COMPUTE_3`, `QUEUE_TRANSFER_0`/`QUEUE_TRANSFER_1`). Each `submit_commands` call takes a `.queue`, and a timeline semaphore can synchronize submissions across different queues:

```cpp
daxa::TimelineSemaphore upload_done = device.create_timeline_semaphore({.name = "upload done"});

// Upload new data on a transfer queue.
device.submit_commands({
    .queue = daxa::QUEUE_TRANSFER_0,
    .command_lists = std::array{upload_cmd_list},
    .signal_timeline_semaphores = std::array{std::pair{upload_done, u64{1}}},
});

// Process it on the main queue, once the upload is done.
device.submit_commands({
    .queue = daxa::QUEUE_MAIN,
    .command_lists = std::array{compute_cmd_list},
    .wait_timeline_semaphores = std::array{std::pair{upload_done, u64{1}}},
});
```

## A Simple Multi-Queue Example

A small render pipeline - upload on a transfer queue, process on a compute queue, then render and present on the main queue - chained together with a single shared timeline semaphore used as a per-frame counter:

```cpp
daxa::TimelineSemaphore frame_timeline = device.create_timeline_semaphore({.name = "frame timeline"});
u64 t = 0;

// 1. Upload this frame's data on the transfer queue.
device.submit_commands({
    .queue = daxa::QUEUE_TRANSFER_0,
    .command_lists = std::array{upload_cmd_list},
    .signal_timeline_semaphores = std::array{std::pair{frame_timeline, ++t}}, // t == 1
});

// 2. Process the uploaded data on a compute queue, once the upload finished.
device.submit_commands({
    .queue = daxa::QUEUE_COMPUTE_0,
    .command_lists = std::array{compute_cmd_list},
    .wait_timeline_semaphores = std::array{std::pair{frame_timeline, t}},     // wait for t == 1
    .signal_timeline_semaphores = std::array{std::pair{frame_timeline, ++t}}, // t == 2
});

// 3. Render the result on the main queue, once compute finished, then present.
device.submit_commands({
    .queue = daxa::QUEUE_MAIN,
    .command_lists = std::array{render_cmd_list},
    .wait_timeline_semaphores = std::array{std::pair{frame_timeline, t}}, // wait for t == 2
    .wait_binary_semaphores = std::array{swapchain.current_acquire_semaphore()},
    .signal_binary_semaphores = std::array{swapchain.current_present_semaphore()},
    .signal_timeline_semaphores = std::array{swapchain.current_timeline_pair()},
});

device.present_frame({
    .wait_binary_semaphores = std::array{swapchain.current_present_semaphore()},
    .swapchain = swapchain,
});
```

Each stage waits for the previous stage's value on `frame_timeline` and signals its own - a single semaphore acts as a version counter for the whole pipeline. The final submit additionally hands off to the swapchain's binary semaphores, as covered above.

## Running Two Queues in Parallel

Multi-queue isn't just for chaining work end-to-end - it's also useful for running independent work *at the same time*. A classic example is a shadow pass and an SSAO pass after a depth prepass: the depth prepass fills the depth (and normal) buffer on `QUEUE_MAIN`, and both the shadow pass (raster, `QUEUE_MAIN`) and the SSAO pass (compute, `QUEUE_COMPUTE_0`) read from it. Neither the shadow pass nor the SSAO pass depends on the other, so once the depth prepass is done, they can run concurrently - both just need to finish before the lighting/composite pass, which reads the shadow map and the new AO buffer.

```cpp
daxa::TimelineSemaphore depth_done = device.create_timeline_semaphore({.name = "depth prepass done"});
daxa::TimelineSemaphore shadow_done = device.create_timeline_semaphore({.name = "shadow pass done"});
daxa::TimelineSemaphore ssao_done = device.create_timeline_semaphore({.name = "ssao pass done"});

// Depth prepass on the main queue - fills the depth/normal buffers everything else reads from.
device.submit_commands({
    .queue = daxa::QUEUE_MAIN,
    .command_lists = std::array{depth_prepass_cmd_list},
    .signal_timeline_semaphores = std::array{std::pair{depth_done, u64{1}}},
});

// Shadow pass on the main queue (raster work requires QUEUE_MAIN).
device.submit_commands({
    .queue = daxa::QUEUE_MAIN,
    .command_lists = std::array{shadow_cmd_list},
    .wait_timeline_semaphores = std::array{std::pair{depth_done, u64{1}}},
    .signal_timeline_semaphores = std::array{std::pair{shadow_done, u64{1}}},
});

// SSAO pass on a compute queue, reading the depth/normal buffers from the prepass.
// It has no dependency on the shadow pass and can run in parallel with it.
device.submit_commands({
    .queue = daxa::QUEUE_COMPUTE_0,
    .command_lists = std::array{ssao_cmd_list},
    .wait_timeline_semaphores = std::array{std::pair{depth_done, u64{1}}},
    .signal_timeline_semaphores = std::array{std::pair{ssao_done, u64{1}}},
});

// Lighting/composite pass on the main queue needs both results.
device.submit_commands({
    .queue = daxa::QUEUE_MAIN,
    .command_lists = std::array{lighting_cmd_list},
    .wait_timeline_semaphores = std::array{
        std::pair{shadow_done, u64{1}},
        std::pair{ssao_done, u64{1}},
    },
});
```

Note that the wait on `depth_done` for the shadow pass, and the wait on `shadow_done` for the lighting pass, are technically redundant here - both pairs of submissions are on `QUEUE_MAIN`, and submissions to the same queue always execute in submission order, just like in Vulkan. They're included anyway for clarity, and so the dependencies stay correct if any of these passes is ever moved to its own queue. The waits on `depth_done` for the SSAO pass and on `ssao_done` for the lighting pass are the ones that actually matter, since they cross from `QUEUE_MAIN` to `QUEUE_COMPUTE_0` and back.

## Submit Indices

Submit indices are Daxa's newest synchronization feature, and the simplest one. Every call to `device.submit_commands` returns a `u64` submit index that is unique and monotonically increasing across the whole device. Internally, each queue also tracks its own latest submit index via an internal timeline semaphore - you can query it with `device.latest_queue_submit_index(queue)`.

You can make a submission wait for a specific submit index on another queue directly, with no semaphore object at all:

```cpp
u64 const upload_submit = device.submit_commands({
    .queue = daxa::QUEUE_TRANSFER_0,
    .command_lists = std::array{upload_cmd_list},
});

u64 const compute_submit = device.submit_commands({
    .queue = daxa::QUEUE_COMPUTE_0,
    .command_lists = std::array{compute_cmd_list},
    .wait_queue_submit_indices = std::array{std::pair{daxa::QUEUE_TRANSFER_0, upload_submit}},
});

device.submit_commands({
    .queue = daxa::QUEUE_MAIN,
    .command_lists = std::array{render_cmd_list},
    .wait_queue_submit_indices = std::array{std::pair{daxa::QUEUE_COMPUTE_0, compute_submit}},
});
```

The CPU can wait on a submit index too:

```cpp
device.wait_on_submit({
    .queue = daxa::QUEUE_COMPUTE_0,
    .queue_submit_index = compute_submit,
});
```

And `device.latest_submit_index()` / `device.oldest_pending_submit_index()` give you device-wide progress, which is what `device.collect_garbage()` uses internally to know when zombified SROs are safe to destroy.

### Why this is useful

Submit indices give you cross-queue and CPU/GPU sync without ever creating, naming, storing, resetting, or destroying a semaphore object. A `u64` returned from `submit_commands` is all you need to either make another submission wait on that work, or to wait for it yourself on the CPU. For most "wait until the GPU is done with X" needs, this replaces what used to require a dedicated timeline semaphore - simpler to use correctly, and nothing extra to keep alive.

## Building Your Own Deferred Destruction

Daxa's zombie/`collect_garbage()` mechanism (see [Deferred destruction](/wiki/buffers-images-acceleration-structures/#deferred-destruction---zombies)) is really just an application of submit indices: when an SRO is destroyed, Daxa remembers the current submit index, and only actually frees it once `device.oldest_pending_submit_index()` has moved past that point - i.e. once every queue has finished all work that was in flight at the time of destruction.

You can use the exact same pattern for your own CPU-side resources - staging buffers you recycle, CPU-side mesh/texture upload data, descriptor-less resource pools, anything that some in-flight command list might still be reading from:

> To be very clear, this is very advanced usage for niche cases! Do not use this for all your frame in flight resources, daxa takes care of nearly all these cases automatically.

```cpp
struct PendingFree
{
    u64 retire_index;
    std::vector<std::byte> data;
};

std::deque<PendingFree> pending_frees;

// After submitting commands that read from `staging`, retire it instead of freeing it directly:
u64 const submit_index = device.submit_commands({
    .command_lists = std::array{upload_cmd_list},
});

pending_frees.push_back({.retire_index = submit_index, .data = std::move(staging)});

// Once per frame (e.g. alongside device.collect_garbage()):
u64 const done_index = device.oldest_pending_submit_index();
while (!pending_frees.empty() && pending_frees.front().retire_index <= done_index)
{
    pending_frees.pop_front(); // safe to destroy/reuse - the GPU is done with it
}
```

Because `oldest_pending_submit_index()` is the minimum over *all* queues, this is the simplest correct check when a resource could have been touched by any queue. If you know a resource was only ever used on one specific queue, `device.latest_queue_submit_index(queue)` (or a CPU-side `device.wait_on_submit`) lets you check or wait on just that queue instead. Either way, the bookkeeping is just a `u64` per resource - no fences, no semaphores, no per-resource sync objects.
