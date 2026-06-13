---
title: Buffers, Images & Acceleration Structures
description: Creation, lifetimes, and bindless access of Daxa's buffer, image, sampler, TLAS and BLAS objects
slug: wiki/buffers-images-acceleration-structures
---

## Shader Resource Objects

Daxa objects fall into two categories: shader resource objects (SROs) and regular objects.

SROs are Daxa's buffer, image, image view, sampler, TLAS (top-level acceleration structure), and BLAS (bottom-level acceleration structure) types. Every other object (`daxa::Device`, `daxa::Pipeline`, `daxa::CommandRecorder`, ...) is a regular object and is reference counted.

SROs are treated differently because:

- They are all directly accessible in shaders.
- They typically occur in much larger numbers than regular objects.
- They are accessed and used at a much greater frequency.
- Having clear, explicit lifetimes matters more for them.

Buffers, images, and acceleration structures are also tied to potentially large regions of memory, so automatic lifetimes can lead to unpredictable and hard to optimize memory usage. Because of this, Daxa does **not** reference count SROs. Instead, the user gets manual lifetime management via explicit create/destroy functions.

SROs are represented on the user side by an ID (`daxa::BufferId`, `daxa::ImageId`, `daxa::ImageViewId`, `daxa::SamplerId`, `daxa::TlasId`, `daxa::BlasId`). IDs are trivially copyable and carry no ownership over the object they refer to. There is no way to use the object without the ID **and** a `daxa::Device` to verify and resolve it - for example, querying an object's info **must** go through a device function taking the ID.
 
IDs are much safer than e.g. a raw pointer to the resource:

- The user has no way to access an object without the device.
- Object access can be cheaply and efficiently validated.
- Thread safety and validation hold even in cases of misuse.
- Validation overhead is close to zero.

## Bindless Access

Traditionally, in graphics APIs like OpenGL or earlier versions of DirectX, resources like textures and buffers were bound to specific binding slots, and shaders referenced them by slot/binding point. This approach has limitations and can lead to performance bottlenecks when dealing with many resources, since binding operations in sum are a lot of cpu work. Aside from performance, these bindings can be cumbersome and error-prone to use. But most importantly, they limit the gpu greatly in how it can access resources. For example in ray tracing, the gpu must effectively be able to read all material textures and geometry buffers at once in a single shader. This is not possible with traditional binding models.

Newer APIs like Metal, Vulkan, and DX12 still expose some form of binding points with more direct descriptor management. While descriptor management gives the user much more control over bindings and even allows a lot of bindless usecases, manual binding and descriptor management is lot of work for the user and hardware, and it can cause many hard-to-debug issues due to its complexity.

Daxa's bindless approach eliminates all of this: buffers, images, samplers, and acceleration structures are referenced in shaders directly via the same `daxa::BufferId` / `daxa::ImageViewId` / `daxa::SamplerId` / `daxa::TlasId` handles that are returned on the CPU when the resource is created - there is no separate binding step. All resources are just ids or pointers that can be directly passed into buffers or push constants on the GPU. 

Bindless provides several advantages:

1. **Improved performance**: drastically reduces cpu binding and descriptor operations.
2. **Simpler code**: no descriptor pools, set layouts, set allocation, set writes, binding points, or sync around set allocation to manage.
3. **Flexibility**: working with dynamic and large datasets is easy, since shaders can access any resource by handle.
4. **Simpler**: Daxa's bindless API surface is super small compared to typical Vulkan/DX12 descriptor management, its much easier to learn and potential misuse is far less likely.

## Object Lifetimes

### Deferred destruction - Zombies?

When an SRO is destroyed via `device.destroy_*`, it is not immediately destroyed - it is zombified.

A zombie object is no longer usable on the users cpu side, but it is still valid in Daxa's internals and on the GPU, since in-flight GPU work may still be referencing it.

Daxa defers the real destruction of zombies until the GPU catches up with the CPU at the time of zombification. This happens exclusively in `Device::collect_garbage`, which checks each zombie's zombification time point against the GPU timeline and destroys it once the GPU has caught up.

## Advanced Lifetime Management

While SROs are not automatically reference-counted from the user's perspective, but Daxa still keeps an internal reference count for every buffer, image, image view, sampler, TLAS, and BLAS.

After creation, this internal refcount starts at 1 and normally never changes for the rest of the object's life. `device.destroy_*(id)` simply decrements this refcount; once it reaches 0, the object is zombified as described above.

Daxa also lets you manipulate this refcount manually: `device.inc_refcnt(id)` (e.g. `device.inc_refcnt_buffer(buffer)`) increments it, and a matching `device.destroy(id)` decrements it again. This is exposed identically through the C API (`daxa_dvc_inc_refcnt_buffer`, `daxa_dvc_destroy_buffer`, ...) and the C++ API (`device.inc_refcnt(id)`, `device.destroy(id)`) - on the C++ side you can use either form interchangeably on the same handles without issues.

