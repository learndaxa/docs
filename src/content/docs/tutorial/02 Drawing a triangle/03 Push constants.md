---
title: Push constants
description: Push constants
slug: "tutorial/drawing-a-triangle/push-constants"
---

## Description

Push constants are a small bank of values, written from the CPU and read by shaders, that don't require creating a buffer or binding a descriptor set. In Daxa they're the standard way to pass per-draw/per-dispatch data - most commonly a handful of `daxa_BufferPtr`/`daxa_ImageId` handles into bindless resources, as we'll do here.

:::tip[Learn more]
See [Shader Integration](/wiki/shader-integration/#push-constants) for how push constants work on the shader side, and [Pipelines & Renderpasses](/wiki/pipelines-and-renderpasses/#push-constants) for the size limit (`DAXA_MAX_PUSH_CONSTANT_BYTE_SIZE`, 128 bytes) and the `.push_constant_size` pipeline field.
:::

## Implementation

To use push constants in our demo project, we need to create a new file: `src/shader/shared.inl` which will be a shared file between our main program and our shader file. Since Glsl is more or less a superset of basic C, we can use some code snippets in both languages.

Since this document is treated as a header file in our C++ code, we can simply insert `#pragma once` at the top to make sure it's only included once. We also need to include the Daxa (Shader) API directly beneath it: `#include <daxa/daxa.inl>`. We'll also include `#include <daxa/utils/task_graph.inl>`, which is needed if you make use of the optional TaskGraph utilities covered later.

We can now start to define common structs, etc. In this case, we need to create a new struct 'MyVertex' that can be pushed to the GPU. Our basic vertices will have a position and color attribute.

```diff lang="cpp"
// src/shader/shared.inl
+#pragma once
+
+// Includes the Daxa API to the shader
+#include <daxa/daxa.inl>
+#include <daxa/utils/task_graph.inl>
+
+struct MyVertex
+{
+    daxa_f32vec3 position;
+    daxa_f32vec3 color;
+};
```

Below this, we have to allow the shader to use pointers to our newly created struct.

```diff lang="cpp"
// src/shader/shared.inl
struct MyVertex
{
    daxa_f32vec3 position;
    daxa_f32vec3 color;
};

+// Allows the shader to use pointers to MyVertex
+DAXA_DECL_BUFFER_PTR(MyVertex)
```

The last step is to create the push constant. The push constant struct needs the attribute 'daxa_BufferPtr' that points to another struct object.

```diff lang="cpp"
// src/shader/shared.inl
DAXA_DECL_BUFFER_PTR(MyVertex)

+struct MyPushConstant
+{
+    daxa_BufferPtr(MyVertex) vertices;
+};
```

To use this file in our main.cpp, we need to include it at the top: `#include "shader/shared.inl"`

## Final code

```cpp
// src/shader/shared.inl
#pragma once

// Includes the Daxa API to the shader
#include <daxa/daxa.inl>
#include <daxa/utils/task_graph.inl>

struct MyVertex
{
    daxa_f32vec3 position;
    daxa_f32vec3 color;
};

// Allows the shader to use pointers to MyVertex
DAXA_DECL_BUFFER_PTR(MyVertex)

struct MyPushConstant
{
    daxa_BufferPtr(MyVertex) vertices;
};
```
