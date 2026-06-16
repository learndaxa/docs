---
title: Buffer / Texture Upload & Mip Map Generation
description: Uploading data to buffers and images via staging buffers, and generating mip chains with blit_image_to_image
slug: wiki/buffer-texture-upload-and-mipmaps
---

## Description

CPU-written data usually can't go straight into the memory the GPU reads fastest from. This page covers the two ways to get data onto the GPU - writing directly into a host-mapped buffer, or going through a staging buffer and a copy - and then uses the same staging pattern to upload texture data and generate a mip chain with `blit_image_to_image`.

This builds on [Command Recording & Submission](/wiki/command-recording/) and [Synchronization](/wiki/synchronization/) - see those pages for more detail on `CommandRecorder`, `pipeline_barrier`, and `pipeline_image_barrier`. See [Buffers, Images & Acceleration Structures](/wiki/buffers-images-acceleration-structures/) for the full `BufferInfo`/`ImageInfo` creation parameters used below.

## Uploading to a Buffer

### Directly via a host-mapped buffer

A buffer created with `daxa::MemoryFlagBits::HOST_ACCESS_SEQUENTIAL_WRITE` gives you a CPU pointer via `device.buffer_host_address_as<T>()`. Writes through this pointer are visible to the GPU without any copy command:

```cpp
daxa::BufferId buffer = device.create_buffer({
    .size = sizeof(MyData),
    .memory_flags = daxa::MemoryFlagBits::HOST_ACCESS_SEQUENTIAL_WRITE,
    .name = "my data buffer",
});

MyData * ptr = device.buffer_host_address_as<MyData>(buffer).value();
*ptr = my_data;
```

This memory typically lives in VRAM that is also CPU-writable. On any GPU with Resizable BAR (ReBAR) - which is effectively all current desktop GPUs - this means the *entire* VRAM allocation can be mapped and written by the CPU like this, not just a small dedicated pool. This is the simplest option and great for small, frequently-updated data (per-frame uniforms, push-constant-sized data, etc.).

That said, ReBAR memory can still come with a small perf cost on some GPUs/drivers: depending on how the driver backs ReBAR-mapped allocations, GPU-side reads from it can be slightly slower than from a non-CPU-visible allocation, and the CPU-visible pool may still be sized/allocated differently under the hood even when the API reports it as "all of VRAM". For large, rarely-updated data where peak GPU read performance matters, it's still worth using a device-only buffer via the staging path below and measuring - the difference is usually small, but not always zero.

### Via a staging buffer

For larger or rarely-updated data, it's often better to put the data in a device-only buffer (no `memory_flags`, fastest possible GPU access, not CPU-writable) and get it there via a small, temporary, host-visible staging buffer:

```cpp
// Device-only buffer - fastest GPU access, not CPU-writable.
daxa::BufferId device_buffer = device.create_buffer({
    .size = sizeof(MyData),
    .name = "my device-only buffer",
});

// Staging buffer - CPU-writable, only used to shuttle data across.
daxa::BufferId staging_buffer = device.create_buffer({
    .size = sizeof(MyData),
    .memory_flags = daxa::MemoryFlagBits::HOST_ACCESS_SEQUENTIAL_WRITE,
    .name = "my staging buffer",
});

MyData * ptr = device.buffer_host_address_as<MyData>(staging_buffer).value();
*ptr = my_data;

daxa::CommandRecorder recorder = device.create_command_recorder({.name = "upload recorder"});

// Make sure the host write to the staging buffer is visible to the copy.
recorder.pipeline_barrier({
    .src_access = daxa::AccessConsts::HOST_WRITE,
    .dst_access = daxa::AccessConsts::TRANSFER_READ,
});

recorder.copy_buffer_to_buffer({
    .src_buffer = staging_buffer,
    .dst_buffer = device_buffer,
    .size = sizeof(MyData),
});

// Make the copy visible to whatever reads device_buffer next.
recorder.pipeline_barrier({
    .src_access = daxa::AccessConsts::TRANSFER_WRITE,
    .dst_access = daxa::AccessConsts::FRAGMENT_SHADER_READ,
});

device.submit_commands({
    .command_lists = std::array{recorder.complete_current_commands()},
});
```

