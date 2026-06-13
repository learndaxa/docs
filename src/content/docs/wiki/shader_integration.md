---
title: Shader Integration & Bindless
description: Sharing types between C++ and shaders, push constants, and bindless access to images and buffers
slug: wiki/shader-integration
---

## Description

Shader integration - sharing types between C++ and shaders, and giving shaders convenient, low-overhead access to resources - is one of the most neglected areas of GPU library design. Most engines either hand-write matching structs on both sides and hope the layouts stay in sync, or wrap every resource access behind heavyweight descriptor set/binding management that the user has to maintain by hand.

Daxa does both of these well, and it is one of its biggest strengths:

- **Code sharing**: structs, constants, and even larger pieces of logic can be written **once**, in a file included by both C++ and shader code, and just work in both.
- **Bindless**: buffers, images, and samplers are referenced in shaders directly via the same ids/addresses the CPU gets back from `device.create_*` - no descriptor sets, no manual binding, no separate "shader-side" resource model to maintain.

This page covers both: the `daxa_` type macros that make code sharing possible, push constants as the way to get that shared data onto the GPU, and how to use bindless image and buffer handles once they're there.

This page builds on [Buffers, Images & Acceleration Structures](/wiki/buffers-images-acceleration-structures) and [Command Recording & Submission](/wiki/command-recording).

## Code Sharing via `daxa_` Types

Shared files are plain headers included from both C++ and shader code. They must include `<daxa/daxa.inl>`, which detects the compiling language and redefines Daxa's `daxa_*` type macros accordingly:

```c
// shared.inl
#include <daxa/daxa.inl>

struct MyData
{
    daxa_u32vec2 size;
    daxa_f32vec3 color;
};
```

The same `MyData` definition is valid in a C++ translation unit, a `.glsl` shader, and a `.slang` shader. Each `daxa_*` macro expands to the matching native type for whichever language is currently compiling:

| Daxa macro | GLSL | Slang | C++ |
|---|---|---|---|
| `daxa_b32` | `bool` | `bool` | `daxa::b32` |
| `daxa_u32` | `uint` | `uint32_t` | `daxa::u32` |
| `daxa_i32` | `int` | `int32_t` | `daxa::i32` |
| `daxa_f32` | `float` | `float` | `daxa::f32` |
| `daxa_u32vec2` | `uvec2` | `uint2` | `daxa::u32vec2` |
| `daxa_f32vec3` | `vec3` | `float3` | `daxa::f32vec3` |
| `daxa_f32mat4x4` | `mat4x4` | `float4x4` | `daxa::f32mat4x4` |
| `daxa_BufferId` | `{ uint64_t value; }` | `daxa::BufferId` | `daxa_BufferId` |
| `daxa_ImageViewId` | `{ uint64_t value; }` | `daxa::ImageViewId` | `daxa_ImageViewId` |
| `daxa_SamplerId` | `{ uint64_t value; }` | `daxa::SamplerId` | `daxa_SamplerId` |

The full list of available types lives in `daxa.inl`, `daxa.glsl`, and `daxa.slang`.

All Daxa buffer references and push constants use **scalar block layout**, which gives `daxa_*` types in shaders the exact same size, alignment, and padding rules as their C++ counterparts. This means a struct made of `daxa_*` types has an **identical memory layout** in C++ and in shader code - no manual padding, no `std140`/`std430` surprises, and no risk of the CPU and GPU silently disagreeing about a struct's layout.

## Push Constants

Daxa intentionally exposes no descriptor sets to the user. Aside from buffers, **push constants** are the only way to get data onto the GPU, and they are the entry point for everything else: image ids, buffer pointers, and small per-dispatch/per-draw parameters all travel through a single shared push constant struct.

`DAXA_DECL_PUSH_CONSTANT(STRUCT, NAME)` declares a global variable `NAME` of type `STRUCT` as the shader's push constant block. It is GLSL-only (it expands to a `layout(push_constant, ...) uniform` block), but the `STRUCT` itself is defined once in a shared file and reused by both C++ and the shader:

```c
// shared.inl
struct MyPush
{
    daxa_u32vec2 size;
    daxa_f32 time;
};
```

```glsl
// main.glsl
#include <daxa/daxa.inl>
#include "shared.inl"

DAXA_DECL_PUSH_CONSTANT(MyPush, push)

void main()
{
    daxa_u32vec2 size = push.size;
    daxa_f32 time = push.time;
}
```

