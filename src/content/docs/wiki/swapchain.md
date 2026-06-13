---
title: Swapchain
description: Swapchain creation, present modes, and frame synchronization in Daxa
slug: wiki/swapchain
---

## Description

A swapchain is the bridge between your rendering and the display: a small set of GPU images that your application renders into, which the windowing system then shows on screen one after another. Daxa's `daxa::Swapchain` bundles together everything you need to use that bridge:

- the presentable images themselves, tied to your window/surface
- the present mode (and the ability to change it at runtime)
- the synchronization primitives needed to safely hand images back and forth between your rendering and the display, including the bookkeeping for how many frames may be "in flight" at once

Bundling all of this into one object is convenient: instead of separately tracking a surface, a list of images, and a set of per-frame semaphores yourself, `daxa::Swapchain` owns all of it, and exposes exactly the handful of functions you need once per frame.

## Creating a Swapchain

```cpp
daxa::Swapchain swapchain = device.create_swapchain({
    .native_window_info = window.get_native_window_info(),
    .surface_format = device.choose_swapchain_surface_format({
        .native_window_info = window.get_native_window_info(),
    }),
    .present_mode = daxa::PresentMode::FIFO,
    .present_operation = daxa::PresentOp::IDENTITY,
    .image_usage = daxa::ImageUsageFlagBits::TRANSFER_DST,
    .max_allowed_frames_in_flight = 2,
    .queue_type = daxa::QueueType::MAIN,
    .name = "my swapchain",
});
```