Usually this internal refcount isn't relevant or useful. But it can help in two situations:

- **Debugging lifetime issues**: if an SRO ends up with a refcount other than 1 outside of code you wrote to change it, or gets destroyed while its refcount is still above 0 and never fully disappears, that's a strong signal of a lifetime bug on the user side.
- **Opt-in reference counting**: if you really want a specific SRO to behave like a reference-counted handle, you can write a thin wrapper type around its ID that calls `inc_refcnt` on copy and `destroy` once the last copy goes out of scope. This adds no extra allocation - it simply defers to Daxa's existing internal refcount instead of introducing a second one.

## Creating Objects

For nearly all functions, Daxa uses structs as parameters, following the naming convention `<Thing>Info`. Combined with C++20 designated initialization, this gives:

- Default function parameters
- Out-of-order, named parameters
- Less boilerplate, since Daxa infers as much as possible

Every SRO's info struct also has a `name` field. These names are passed to Vulkan via the debug-utils extension, so the driver, validation layers, and tools like RenderDoc can show each resource under its given name - and Daxa uses these names in its own error messages too.

### Buffers

```cpp
daxa::BufferId buffer = device.create_buffer({
    .size = 64,
    .name = "example buffer",
});
```

Not all buffers have a host pointer - to read/write a buffer directly from the CPU, set `.memory_flags`:

```cpp
daxa::BufferId staging_buffer = device.create_buffer({
    .size = 64,
    .memory_flags = daxa::MemoryFlagBits::HOST_ACCESS_SEQUENTIAL_WRITE,
    .name = "example staging buffer",
});

MyType * ptr = device.buffer_host_address_as<MyType>(staging_buffer).value();
```

* Use `daxa::MemoryFlagBits::HOST_ACCESS_SEQUENTIAL_WRITE` for buffers that need fast GPU reads with sequential host writes. Typically lives in device VRAM.
* Use `daxa::MemoryFlagBits::HOST_ACCESS_RANDOM` for buffers that need random CPU read/write access (e.g. readback). Typically lives in host RAM.

### Images & Image Views

```cpp
daxa::ImageId image = device.create_image({
    .format = daxa::Format::R8G8B8A8_SRGB,
    .size = {1024, 1024, 1},
    .usage = daxa::ImageUsageFlagBits::SHADER_SAMPLED | daxa::ImageUsageFlagBits::TRANSFER_DST,
    .name = "example texture image",
});

daxa::ImageViewId image_view = device.create_image_view({
    .type = daxa::ImageViewType::REGULAR_2D,
    .format = daxa::Format::R8G8B8A8_SRGB,
    .image = image,
    .name = "example image view",
});
```

Every image also has an implicit default view covering its full extent, available via `image.default_view()`.

### Samplers

```cpp
daxa::SamplerId sampler = device.create_sampler({});
```

### Acceleration Structures (TLAS / BLAS)

TLASs and BLASs are used for hardware ray tracing. Like buffers and images, they are SROs and are identified by `daxa::TlasId` / `daxa::BlasId`. Before creating one, query the required backing size with `device.tlas_build_sizes()` / `device.blas_build_sizes()`:

```cpp
daxa::BlasId blas = device.create_blas({
    .size = blas_build_size, // from device.blas_build_sizes(...)
    .name = "example blas",
});

daxa::TlasId tlas = device.create_tlas({
    .size = tlas_build_size, // from device.tlas_build_sizes(...)
    .name = "example tlas",
});
```

Building the actual acceleration structure contents happens later via build commands on a `daxa::CommandRecorder`.

## Querying, Validating & Destroying Objects

Every SRO's info can be queried back from the device. Because SROs aren't reference counted, info is returned by value to avoid race conditions:

```cpp
daxa::BufferInfo buffer_info = device.buffer_info(buffer).value();
daxa::ImageInfo image_info = device.image_info(image).value();

// The device can tell you whether an ID is still valid:
const bool buffer_valid = device.is_id_valid(buffer);

// Buffers, BLASs, and TLASs can be turned into GPU-visible addresses:
daxa::DeviceAddress address = device.device_address(buffer).value();
```

The device is also responsible for destroying SROs:

```cpp
device.destroy_buffer(buffer);
device.destroy_image(image);
device.destroy_image_view(image_view);
device.destroy_sampler(sampler);
device.destroy_tlas(tlas);
device.destroy_blas(blas);
```

As described in [Deferred destruction](#deferred-destruction---zombies), these calls zombify the object - the real GPU-side destruction happens later, in `device.collect_garbage()`.