```cpp
// main.cpp
recorder.push_constant(MyPush{
    .size = {1024, 1024},
    .time = elapsed_time,
});
```

Because `MyPush` is defined once and shared, there is no manual offset/size bookkeeping - the C++ struct you fill in is bit-for-bit the struct the shader reads.

## Bindless Access: Images & Buffers

The same push constant mechanism is how bindless resources reach the shader: an image id or a buffer's device address is just another field in the shared struct.

### Images

Every image has an implicit default view covering its full extent (`image_id.default_view()`), so the common case needs only a `daxa_ImageViewId`:

```c
// shared.inl
struct DrawPush
{
    daxa_ImageViewId texture;
    daxa_SamplerId sampler;
};
```

```cpp
// main.cpp
recorder.push_constant(DrawPush{
    .texture = texture_image.default_view(),
    .sampler = sampler_id,
});
```

**GLSL** turns a `daxa_ImageViewId` (optionally with a `daxa_SamplerId`) into a `texture`/`image`/`sampler` object in place, via macros from `<daxa/daxa.glsl>`:

```glsl
#include <daxa/daxa.inl>
#include "shared.inl"

DAXA_DECL_PUSH_CONSTANT(DrawPush, push)

void main()
{
    vec4 color = texture(daxa_sampler2D(push.texture, push.sampler), uv);
    imageStore(daxa_image2D(push.texture), pixel, color);
}
```

**Slang** does the same via `Texture*::Get(id)`, direct table indexing, or `.get()` on a typed id - and unlike GLSL, the result can be stored in a local variable:

```cpp
#include <daxa/daxa.slang>
#include "shared.inl"

[[vk::push_constant]] DrawPush push;

void main()
{
    Texture2D<float4> tex = Texture2D<float4>::Get(push.texture);
    SamplerState smp = push.sampler.get();
    float4 color = tex.Sample(smp, uv);
}
```

> GLSL handles **cannot** be stored in local variables - the `daxa_*` access macros must be used directly at the point of use (you can still pass the *ids* around freely, just not the resulting GLSL objects).

Slang additionally provides **typed** id/index wrappers for every texture dimension: `daxa::Texture2DId<float4>`, `daxa::RWTexture2DId<float4>`, `daxa::Texture2DIndex<float4>`, and so on, for every `TextureX`/`RWTextureX` Slang type. These wrap a plain `daxa::ImageViewId`/`daxa::ImageViewIndex` but carry the texel type as well, so `.get()`/`.get_coherent()` returns an already-typed `Texture2D<float4>` directly - no need to repeat the type via `Texture2D<float4>::Get(id)`. They're most useful in Slang-only structs where you want the texture's type to be part of the struct definition itself, rather than just an untyped `daxa_ImageViewId`.

### Buffers

A buffer's GPU-side address is retrieved on the CPU with `device.device_address(buffer_id).value()` and sent to the shader as a typed pointer using `daxa_BufferPtr`/`daxa_RWBufferPtr`:

```c
// shared.inl
struct MyData
{
    daxa_f32vec3 position;
};
DAXA_DECL_BUFFER_PTR(MyData)

struct ComputePush
{
    daxa_BufferPtr(MyData) data;
};
```

```cpp
// main.cpp
recorder.push_constant(ComputePush{
    .data = device.device_address(data_buffer).value(),
});
```

`daxa_BufferPtr(MyData)` expands per language: a read-only buffer reference in GLSL, a `Ptr<MyData>` in Slang, and a plain `daxa::types::DeviceAddress` (a `u64`) in C++ - so it fits directly into a shared struct. `DAXA_DECL_BUFFER_PTR(MyData)` (needed in GLSL to declare the underlying buffer reference types) expands to nothing in C++ and Slang.

Reading through the pointer uses `deref(...)` in both GLSL and Slang:

```glsl
// GLSL
daxa_f32vec3 pos = deref(push.data).position;
deref(push.data).position = vec3(1, 0, 0);
```

```cpp
// Slang
float3 pos = deref(push.data).position;
deref(push.data).position = float3(1, 0, 0);
```

For a read-write pointer, declare the field as `daxa_RWBufferPtr(MyData)` instead. If you only have a `daxa_BufferId` in the shader (e.g. passed as part of a larger bindless array) and need its address, `daxa_id_to_address(buffer_id)` returns the raw `daxa_u64` address, which can be cast to a `daxa_BufferPtr(T)`.

