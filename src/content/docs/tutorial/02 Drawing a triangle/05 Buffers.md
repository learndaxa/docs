---
title: Buffers
description: Buffers
slug: "tutorial/drawing-a-triangle/buffers"
---

## General

When uploading data to the GPU, OpenGL used target-specific buffer targets (Vertex Object/Array Buffers, etc.). Daxa uses bindless buffers instead. This means a buffer isn't bound to one target only. One buffer can be used in all of these different bind targets and there is therefore only one buffer 'type'.

To create a buffer, we simply need the device the memory should be allocated on as well as the allocation size.

To allocate the data needed for our triangle vertex data we can simply create a new buffer:

```diff lang="cpp"
// src/main.cpp
        pipeline = result.value();
    }

+    auto buffer_id = device.create_buffer({
+        .size = sizeof(MyVertex) * 3,
+        .name = "my vertex data",
+    });

    while (!window.should_close())
```

## Uploading to Buffers

To upload to a buffer in daxa, you query the buffer's host pointer. Not all buffers have a host pointer, make sure to set either `daxa::MemoryFlagBits::HOST_ACCESS_SEQUENTIAL_WRITE` or `daxa::MemoryFlagBits::HOST_ACCESS_RANDOM` as `.memory_flags` when creating the buffer:

```diff lang="cpp"
// src/main.cpp
        pipeline = result.value();
    }

    auto buffer_id = device.create_buffer({
        .size = sizeof(MyVertex) * 3,
+        .memory_flags = daxa::MemoryFlagBits::HOST_ACCESS_SEQUENTIAL_WRITE,
        .name = "my vertex data",
    });

    while (!window.should_close())
```

* Use `daxa::MemoryFlagBits::HOST_ACCESS_SEQUENTIAL_WRITE` for buffers that require fast reads on the gpu and host writes. This type is suboptimal for host readback. Its typically in device vram.
* Use `daxa::MemoryFlagBits::HOST_ACCESS_RANDOM` for buffers that do not need fast access on the gpu but random cpu write and read access. This type is optimal for readback. Its typically in host ram.

Uploading any data itself is then done via direct writes through the host address:

```diff lang="cpp"
// src/main.cpp
    auto buffer_id = device.create_buffer({
        .size = sizeof(MyVertex) * 3,
        .memory_flags = daxa::MemoryFlagBits::HOST_ACCESS_SEQUENTIAL_WRITE,
        .name = "my vertex data",
    });

+    MyVertex * vert_buf_ptr = device.buffer_host_address_as<MyVertex>(buffer_id).value();
+    vert_buf_ptr[0] = {.position = {-0.5f, +0.5f, 0.0f}, .color = {1.0f, 0.0f, 0.0f}};
+    vert_buf_ptr[1] = {.position = {+0.5f, +0.5f, 0.0f}, .color = {0.0f, 1.0f, 0.0f}};
+    vert_buf_ptr[2] = {.position = {+0.0f, -0.5f, 0.0f}, .color = {0.0f, 0.0f, 1.0f}};

    while (!window.should_close())
```

This direct host-pointer upload is fine for a handful of vertices written once at startup. For larger or per-frame uploads, a staging buffer plus a GPU-side copy is more appropriate.

:::tip[Learn more]
See [Buffers, Images & Acceleration Structures](/wiki/buffers-images-acceleration-structures/#buffers) for the full resource model (bindless IDs, object lifetimes, deferred destruction), and [Buffer/Texture Upload & Mipmaps](/wiki/buffer-texture-upload-and-mipmaps/) for staging-buffer uploads of larger data.
:::