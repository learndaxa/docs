---
title: Pipelines
description: Compute, raster, and ray tracing pipeline creation, and the full raster blend/depth/rasterizer state
slug: wiki/pipelines
---

## Description

A pipeline is a GPU object that bundles shader stages together with the fixed-function state needed to run them - things like blending, depth testing, and rasterizer configuration for raster pipelines, or shader groups and recursion depth for ray tracing pipelines. Daxa has three kinds, each created directly from `daxa::Device`:

- `daxa::ComputePipeline` via `device.create_compute_pipeline(...)`
- `daxa::RasterPipeline` via `device.create_raster_pipeline(...)`
- `daxa::RayTracingPipeline` / `daxa::RayTracingPipelineLibrary` via `device.create_ray_tracing_pipeline(...)` / `device.create_ray_tracing_pipeline_library(...)`

This page covers the `*PipelineInfo` structs that configure each kind of pipeline in detail. For compiling GLSL/HLSL/Slang to SPIR-V and hot-reloading pipelines while developing, see [Pipeline Manager](/wiki/pipeline-manager/) - it ultimately calls the same `device.create_*_pipeline` functions described here. For binding a pipeline and issuing draws/dispatches/trace-rays, see [Command Recording & Submission](/wiki/command-recording/).

## Compute Pipelines

Compute pipelines are the simplest: a single shader stage, plus a push constant size.

```cpp
struct ComputePipelineInfo
{
    ShaderInfo shader_info = {};
    u32 push_constant_size = DAXA_MAX_PUSH_CONSTANT_BYTE_SIZE;
    SmallString name = {};
};

daxa::ComputePipeline pipeline = device.create_compute_pipeline({
    .shader_info = {
        .byte_code = spirv_words.data(),
        .byte_code_size = static_cast<u32>(spirv_words.size()),
        .entry_point = "main",
    },
    .push_constant_size = sizeof(MyPushConstant),
    .name = "my compute pipeline",
});
```

### `ShaderInfo`

Every shader stage in every pipeline type (compute, raster, ray tracing) is described by the same `ShaderInfo` struct:

```cpp
struct ShaderInfo
{
    u32 const * byte_code = {};
    u32 byte_code_size = {};
    ShaderCreateFlags create_flags = {};
    Optional<u32> required_subgroup_size = {};
    SmallString entry_point = "main";
};
```

- `.byte_code` / `.byte_code_size`: a pointer to compiled SPIR-V words and the word count. Daxa itself doesn't compile shaders - this is raw SPIR_V, normally produced by [Pipeline Manager](/wiki/pipeline-manager/) or your own glslang/dxc/slangc invocation.
- `.create_flags`: `ShaderCreateFlagBits::ALLOW_VARYING_SUBGROUP_SIZE` lets the driver pick any subgroup size at dispatch time; `ShaderCreateFlagBits::REQUIRE_FULL_SUBGROUPS` requires every invoked subgroup to be fully occupied. Both map to the corresponding Vulkan subgroup-size-control flags and default to off.
- `.required_subgroup_size`: when set, pins the shader to a specific subgroup (wave) size, e.g. `32` or `64`. Leave as `None` to let the driver choose.
- `.entry_point`: the name of the shader's entry function. Defaults to `"main"`, which is what GLSL/HLSL compilers normally produce.

### Push constants

`.push_constant_size` reserves space in the pipeline's push constant range, up to `DAXA_MAX_PUSH_CONSTANT_BYTE_SIZE` (128 bytes). All three pipeline types have this field with the same default (the full 128 bytes) - it only needs to be set explicitly if you want to assert a smaller, specific size (e.g. `sizeof(MyPushConstant)`).

### Using a compute pipeline

```cpp
recorder.set_pipeline(pipeline);
recorder.push_constant(my_push_constant);
recorder.dispatch({.x = group_count_x, .y = group_count_y, .z = group_count_z});
```

`dispatch_indirect(DispatchIndirectInfo{...})` is also available, reading the dispatch dimensions from a `BufferId` at a given offset instead of immediate values.

