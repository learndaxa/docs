---
title: Why TaskGraph?
description: Why TaskGraph? A comprehensive guide to TaskGraph's design, benefits, and how it solves synchronization complexity
slug: wiki/why-taskgraph
---

## Why Automatic Synchronization?

Writing correct Vulkan synchronization by hand is notoriously difficult. The complexity comes not just from remembering which pipeline stages and access types to use, but from the *combinatorial explosion* of feature interactions.

Suppose you have a deferred renderer with a G-buffer pass and a composite pass. You need a barrier between them. Now add ambient occlusion - it needs to read the G-buffer and write its own result, so you need new barriers around it. Add shadow mapping, decal rendering, post-processing. Each feature adds more passes, and each pass creates new ordering constraints and requires new barriers with the right stages and access patterns. 

This becomes especially nightmarish once you add feature toggles. If ambient occlusion is optional (a `#define` or a runtime setting), then sometimes the barrier before composite reads from the G-buffer, and sometimes it reads from the AO result. Or maybe the pass order changes depending on the quality setting. Now you need to track which barriers are needed under which feature combinations - and worse, you need to ensure they're *correct* for each combination. Is the sync still proper when RTAO is disabled? What about when you enable MSAA? The number of combinations explodes, and the human brain cannot track all the synchronization invariants across all of them.

In large codebases, this gets even worse. Suppose you change a pass in one file - maybe you make it write to a new resource, or read from a different one. Now you need to manually trace through the codebase to find every barrier that touches those resources and update them. You need to find every downstream pass that might be affected. You need to mentally construct the full resource access timeline and convince yourself it's still correct. It's a form of manual dependency tracking that doesn't scale.

The human brain is bad at this. You end up with synchronization bugs that:
- Only manifest under specific hardware/driver combinations
- Only trigger when certain features are enabled together
- Appear to work for months, then cause subtle rendering corruption or hangs
- Are nearly impossible to optimize, because reordering or removing a pass means manually auditing all the barriers
- Persist after code refactors, because the resource access paths are scattered across the codebase with no enforcement that they stay consistent

Automatic synchronization solves this by making the synchronization **data-driven**: you declare *what* each operation does (operation A writes the G-buffer, operation B reads it, operation C reads the AO result), and the system figures out *how* to synchronize it correctly - regardless of which features are enabled or how operations are reordered.

## Different Approaches to Synchronization

There's a spectrum of how much synchronization work is automated:

**Full Automation (OpenGL, NVRHI)** - You don't think about synchronization at all. You issue draw calls and the driver figures out all barriers, waits, and pipeline stage masking. Pro: extremely easy to learn and use. You can write rendering code without ever worrying about synchronization.

Con: the driver must track resource accesses on the fly and generate synchronization just-in-time. Because it doesn't know what you'll do until you do it, it can't do expensive optimizations. Every barrier must be cheap to generate. But modern GPUs benefit from smarter scheduling - batching barriers, reordering tasks for cache locality, proving that certain barriers are redundant. These things are infesable with JIT Sync generation, so you get unnecessary stalls and wasted GPU time.

Also, the driver must know about *every* resource access, *all the time*. This conflicts with modern GPU programming using bindless resources (where you access thousands of resources through tables/pointers rather than fixed descriptor sets). If you access a resource through a shader-loaded pointer, how does the driver know you touched it? It either can't (breaking sync), or it requires you to manually annotate every bindless access (defeating the point of being "automatic" and adding strange API warts). Full automation and bindless resources are fundamentally at odds.

**Explicit Render Graphs (modern RenderGraph pattern)** - The core idea is to *section* all your rendering code. Instead of one monolithic `render()` function that builds command buffers, you divide it into discrete **passes**. Each pass is a self-contained unit of work: render the G-buffer, compute ambient occlusion, composite the result, etc. Within a pass, you record commands freely - no synchronization needed between commands in the same pass.

Each pass explicitly declares which resources it touches and how:
- Read: "I need to read this buffer/image"
- Write: "I will write to this buffer/image"
- Read-write: "I both read and write this"

The render graph collects all these declarations. It then **analyzes the dependency structure**: which passes write resources that other passes read? This forms a dependency graph - a directed acyclic graph where edges represent "this pass must run before that pass".