- `.native_window_info`: connects the swapchain to your OS window/surface. This comes from your windowing library - see [Creating a Window](/tutorial/drawing-a-triangle/creating-a-window/) for how to obtain it from GLFW.
- `.surface_format`: a `daxa::SurfaceFormat`, which pairs a `daxa::Format` (e.g. `B8G8R8A8_SRGB`) with a `daxa::ColorSpace`. `device.choose_swapchain_surface_format({...})` picks a sensible default supported by your surface; pass `.preferred_formats` (ordered most to least preferred) if you care which one is chosen.
- `.present_mode`: how rendered images are handed off to the display. Defaults to `FIFO`. See [Present Modes](#present-modes) below.
- `.present_operation`: a transform (rotation/mirroring) the presentation engine applies to the image before showing it. Defaults to `IDENTITY` (no transform), which is correct for almost all desktop setups - this mainly matters on mobile/embedded displays that are physically mounted in a rotated orientation.
- `.image_usage`: usage flags for the swapchain images, same as for any other image (see [Buffers, Images & Acceleration Structures](/wiki/buffers-images-acceleration-structures/)). `TRANSFER_DST` is enough to `clear_image`/`copy_image_to_image` into the swapchain image; add `COLOR_ATTACHMENT` if you want to render into it directly with a raster pipeline.
- `.max_allowed_frames_in_flight`: how many frames the CPU is allowed to get ahead of the GPU. Defaults to `2`. See [Frames in Flight](#frames-in-flight) below.
- `.queue_type`: which queue presents the swapchain images. Defaults to `daxa::QueueType::MAIN`.
- `.name`: debug name, shown in validation messages and tools like RenderDoc.

## Present Modes

The present mode controls how your rendered images make their way to the screen:

| mode | meaning |
| --- | --- |
| `daxa::PresentMode::IMMEDIATE` | Images are shown the moment they're submitted, which may cause visible tearing. |
| `daxa::PresentMode::FIFO` | A first-in-first-out queue: the display takes the front image at each "vertical blank" (screen refresh), and your application pushes new images onto the back. If the queue is full, your application has to wait. This is most similar to vertical sync in modern games, and is the recommended default. |
| `daxa::PresentMode::FIFO_RELAXED` | Like `FIFO`, but if your application is late and the queue was empty at the last vertical blank, the next image is shown immediately instead of waiting for the following blank. This can cause tearing, but only when you're already missing your frame deadline. |
| `daxa::PresentMode::MAILBOX` | Like `FIFO`, but instead of blocking when the queue is full, the queued image is replaced with the newest one. Lets you render as fast as possible without tearing - often called "triple buffering" - at the cost of wasted rendering work for frames that never get shown. Has limited support on AMD. |

You can change the present mode at runtime:

```cpp
swapchain.set_present_mode(daxa::PresentMode::MAILBOX);
```

> `set_present_mode` recreates the underlying swapchain and **waits for the device to go idle**, so only call it in response to a deliberate user setting change - not every frame. It also invalidates any `ImageId`s previously returned by `acquire_next_image()`.

## Resizing

When the window's size changes, the swapchain's images no longer match the surface and need to be recreated at the new size:

```cpp
if (window.swapchain_out_of_date)
{
    swapchain.resize();
    window.swapchain_out_of_date = false;
}
```

Like `set_present_mode`, `resize()` recreates the swapchain, **waits for the device to go idle**, and invalidates previously acquired `ImageId`s - so only call it when the window has actually been resized (e.g. via the resize callback set up in [Creating a Window](/tutorial/drawing-a-triangle/creating-a-window/)).

A few read-only queries are useful after a resize (or at any time):

```cpp
daxa::Extent2D extent = swapchain.get_surface_extent(); // current width/height
daxa::Format format = swapchain.get_format();           // matches .surface_format.format
daxa::ColorSpace color_space = swapchain.get_color_space();
daxa::SwapchainInfo const & info = swapchain.info();     // the full info used to create it
```

## Acquiring and Presenting Images

Each frame, you acquire one of the swapchain's images, render into it, and present it:

```cpp
daxa::ImageId swapchain_image = swapchain.acquire_next_image();
if (swapchain_image.is_empty())
{
    // The swapchain is out of date (e.g. the window was minimized or
    // resized between frames) - skip this frame.
    continue;
}

// ... record commands that render into swapchain_image ...

device.present_frame({
    .wait_binary_semaphores = std::array{swapchain.current_present_semaphore()},
    .swapchain = swapchain,
});
```

`acquire_next_image()` may return an empty `ImageId` (`is_empty() == true`) if the swapchain can't currently provide an image - simply skip the frame and try again next iteration.

## Synchronizing a Frame

Acquiring and presenting are hand-offs between your rendering and the display: the display needs to know when the GPU is done rendering before it shows an image, and the GPU needs to know when the display is done showing an image before rendering into it again. The swapchain exposes the semaphores that express these hand-offs, and `submit_commands`/`present_frame` are where you plug them in.

```cpp
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
```

- **`current_acquire_semaphore()`**: a binary semaphore that the display signals once the image returned by `acquire_next_image()` is actually free to be rendered into. The *first* submission that touches the acquired image must wait on this.
- **`current_present_semaphore()`**: a binary semaphore that your rendering must signal once it's done with the image, and that `present_frame` waits on before showing it. The *last* submission that touches the acquired image must signal this, and `present_frame` must wait on it.
- **`current_timeline_pair()`**: a `(TimelineSemaphore, u64)` pair used purely for [frames-in-flight](#frames-in-flight) bookkeeping - explained below. The *last* submission that touches the acquired image must signal it.

If you only submit once per frame (as in the example above), that one submission is both the "first" and "last" submission, so it waits on the acquire semaphore and signals both the present semaphore and the timeline pair. If you split a frame's swapchain-image work across multiple submissions, only the first needs to wait on the acquire semaphore, and only the last needs to signal the present semaphore and timeline pair.

Both `current_acquire_semaphore()` and `current_present_semaphore()` may return a *different* semaphore object after each `acquire_next_image()` call - always re-query them rather than caching the result across frames. For more on binary vs. timeline semaphores in general (and why the swapchain specifically needs binary ones), see [Synchronization](/wiki/synchronization/#why-binary-semaphores-still-exist).

## Frames in Flight

"Frames in flight" refers to how many frames' worth of work the CPU is allowed to record and submit before the GPU has finished the oldest of them. Some slack here is good - it lets the CPU keep preparing the next frame while the GPU works through the previous one - but unlimited slack means the CPU could race ahead indefinitely, piling up memory for images, buffers and command lists that are all still queued behind GPU work.

The swapchain tracks this with two numbers: a CPU-side counter that increments every time `acquire_next_image()` succeeds, and a GPU-side `TimelineSemaphore` that your last submission for each frame signals via `current_timeline_pair()`. The gap between these two numbers is exactly how many frames are currently in flight.

```cpp
daxa::TimelineSemaphore const & gpu_timeline = swapchain.gpu_timeline_semaphore();
u64 cpu_value = swapchain.current_cpu_timeline_value();
```

`acquire_next_image()` calls `wait_for_next_frame()` internally, which blocks the CPU until the GPU timeline has caught up to within `.max_allowed_frames_in_flight` of the CPU counter. So as long as you signal `current_timeline_pair()` correctly each frame (as shown above), the swapchain automatically paces your main loop - no extra code needed. You can also call `swapchain.wait_for_next_frame()` yourself if you want to wait for a free frame slot *before* doing other per-frame CPU work, ahead of calling `acquire_next_image()`.

This is the main benefit of bundling frames-in-flight handling with the swapchain: without it, you'd need to maintain your own ring of semaphores/fences sized by `max_allowed_frames_in_flight`, match each one up with the right swapchain image, and remember to wait on the right slot before reusing per-frame resources. With `daxa::Swapchain`, that ring buffer and its indexing are entirely internal - you just acquire, submit (signaling the three semaphores above), and present.

## Full Example: A Frame Loop

Putting it all together, a typical main loop looks like this:

```cpp
while (!window.should_close())
{
    window.update();

    if (window.swapchain_out_of_date)
    {
        swapchain.resize();
        window.swapchain_out_of_date = false;
    }

    daxa::ImageId swapchain_image = swapchain.acquire_next_image();
    if (swapchain_image.is_empty())
    {
        continue;
    }

    daxa::CommandRecorder recorder = device.create_command_recorder({.name = "frame recorder"});

    // Daxa images start out in an undefined layout and must be transitioned
    // to GENERAL before their first use - see [Synchronization](/wiki/synchronization/).
    recorder.pipeline_image_barrier({
        .dst_access = daxa::AccessConsts::COLOR_ATTACHMENT_OUTPUT_READ_WRITE,
        .image = swapchain_image,
        .layout_operation = daxa::ImageLayoutOperation::TO_GENERAL,
    });

    // ... render into swapchain_image here (e.g. via a renderpass) ...

    // Swapchain images must be transitioned to PRESENT_SRC before presenting.
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

    // Reclaim resources the GPU has finished with - see [Buffers, Images & Acceleration Structures](/wiki/buffers-images-acceleration-structures/#deferred-destruction---zombies).
    device.collect_garbage();
}
```

Every piece here maps to one of the sections above: `resize()` keeps the swapchain matching the window, `acquire_next_image()`/`present_frame()` are the hand-off points with the display, the three semaphores synchronize that single submission with both the display and the frames-in-flight counter, and `collect_garbage()` lets the device free anything that the now-completed GPU work was holding onto.
