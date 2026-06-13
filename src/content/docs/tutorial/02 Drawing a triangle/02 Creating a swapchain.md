---
title: Creating a swapchain
description: Creating a swapchain
slug: "tutorial/drawing-a-triangle/creating-a-swapchain"
---

## Swapchain creation

In Daxa, the swapchain is a key element in rendering graphics, acting as a bridge between your application and the display. It's a collection of buffers used for displaying images on the screen. Unlike other/older APIs, Vulkan requires explicit management of these, which Daxa luckily handles for you.

The following code sample creates a new swapchain using a `daxa::NativeWindowInfo`, which is supplied by your windowing library of choice via the `AppWindow::get_native_window_info()` helper we created earlier.

```diff lang="cpp"
// src/main.cpp
    daxa::Device device = instance.create_device_2(instance.choose_device({}, {}));

+    daxa::Swapchain swapchain = device.create_swapchain({
+        // this info is given by the windowing API
+        .native_window_info = window.get_native_window_info(),
+        // We ask the device to pick a surface format for us. If you don't
+        // care what format the swapchain images are in, you can just pass
+        // the native window info and let Daxa pick a sensible default.
+        // Optionally, `preferred_formats` can be supplied to influence
+        // the selection.
+        .surface_format = device.choose_swapchain_surface_format({
+            .native_window_info = window.get_native_window_info(),
+        }),
+        .present_mode = daxa::PresentMode::FIFO,
+        .image_usage = daxa::ImageUsageFlagBits::TRANSFER_DST,
+        .name = "my swapchain",
+    });

    while (!window.should_close())
```

`device.choose_swapchain_surface_format()` returns a `daxa::SurfaceFormat`, which simply pairs a `daxa::Format` with a `daxa::ColorSpace`. If you have a strong preference for a particular format, you can pass a list of `preferred_formats` (ordered from most to least preferred) and Daxa will pick the first one supported by the surface, falling back to a sensible default otherwise.

### daxa::PresentMode

This defines how the rendered images are supplied to your screen. `daxa::PresentMode::FIFO` (the default used above) is the recommended option for most use cases - it's the equivalent of standard vertical sync.

:::tip[Learn more]
See [Swapchain](/wiki/swapchain/#present-modes) for a full comparison of `IMMEDIATE`, `FIFO`, `FIFO_RELAXED`, and `MAILBOX`, and how to switch between them at runtime with `swapchain.set_present_mode(...)`.
:::

## Swapchain usage

You can now acquire a new swapchain image by later running

```cpp
// src/main.cpp
daxa::ImageId swapchain_image = swapchain.acquire_next_image();
```

`acquire_next_image()` blocks until a frame-in-flight slot is free, then returns the next presentable image - or an empty `ImageId` if the swapchain currently can't provide one (e.g. the window was just resized). The swapchain also owns the acquire/present semaphores and the frames-in-flight bookkeeping needed to synchronize rendering with the display; we'll wire these up in [Finishing up](/tutorial/drawing-a-triangle/finishing-up/).

:::tip[Learn more]
See [Swapchain](/wiki/swapchain/) for the full picture: synchronization semaphores, frames in flight, resizing, and a complete annotated frame loop.
:::

## Final code

```cpp
// src/main.cpp
#include "window.hpp"

int main(int argc, char const *argv[])
{
    // Create a window
    auto window = AppWindow("Learn Daxa", 860, 640);

    daxa::Instance instance = daxa::create_instance({});

    daxa::Device device = instance.create_device_2(instance.choose_device({}, {}));

    daxa::Swapchain swapchain = device.create_swapchain({
        .native_window_info = window.get_native_window_info(),
        .surface_format = device.choose_swapchain_surface_format({
            .native_window_info = window.get_native_window_info(),
        }),
        .present_mode = daxa::PresentMode::FIFO,
        .image_usage = daxa::ImageUsageFlagBits::TRANSFER_DST,
        .name = "my swapchain",
    });

    while (!window.should_close())
    {
        window.update();
    }

    return 0;
}
```