With this dependency graph, the render graph can:
- **Automatically infer synchronization.** If pass A writes resource X and pass B reads it, the graph knows a barrier is needed between A and B. It generates the exact pipeline stages, access types, and image layouts needed - all derived from the resource type and access mode.
- **Reorder passes.** If passes don't share any resources, they're independent - the graph can reorder them or run them concurrently for better GPU utilization.
- **Optimize resource allocation.** The graph tracks which resources are live (in use) at each point. It can allocate temporary buffers/images from a pool, reuse memory between passes that don't overlap, alias buffers to save memory.
- **Insert efficient synchronization.** Instead of a barrier before every pass, it can batch barriers, prove that some are redundant, or use more efficient synchronization primitives (e.g., event-based sync for independent queues).

This is a middle ground between full automation and manual sync: you give up some low-level control (the graph decides barrier placement), but you gain correctness guarantees and much better performance. All synchronization is *derived* from your declarations, not guessed by a driver or written by hand.

Because render graphs are fully explicit, you decide exactly what gets tracked. You don't waste work tracking resources that don't need synchronization - constant material textures, static geometry buffers, or immutable data structures. You only declare the accesses that matter, and the graph only generates sync for those. Full automation has no such choice - the driver must conservatively track everything, leading to unnecessary barriers and wasted GPU time.

The explicitness also enables much more precise optimizations. For example, you can explicitly declare that certain write accesses are *allowed* to happen concurrently - two shaders writing disjoint regions of the same buffer, or using atomics to coordinate writes. This gives you, the programmer, the responsibility to ensure correctness, but it gives the graph the information it needs to avoid false ordering dependencies. This is incredibly valuable for tiled rendering (where multiple tiles write the same framebuffer), atomic-based algorithms, or any pattern where multiple passes safely update shared resources without full serialization. The graph can then generate the minimal synchronization needed to make this work - perhaps just an event or semaphore, not heavy pipeline barriers. This precision and control is impossible with full automation and impractical to maintain by hand.

## Precompilable vs. Runtime Render Graphs

Within the render graph family, there's another choice: when do you build the graph?

**Full Runtime Graphs** - You record a new graph every frame. Inside `render()`, you call `graph.add_pass(...)` for each of your draws, then `graph.complete()` and `graph.execute()`. This is more comfortable to write: you can use frame-local variables, branching logic, dynamic pass counts. If you're rendering a different set of objects, rendering at a different resolution, or toggling features, you just write different `add_pass` calls. The downside is that every frame, the graph compiler runs: it walks all your passes, builds dependency graphs, generates barriers, allocates scratch space for transient resources - all of that per frame. For a complex scene, this can cost milliseconds.

**Precompilable Graphs** - You record the graph once, at startup or load time. The structure is fixed: you always record the same passes in the same order, with the same resources attached. The graph is compiled once and then executed repeatedly without recompilation. This is less flexible: if you want to conditionally include a pass or change what a pass accesses, you either commit to that variation ahead of time (multiple graph variants) or you're stuck. But the payoff is huge:

1. **Compilation cost vanishes.** That milliseconds-per-frame graph compilation is gone. The work happens once, at load or when a setting is changed in the menu.
2. **Smarter optimizations.** Because the graph compiler/optimizer knows the graph won't change, it can do expensive analyses: detect which resources can be safely reused (alias buffers), prove that certain barriers are redundant, reorder passes for cache locality. These are too costly to do every frame.
3. **Predictability.** Pass order, barrier placement, and resource allocation are deterministic. You can log them, compare across frames, prove correctness offline.
4. **Debuggability.** You can inspect the compiled graph at load time, see exactly what barriers were inserted and why, add debug markers and annotations, reason about performance.

## Daxa's Choice: Precompilable TaskGraph

Daxa opts for precompilable TaskGraphs. You record your graph at startup or scene-load time, with fixed passes and attachments. The graph is compiled once, then executed every frame.

This is a strong tradeoff:
- **Performance**: The cost of graph compilation is amortized across thousands of frames. You get the benefit of expensive optimizations without paying for them every frame.
- **Predictability**: Pass order and synchronization are baked in, not data-dependent. Easier to reason about, profile, and debug.
- **Convenience**: You still avoid most of the synchronization complexity. You declare what you read and write, TaskGraph generates the barriers. Just without per-frame recompilation overhead.