### Pointer-Based Shared Data Structure Example

`daxa_BufferPtr(T)`/`daxa_RWBufferPtr(T)` fields aren't limited to push constants - they are just regular `daxa_u64`-sized values, so they can appear in **any** shared struct, including one that itself lives behind another pointer. This lets you build a small tree of pointers: the push constant holds a single pointer to a "root" struct, and that struct's fields are themselves pointers into other buffers.

This is the standard way to give a shader access to an entire scene/object's data through one push constant field:

```c
// shared.inl
struct Vertex
{
    daxa_f32vec3 position;
    daxa_f32vec3 normal;
};
DAXA_DECL_BUFFER_PTR(Vertex)

struct Material
{
    daxa_ImageViewId albedo;
    daxa_ImageViewId normal_map;
    daxa_SamplerId sampler;
};
DAXA_DECL_BUFFER_PTR_ALIGN(Material, 8)

struct Mesh
{
    daxa_BufferPtr(Vertex) vertices;
    daxa_BufferPtr(Material) material;
    daxa_u32 vertex_count;
    daxa_f32mat4x4 transform;
};
DAXA_DECL_BUFFER_PTR_ALIGN(Mesh, 8)

struct DrawPush
{
    daxa_BufferPtr(Mesh) mesh;
};
```

Note that `Material` contains plain `daxa_ImageViewId`/`daxa_SamplerId` fields - image and sampler ids are themselves just `daxa_u64` values, so they're as freely embeddable in shared structs as any other `daxa_*` type.

`DAXA_DECL_BUFFER_PTR(T)` declares its buffer reference with the default alignment of 4. Under scalar block layout, a struct's required alignment is the alignment of its largest member - so any struct containing an 8-byte-aligned field (`daxa_BufferPtr`/`daxa_RWBufferPtr`, `daxa_ImageViewId`, `daxa_SamplerId`, `daxa_u64`/`daxa_i64`, `daxa_f64`, ...) must use `DAXA_DECL_BUFFER_PTR_ALIGN(T, 8)` instead. `Vertex` only contains 4-byte-aligned `float`s, so the default `DAXA_DECL_BUFFER_PTR(Vertex)` is fine; `Material` and `Mesh` both contain 8-byte ids/pointers and need the explicit `, 8` alignment. Getting this wrong causes the GLSL and C++ layouts of the struct to diverge.

