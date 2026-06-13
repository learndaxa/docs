---
title: Creating an instance and device
description: Creating an instance and device
slug: "tutorial/drawing-a-triangle/creating-an-instance-and-device"
---

## Include the header

Well done! We have now created all the fundamentals and can finally start using Daxa. To use Daxa's C++ API, we need to include the following header:

```cpp
// src/main.cpp
#include <daxa/daxa.hpp>
```

Since this header is already included in the `window.hpp` header file, we don't need to also include this in our `main.cpp`.

## Creating an instance

Using this header we can now generate a new Daxa instance, and replace the `// Daxa rendering initialization code goes here...` placeholder from [Creating a Window](/tutorial/drawing-a-triangle/creating-a-window/):

```diff lang="cpp"
// src/main.cpp
    auto window = AppWindow("Learn Daxa", 860, 640);

-    // Daxa rendering initialization code goes here...
+    daxa::Instance instance = daxa::create_instance({});

    while (!window.should_close())
```

A curious thing you will notice is that most function calls take a struct as a parameter. This is done to emulate named parameters and also to enable out-of-order default argument values using C++20's designated initializers.

Daxa is a relatively explicit API but has a lot of defaults via struct default member values. This makes it much nicer to use in many cases.

Nearly all Daxa objects can be assigned a debug name in creation. This name is used in the error messages we emit and is also displayed in tools like RenderDoc.

:::tip[Learn more]
`{}` here is a default-constructed `daxa::InstanceInfo` - see [Initialization and Device](/wiki/initialization-and-device/) for its fields (debug/validation flags, engine/app name).
:::

## Choosing and creating a device

A PC can have multiple graphics cards. Unlike OpenGL, you need to manually select which GPU you want to use to perform calculations.

Below is sample code that selects the first device provided by the Vulkan driver (so long as it supports all of Daxa's required features). This means that if the user sets a device override in an application such as NVIDIA control panel, said device will be selected.

```diff lang="cpp"
// src/main.cpp
    daxa::Instance instance = daxa::create_instance({});

+    daxa::Device device = instance.create_device_2(instance.choose_device({}, {}));

    while (!window.should_close())
```

`choose_device({}, {})` takes a set of desired implicit features and a base `daxa::DeviceInfo2` (both left at their defaults here), and returns the first device that satisfies them, ready to pass to `create_device_2`. Usually, this is the desired behavior - if the user has already picked a GPU for your application via their OS/driver settings, this respects that choice.

:::tip[Learn more]
See [Initialization and Device](/wiki/initialization-and-device/#choosing-a-device) for how to inspect `list_devices_properties()` yourself, select a device manually, and why picking the *first* suitable device (rather than scoring/ranking devices) is usually the right approach. It also covers what `daxa::Device` gives your application once created.
:::