The main constraint is that your graph structure must be knowable at recording time. If you genuinely need a different set of passes or attachments every frame - say, you're rendering from a dynamic BVH where the pass count depends on scene data - precompilable graphs are less suitable. But for most rendering workloads (where the pipeline structure is known and feature toggles are small), precompilable TaskGraphs deliver the best combination of ease-of-use and raw performance.

## In Practice: Static Graphs Are the Right Choice

This is a somewhat opinionated take - render graphs vary widely in design and philosophy, and different frameworks make different tradeoffs. But I've worked with render graphs extensively as a graphics programmer, and I'm very confident that for most game-like programs and graphics-heavy applications, static graphs are the right choice.

In reality, rendering pipelines don't change much between frames - and they shouldn't. Modern performance-sensitive renderers, from AAA games to compute-heavy visualizations, use static render graphs. Call of Duty uses a static graph. Your raytracer should too.

Why? **Predictable performance during gameplay.** The graph should be static *while the player is playing*. If your graph structure changes every frame during gameplay, your frame time becomes unpredictable - one frame takes 8ms, the next takes 12ms because the graph just recompiled. This makes it impossible to reason about performance: is that a bottleneck, or just pipeline churn?

But it's completely fine for the graph to recompile outside gameplay. If the user toggles RTAO on/off in the settings menu, go ahead and recompile the graph with a new configuration - even if it takes 200ms, it doesn't matter because the player isn't playing. The recompilation happens in the menu, on a loading screen, or during a scene transition. Once recompiled, the graph stays static during gameplay again.

This is the key: **static during gameplay, reconfigurable during menus/loading.** You get all the performance predictability of static graphs for what matters (frame times), while keeping the flexibility to change quality settings. The flexibility you think you need usually isn't worth per-frame recompilation costs.

## Daxa's TaskGraph: A Render Graph in Practice

Daxa's TaskGraph is a precompilable render graph. It's the concrete realization of the render graph pattern described above. The following example is more involved, but that's intentional—TaskGraph's benefits only become obvious when you have enough passes, dependencies, and feature toggles.

### Before: Manual Barriers

Here's a simple renderer written by hand, with explicit barriers. Notice what happens when you add feature toggles:

```cpp
void render_frame(bool enable_rtao) {
    // G-buffer pass: render scene geometry
    cmd.begin_rendering(...);
    cmd.set_pipeline(g_buffer_pipeline);
    cmd.draw();
    cmd.end_rendering();

    // Barrier: g_buffer is now readable
    // Start with lighting (fragment) and shadow cull (compute) requirements, conditionally add RTAO trace (raytracing) if needed
    auto g_buffer_dst_stages = eFragmentShader | eComputeShader;
    auto g_buffer_dst_access = eShaderRead;
    if (enable_rtao) {
        g_buffer_dst_stages |= eRayTracingShader;
        // access type stays the same (eShaderRead) for all paths
    }

    cmd.pipeline_barrier({
        .src_stages = eColorAttachmentOutput,
        .src_access = eColorAttachmentWrite,
        .dst_stages = g_buffer_dst_stages,
        .dst_access = g_buffer_dst_access,
    });

    if (enable_rtao) {
        // RTAO trace pass (raytracing): read g_buffer, write trace result
        cmd.set_pipeline(rtao_trace_pipeline);
        cmd.push_constant(...);
        cmd.trace_rays(...);

        // Barrier: trace result is now readable by spatial denoise
        cmd.pipeline_barrier({
            .src_stages = eRayTracingShader,
            .src_access = eShaderWrite,
            .dst_stages = eComputeShader,
            .dst_access = eShaderRead,
        });

        // RTAO spatial denoise pass (compute): read trace result, write spatial result
        cmd.set_pipeline(rtao_spatial_denoise_pipeline);
        cmd.push_constant(...);
        cmd.dispatch();

        // Barrier: spatial result is now readable by temporal denoise
        cmd.pipeline_barrier({
            .src_stages = eComputeShader,
            .src_access = eShaderWrite,
            .dst_stages = eComputeShader,
            .dst_access = eShaderRead,
        });

        // RTAO temporal denoise pass (compute): read spatial result, write rtao_result
        cmd.set_pipeline(rtao_temporal_denoise_pipeline);
        cmd.push_constant(...);
        cmd.dispatch();

        // Barrier: rtao_result is now readable by fragment shader (for lighting)
        cmd.pipeline_barrier({
            .src_stages = eComputeShader,
            .src_access = eShaderWrite,
            .dst_stages = eFragmentShader,
            .dst_access = eShaderRead,
        });
    }

    // Shadow geometry cull pass (compute): read g_buffer, write culled geometry
    cmd.set_pipeline(shadow_cull_pipeline);
    cmd.push_constant(...);
    cmd.dispatch();

    // Barrier: culled geometry is now readable by shadow draw
    cmd.pipeline_barrier({
        .src_stages = eComputeShader,
        .src_access = eShaderWrite,
        .dst_stages = eDrawIndirect,
        .dst_access = eIndirectCommandRead,
    });

    // Shadow geometry draw pass (raster): read culled geometry, write shadow map
    cmd.begin_rendering(...);
    cmd.set_pipeline(shadow_geometry_pipeline);
    cmd.push_constant(...);
    cmd.draw_indirect(...);
    cmd.end_rendering();

    // Barrier: shadow map is now readable by lighting
    cmd.pipeline_barrier({
        .src_stages = eColorAttachmentOutput,
        .src_access = eColorAttachmentWrite,
        .dst_stages = eFragmentShader,
        .dst_access = eSampledRead,
    });

    // Lighting pass - reads g_buffer and optionally rtao_result
    cmd.begin_rendering(...);
    cmd.set_pipeline(lighting_pipeline);
    cmd.push_constant(...);
    cmd.draw();
    cmd.end_rendering();

    // Barrier: lit_result is now readable by composite
    cmd.pipeline_barrier({
        .src_stages = eColorAttachmentOutput,
        .src_access = eColorAttachmentWrite,
        .dst_stages = eComputeShader,
        .dst_access = eShaderRead,
    });

    // Composite pass (compute): read lit_result and shadow map
    cmd.set_pipeline(composite_compute_pipeline);
    cmd.push_constant(...);
    cmd.dispatch();
}
```

