---
title: C API and Raw Vulkan Handle Access
description: How to use Daxa's C API directly, how it relates to the C++ API, and how to obtain raw Vulkan handles for interoperability
slug: wiki/c-api
---

Daxa exposes a full C API in addition to its C++ layer. The C++ types are thin reference-counted wrappers around C handles — both APIs drive the same underlying implementation. This page covers when and how to reach into the C API, including how to extract raw Vulkan handles for interoperability with other Vulkan code or libraries.

## The Relationship Between the C and C++ APIs

Every C++ type in Daxa (`daxa::Device`, `daxa::Instance`, `daxa::CommandRecorder`, etc.) inherits from `ManagedPtr<CppType, daxa_CHandle>`. The C handle is the actual opaque pointer that all Daxa internals operate on. The C++ wrapper adds:

- Automatic reference counting (copy/move/destroy)
- Overloaded, ergonomic methods that translate to C API calls
- C++ types in signatures (`Optional<T>`, `std::string_view`, etc.)

There is no performance difference between the two. The C++ methods compile down to direct calls to the C functions — there is no additional indirection or abstraction at runtime.

### Getting a C Handle from a C++ Object

Every C++ wrapper exposes a `.get()` method that returns the underlying C handle:

```cpp
daxa::Device device = /* ... */;
daxa_Device c_device = device.get();

daxa::Instance instance = /* ... */;
daxa_Instance c_instance = instance.get();

daxa::CommandRecorder recorder = /* ... */;
daxa_CommandRecorder c_recorder = recorder.get();
```

You can pass these C handles to any C API function directly.

### Calling C API Functions from C++

The C API is declared in `<daxa/c/daxa.h>` (or individual sub-headers). Since they use `extern "C"` linkage, they are callable from C++ without any bridging code:

```cpp
#include <daxa/daxa.hpp>      // C++ API
#include <daxa/c/device.h>    // C API (already included transitively, but explicit for clarity)

// Query the underlying VkDevice directly from a C++ Device:
VkDevice vk_device = daxa_dvc_get_vk_device(device.get());
```

## Including the C API

The C headers are under `daxa/c/`. Include the umbrella header or individual sub-headers:

```c
#include <daxa/c/daxa.h>          // instance + device + gpu resources + sync + pipeline
#include <daxa/c/command_recorder.h>  // CommandRecorder and ExecutableCommandList
#include <daxa/c/swapchain.h>     // Swapchain
```

All C API functions use `DAXA_EXPORT` which expands to `extern "C" DAXA_CMAKE_EXPORT` in C++ translation units, so they work from both C and C++.

## Error Handling in the C API

Most C API functions return `daxa_Result` — an error code. The C++ wrappers check this internally and throw or assert on failure. In C, check it yourself:

```c
daxa_Device device;
daxa_Result result = daxa_instance_create_device_2(instance, &info, &device);
if (result != DAXA_RESULT_SUCCESS)
{
    /* handle error */
}
```

`DAXA_RESULT_SUCCESS` is zero. Any non-zero value indicates a failure, and a few functions also define specific non-success codes with diagnostic meaning.

## Object Lifetimes from C

Regular Daxa objects (device, instance, pipelines, semaphores, command recorders, swapchain) are reference counted. The C API exposes inc/dec refcount functions for each type:

```c
daxa_dvc_inc_refcnt(device);  // increment
daxa_dvc_dec_refcnt(device);  // decrement (destroys when refcount hits zero)

daxa_instance_inc_refcnt(instance);
daxa_instance_dec_refcnt(instance);
```

SROs (buffers, images, image views, samplers, TLAS, BLAS) use a separate destroy model rather than refcounting at the user level — though they do have internal refcounts that can be manipulated explicitly:

```c
daxa_dvc_destroy_buffer(device, buffer_id);
daxa_dvc_destroy_image(device, image_id);

// Manual internal refcount manipulation:
daxa_dvc_inc_refcnt_buffer(device, buffer_id);
daxa_dvc_destroy_buffer(device, buffer_id);  // decrements internal refcount
```

