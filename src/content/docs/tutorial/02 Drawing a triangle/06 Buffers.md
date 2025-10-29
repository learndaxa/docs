---
title: Buffers
description: Buffers
slug: "tutorial/drawing-a-triangle/buffers"
---

## General

When uploading data to the GPU, OpenGL used target-specific buffer targets (Vertex Object/Array Buffers, etc.). Daxa uses bindless buffers instead. This means a buffer isn't bound to one target only. One buffer can be used in all of these different bind targets and there is therefore only one buffer 'type'.

To create a buffer, we simply need the device the memory should be allocated on as well as the allocation size.

To allocate the data needed for our triangle vertex data we can simply create a new buffer:

```cpp
auto buffer_id = device.create_buffer({
    .size = sizeof(MyVertex) * 3,
    .name = "my vertex data",
});
```

## Uploading to Buffers

To upload to a buffer in daxa, you query the buffers host pointer. Not all buffers have a host pointer, make sure to set either `MemoryFlagBits::HOST_ACCESS_SEQUENTIAL_WRITE` or `MemoryFlagBits::HOST_ACCESS_RANDOM` as `.allocate_info` when creating the buffer:

```cpp
auto buffer_id = device.create_buffer({
    .size = sizeof(MyVertex) * 3,
    .allocate_info = MemoryFlagBits::HOST_ACCESS_SEQUENTIAL_WRITE,
    .name = "my vertex data",
});
```

* Use `MemoryFlagBits::HOST_ACCESS_SEQUENTIAL_WRITE` for buffers that require fast reads on the gpu and host writes. This type is suboptimal for host readback. Its typically in device vram.
* Use `MemoryFlagBits::HOST_ACCESS_RANDOM` for buffers that do not need fast access on the gpu but random cpu write and read access. This type is optimal for readback. Its typically in host ram.

Uploading any data itself is then done via direct writes or a memcpy like so:

```cpp
std::array<MyVertex, 3> * vert_buf_ptr = device.buffer_host_address_as<std::array<MyVertex, 3>>(buffer_id).value();
*vert_buf_ptr = std::array{
    MyVertex{.position = {-0.5f, +0.5f, 0.0f}, .color = {1.0f, 0.0f, 0.0f}},
    MyVertex{.position = {+0.5f, +0.5f, 0.0f}, .color = {0.0f, 1.0f, 0.0f}},
    MyVertex{.position = {+0.0f, -0.5f, 0.0f}, .color = {0.0f, 0.0f, 1.0f}},
};~
```