Now you're manually managing barriers across multiple code paths. If RTAO is on, you need different barriers than if it's off. If you add another toggle (high-quality lighting?), the number of paths explodes. Each path needs its own manually-crafted barriers. One mistake and you get corruption in a specific feature combination that only your QA team finds three weeks before ship.

### The TaskGraph Version

Here's the same renderer as a TaskGraph:

```cpp
auto graph = daxa::TaskGraph({.device = device});

// G-buffer pass
graph.add_task(daxa::Task::Raster("g-buffer")
    .writes(task_g_buffer)
    .executes([=](daxa::TaskInterface ti) {
        ti.recorder.begin_rendering(...);
        ti.recorder.set_pipeline(g_buffer_pipeline);
        ti.recorder.draw();
        ti.recorder.end_rendering();
    }));

if (enable_rtao) {
    // RTAO trace pass (raytracing): read g_buffer, write trace result
    graph.add_task(daxa::Task::RayTracing("rtao trace")
        .reads(task_g_buffer)
        .writes(task_rtao_trace)
        .executes([=](daxa::TaskInterface ti) {
            ti.recorder.set_pipeline(rtao_trace_pipeline);
            ti.recorder.push_constant(...);
            ti.recorder.trace_rays(...);
        }));

    // RTAO spatial denoise pass (compute): read trace result, write spatial result
    graph.add_task(daxa::Task::Compute("rtao spatial denoise")
        .reads(task_rtao_trace)
        .writes(task_rtao_spatial)
        .executes([=](daxa::TaskInterface ti) {
            ti.recorder.set_pipeline(rtao_spatial_denoise_pipeline);
            ti.recorder.push_constant(...);
            ti.recorder.dispatch();
        }));

    // RTAO temporal denoise pass (compute): read spatial result, write rtao_result
    graph.add_task(daxa::Task::Compute("rtao temporal denoise")
        .reads(task_rtao_spatial)
        .writes(task_rtao_result)
        .executes([=](daxa::TaskInterface ti) {
            ti.recorder.set_pipeline(rtao_temporal_denoise_pipeline);
            ti.recorder.push_constant(...);
            ti.recorder.dispatch();
        }));
}

// Shadow geometry cull pass (compute): read g_buffer, write culled geometry
graph.add_task(daxa::Task::Compute("shadow geometry cull")
    .reads(task_g_buffer)
    .writes(task_shadow_culled_geometry)
    .executes([=](daxa::TaskInterface ti) {
        ti.recorder.set_pipeline(shadow_cull_pipeline);
        ti.recorder.push_constant(...);
        ti.recorder.dispatch();
    }));

// Shadow geometry draw pass (raster): read culled geometry, write shadow map
graph.add_task(daxa::Task::Raster("shadow geometry draw")
    .reads(task_shadow_culled_geometry)
    .writes(task_shadow_map)
    .executes([=](daxa::TaskInterface ti) {
        ti.recorder.begin_rendering(...);
        ti.recorder.set_pipeline(shadow_geometry_pipeline);
        ti.recorder.push_constant(...);
        ti.recorder.draw_indirect(...);
        ti.recorder.end_rendering();
    }));

// Lighting pass - RTAO is optional
auto rtao_result = enable_rtao ? task_rtao_result : daxa::NullTaskImage();
graph.add_task(daxa::Task::Raster("lighting")
    .reads(task_g_buffer)
    .reads(rtao_result)  // If null, TaskGraph ignores this read
    .reads(task_shadow_map)
    .writes(task_lit_result)
    .executes([=](daxa::TaskInterface ti) {
        ti.recorder.begin_rendering(...);
        ti.recorder.set_pipeline(lighting_pipeline);
        // ti.id() of a NullTaskImage returns a special null value that shaders can detect
        ti.recorder.push_constant(...);
        ti.recorder.draw();
        ti.recorder.end_rendering();
    }));

// Composite pass (compute) - read lit_result and shadow map
graph.add_task(daxa::Task::Compute("composite")
    .reads(task_lit_result)
    .reads(task_shadow_map)
    .writes(swapchain_image)
    .executes([=](daxa::TaskInterface ti) {
        ti.recorder.set_pipeline(composite_compute_pipeline);
        ti.recorder.push_constant(...);
        ti.recorder.dispatch();
    }));

// Compile and execute
graph.complete({});
graph.execute({});
```