See [Buffers, Images & Acceleration Structures](/wiki/buffers-images-acceleration-structures/#advanced-lifetime-management) for the full picture on internal refcounting.

## Obtaining Raw Vulkan Handles

The C API exposes a `get_vk_*` function for every major object type. These are the canonical way to extract handles for interoperability — for example, passing a `VkDevice` to a library that doesn't know about Daxa, recording commands into a `VkCommandBuffer` with raw Vulkan calls, or inspecting objects in a debugger.

### Instance and Device

```cpp
#include <daxa/c/instance.h>
#include <daxa/c/device.h>

VkInstance        vk_instance         = daxa_instance_get_vk_instance(instance.get());
VkDevice          vk_device           = daxa_dvc_get_vk_device(device.get());
VkPhysicalDevice  vk_physical_device  = daxa_dvc_get_vk_physical_device(device.get());
```

### Queues

Queue retrieval also returns the queue family index, which Vulkan requires for operations like pipeline barrier queue family ownership transfers:

```cpp
VkQueue  vk_queue            = {};
uint32_t vk_queue_family_idx = {};
daxa_dvc_get_vk_queue(device.get(), DAXA_QUEUE_MAIN, &vk_queue, &vk_queue_family_idx);
```

`DAXA_QUEUE_MAIN`, `DAXA_QUEUE_COMPUTE_0`–`DAXA_QUEUE_COMPUTE_3`, and `DAXA_QUEUE_TRANSFER_0`–`DAXA_QUEUE_TRANSFER_1` are the available queue constants. Queue counts depend on the hardware; not all queues may be present.

### Buffers, Images, Image Views, and Samplers

SROs are identified by IDs. Since a `daxa::BufferId` and `daxa_BufferId` are the same type (a struct containing a single `uint64_t`), they can be passed directly to C API functions:

```cpp
daxa::BufferId  buffer_id   = device.create_buffer({.size = 1024, .name = "buf"});
daxa::ImageId   image_id    = device.create_image({/* ... */});
daxa::ImageViewId view_id   = image_id.default_view();
daxa::SamplerId sampler_id  = device.create_sampler({});

VkBuffer    vk_buffer = {};
VkImage     vk_image  = {};
VkImageView vk_view   = {};
VkSampler   vk_sampler = {};

daxa_dvc_get_vk_buffer    (device.get(), buffer_id,    &vk_buffer);
daxa_dvc_get_vk_image     (device.get(), image_id,     &vk_image);
daxa_dvc_get_vk_image_view(device.get(), view_id,      &vk_view);
daxa_dvc_get_vk_sampler   (device.get(), sampler_id,   &vk_sampler);
```

All four functions return `daxa_Result` — check for success before using the handle.

### Command Recorder

While a `daxa::CommandRecorder` is open (before `complete_current_commands()`), you can retrieve the underlying `VkCommandBuffer` and record raw Vulkan commands into it. Daxa and raw Vulkan commands can be freely interleaved this way:

```cpp
daxa::CommandRecorder recorder = device.create_command_recorder({.name = "recorder"});

VkCommandBuffer vk_cmd  = daxa_cmd_get_vk_command_buffer(recorder.get());
VkCommandPool   vk_pool = daxa_cmd_get_vk_command_pool(recorder.get());

// Raw Vulkan call interleaved with Daxa recording:
vkCmdBeginQuery(vk_cmd, query_pool, 0, 0);
recorder.dispatch({.x = 64, .y = 1, .z = 1});
vkCmdEndQuery(vk_cmd, query_pool, 0);

daxa::ExecutableCommandList cmd_list = recorder.complete_current_commands();
```

The `VkCommandBuffer` is only valid until `complete_current_commands()` is called.

### Swapchain

```cpp
VkSwapchainKHR vk_swapchain = daxa_swp_get_vk_swapchain(swapchain.get());
```

### Semaphores

```cpp
VkSemaphore vk_binary   = daxa_binary_semaphore_get_vk_semaphore(binary_sem.get());
VkSemaphore vk_timeline = daxa_timeline_semaphore_get_vk_semaphore(timeline_sem.get());
```

Timeline semaphores are standard Vulkan timeline semaphores and can be used directly in `VkSubmitInfo2` wait/signal chains alongside Daxa's own submission.

## Using the C API Directly (Pure C)

For projects that cannot use C++, the full C API is sufficient to use Daxa end to end. Creating an instance and device looks like this:

```c
#include <daxa/c/daxa.h>
#include <daxa/c/command_recorder.h>

daxa_Instance instance = NULL;
daxa_InstanceInfo instance_info = DAXA_DEFAULT_INSTANCE_INFO;
instance_info.app_name = (daxa_SmallString){.data = "my app", .size = 6};
daxa_create_instance(&instance_info, &instance);

daxa_DeviceInfo2 device_info = DAXA_DEFAULT_DEVICE_INFO_2;
daxa_Device device = NULL;
daxa_instance_create_device_2(instance, &device_info, &device);

// Create and use resources...

daxa_dvc_dec_refcnt(device);
daxa_instance_dec_refcnt(instance);
```

`DAXA_DEFAULT_INSTANCE_INFO` and `DAXA_DEFAULT_DEVICE_INFO_2` are `static const` structs with sensible defaults defined in the headers — the same defaults the C++ constructors use.

## Interoperability Notes

- **Image layouts**: Daxa keeps all images in `VK_IMAGE_LAYOUT_GENERAL` at all times (except swapchain images during present). When inserting raw Vulkan barriers or recording Vulkan commands that expect a specific layout, this layout is always the starting and ending point.
- **Descriptor sets**: Daxa manages its own global bindless descriptor set internally. Do not bind other descriptor sets to the same layout slots Daxa uses — this will conflict with Daxa's bindless globals. The specific set indices Daxa occupies can be found in the Daxa source, but in practice, avoid using set 0 for your own descriptors when mixing raw Vulkan and Daxa.
- **Synchronization**: Any raw Vulkan barriers inserted into a `VkCommandBuffer` obtained via `daxa_cmd_get_vk_command_buffer` are invisible to Daxa. Daxa does not know about them, and subsequent Daxa commands may re-issue conflicting barriers. Interleave raw barriers carefully and only when necessary for things Daxa cannot express (e.g., custom query begin/end, vendor-specific extensions).
- **Command buffer reuse**: Daxa creates and pools command buffers internally. The `VkCommandBuffer` you get from `daxa_cmd_get_vk_command_buffer` is owned by Daxa's pool — do not free it, reset it, or submit it independently.