## Raster Pipelines

Raster pipelines run inside a renderpass scope — opened with `begin_renderpass` and closed with `end_renderpass` on the `CommandRecorder`. This section covers `RasterPipelineInfo`, the fixed state baked into the pipeline at creation time: shader stages, color attachment formats and blending, depth testing, tessellation, and rasterizer settings. For the recording side — render attachment configuration, opening/closing renderpasses, and draw commands — see [Command Recording & Submission](/wiki/command-recording/#raster-pass).

### `RasterPipelineInfo`

```cpp
struct RasterPipelineInfo
{
    Optional<ShaderInfo> mesh_shader_info = {};
    Optional<ShaderInfo> vertex_shader_info = {};
    Optional<ShaderInfo> tesselation_control_shader_info = {};
    Optional<ShaderInfo> tesselation_evaluation_shader_info = {};
    Optional<ShaderInfo> fragment_shader_info = {};
    Optional<ShaderInfo> task_shader_info = {};
    FixedList<RenderAttachment, 8> color_attachments = {};
    Optional<DepthTestInfo> depth_test = {};
    Optional<TesselationInfo> tesselation = {};
    RasterizerInfo raster = {};
    u32 push_constant_size = DAXA_MAX_PUSH_CONSTANT_BYTE_SIZE;
    SmallString name = {};
};
```

Every shader stage is `Optional<ShaderInfo>`, since which stages are present determines the kind of pipeline:

- A traditional pipeline supplies `.vertex_shader_info` and `.fragment_shader_info`, optionally adding `.tesselation_control_shader_info` / `.tesselation_evaluation_shader_info` for tessellation.
- A mesh-shading pipeline supplies `.mesh_shader_info` and `.fragment_shader_info`, optionally adding `.task_shader_info` for the task (amplification) stage. Vertex/tessellation and mesh/task stages are mutually exclusive.

```cpp
daxa::RasterPipeline pipeline = device.create_raster_pipeline({
    .vertex_shader_info = {.byte_code = vert_spirv.data(), .byte_code_size = static_cast<u32>(vert_spirv.size())},
    .fragment_shader_info = {.byte_code = frag_spirv.data(), .byte_code_size = static_cast<u32>(frag_spirv.size())},
    .color_attachments = {{.format = swapchain.get_format()}},
    .depth_test = {
        .depth_attachment_format = daxa::Format::D32_SFLOAT,
        .enable_depth_write = true,
        .depth_test_compare_op = daxa::CompareOp::LESS_OR_EQUAL,
    },
    .raster = {
        .face_culling = daxa::FaceCullFlagBits::BACK_BIT,
    },
    .push_constant_size = sizeof(MyPushConstant),
    .name = "my raster pipeline",
});
```

### Color attachments and blending

```cpp
struct RenderAttachment
{
    Format format = {};
    Optional<BlendInfo> blend = {};
};
```

`.color_attachments` is a `FixedList<RenderAttachment, 8>` - one entry per color attachment, in the same order as the renderpass's `RenderPassBeginInfo::color_attachments`. `.format` of each entry must match the format of the corresponding attachment's image view at draw time. `.blend` is `None` by default, meaning that attachment's blending is **disabled** - fragment shader output simply overwrites the attachment.

To enable blending for an attachment, give it a `BlendInfo`:

```cpp
struct BlendInfo
{
    BlendFactor src_color_blend_factor = BlendFactor::ONE;
    BlendFactor dst_color_blend_factor = BlendFactor::ZERO;
    BlendOp color_blend_op = BlendOp::ADD;
    BlendFactor src_alpha_blend_factor = BlendFactor::ONE;
    BlendFactor dst_alpha_blend_factor = BlendFactor::ZERO;
    BlendOp alpha_blend_op = BlendOp::ADD;
    ColorComponentFlags color_write_mask = R | G | B | A;
};
```

Blending combines the fragment shader's output color (`src`) with the color already in the attachment (`dst`), separately for the RGB channels and the alpha channel:

```
result.rgb = (src.rgb * src_color_blend_factor)  <color_blend_op>  (dst.rgb * dst_color_blend_factor)
result.a   = (src.a   * src_alpha_blend_factor)  <alpha_blend_op>  (dst.a   * dst_alpha_blend_factor)
```

**`BlendFactor`** - the multiplier applied to `src`/`dst` before combining:

| value | meaning |
| --- | --- |
| `ZERO` | `0` |
| `ONE` | `1` |
| `SRC_COLOR` | `src.rgb` |
| `ONE_MINUS_SRC_COLOR` | `1 - src.rgb` |
| `DST_COLOR` | `dst.rgb` |
| `ONE_MINUS_DST_COLOR` | `1 - dst.rgb` |
| `SRC_ALPHA` | `src.a` |
| `ONE_MINUS_SRC_ALPHA` | `1 - src.a` |
| `DST_ALPHA` | `dst.a` |
| `ONE_MINUS_DST_ALPHA` | `1 - dst.a` |
| `CONSTANT_COLOR` | a constant blend color |
| `ONE_MINUS_CONSTANT_COLOR` | `1 -` constant blend color |
| `CONSTANT_ALPHA` | a constant blend alpha |
| `ONE_MINUS_CONSTANT_ALPHA` | `1 -` constant blend alpha |
| `SRC_ALPHA_SATURATE` | `min(src.a, 1 - dst.a)` - only meaningful for `src_color_blend_factor` |
| `SRC1_COLOR` / `ONE_MINUS_SRC1_COLOR` / `SRC1_ALPHA` / `ONE_MINUS_SRC1_ALPHA` | the equivalent values from a fragment shader's second color output (dual source blending) |

> The constant blend color/alpha used by `CONSTANT_*` factors is fixed at `(1, 1, 1, 1)` and is not currently configurable per draw.

**`BlendOp`** - how the two scaled values are combined:

| value | meaning |
| --- | --- |
| `ADD` | `src + dst` |
| `SUBTRACT` | `src - dst` |
| `REVERSE_SUBTRACT` | `dst - src` |
| `MIN` | `min(src, dst)` |
| `MAX` | `max(src, dst)` |

**`color_write_mask`** - a `ColorComponentFlags` (`ColorComponentFlagBits::R/G/B/A`, default all four) controlling which channels of the result are actually written to the attachment. This applies regardless of whether blending is enabled - e.g. a depth-only prepass writing to a color attachment for other reasons could set this to `ColorComponentFlagBits::NONE`.

Some common configurations:

```cpp
// Disabled (default) - output overwrites the attachment.
daxa::RenderAttachment{.format = format}

// Standard "straight alpha" blending - the usual choice for UI/transparency.
daxa::RenderAttachment{
    .format = format,
    .blend = daxa::BlendInfo{
        .src_color_blend_factor = daxa::BlendFactor::SRC_ALPHA,
        .dst_color_blend_factor = daxa::BlendFactor::ONE_MINUS_SRC_ALPHA,
        .color_blend_op = daxa::BlendOp::ADD,
        .src_alpha_blend_factor = daxa::BlendFactor::ONE,
        .dst_alpha_blend_factor = daxa::BlendFactor::ONE_MINUS_SRC_ALPHA,
        .alpha_blend_op = daxa::BlendOp::ADD,
    },
}

// Premultiplied alpha - use when the shader output color is already
// multiplied by its alpha.
daxa::RenderAttachment{
    .format = format,
    .blend = daxa::BlendInfo{
        .src_color_blend_factor = daxa::BlendFactor::ONE,
        .dst_color_blend_factor = daxa::BlendFactor::ONE_MINUS_SRC_ALPHA,
    },
}

// Additive blending - e.g. particles, light accumulation.
daxa::RenderAttachment{
    .format = format,
    .blend = daxa::BlendInfo{
        .src_color_blend_factor = daxa::BlendFactor::ONE,
        .dst_color_blend_factor = daxa::BlendFactor::ONE,
    },
}
```

Because `.blend` is per-`RenderAttachment`, a pipeline with multiple color attachments (multiple render targets, MRT) can blend each attachment independently - e.g. blend into a lit color buffer while overwriting a G-buffer normals attachment with no blending at all.

### Depth testing

```cpp
struct DepthTestInfo
{
    Format depth_attachment_format = Format::UNDEFINED;
    bool enable_depth_write = {};
    CompareOp depth_test_compare_op = CompareOp::LESS_OR_EQUAL;
    f32 min_depth_bounds = 0.0f;
    f32 max_depth_bounds = 1.0f;
};
```

`.depth_test` is `None` by default - no depth attachment, no depth testing. Setting it enables depth testing against a depth attachment of `.depth_attachment_format` (which must match the renderpass's `.depth_attachment` image view).

- `.enable_depth_write`: whether passing fragments write their depth back into the attachment. Set this to `false` for things like transparent geometry that should be depth-*tested* but not occlude what's drawn after it.
- `.depth_test_compare_op`: a `CompareOp` (`NEVER`, `LESS`, `EQUAL`, `LESS_OR_EQUAL`, `GREATER`, `NOT_EQUAL`, `GREATER_OR_EQUAL`, `ALWAYS`) - the function used to compare the incoming fragment's depth against the value already in the attachment. `LESS_OR_EQUAL` (the default) is the conventional "closer wins" test for a reversed-or-not depth buffer where smaller values are nearer.
- `.min_depth_bounds` / `.max_depth_bounds`: the depth bounds test range.

`CompareOp` is reused elsewhere too - the same enum is the natural one to reach for if you implement your own depth comparisons in shader code.

### Tessellation

```cpp
struct TesselationInfo
{
    u32 control_points = 3;
    TesselationDomainOrigin origin = {};
};
```

Only relevant when `.tesselation_control_shader_info` / `.tesselation_evaluation_shader_info` are set. `.control_points` is the number of control points per input patch (3 for triangle patches, the default). `.origin` is a `TesselationDomainOrigin` (`LOWER_LEFT` or `UPPER_LEFT`) controlling the orientation of the `(u, v)` tessellation coordinate space, which must match what the tessellation evaluation shader expects.

### Rasterizer state

```cpp
struct RasterizerInfo
{
    PrimitiveTopology primitive_topology = PrimitiveTopology::TRIANGLE_LIST;
    bool primitive_restart_enable = {};
    PolygonMode polygon_mode = PolygonMode::FILL;
    FaceCullFlags face_culling = FaceCullFlagBits::NONE;
    FrontFaceWinding front_face_winding = FrontFaceWinding::CLOCKWISE;
    bool depth_clamp_enable = {};
    bool rasterizer_discard_enable = {};
    bool depth_bias_enable = {};
    f32 depth_bias_constant_factor = 0.0f;
    f32 depth_bias_clamp = 0.0f;
    f32 depth_bias_slope_factor = 0.0f;
    f32 line_width = 1.0f;
    Optional<ConservativeRasterInfo> conservative_raster_info = {};
    Optional<LineRasterInfo> line_raster_info = {};
    Optional<RasterizationSamples> static_state_sample_count = {};
};
```

- `.primitive_topology`: how vertices are assembled into primitives - `TRIANGLE_LIST` (the default), `TRIANGLE_STRIP`, `TRIANGLE_FAN`, `LINE_LIST`, `LINE_STRIP`, `POINT_LIST`, the `_WITH_ADJACENCY` variants (for geometry shaders), or `PATCH_LIST` (for tessellation).
- `.primitive_restart_enable`: for strip/fan topologies with an index buffer, treat the index value `0xFFFFFFFF`/`0xFFFF` as "start a new primitive" instead of as a vertex index.
- `.polygon_mode`: `FILL` (the default), `LINE` (wireframe), or `POINT` (vertices only). `LINE`/`POINT` require the `fillModeNonSolid` device feature.
- `.face_culling`: a `FaceCullFlags` - `FaceCullFlagBits::NONE` (default, no culling), `FRONT_BIT`, `BACK_BIT`, or `FRONT_AND_BACK`.
- `.front_face_winding`: which winding order (`CLOCKWISE` (default) or `COUNTER_CLOCKWISE`) of a triangle's vertices, in screen space, is considered "front-facing" for culling purposes.
- `.depth_clamp_enable`: clamp fragment depths to `[0, 1]` instead of clipping geometry against the near/far planes. Useful for techniques like shadow casters that should never be near/far-clipped.
- `.rasterizer_discard_enable`: discard all fragments immediately after the rasterizer - i.e. run the vertex/geometry/tessellation stages but produce no fragment shader invocations. Useful for pipelines used purely for their side effects (e.g. transform feedback / stream-out style work).
- `.depth_bias_enable` + `.depth_bias_constant_factor` / `.depth_bias_clamp` / `.depth_bias_slope_factor`: adds a bias to each fragment's depth value before the depth test - the classic technique for avoiding shadow acne / z-fighting on coplanar geometry (e.g. shadow map rendering). These three values can also be overridden per-draw via `RenderCommandRecorder::set_depth_bias(DepthBiasInfo{...})`.
- `.line_width`: width in pixels for `LINE_*` topologies / `polygon_mode = LINE`. Requires the `wideLines` device feature for values other than `1.0`.
- `.conservative_raster_info`: `Optional<ConservativeRasterInfo>` - enables [conservative rasterization](https://www.khronos.org/blog/vulkan-subgroup-tutorial), where `.mode` is `OVERESTIMATE` (any pixel even partially covered by a primitive is rasterized) or `UNDERESTIMATE` (only pixels fully covered are), and `.size` extends/shrinks the effective primitive size in pixels. Useful for things like voxelization, where you need guaranteed coverage of every touched pixel.
- `.line_raster_info`: `Optional<LineRasterInfo>` - fine-grained line rendering control: `.mode` selects between `DEFAULT`, `RECTANGULAR`, `BRESENHAM`, and `RECTANGULAR_SMOOTH` line rasterization algorithms, and `.stippled` + `.stipple_factor` + `.stipple_pattern` enable dashed/dotted lines (a 16-bit repeating on/off pattern, each bit repeated `.stipple_factor` times).
- `.static_state_sample_count`: `Optional<RasterizationSamples>` (`E1`, `E2`, `E4`, `E8` - 1/2/4/8x MSAA). When `None` (the default), the pipeline uses whatever MSAA sample count the command recorder is currently set to via `set_rasterization_samples` (a dynamic state, on devices that support it); when set, the sample count is baked into the pipeline and `set_rasterization_samples` must not be used to change it.

## Ray Tracing Pipelines

A ray tracing pipeline bundles together every shader stage that can be invoked while tracing rays - ray generation, intersection, any-hit, closest-hit, miss, and callable shaders - plus a description of how those shaders are organized into **shader groups**.

```cpp
struct RayTracingPipelineInfo
{
    Span<ShaderInfo const> ray_gen_shaders = {};
    Span<ShaderInfo const> intersection_shaders = {};
    Span<ShaderInfo const> any_hit_shaders = {};
    Span<ShaderInfo const> callable_shaders = {};
    Span<ShaderInfo const> closest_hit_shaders = {};
    Span<ShaderInfo const> miss_hit_shaders = {};
    Span<RayTracingShaderGroupInfo const> shader_groups = {};
    Span<RayTracingPipelineLibrary const> pipeline_libraries = {};
    u32 max_ray_recursion_depth = {};
    u32 push_constant_size = DAXA_MAX_PUSH_CONSTANT_BYTE_SIZE;
    SmallString name = {};
};
```

- The six `Span<ShaderInfo const>` fields are flat lists of compiled shaders for each stage. A pipeline can have multiple ray generation shaders, multiple miss shaders, and so on - `.shader_groups` (below) is what ties specific shaders together and is what the SBT ultimately indexes into.
- `.max_ray_recursion_depth`: the maximum depth of `TraceRay()` calls a shader in this pipeline is allowed to make recursively (a closest-hit shader tracing a reflection ray, which itself can hit something that traces another ray, etc.). Must be `<= RayTracingPipelineProperties::max_ray_recursion_depth` for the device.
- `.pipeline_libraries`: see [Ray tracing pipeline libraries](#ray-tracing-pipeline-libraries) below.
- `.push_constant_size` / `.name`: same meaning as for compute/raster pipelines.

### Shader groups

Vulkan ray tracing organizes shaders into **groups**, and it's groups - not individual shaders - that the shader binding table indexes into:

```cpp
enum struct ShaderGroup
{
    GENERAL = 0,
    TRIANGLES_HIT_GROUP = 1,
    PROCEDURAL_HIT_GROUP = 2,
};

struct RayTracingShaderGroupInfo
{
    ShaderGroup type;
    u32 general_shader_index = (~0U);
    u32 closest_hit_shader_index = (~0U);
    u32 any_hit_shader_index = (~0U);
    u32 intersection_shader_index = (~0U);
};
```

- `GENERAL`: a single ray generation, miss, or callable shader. Set `.general_shader_index` to that shader's index within the corresponding `ray_gen_shaders` / `miss_hit_shaders` / `callable_shaders` span.
- `TRIANGLES_HIT_GROUP`: a hit group for built-in triangle geometry. Set `.closest_hit_shader_index` (into `closest_hit_shaders`) and optionally `.any_hit_shader_index` (into `any_hit_shaders`); leave `.intersection_shader_index` at its default (`~0U`), since triangle intersection is handled by fixed-function hardware.
- `PROCEDURAL_HIT_GROUP`: a hit group for custom geometry (AABBs). Set `.intersection_shader_index` (into `intersection_shaders`, required) and optionally `.closest_hit_shader_index` / `.any_hit_shader_index`.

```cpp
daxa::RayTracingPipeline pipeline = device.create_ray_tracing_pipeline({
    .ray_gen_shaders = std::array{ray_gen_shader_info},
    .miss_hit_shaders = std::array{miss_shader_info},
    .closest_hit_shaders = std::array{closest_hit_shader_info},
    .shader_groups = std::array{
        // Group 0: ray generation
        daxa::RayTracingShaderGroupInfo{.type = daxa::ShaderGroup::GENERAL, .general_shader_index = 0},
        // Group 1: miss
        daxa::RayTracingShaderGroupInfo{.type = daxa::ShaderGroup::GENERAL, .general_shader_index = 0},
        // Group 2: triangle hit group
        daxa::RayTracingShaderGroupInfo{.type = daxa::ShaderGroup::TRIANGLES_HIT_GROUP, .closest_hit_shader_index = 0},
    },
    .max_ray_recursion_depth = 1,
    .name = "my rt pipeline",
});
```

The **order** of `.shader_groups` matters: it's exactly the order groups are laid out in a default shader binding table (see below), and `TraceRaysInfo`'s `*_shader_binding_table_offset` fields index into this order.

### Ray tracing pipeline libraries

```cpp
daxa::RayTracingPipelineLibrary library = device.create_ray_tracing_pipeline_library(info);
```

A `RayTracingPipelineLibrary` is built from the exact same `RayTracingPipelineInfo` as a full pipeline, but produces a reusable collection of compiled shaders/groups rather than a directly-usable pipeline. Listing one or more libraries in a `RayTracingPipelineInfo::pipeline_libraries` links their shaders and groups into the resulting pipeline (or library) in addition to its own. This is useful for sharing a large, common set of hit/miss/callable shaders across multiple ray tracing pipelines without recompiling them for each one.

### The Shader Binding Table (SBT)

The SBT tells the GPU which shader group to run for each ray generation invocation, miss event, hit, and callable shader call. It's a GPU buffer, addressed via four regions - one per shader stage category:

```cpp
struct StridedDeviceAddressRegion
{
    DeviceAddress address {};
    u64 stride {};
    u64 size {};
};

struct RayTracingShaderBindingTable
{
    StridedDeviceAddressRegion raygen_region = {};
    StridedDeviceAddressRegion miss_region = {};
    StridedDeviceAddressRegion hit_region = {};
    StridedDeviceAddressRegion callable_region = {};
};
```

Each region is a `(address, stride, size)` slice of a buffer containing one **shader group handle** per entry (plus optional application data after the handle, for custom SBTs). `trace_rays` selects:

- the raygen shader from `raygen_region` (always entry 0 - exactly one raygen shader runs per `trace_rays` call),
- the miss shader from `miss_region`, indexed by the ray's `miss index` (set in the shader via `TraceRay`),
- the hit group from `hit_region`, indexed by the geometry's instance/geometry/ray index according to Vulkan's standard hit group indexing rules,
- callable shaders from `callable_region`, indexed by `ExecuteCallable`'s shader index argument.

#### Building a default SBT

For the common case - one SBT laid out in exactly the order of `RayTracingPipelineInfo::shader_groups` - `RayTracingPipeline` can build one for you:

```cpp
struct SbtPair { daxa::BufferId buffer; daxa::RayTracingShaderBindingTable table; };
auto create_default_sbt() const -> SbtPair;
```

```cpp
auto [sbt_buffer, sbt_table] = pipeline.create_default_sbt();
```

This allocates a buffer, copies each shader group's handle into it grouped by stage (all `GENERAL` raygen groups, then miss groups, then hit groups, then callable groups, in the order they appear in `.shader_groups`), and returns the buffer alongside a `RayTracingShaderBindingTable` whose four regions point into it. The buffer is owned by you (a regular `BufferId`) and should eventually be destroyed like any other buffer.

#### Building a custom SBT

For more control - e.g. packing per-instance shader records after each handle - use:

```cpp
void get_shader_group_handles(void * out_blob, uint32_t first_group = 0, int32_t group_count = -1) const;
```

This copies the raw shader group handles (starting at `first_group`, defaulting to all groups) into `out_blob`, so you can interleave them with your own per-record data when building the buffer yourself. The sizing and alignment rules for a hand-built SBT come from `RayTracingPipelineProperties` (available via `device.properties().ray_tracing_properties`):

- `.shader_group_handle_size`: size in bytes of each handle written by `get_shader_group_handles`.
- `.shader_group_handle_alignment`: required alignment of each handle within the buffer.
- `.shader_group_base_alignment`: required alignment of each region's base `.address`.
- `.max_shader_group_stride`: maximum allowed `.stride` for a region.
- `.max_ray_recursion_depth` / `.max_ray_dispatch_invocation_count` / `.max_ray_hit_attribute_size`: device limits that bound `RayTracingPipelineInfo::max_ray_recursion_depth`, the total invocation count (`width * height * depth`) passed to `trace_rays`, and the size of hit attribute data passed from intersection to hit shaders, respectively.

### Tracing rays

```cpp
recorder.set_pipeline(pipeline);
recorder.push_constant(my_push_constant);
recorder.trace_rays({
    .width = width,
    .height = height,
    .depth = 1,
    .shader_binding_table = sbt_table,
});
```

`TraceRaysInfo` additionally has `.raygen_shader_binding_table_offset`, `.miss_shader_binding_table_offset`, `.miss_shader_binding_table_stride`, and `.hit_shader_binding_table_offset` for selecting a starting entry/stride within the SBT's regions - useful when one SBT buffer holds groups for multiple different "passes" (e.g. primary rays vs. shadow rays) and you select between them per `trace_rays` call. `trace_rays_indirect(TraceRaysIndirectInfo{...})` is the same, but reads `width`/`height`/`depth` from a GPU buffer via `.indirect_device_address`, letting the GPU itself decide how many rays to trace.