### What TaskGraph Does

Count the barriers in the manual example: the RTAO pipeline has three stages with barriers between them, the shadow passes have barriers for indirect command reading and then shadow map sampling, the lighting barrier, and conditional stage selection if certain features toggle. Now count them in the TaskGraph example: **zero**. Not one. TaskGraph generates every barrier automatically from your `.reads()` and `.writes()` declarations.

When you call `complete()`, TaskGraph:

1. **Analyzes the resource access graph** to determine which tasks depend on which. G-buffer flows to lighting and RTAO trace. RTAO trace outputs to spatial denoise, which outputs to temporal denoise, which outputs to lighting. Shadow culling reads g_buffer and outputs to shadow draw, which outputs to lighting. TaskGraph discovers all these dependencies and generates the right barriers with the right stages and access types.

2. **Inserts efficient synchronization** - not a barrier before every task (which is what happens if you reason locally), but only where a dependency actually exists. RTAO and shadow passes read from different intermediate outputs, so TaskGraph places barriers only where data flows between them.

3. **Handles multi-stage pipelines automatically.** The manual version has explicit barriers between RTAO stages (trace → spatial → temporal), each carefully tuned for raytracing and compute stages. TaskGraph sees that temporal denoise's output goes to lighting, and generates all the intervening barriers without hand-written synchronization code.

4. **Proves which barriers can be optimized away.** Because it sees the entire graph at once, it can recognize that some barriers are implied by others, or that certain feature combinations make entire chains redundant.

The manual example has multiple barriers - three for the RTAO chain, one for shadow indirect commands, one for shadow map sampling - plus potential conditional logic. The TaskGraph example has zero. As your renderer grows - add temporal reprojection, cascaded shadows, screen-space reflections, decal rendering - the manual version accumulates barrier logic for every new feature and every new resource dependency. TaskGraph stays clean: one declaration per resource per task, synchronization emerges from the graph automatically.

### TaskGraph Optimizations

Look at the execution order as you wrote it, with the barriers TaskGraph must insert:

**Sequential order (with barriers):**
1. G-buffer
   - **Barrier** (g_buffer: written → readable by Fragment/Raytracing/Compute)