The staging buffer must stay alive until the GPU has finished the copy - either wait on the returned submit index, or retire it using the [deferred destruction pattern](/wiki/synchronization/#building-your-own-deferred-destruction) from the synchronization page.

## Uploading Texture Data

Either way, the image itself looks the same: a freshly created image starts out in `UNDEFINED` and needs its one-time `TO_GENERAL` transition before it can be written to (see [Image Barriers](/wiki/synchronization/#image-barriers)).

```cpp
daxa::ImageId image = device.create_image({
    .format = daxa::Format::R8G8B8A8_SRGB,
    .size = {1024, 1024, 1},
    .mip_level_count = 11, // 1024 -> 1 inclusive
    .usage = daxa::ImageUsageFlagBits::TRANSFER_DST |
             daxa::ImageUsageFlagBits::TRANSFER_SRC | // needed as a blit source for mip generation
             daxa::ImageUsageFlagBits::SHADER_SAMPLED,
    .name = "example texture",
});
```

### Direct host image copy (optional)

`VK_EXT_host_image_copy` lets the CPU write directly into an image's memory and perform layout transitions from the host, with no command recorder, staging buffer, or submission at all - the image analogue of the direct buffer write above. Daxa exposes this as `device.copy_memory_to_image()` / `device.copy_image_to_memory()`, plus `device.image_layout_operation()` for host-side layout transitions:

```cpp
// One-time TO_GENERAL transition, done directly on the host.
device.image_layout_operation({
    .image = image,
    .layout_operation = daxa::ImageLayoutOperation::TO_GENERAL,
});

device.copy_memory_to_image({
    .memory_ptr = reinterpret_cast<std::byte const *>(pixels),
    .image = image,
    .image_slice = {.mip_level = 0},
    .image_extent = {1024, 1024, 1},
});
```

This is the simplest possible texture upload - but support for `VK_EXT_host_image_copy` is patchy. Many drivers don't support it, and even where the driver does, many tools like Nsight, RenderDoc, and RDA don't handle it properly. Because of this, Daxa treats host image copy as an **optional** feature: check `device.properties().implicit_features & daxa::ImplicitFeatureFlagBits::HOST_IMAGE_COPY` before relying on it, and fall back to the staging-buffer path below when it isn't available.

### Via a staging buffer

Images have no host-mapped equivalent for regular writes - there's no `HOST_ACCESS` flag for images - so without host image copy, texture data has to arrive via a staging buffer and `copy_buffer_to_image`, the same way as the device-only buffer above:

```cpp
usize const texture_size = 1024 * 1024 * 4; // RGBA8, mip 0 only

daxa::BufferId staging_buffer = device.create_buffer({
    .size = texture_size,
    .memory_flags = daxa::MemoryFlagBits::HOST_ACCESS_SEQUENTIAL_WRITE,
    .name = "texture staging buffer",
});

std::memcpy(device.buffer_host_address_as<std::byte>(staging_buffer).value(), pixels, texture_size);

daxa::CommandRecorder recorder = device.create_command_recorder({.name = "texture upload recorder"});

// One-time transition out of UNDEFINED before the image's first use.
recorder.pipeline_image_barrier({
    .dst_access = daxa::AccessConsts::TRANSFER_WRITE,
    .image = image,
    .layout_operation = daxa::ImageLayoutOperation::TO_GENERAL,
});

// Make sure the host write to the staging buffer is visible to the copy.
recorder.pipeline_barrier({
    .src_access = daxa::AccessConsts::HOST_WRITE,
    .dst_access = daxa::AccessConsts::TRANSFER_READ,
});

recorder.copy_buffer_to_image({
    .src_buffer = staging_buffer,
    .dst_image = image,
    .image_slice = {.mip_level = 0},
    .image_extent = {1024, 1024, 1},
});
```

At this point only mip level 0 has data - the rest of the mip chain still needs to be generated.

## Generating Mip Maps

`blit_image_to_image` copies between two image regions, optionally rescaling with a filter - which makes it a convenient way to downsample one mip level into the next. Each iteration blits the previous (larger) mip into the current (half-sized) one, with `daxa::Filter::LINEAR` to average neighboring pixels:

```cpp
// Make mip 0's upload visible to the first blit, which reads it as a source.
recorder.pipeline_image_barrier({
    .src_access = daxa::AccessConsts::TRANSFER_WRITE,
    .dst_access = daxa::AccessConsts::TRANSFER_READ,
    .image = image,
});

daxa::Extent3D mip_size = {1024, 1024, 1};
for (u32 mip = 1; mip < 11; ++mip)
{
    daxa::Extent3D const src_size = mip_size;
    mip_size = {std::max(mip_size.x / 2, 1u), std::max(mip_size.y / 2, 1u), 1};

    recorder.blit_image_to_image({
        .src_image = image,
        .dst_image = image,
        .src_slice = {.mip_level = mip - 1},
        .src_offsets = {{{0, 0, 0}, {static_cast<i32>(src_size.x), static_cast<i32>(src_size.y), 1}}},
        .dst_slice = {.mip_level = mip},
        .dst_offsets = {{{0, 0, 0}, {static_cast<i32>(mip_size.x), static_cast<i32>(mip_size.y), 1}}},
        .filter = daxa::Filter::LINEAR,
    });

    // Make this level's write visible to the next blit, which reads it as a source.
    recorder.pipeline_image_barrier({
        .src_access = daxa::AccessConsts::TRANSFER_WRITE,
        .dst_access = daxa::AccessConsts::TRANSFER_READ,
        .image = image,
    });
}

device.submit_commands({
    .command_lists = std::array{recorder.complete_current_commands()},
});
```

`src_image` and `dst_image` can be the same `ImageId` here because `src_slice`/`dst_slice` select different mip levels of it - source and destination never overlap. The barrier between iterations is required because each blit both reads the mip written by the previous iteration and writes a new one; without it, the GPU could run these blits out of order or overlapped and read a partially-written mip.

This is the cheap, hardware-accelerated way to build a mip chain. If you need a different downsampling filter (e.g. a Gaussian blur, or one that handles alpha/normal maps specially), do the same thing with a compute shader dispatch per mip level instead of `blit_image_to_image`, with a `pipeline_barrier` between dispatches in place of the image barriers above - see [Command Recording & Submission: Compute Dispatch](/wiki/command-recording/#compute-dispatch).

Once uploaded, see [Shader Integration](/wiki/shader-integration/#bindless-access-images--buffers) for sampling the image via its bindless `ImageViewId`, and [Pipelines](/wiki/pipelines/#color-attachments-and-blending) for using it as a render attachment instead of a sampled texture.

## Host Writes vs. GPU Copy Commands

Every upload path above is either a **host write** (the host-mapped buffer write, or `copy_memory_to_image`/`copy_image_to_memory`) or a **GPU copy command** (`copy_buffer_to_buffer`, `copy_buffer_to_image`, recorded and submitted like any other GPU work). Which one actually moves the data matters for both throughput and CPU/GPU overlap.

- **GPU copy commands run on the GPU's DMA engine(s)** and can typically reach a much higher fraction of the PCIe link's peak bandwidth than the CPU can drive through a mapped pointer. For large transfers, `copy_buffer_to_buffer`/`copy_buffer_to_image` is usually the faster way to move data across PCIe.
- **Host writes block the host while they happen.** A `memcpy` into a mapped pointer, or a call to `copy_memory_to_image`, is CPU work happening on the CPU's timeline - the CPU itself is doing the copy, rather than just recording a command for the GPU to execute later. This is the important distinction: it decides *who* spends time performing the copy, and *when* that time is spent.

This makes host writes attractive for getting data over **early**: a host write can complete before any GPU work for the frame has even been recorded, with no staging buffer, no submission, and no cross-queue synchronization - the data is simply there once the write returns. For small, latency-sensitive uploads (a handful of matrices, a small texture patch), this simplicity is often worth more than the bandwidth difference.

For large uploads, though, it's usually better to let the GPU's DMA engine perform the copy on the GPU timeline instead: write into a staging buffer (the host is fast at sequential writes), then record a copy command - ideally on a dedicated transfer queue (see [Multi-Queue Sync](/wiki/synchronization/#multi-queue-sync-with-timeline-semaphores)) so it runs alongside other GPU work. This keeps the CPU free to keep recording and submitting other work while the transfer happens in the background, and gets you closer to peak PCIe bandwidth for the transfer itself.

## Loading Directly Into a Reusable Staging Buffer

A common (and wasteful) pattern when loading assets is: allocate a regular CPU buffer, load/decode the asset into it, then `memcpy` that into a staging buffer for the GPU copy - that's a full CPU -> CPU copy in addition to the CPU -> GPU one.

Since a host-visible Daxa buffer's `buffer_host_address_as<T>()` pointer is just regular memory, you can load or decode asset data **directly into it**, skipping the intermediate CPU allocation and copy entirely. Keep one reusable staging buffer around (sized for your largest expected asset, or a fixed "upload budget") instead of allocating a fresh one per asset:

```cpp
daxa::BufferId staging_buffer = device.create_buffer({
    .size = 64 * 1024 * 1024, // reusable staging buffer, e.g. 64 MiB
    .memory_flags = daxa::MemoryFlagBits::HOST_ACCESS_RANDOM, // Fast Cpu accessible memory
    .name = "reusable staging buffer",
});

std::byte * staging_ptr = device.buffer_host_address_as<std::byte>(staging_buffer).value();

// Decode/load straight into GPU-visible memory - no intermediate CPU-side buffer.
load_texture_file("my_texture.png", staging_ptr, texture_size);

// ... then a single copy_buffer_to_image / copy_buffer_to_buffer, as shown above.
```

This turns "decode into RAM, `memcpy` RAM -> staging, GPU-copy staging -> VRAM" into "decode directly into staging, GPU-copy staging -> VRAM" - one fewer full-size copy, and one fewer CPU-side allocation. If you reuse the same staging buffer across many loads, make sure the previous load's GPU copy has finished before overwriting it - either wait on its submit index, or keep a small ring of staging buffers and rotate through them using the [deferred destruction](/wiki/synchronization/#building-your-own-deferred-destruction) pattern.

## TransferMemoryPool: A Ready-Made Reusable Staging Buffer

Sizing a reusable staging buffer, handing out offsets into it, and tracking via submit indices when old regions are safe to reuse is exactly what `daxa::TransferMemoryPool` does for you. It's declared in `<daxa/utils/mem.hpp>` (an alias for `daxa::RingBuffer`) and implements the staging buffer as a ring buffer: a single backing `BufferId` that allocations are handed out from linearly, wrapping around once old allocations have been reclaimed.

```cpp
#include <daxa/utils/mem.hpp>

daxa::TransferMemoryPool pool{daxa::TransferMemoryPoolInfo{
    .device = device,
    .capacity = 64 * 1024 * 1024, // 64 MiB ring buffer
    .name = "transfer pool",
}};
```

`prefer_device_memory` (true by default) controls where the backing buffer lives: `true` allocates GPU-local, CPU-visible memory (ReBAR) - the right choice for CPU -> GPU staging. Set it to `false` for CPU-local memory, which is more appropriate for a pool used for GPU -> CPU readback.

`pool.allocate(size, alignment)` returns an `Allocation` with a `host_address` to write into directly - the same "load straight into staging memory" pattern as above, except the pool decides where in the ring buffer your data goes:

```cpp
daxa::TransferMemoryPool::Allocation alloc = pool.allocate(texture_size, 16).value();

// Decode/load directly into the pool's memory.
load_texture_file("my_texture.png", alloc.host_address, texture_size);

recorder.copy_buffer_to_image({
    .src_buffer = pool.buffer(),
    .buffer_offset = alloc.buffer_offset,
    .dst_image = image,
    .image_slice = {.mip_level = 0},
    .image_extent = {1024, 1024, 1},
});
```

`alloc.device_address` is also useful for data that's read directly via a buffer pointer rather than copied (e.g. push-constant-sized per-draw data), and `pool.allocate_fill<T>(value)` is a shorthand for allocating `sizeof(T)` and immediately writing `value` into it.

This combination - a host pointer to write into plus a device address to hand to a shader, with no separate buffer to create or manage - also makes the pool a convenient stand-in for small "uniform buffers": per-pass data (a camera matrix, a handful of parameters) that changes every frame. Instead of creating and maintaining a dedicated `BufferId` for each pass (and dealing with double/triple-buffering it so this frame's writes don't clobber data the GPU is still reading for the previous frame), just `pool.allocate_fill(my_pass_data)` each time you need it and pass `alloc.device_address` to the shader.

The one thing to be careful of is that an allocation's lifetime is **much** more constrained than a regular buffer's: an `Allocation` is only valid for the commands submitted before the *next* `reuse_memory_after_pending_submits()` call. Don't hold on to an `Allocation`, its `host_address`, or its `device_address` beyond that, and don't expect to write into it once and read it across multiple frames - the underlying memory will be recycled for later allocations as soon as the ring buffer wraps around to it. Treat every allocation as strictly single-use and scoped to the commands you're about to submit.

Once per frame (or after submitting the commands that consume your allocations), call `pool.reuse_memory_after_pending_submits()`. This marks everything allocated so far as reclaimable once the GPU catches up - the same submit-index-based mechanism as [Building Your Own Deferred Destruction](/wiki/synchronization/#building-your-own-deferred-destruction), but built into the pool, and reclaimed space is automatically made available again for future `allocate()` calls. If you allocate faster than old regions can be reclaimed (i.e. you'd wrap into memory the GPU might still be using), `allocate()` simply returns `std::nullopt`.

For most projects, a single `TransferMemoryPool` is all you need as the one reusable staging buffer for per-frame uploads, texture loads, and readbacks alike.
