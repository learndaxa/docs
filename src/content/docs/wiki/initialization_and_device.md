---
title: Initialization and Device
description: Creating a Daxa instance, selecting a GPU, creating a device, and what the device gives you
slug: wiki/initialization-and-device
---

## Description

Two objects sit at the root of every Daxa application:

- `daxa::Instance` - the entry point into Daxa. It enumerates the available GPUs and their capabilities, and creates devices.
- `daxa::Device` - represents one selected GPU. Nearly everything else in Daxa - resources, pipelines, swapchains, command recording, submission, synchronization - is created from, and owned by, a device.

## Creating an Instance

```cpp
daxa::Instance instance = daxa::create_instance({});
```

`InstanceInfo` has three fields, all defaulted:

```cpp
struct InstanceInfo
{
    InstanceFlags flags =
        InstanceFlagBits::DEBUG_UTILS |
        InstanceFlagBits::PARENT_MUST_OUTLIVE_CHILD;
    SmallString engine_name = "daxa";
    SmallString app_name = "daxa app";
};
```

- `.flags`: `DEBUG_UTILS` enables Vulkan's debug naming/validation messages, which is what lets every named Daxa object (buffers, images, pipelines, ...) show up with that name in error messages and tools like RenderDoc. `PARENT_MUST_OUTLIVE_CHILD` means the instance must stay alive for as long as any device created from it - i.e. don't destroy the instance before its devices.
- `.engine_name` / `.app_name`: reported to the driver. The defaults are fine while developing; setting `.app_name` to your project's name is good practice once you ship something, since some drivers use this to apply per-application workarounds.

## Choosing a Device

A PC can have multiple GPUs, and not every GPU supports everything Daxa needs. Before creating a `daxa::Device`, you pick *which* physical GPU to create it from.

### Inspecting the available devices

```cpp
std::span<daxa::DeviceProperties const> devices = instance.list_devices_properties();
```

Each `DeviceProperties` entry describes one physical GPU:

- **Identity**: `.device_name`, `.vendor_id`, `.device_id`, `.device_type` (`DISCRETE_GPU`, `INTEGRATED_GPU`, `VIRTUAL_GPU`, `CPU`, or `OTHER`), `.vulkan_api_version`, `.driver_version`.
- **Support check**: `.missing_required_feature` - `MissingRequiredVkFeature::NONE` if this device has everything Daxa itself needs to run at all. Any other value names the specific missing feature, and the device can't be used with Daxa regardless of what your application needs.
- **Features**: `.implicit_features` are capabilities Daxa enables automatically if the device supports them (e.g. `MESH_SHADER`, `BASIC_RAY_TRACING`, `RAY_TRACING_PIPELINE`, `SHADER_FLOAT16`, ...). `.explicit_features` are capabilities that exist on the device but must be requested deliberately when creating the device (e.g. `BUFFER_DEVICE_ADDRESS_CAPTURE_REPLAY`, mainly needed for tools like RenderDoc to replay captures).
- **Limits**: `.limits` is a large `DeviceLimits` struct (max image sizes, descriptor set limits, push constant size, compute workgroup sizes, etc.). The descriptor set limits here are what `max_allowed_images`/`max_allowed_buffers`/etc. (see [Creating a Device](#creating-a-device)) are checked against.
- **Queues**: `.compute_queue_count` / `.transfer_queue_count` - how many extra compute/transfer queues this device exposes (see [Synchronization](/wiki/synchronization/#multi-queue-sync-with-timeline-semaphores)).
- **Optional extended properties**: `.mesh_shading_properties`, `.ray_tracing_properties`, `.acceleration_structure_properties`, `.invocation_reorder_properties`, `.host_image_copy_properties` are each `Optional<...>` - only populated if the device supports that feature.

### Selecting a device manually

```cpp
daxa::DeviceInfo2 device_info = {.name = "my device"};

std::span<daxa::DeviceProperties const> devices = instance.list_devices_properties();
for (u32 i = 0; i < devices.size(); ++i)
{
    daxa::DeviceProperties const & props = devices[i];

    if (props.missing_required_feature != daxa::MissingRequiredVkFeature::NONE)
    {
        continue; // Daxa cannot run on this device at all.
    }

    daxa::ImplicitFeatureFlags required_implicit_features = daxa::ImplicitFeatureFlagBits::BASIC_RAY_TRACING;
    if ((props.implicit_features & required_implicit_features) != required_implicit_features)
    {
        continue; // missing a feature this application needs.
    }

    device_info.physical_device_index = i;
    break;
}

if (device_info.physical_device_index == ~0u)
{
    throw std::runtime_error("No suitable GPU found.");
}

daxa::Device device = instance.create_device_2(device_info);
```

### `choose_device` - the built-in convenience helper

```cpp
daxa::Device device = instance.create_device_2(
    instance.choose_device({}, {})
);
```

`choose_device(desired_implicit_features, base_info)` performs essentially the loop above for you: it walks `list_devices_properties()` in order and returns a copy of `base_info` with `.physical_device_index` set to the **first** device where `.missing_required_feature == NONE`, the device's descriptor set limits can fit `base_info.max_allowed_images`/`max_allowed_buffers`/`max_allowed_acceleration_structures`, and the device has all of `base_info.explicit_features` and `desired_implicit_features`. If no device qualifies, it throws.

### A note on device selection strategy

It's tempting to write a "score" function - give discrete GPUs more points than integrated ones, add up some limits, and create a device from whichever GPU scores highest. In practice this tends to cause more problems than it solves:

- If the user has already picked a GPU for your application via their OS/driver settings (NVIDIA Control Panel, AMD switchable graphics, Windows' per-app "Graphics performance preference"), a scoring function that re-ranks devices can silently override that choice.
- "Discrete is always better" isn't actually true - on a laptop, the integrated GPU might be the only one that supports a feature you need, or the user may prefer it for battery life.
- If nothing scores particularly well, a score-based picker still picks *something* - so your application can end up silently running (and running badly) on hardware that doesn't really meet its requirements, instead of telling the user what's wrong.

A simpler and more robust approach: decide what your application actually *requires* (features, limits, queue counts), then take the **first** device that satisfies those requirements - exactly what `choose_device` does. If nothing satisfies them, **abort with a clear error message** explaining what's missing, rather than quietly falling back to a weaker device (like an integrated GPU) that the user never chose and that may not run your application acceptably.

## Creating a Device

```cpp
daxa::Device device = instance.create_device_2({
    .physical_device_index = chosen_index,
    .max_allowed_images = 10'000,
    .max_allowed_buffers = 10'000,
    .max_allowed_samplers = 400,
    .max_allowed_acceleration_structures = 10'000,
    .name = "my device",
});
```

- `.physical_device_index`: which entry of `list_devices_properties()` to create the device from - set via `choose_device` or your own selection logic above.
- `.explicit_features`: any of the device's `explicit_features` (see above) that you want enabled. Leave default unless you specifically need one - e.g. `BUFFER_DEVICE_ADDRESS_CAPTURE_REPLAY` for RenderDoc-style capture/replay tooling.
- `.max_allowed_images` / `.max_allowed_buffers` / `.max_allowed_samplers` / `.max_allowed_acceleration_structures`: how many of each resource type Daxa's bindless descriptor sets are sized for. The defaults (10,000 / 10,000 / 400 / 10,000) are generous; the chosen device's descriptor set limits must be able to fit these numbers, or device creation fails. `choose_device`'s device-matching check verifies this for you against whatever values you pass in `base_info`.
- `.name`: debug name for the device.

## The Device

Once created, `daxa::Device` is the object nearly everything else in Daxa hangs off of. This is a deliberate contrast to APIs like OpenGL: there, the "device" is an implicit global/thread-local context that every call implicitly affects. In Daxa, there is no global state - a `daxa::Device` is an explicit object containing *all* of Daxa's state for that GPU (resources, pipelines, queues, sync primitives), and you pass it around to whatever code needs it. Nothing about one device's state is visible to or shared with another device.

`daxa::Device` is also **thread-safe**: it's internally synchronized and may be called from multiple threads at the same time. This is what lets you, for example, create resources on a worker thread while submitting commands from your main thread, without any locking of your own.

The functions exposed by the device fall into a few groups:

- **Resource creation and destruction**: `create_buffer`, `create_image`, `create_image_view`, `create_sampler`, `create_blas`/`create_tlas` (and their `destroy_*` counterparts), plus `create_memory` for manual memory management. See [Buffers, Images & Acceleration Structures](/wiki/buffers-images-acceleration-structures/).
- **Pipelines and swapchains**: `create_raster_pipeline`, `create_compute_pipeline`, `create_ray_tracing_pipeline`, `create_swapchain`. See [Pipeline Manager](/wiki/pipeline-manager/) and [Swapchain](/wiki/swapchain/).
- **Command recording and submission**: `create_command_recorder`, `submit_commands`, `present_frame`, `wait_idle`, `queue_wait_idle`. See [Command Recording & Submission](/wiki/command-recording/).
- **Synchronization object creation**: `create_binary_semaphore`, `create_timeline_semaphore`, `create_event`, `create_timeline_query_pool`. See [Synchronization](/wiki/synchronization/).
- **Querying object state**: `buffer_info`/`image_info`/`sampler_info`/... return the creation info of a resource (kept up to date by Daxa); `is_buffer_id_valid`/`is_image_id_valid`/... check whether an id still refers to a live object; `buffer_device_address`/`buffer_host_address` retrieve GPU/CPU pointers; `properties()` returns this device's `DeviceProperties` (the same struct seen during selection); `info()` returns the `DeviceInfo2` it was created with.
- **Garbage collection**: `collect_garbage()` actually frees resources that were destroyed earlier and that the GPU has since finished using - see [Deferred destruction](/wiki/buffers-images-acceleration-structures/#deferred-destruction---zombies).