2. RTAO trace (raytracing)
   - **Barrier** (rtao_trace: Raytracing → Compute)
3. RTAO spatial denoise (compute)
   - **Barrier** (rtao_spatial: Compute → Compute)
4. RTAO temporal denoise (compute)
   - **Barrier** (rtao_result: Compute → Fragment)
5. Shadow cull (compute)
   - **Barrier** (shadow_culled: Compute → DrawIndirect)
6. Shadow draw (raster)
   - **Barrier** (shadow_map: ColorAttachmentOutput → Fragment)
7. Lighting

That's 6 barriers. But RTAO and shadow are completely independent—they read from g_buffer and write to different outputs. TaskGraph can reorder the execution to interleave them, and in doing so, reduce the number of barriers:

**Reordered (with barriers):**
1. G-buffer
   - **Barrier** (g_buffer: written → readable by Fragment/Raytracing/Compute/DrawIndirect)
2. RTAO trace (raytracing)
3. Shadow cull (compute)
   - **Barrier** (rtao_trace: Raytracing → Compute; shadow_culled: Compute → DrawIndirect) — *batched*
4. RTAO spatial denoise (compute)
5. Shadow draw (raster)
   - **Barrier** (rtao_spatial: Compute → Compute)
6. RTAO temporal denoise (compute)
   - **Barrier** (rtao_result: Compute → Fragment; shadow_map: ColorAttachmentOutput → Fragment) — *batched*
7. Lighting

That's 4 barriers instead of 6. More importantly, independent passes now run in parallel (RTAO trace + shadow cull), and barriers are batched across multiple independent writes. **You never reasoned about barrier placement, never manually interleaved passes, never tried to batch synchronization.** TaskGraph sees which resources are independent, reorders to maximize parallelism, and batches barriers—all automatically from your `.reads()` and `.writes()` declarations.

The manual version forces a specific execution order. Want to pipeline shadow and RTAO? You'd have to restructure the barrier code, carefully interleave dispatches, and hope you didn't miss a synchronization point. TaskGraph just works—it sees the dependency graph and finds the best execution order automatically.

### Transient Memory Reuse

TaskGraph also optimizes memory allocation. Each transient resource has a limited lifetime—`task_rtao_trace` is only alive between RTAO trace and spatial denoise, then it's dead forever. TaskGraph computes these lifetimes and reuses GPU memory:

| Resource | RTAO Trace | Spatial Denoise | Temporal Denoise | Shadow Cull | Shadow Draw | Lighting | Composite |
|----------|:----------:|:---------------:|:----------------:|:-----------:|:-----------:|:--------:|:---------:|
| task_rtao_trace | ✓ write | ✓ read | — | — | — | — | — |
| task_rtao_spatial | — | ✓ write | ✓ read | — | — | — | — |
| task_rtao_result | — | — | ✓ write | — | — | ✓ read | — |
| task_shadow_culled_geometry | — | — | — | ✓ write | ✓ read | — | — |
| task_shadow_map | — | — | — | — | ✓ write | ✓ read | — |

| Memory Region | RTAO Trace | Spatial Denoise | Temporal Denoise | Shadow Cull | Shadow Draw | Lighting | Composite |
|-----------|:----------:|:---------------:|:----------------:|:-----------:|:-----------:|:--------:|:---------:|
| memory region A | rtao_trace | rtao_spatial | rtao_result | (freed) | (freed) | rtao_result | (freed) |
| memory region B | — | — | — | shadow_culled | shadow_map | shadow_map | (freed) |

`rtao_trace` and `rtao_spatial` don't overlap, so they share **memory region A**. In manual code, you'd allocate them separately and try to alias them by hand—which is **dangerous** (silent corruption if you forget a lifetime) and error-prone at scale. TaskGraph computes lifetimes automatically and packs allocations mathematically correctly. A 10-stage denoising pipeline saves 30-50% GPU memory with zero manual bookkeeping.

One subtlety: memory aliasing and barrier reduction can conflict. Packing memory tightly might force a specific execution order to respect lifetimes, which prevents the optimal task reordering. Conversely, reordering for minimal barriers might extend resource lifetimes, reducing aliasing opportunities. TaskGraph provides options: optimize for memory pressure, minimize barriers, or balance both. You declare your priorities, and TaskGraph computes a schedule that respects them.