On the C++ side, `Mesh::vertices` and `Mesh::material` are just `daxa::types::DeviceAddress` values - filled in exactly like any other buffer pointer, by writing the addresses of the vertex and material buffers into the `Mesh` struct wherever it lives (a dedicated buffer, or an allocation from a [reusable staging buffer](/wiki/buffer-texture-upload-and-mipmaps#transfermemorypool-a-ready-made-reusable-staging-buffer)):

```cpp
// main.cpp
Material material_data{
    .albedo = albedo_image.default_view(),
    .normal_map = normal_image.default_view(),
    .sampler = sampler_id,
};
// ... write material_data into material_buffer ...

Mesh mesh_data{
    .vertices = device.device_address(vertex_buffer).value(),
    .material = device.device_address(material_buffer).value(),
    .vertex_count = vertex_count,
    .transform = transform,
};
// ... write mesh_data into mesh_buffer, e.g. via a host-mapped pointer ...

recorder.push_constant(DrawPush{
    .mesh = device.device_address(mesh_buffer).value(),
});
```

The shader follows the chain of pointers - the push constant's pointer to the `Mesh`, then the `Mesh`'s pointers to its vertices and material:

```glsl
// GLSL
Mesh mesh = deref(push.mesh);
Vertex v = deref_i(mesh.vertices, gl_VertexIndex);

Material mat = deref(mesh.material);
vec4 albedo = texture(daxa_sampler2D(mat.albedo, mat.sampler), uv);
```

```cpp
// Slang
Mesh mesh = deref(push.mesh);
Vertex v = deref_i(mesh.vertices, vertex_index);

Material mat = deref(mesh.material);
float4 albedo = Texture2D<float4>::Get(mat.albedo).Sample(mat.sampler.get(), uv);
```

Nothing about this is special-cased - it's the same `deref`/`deref_i` macros used everywhere else, applied one pointer at a time. This is how larger, more dynamic data (entire scenes, draw lists, material tables, ...) is passed to shaders with a single push constant field, instead of growing the push constant struct itself.

### Slang Typed Image Handles Example

If a struct like `Material` is only ever used from Slang (never shared with GLSL), the typed handles from the previous section let you skip the untyped `daxa_ImageViewId` + `Texture2D<float4>::Get(...)` pair entirely:

```cpp
// Slang-only variant of Material
struct MaterialSlang
{
    daxa::Texture2DId<float4> albedo;
    daxa::Texture2DId<float4> normal_map;
    daxa::SamplerId sampler;
};

void main()
{
    MaterialSlang mat = ...;
    float4 albedo = mat.albedo.get().Sample(mat.sampler.get(), uv);
}
```

`daxa::Texture2DId<float4>` is purely a Slang-side typing convenience - it's a thin wrapper holding a single `daxa::ImageViewId` field (`.id`), with the exact same `daxa_u64` size and layout. On the CPU there is no typed equivalent, it decays to the usual types: a buffer read as `MaterialSlang` in Slang is filled from C++ exactly like the untyped `Material` struct, with plain `daxa::ImageViewId`/`daxa::SamplerId` values from `image.default_view()` and the sampler id - the same bytes, just given a more specific type on the Slang side.

## GLSL Annotations for Images

The `daxa_image2D(id)`-style macros give you an image with no qualifiers (no `coherent`, `readonly`, `restrict`, format, ...). Pre-declaring every possible combination would explode compile times, so instead Daxa lets you declare your own annotated accessors on demand:

```glsl
DAXA_DECL_IMAGE_ACCESSOR(image2D, coherent restrict, RWCoherRestr)
DAXA_DECL_IMAGE_ACCESSOR(iimage2DArray, writeonly restrict, WORestr)
DAXA_DECL_IMAGE_ACCESSOR_WITH_FORMAT(uimage2D, r32ui, , R32uiImage)

void main()
{
    daxa_ImageViewId img0, img1, img2 = ...;

    vec4 v = imageLoad(daxa_access(RWCoherRestr, img0), ivec2(0, 0));
    imageStore(daxa_access(WORestr, img1), ivec2(0, 0), ivec4(v));
    imageAtomicOr(daxa_access(R32uiImage, img2), ivec2(0, 0), 1 << 31);
}
```

- `DAXA_DECL_IMAGE_ACCESSOR(TYPE, ANNOTATIONS, ACCESSOR_NAME)` declares a new table of `TYPE` images with the given qualifiers.
- `DAXA_DECL_IMAGE_ACCESSOR_WITH_FORMAT(TYPE, FORMAT, ANNOTATIONS, ACCESSOR_NAME)` additionally pins a storage format (needed for some functions, e.g. `imageAtomicOr`).
- `daxa_access(ACCESSOR_NAME, image_view_id)` indexes into that table with an image view id, giving you the annotated image object.

Each `ACCESSOR_NAME` must be unique; declare it once per qualifier/format combination you actually need.

## Always-Enabled GLSL/SPIR-V Extensions

Daxa's GLSL headers always enable a small set of extensions required for code sharing and bindless access to work:

- **`GL_EXT_scalar_block_layout`** - gives C++ and GLSL structs identical layouts, which is what makes shared `daxa_*` structs possible.
- **`GL_EXT_shader_explicit_arithmetic_types_int64`** - fixed-size integer types (`uint64_t`, ...) used by ids and buffer addresses.
- **`GL_EXT_buffer_reference`** (+ `buffer_reference2`) - lets a `uint64_t` be reinterpreted as a pointer-like buffer reference, the basis of `daxa_BufferPtr`/`daxa_RWBufferPtr`.
- **`GL_EXT_nonuniform_qualifier`** - allows `nonuniformEXT(...)`, needed for diverging bindless resource indices within a subgroup.
- **`GL_EXT_samplerless_texture_functions`** - adds texture-query overloads that don't require a sampler, used by the `daxa_texture*`/`daxa_image*` accessors.
- **`GL_EXT_shader_image_load_formatted`** - lets storage images be declared without a fixed format, drastically shrinking the generated bindless image tables.
- **`GL_EXT_shader_image_int64`** *(optional, `DAXA_IMAGE_INT64`)* - 64-bit image atomics, for the i64/u64 image tables.
- **`GL_KHR_memory_scope_semantics`** - replaces the old, poorly-defined `coherent` qualifier with explicit, scoped memory/execution barriers.
