---
title: TaskGraph from the Ground Up
description: A step-by-step walkthrough that builds a small TaskGraph one concept at a time, from an empty graph to a multi-task pipeline with automatic synchronization
slug: wiki/taskgraph-bottom-up
---

This page builds a TaskGraph from scratch, one concept at a time. It starts from the smallest possible graph and grows it piece by piece into a multi-task pipeline — introducing each concept exactly when the running example first needs it.

For motivation and a deeper look at why TaskGraph works the way it does — including a side-by-side comparison of manual Vulkan barriers versus the TaskGraph equivalent — see [TaskGraph — How and Why](/wiki/taskgraph-how-why/).

## 1. An Empty Graph

A `daxa::TaskGraph` is created from a device:

```c++
daxa::TaskGraph task_graph = daxa::TaskGraph({
    .device = device,
    .name = "my task graph",
});

task_graph.complete({});
task_graph.execute({});
```

- `complete()` finalizes recording. From this point on, no more tasks or resources can be added, and TaskGraph computes the batches and synchronization for everything recorded so far.
- `execute()` runs the recorded task callbacks, in whatever order/batches TaskGraph decided on.

With nothing recorded yet, `complete()` and `execute()` do nothing observable - but this is the skeleton every graph is built on.

## 2. A Single Task

`add_task` records a task. The smallest possible task has a name, a type, and a callback:

```c++
task_graph.add_task(daxa::Task::Compute("begin frame")
    .executes([=](daxa::TaskInterface ti)
    {
        // ti.recorder is a daxa::CommandRecorder - record whatever commands you like here.
    }));
```

`daxa::Task::Compute(...)` is one of several task type tags - `Compute`, `Raster`, `Transfer`, `RayTracing` - which pick the queue/pipeline stages the task may use, and also pick the *default* attachment stage for that task (more on that in step 3).

The `.executes(...)` lambda only runs while `execute()` is running, once per execution. It is copied into the task graph, so it must be small, copyable, and trivially destructible - capture pointers/handles, not owning containers like `std::vector` or `std::function`.

> A task with no attachments compiles and runs fine, but TaskGraph has no idea what resources it touches. It can't be synchronized against anything, and TaskGraph is free to place it anywhere relative to other tasks, since there is nothing to order it against. This is fine for one-off setup work, but not for anything that needs to run before or after another task.

## 3. Giving a Task Something to Track: a Task Resource

For TaskGraph to reason about what a task does, it needs *task resources* - virtual handles that stand in for real buffers/images at execution time. Create one with `create_task_buffer`:

```c++
daxa::TaskBufferView task_particles = task_graph.create_task_buffer({
    .size = sizeof(Particle) * MAX_PARTICLES,
    .name = "particles",
});
```

This doesn't allocate anything by itself - `task_particles` is just a handle TaskGraph can use to track usages. By default (`TaskResourceLifetimeType::TRANSIENT`), TaskGraph allocates and manages the real buffer behind it automatically. Other lifetime types and external resources are covered in sections 7 and 11.

Now give a task an *attachment* referencing it:

```c++
task_graph.add_task(daxa::Task::Compute("init particles")
    .writes(task_particles)
    .executes([=](daxa::TaskInterface ti)
    {
        ti.recorder.set_pipeline(*init_particles_pipeline);
        ti.recorder.push_constant(InitParticlesPush{
            .particles = ti.device_address(task_particles).value(),
        });
        ti.recorder.dispatch({.x = MAX_PARTICLES / 64});
    }));
```

`.writes(task_particles)` adds an attachment: it tells TaskGraph that this task writes `task_particles`. Because `daxa::Task::Compute` defaults its attachments to the compute shader stage, plain `.reads(...)`/`.writes(...)` here mean "compute shader read/write" - no extra prefix needed. Raster tasks instead use stage-specific accessors like `.color_attachment.writes(...)`, since a single raster task can touch several shader stages at once - see [Task Attachments](/wiki/taskgraph-how-why/#task-attachments).

Inside the callback, `ti.device_address(task_particles)` resolves the *real* buffer address for this execution. The task only ever refers to the virtual `task_particles` handle while being recorded; the real resource is looked up each time the callback runs.

## 4. A Second Task: the First Dependency

Add a second task that updates the same buffer:

```c++
task_graph.add_task(daxa::Task::Compute("update particles")
    .reads_writes(task_particles)
    .executes([=](daxa::TaskInterface ti)
    {
        ti.recorder.set_pipeline(*update_particles_pipeline);
        ti.recorder.push_constant(UpdateParticlesPush{
            .particles = ti.device_address(task_particles).value(),
            .dt = delta_time,
        });
        ti.recorder.dispatch({.x = MAX_PARTICLES / 64});
    }));
```

`.reads_writes(...)` is used here instead of a separate `.reads(...)` and `.writes(...)`, because a task may only attach a given `TaskBufferView` once - buffers can't be sliced, so a second attachment for the same view would be redundant (see [Additional Usage Rules](/wiki/taskgraph-how-why/#additional-usage-rules)).

`task_particles` now has two attachments, in the order their tasks were recorded: "init particles" writes it, then "update particles" reads and writes it. TaskGraph builds a *timeline* for `task_particles` from these attachments. A write followed by a read/write forms an ordering dependency, so TaskGraph **must** run "init particles" before "update particles" - there is no other valid order.

If you swapped the order of these two `add_task` calls, TaskGraph would form the dependency the other way around, and "update particles" would run first, reading uninitialized data. **Recording order only matters between tasks that touch the same resource** - this is the entire mechanism dependencies are built from.

## 5. A Second Resource: Independent Timelines

Add a third task that renders the particles into an image. First, create a task image:

```c++
daxa::TaskImageView task_color = task_graph.create_task_image({
    .format = daxa::Format::R16G16B16A16_SFLOAT,
    .size = render_size,
    .name = "color",
});
```

```c++
task_graph.add_task(daxa::Task::Compute("render particles")
    .reads(task_particles)
    .writes(task_color)
    .executes([=](daxa::TaskInterface ti)
    {
        ti.recorder.set_pipeline(*render_particles_pipeline);
        ti.recorder.push_constant(RenderParticlesPush{
            .particles = ti.device_address(task_particles).value(),
            .color = ti.id(task_color),
        });
        ti.recorder.dispatch({.x = render_size.x / 8, .y = render_size.y / 8});
    }));
```

`task_particles`'s timeline now has three entries: write (init) -> read_write (update) -> read (render). Each entry forms a dependency on the one before it, so the only valid order for these three tasks is `init -> update -> render`.

`task_color`'s timeline has only one entry so far - this task's write - so it doesn't impose any ordering by itself yet.

## 6. A Task That Can Be Reordered

Add a fourth task that writes a second image, completely unrelated to the particle resources:

```c++
daxa::TaskImageView task_background = task_graph.create_task_image({
    .format = daxa::Format::R16G16B16A16_SFLOAT,
    .size = render_size,
    .name = "background",
});

task_graph.add_task(daxa::Task::Compute("render background")
    .writes(task_background)
    .executes([=](daxa::TaskInterface ti)
    {
        ti.recorder.set_pipeline(*render_background_pipeline);
        ti.recorder.push_constant(RenderBackgroundPush{.background = ti.id(task_background)});
        ti.recorder.dispatch({.x = render_size.x / 8, .y = render_size.y / 8});
    }));
```

"render background" doesn't touch `task_particles`, `task_color`, or anything else recorded so far - it has no entries on any shared timeline. TaskGraph is therefore free to run it whenever it likes relative to the particle tasks: before them, after them, or (if the underlying queue allows) concurrently with them. Recording it last does **not** pin it to last place in execution.

Now add a fifth task that combines both images:

```c++
task_graph.add_task(daxa::Task::Compute("composite")
    .reads(task_background)
    .reads_writes(task_color)
    .executes([=](daxa::TaskInterface ti)
    {
        ti.recorder.set_pipeline(*composite_pipeline);
        ti.recorder.push_constant(CompositePush{
            .background = ti.id(task_background),
            .color = ti.id(task_color),
        });
        ti.recorder.dispatch({.x = render_size.x / 8, .y = render_size.y / 8});
    }));
```

The timelines are now:

- `task_particles`: write (init) -> read_write (update) -> read (render particles)
- `task_color`: write (render particles) -> read_write (composite)
- `task_background`: write (render background) -> read (composite)

This leaves "render background" as the only task without a dependency on `{init, update, render particles}` - it only shares `task_background` with "composite". TaskGraph is free to move it earlier or run it alongside the particle tasks, as long as it still happens before "composite":

`{init -> update -> render particles, render background} -> composite`

This is the same reordering behavior described in [Usage Implications](/wiki/taskgraph-how-why/#usage-implications) on the main TaskGraph page, just built up from real resources instead of abstract `TaskA`/`TaskB`/`TaskC` names.

## 7. External Task Resources

All the task resources created so far have been **transient** - TaskGraph allocates them, uses them internally within the graph, then frees them. But sometimes you need resources that exist *outside* the graph entirely: they must outlive graph recreations, be modified from code, or represent resources managed elsewhere (like swapchain images).

**External task resources** are adapters that let you feed outside resources into the graph. Unlike transient resources, they are created as standalone objects outside the graph and registered into it. This decouples the graph's task logic from where the actual GPU memory lives.

**Why external resources are useful:**
- **Truly persistent data**: Streamer data, large lookups, persistent compute buffers that must survive across multiple graph recreations
- **Externally-managed resources**: Swapchain images, whose lifetime and acquisition are handled outside the graph
- **Runtime-modified resources**: Buffers that need to be read/written by CPU code or other systems between graph executions

**Example: Streamer Data Buffer**

An `ExternalTaskBuffer` wraps an existing `BufferId` and is registered into the graph with `register_buffer`, which returns a `TaskBufferView` to use in task attachments:

```c++
// streamer_data_buffer is passed in - created elsewhere, persists across graph recreations
daxa::ExternalTaskBuffer ext_streamer_data = daxa::ExternalTaskBuffer({
    .buffer = streamer_data_buffer,
    .name = "streamer data",
});

void recreate_graph() {
    task_graph = daxa::TaskGraph({.device = device, .name = "render graph"});
    
    daxa::TaskBufferView task_streamer_data = task_graph.register_buffer(ext_streamer_data);
    
    task_graph.add_task(daxa::Task::Compute("load meshes")
        .writes(task_streamer_data)
        .executes([=](daxa::TaskInterface ti) { /* ... */ }));
    
    task_graph.complete({});
}
```

**Example: Swapchain Image**

`ExternalTaskImage` works the same way, with `is_swapchain_image` telling TaskGraph to handle the required present layout transitions automatically:

```c++
daxa::ExternalTaskImage ext_swapchain_image = daxa::ExternalTaskImage({
    .image = {},               // No image yet - set each frame before execute
    .is_swapchain_image = true,
    .name = "swapchain",
});

void recreate_graph() {
    task_graph = daxa::TaskGraph({.device = device, .name = "render graph"});
    
    daxa::TaskImageView task_swapchain = task_graph.register_image(ext_swapchain_image);
    
    task_graph.add_task(daxa::Task::Transfer("copy to swapchain")
        .reads(task_color)
        .writes(task_swapchain)
        .executes([=](daxa::TaskInterface ti) { /* ... */ }));
    
    task_graph.complete({});
}

// Each frame, update the external resource and execute
auto swapchain_image = device.acquire_swapchain_image({...});
ext_swapchain_image.set_image(swapchain_image.value());
task_graph.execute({});
```

**Switching Out External Resources Between Executions**

You can call `set_buffer()` / `set_image()` on an external resource between executions - without recreating the graph. TaskGraph detects the resource change and automatically recomputes only the synchronization affected by that swap on that frame. This is how the swapchain image example above works for every frame.

> **It is not legal to switch external resources while the graph is executing.** Only call `set_buffer()` / `set_image()` after `execute()` has returned.

The same applies to less frequent changes: if the streamer needs to grow its buffer, create a new one, call `set_buffer()`, and execute - no graph recreation needed:

```c++
if (streamer_requested_expansion) {
    daxa::BufferId new_buffer = device.create_buffer({.size = 1024 * 1024 * 1024, .name = "streamer data"});
    device.destroy_buffer(streamer_data_buffer);
    streamer_data_buffer = new_buffer;
    ext_streamer_data.set_buffer(streamer_data_buffer);
    // Next execute() sees the new buffer and recomputes only what changed
}
```

This flexibility is what makes external resources so powerful: resources can change in response to runtime events while the graph's task structure stays stable. TaskGraph retains almost all precomputed data for sync, ordering, and barrier generation while adapting only what changed.

## 8. Early Tips for Attachment Granularity

Not every GPU resource needs to be a task resource. TaskGraph only provides value where there are synchronization or ordering requirements to manage - so only give it resources that actually have those.

**Track these:**
- Resources with transient lifetimes that may alias across frames: scratch buffers, intermediate render targets, temporary compute storage
- Resources written at least once per frame, since writes create ordering requirements against subsequent reads

**Don't track static asset data:**
Mesh buffers, index buffers, material parameters, textures - anything loaded once and read many times - should stay out of the graph. The set of assets changes frequently, but their content per frame is constant. There are no write dependencies to enforce, so TaskGraph has nothing to contribute. Tracking them would only add noise.

**When assets do need GPU processing:**
Asset upload, decompression, or format conversion are the exception. For those, consider:
- A **separate lightweight task graph** dedicated to asset processing, isolated from the main frame graph
- **Manual synchronization** for simple one-off operations - asset processing is often straightforward enough that a hand-written barrier is less overhead than tracking it in a full graph
- **An async queue** for work that doesn't need to block the main rendering queue at all

Keeping asset processing out of the main graph means the main graph stays small, fast to analyze, and contains only the dependencies that actually matter each frame.

## 9. A Complete Frame Loop

Putting it all together: the graph is built once and reused across frames. The swapchain image is an `ExternalTaskImage` (covered in section 7), updated each frame via `set_image()` before `execute()`. The graph itself is only recreated when settings actually change:

```c++
struct Settings {
    daxa::Extent2D render_size;
    // ...
};

daxa::TaskGraph task_graph;
Settings current_settings;
bool graph_dirty = true;

// ExternalTaskImage lives outside the graph - survives graph recreations
daxa::ExternalTaskImage ext_swapchain = daxa::ExternalTaskImage({
    .is_swapchain_image = true,
    .name = "swapchain",
});

void recreate_graph() {
    task_graph = daxa::TaskGraph({.device = device, .name = "render graph"});

    // Transient - allocated and freed by TaskGraph each execution
    daxa::TaskImageView task_color = task_graph.create_task_image({
        .format = daxa::Format::R16G16B16A16_SFLOAT,
        .size = current_settings.render_size,
        .name = "color",
    });

    // External - registered into the graph, real image supplied per-frame
    daxa::TaskImageView task_swapchain = task_graph.register_image(ext_swapchain);

    task_graph.add_task(daxa::Task::Compute("clear color")
        .writes(task_color)
        .executes([=](daxa::TaskInterface ti) { /* ... */ }));

    task_graph.add_task(daxa::Task::Transfer("copy to swapchain")
        .reads(task_color)
        .writes(task_swapchain)
        .executes([=](daxa::TaskInterface ti) { /* ... */ }));

    task_graph.complete({});
    graph_dirty = false;
}

while (running) {
    if (settings_changed || graph_dirty) {
        current_settings = new_settings;
        recreate_graph();
    }

    auto swapchain_image = device.acquire_swapchain_image({.swapchain = swapchain});
    if (swapchain_image.is_empty()) continue;

    // Bind this frame's swapchain image, then execute
    ext_swapchain.set_image(swapchain_image.value());
    task_graph.execute({});

    device.present_image({.swapchain = swapchain, .image = swapchain_image.value()});
}
```

`recreate_graph()` runs only when something structurally changes (resolution, pipelines, etc.). Every other frame is just `set_image` + `execute` - no rebuilding, no re-recording.

For a side-by-side look at what the barrier and layout transition code in this loop would look like written by hand versus what TaskGraph generates for you, see [TaskGraph — How and Why: Manual vs. Automatic Synchronization](/wiki/taskgraph-how-why/#manual-sync-vs-taskgraph).

## 10. Built-in Convenience Tasks

TaskGraph provides a handful of pre-built tasks for the most common transfer operations. Instead of `add_task` with a manual callback, call them directly on the graph:

```c++
// Clear a buffer to a u32 value. offset and size are optional (default: entire buffer).
task_graph.clear_buffer({
    .buffer      = task_particles,
    .offset      = 0,
    .size        = ~0ull,   // clear all
    .clear_value = 0u,
    .name        = "clear particles",
});

// Clear an image. clear_value is a ClearValue union (color or depth/stencil).
task_graph.clear_image({
    .view        = task_color,
    .clear_value = std::array{0u, 0u, 0u, 0u},
    .name        = "clear color",
});

// Copy one buffer into another (full copy).
task_graph.copy_buffer_to_buffer({
    .src_buffer = task_staging,
    .dst_buffer = task_particles,
    .name       = "upload particles",
});

// Copy one image into another.
task_graph.copy_image_to_image({
    .src_image = task_color,
    .dst_image = task_swapchain,
    .name      = "copy to swapchain",
});
```

Each of these internally calls `add_task`, so they participate in the normal dependency tracking and synchronization - no special handling needed. They just save you from writing a Transfer callback by hand for the common cases.

## 11. Resource Lifetime Types

Both `create_task_buffer` and `create_task_image` accept a `lifetime_type` field that controls how TaskGraph allocates and manages the backing GPU memory. Choosing the right type affects memory usage, frame-to-frame data persistence, and whether aliasing is possible.

### TRANSIENT (default)

Transient resources are allocated during `execute()` and their memory is returned once execution finishes. They have no guaranteed content between executions — every frame starts with undefined data. This is the right default for any resource that starts fresh each frame: intermediate render targets, scratch buffers, temporary compute storage.

Because transient lifetimes are scoped to a single execution, TaskGraph can analyze which transients are alive at the same time and alias their memory. With `alias_transients = true` in `TaskGraphInfo` (see section 18), two transients whose lifetimes do not overlap share the same physical allocation. Combined with `optimize_transient_lifetimes = true`, TaskGraph reorders tasks to shrink each transient's alive window and maximize aliasing opportunities. On complex graphs this can reduce peak VRAM usage significantly. `get_resource_memory_block_size()` returns the current size of the shared block so you can observe the effect.

### PERSISTENT

Persistent resources are allocated once on the first `execute()` and their memory persists across executions — the GPU sees the same allocation every frame, and whatever was written last frame is still there. All persistent resources are automatically cleared to zero before the very first execution. To explicitly re-zero a persistent resource later (e.g. after a settings change), call `request_persistent_buffer_clear` or `request_persistent_image_clear` after `complete()` but before the next `execute()`.

```c++
daxa::TaskBufferView task_shadow_cache = task_graph.create_task_buffer({
    .size         = sizeof(ShadowSample) * MAX_SHADOW_SAMPLES,
    .lifetime_type = daxa::TaskResourceLifetimeType::PERSISTENT,
    .name         = "shadow cache",
});
```

Use persistent resources for anything that needs to carry state between frames: shadow map caches, frame-to-frame accumulation buffers, readback results, or any data that is expensive to recompute every frame.

### PERSISTENT_DOUBLE_BUFFER

Double-buffered persistent resources maintain two copies of the backing memory simultaneously. TaskGraph swaps which copy is "current" and which is "previous" on every execution. Access the two copies via `.current()` and `.previous()` on the view:

```c++
daxa::TaskImageView task_history = task_graph.create_task_image({
    .format       = daxa::Format::R16G16B16A16_SFLOAT,
    .size         = render_size,
    .lifetime_type = daxa::TaskResourceLifetimeType::PERSISTENT_DOUBLE_BUFFER,
    .name         = "taa history",
});

task_graph.add_task(daxa::Task::Compute("taa resolve")
    .reads(task_history.previous())   // last frame's accumulated result
    .reads(task_color)
    .writes(task_history.current())   // this frame's output
    .executes([=](daxa::TaskInterface ti)
    {
        ti.recorder.set_pipeline(*taa_pipeline);
        ti.recorder.push_constant(TaaPush{
            .history = ti.id(task_history.previous()),
            .color   = ti.id(task_color),
            .output  = ti.id(task_history.current()),
        });
        ti.recorder.dispatch(/* ... */);
    }));
```

Both copies are zero-initialized before the first execution. On the first frame, `previous()` will be all zeros — factor this into the resolve logic (a blend weight of 0 for the history on the first frame is common).

The canonical use cases are temporal anti-aliasing history, screen-space ambient occlusion accumulation, and any ping-pong compute pattern where each frame reads last frame's output and writes a new one.

### EXTERNAL

External resources are not managed by TaskGraph at all — they are pre-existing `BufferId`s and `ImageId`s that you register into the graph with `register_buffer` / `register_image`. They are the mechanism for feeding swapchain images, streamer buffers, or any externally-owned resource into the graph. This was covered in section 7.

## 12. TaskInterface Features

Every task callback receives a `daxa::TaskInterface ti`. Beyond `ti.recorder` for recording commands, `ti` exposes several other members worth knowing.

**`ti.device`** is the `daxa::Device` the graph belongs to. Use it to query resource info, create temporary objects, or call any device-level operation from inside the callback.

**`ti.queue`** is the `daxa::Queue` this task is executing on. Useful when a callback needs to submit work to the same queue or make queue-specific decisions.

**`ti.task_name`** and **`ti.task_index`** are the name string and integer index of this task within the graph. Primarily useful for debug logging or custom profiling inside `pre_task_callback` / `post_task_callback`.

**Getting attachment data** — the `ti.get(view_or_index)` family resolves a task resource view to its runtime attachment info, and shorthand helpers build on top of it:

```c++
ti.device_address(task_buffer)    // -> Optional<DeviceAddress>  (buffer or BLAS/TLAS)
ti.id(task_image)                 // -> ImageId / BufferId       (raw resource id)
ti.view(task_image)               // -> ImageViewId              (pre-created image view)
ti.info(task_resource)            // -> Optional<ImageInfo/BufferInfo>  (resource metadata)
ti.image_view_info(task_image)    // -> Optional<ImageViewInfo>
ti.host_address(task_buffer)      // -> Optional<std::byte*>     (host-mapped buffers only)
```

These all read from the same attachment data that TaskGraph resolved at execution time — they just offer different projections of it.

**`ti.attachment_infos`** is a `std::span<TaskAttachmentInfo const>` containing the fully-resolved metadata for every attachment in this task — actual `ImageId`s, `BufferId`s, access types, and image view ids — in declaration order. This is the raw data that all the `ti.get(...)` helpers index into. It is most useful in generic code, `pre_task_callback`/`post_task_callback`, or tooling that needs to inspect what resources a task is touching without knowing the attachment names up front.

**`ti.allocator`** is a pointer to a per-frame linear staging allocator (`daxa::TransferMemoryPool`). It is the easiest and fastest way to get a small slice of device-local, host-visible buffer memory for use within a task — no staging buffer, no manual allocation, no lifetime management. Good uses include atomic counters that a pass resets and reads back, or a block of constants that would exceed push constant size limits:

```c++
if (ti.allocator)
{
    auto alloc = ti.allocator->allocate_fill(MyData{/* ... */});
    if (alloc)
    {
        ti.recorder.push_constant(MyPush{
            .data_ptr = alloc->device_address,
        });
    }
}
```

Allocations are only valid for the duration of the task. The device address and host pointer must not be stored anywhere that outlives the callback — do not pass them out, cache them, or use them after the task returns. Memory is automatically reclaimed after the GPU finishes the frame.

The allocator is backed by a fixed-size ring buffer (128 KiB by default, configurable via `staging_memory_pool_size` in `TaskGraphInfo`). It is intended for small, per-task scratch data — not large uploads. `allocate()` returns `std::nullopt` if the pool is exhausted for this frame, so always check the return value. The pointer itself is null if the pool was disabled (`staging_memory_pool_size = 0`), so guard with `if (ti.allocator)` when using it in reusable code.

## 13. Granular Attachment Access

The plain `.reads(...)`, `.writes(...)`, and `.reads_writes(...)` methods attach a resource at the task's *default stage* - `COMPUTE_SHADER` for `Task::Compute`, `TRANSFER` for `Task::Transfer`, and so on. That default covers the vast majority of cases. When you need a different stage, two mechanisms let you be more specific.

**Stage sub-object accessors** are shorthand for the most common non-default stages. Two are provided:

```c++
task_graph.add_task(daxa::Task::Raster("render scene")
    .color_attachment.writes(task_render_target)    // write-only; use .reads_writes for blending
    .indirect_cmd.reads(task_draw_args)             // INDIRECT_COMMAND_READ stage
    .reads(task_vertex_data)                           // default RASTER_SHADER stage
    .executes([=](daxa::TaskInterface ti) { /* ... */ }));
```

`color_attachment` and `indirect_cmd` are typed accessors that only expose access modes that make sense for their stage — `indirect_cmd` does not expose `.writes(...)` because indirect command buffers are always read-only.

**`.samples(...)`** is another important accessor worth calling out explicitly. When a task samples an image through a sampler (as opposed to a plain load), it must be attached with `.samples(...)` rather than `.reads(...)`:

```c++
task_graph.add_task(daxa::Task::Raster("render scene")
    .samples(task_shadow_map)   // image will be sampled - informs resource creation
    .reads(task_depth)          // plain image load, no sampler
    .executes([=](daxa::TaskInterface ti) { /* ... */ }));
```

This distinction matters because TaskGraph uses the access type to inform image resource creation: an image attached with `.samples(...)` at any point in the graph will be created with the `SAMPLED` usage flag set, which Vulkan requires before sampling is legal. Using `.reads(...)` for a sampled image will silently omit that flag and produce undefined behavior at runtime. Always use `.samples(...)` for images accessed through a sampler.

## 14. [ADVANCED] Custom Attachment Access with `.uses()`

`.uses(TaskAccess, views...)` accepts a `TaskAccess` value directly, which is usually not needed - the named accessors and sub-objects cover virtually all practical cases. Where it becomes useful is when the access needs to be determined programmatically: selecting between read-only and read-write at graph recording time based on a flag, picking a stage from a variable, or sharing an access constant defined elsewhere. `.uses()` gives you a single point to pass whatever `TaskAccess` you have computed:

```c++
using namespace daxa::TaskAccessConsts;

task_graph.add_task(daxa::Task::Raster("render scene")
    .uses(VERTEX_SHADER::READ,   task_vertex_buffer)   // read in vertex shader specifically
    .uses(FRAGMENT_SHADER::READ, task_material_atlas)  // read in fragment shader specifically
    .uses(COLOR_ATTACHMENT,      task_render_target)   // color attachment read-write (same as .color_attachment.reads_writes)
    .uses(DEPTH_ATTACHMENT,      task_depth_image)     // depth/stencil attachment read-write
    .uses(DEPTH_ATTACHMENT_READ, task_shadow_map)      // depth image read-only (sampling as shadow map)
    .uses(INDIRECT_COMMAND_READ, task_draw_args)       // same as .indirect_cmd.reads
    .executes([=](daxa::TaskInterface ti) { /* ... */ }));
```

`TaskAccessConsts` also has short aliases: `CA` for `COLOR_ATTACHMENT`, `ICR` for `INDIRECT_COMMAND_READ`, and single-letter shorthands on per-stage partials like `COMPUTE_SHADER::R` / `COMPUTE_SHADER::W` / `COMPUTE_SHADER::RW`.

You can also construct a `TaskAccess` directly from a `daxa::TaskStages` and a `daxa::TaskAccessType`, or combine existing constants with `|`, which is handy when the access is determined at runtime:

```c++
using namespace daxa::TaskAccessConsts;

daxa::TaskAccess access = FRAGMENT_SHADER::READ;
if (pass_also_updates_buffer)
    access = access.access | TaskAccessType::WRITE;

task.uses(access, task_buffer);
```

## 15. [ADVANCED] Letting Two Writers Run Concurrently

Suppose "render background" from section 6 is split into two tasks that each paint half of `task_background` independently. Both attach the same view, so by default TaskGraph forms a write → write dependency and forces them to run sequentially - even though they touch disjoint pixels and never interfere.

`.writes_concurrent(...)` tells TaskGraph that this write does not need ordering against other concurrent writes to the same resource:

```c++
task_graph.add_task(daxa::Task::Compute("render background left")
    .writes_concurrent(task_background)
    .executes([=](daxa::TaskInterface ti) { /* ... dispatch over the left half ... */ }));

task_graph.add_task(daxa::Task::Compute("render background right")
    .writes_concurrent(task_background)
    .executes([=](daxa::TaskInterface ti) { /* ... dispatch over the right half ... */ }));
```

These two tasks may now run in any order or concurrently. Reads are always implicitly concurrent - multiple readers never need ordering against each other - so `.writes_concurrent(...)` and `.reads_writes_concurrent(...)` exist specifically for the write case (see [Concurrent Access](/wiki/taskgraph-how-why/#concurrent-access)). Any task that subsequently reads `task_background` still forms a normal dependency on both writers; it just doesn't care which ran first.

The concurrent access flags are also the right choice when multiple tasks write to the same resource but coordinate internally rather than through TaskGraph - for example, several compute dispatches appending to a shared buffer using atomic operations. TaskGraph sees them all writing the same resource and would otherwise serialize them; marking the attachment concurrent tells it that those tasks have their own synchronization and do not need to be ordered against each other.

## 16. [ADVANCED] Image Subresource Views: `.mips()` and `.layers()`

`TaskImageView` has two chainable methods that restrict which part of a task image the view covers:

```c++
task_image.mips(base_mip, count)    // view covers [base_mip, base_mip + count)
task_image.layers(base_layer, count) // view covers [base_layer, base_layer + count)
```

Both return a new `TaskImageView` with the slice set; the original is unchanged. They can be chained:

```c++
task_image.mips(1, 1).layers(2, 4)  // mip 1, array layers 2–5
```

The main use is telling TaskGraph to generate a view into a specific mip level or array layer range for a task's attachment. For example, a downsample chain where each step reads one mip and writes the next:

```c++
daxa::TaskImageView task_chain = task_graph.create_task_image({
    .format          = daxa::Format::R16G16B16A16_SFLOAT,
    .size            = full_res,
    .mip_level_count = 5,
    .name            = "downsample chain",
});

for (u32 dst_mip = 1; dst_mip < 5; ++dst_mip)
{
    task_graph.add_task(daxa::Task::Compute("downsample mip " + std::to_string(dst_mip))
        .reads(task_chain.mips(dst_mip - 1, 1))
        .writes(task_chain.mips(dst_mip, 1))
        .executes([=](daxa::TaskInterface ti)
        {
            ti.recorder.push_constant(DownsamplePush{
                .src = ti.id(task_chain.mips(dst_mip - 1, 1)),
                .dst = ti.id(task_chain.mips(dst_mip, 1)),
            });
            ti.recorder.dispatch(/* ... */);
        }));
}
```

TaskGraph uses the slice in each attachment to create the correct `VkImageView` for that subresource range and fills it into `ti.id(...)` / `ti.attachment_shader_blob` accordingly.

**Sync tracking is not at subresource granularity.** Barriers and dependency tracking operate on the whole image, regardless of which slice each attachment covers. Two tasks that write different mip levels of the same `TaskImageView` will still be ordered against each other by TaskGraph, even though they touch disjoint subresources and could theoretically run concurrently.

This is intentional, for two reasons:

1. **Complexity vs. benefit.** Per-subresource sync tracking is significantly more complex to implement and reason about, and the cases where it would actually unlock parallelism in practice are rare. The overhead is not worth the gain for the vast majority of graphs.

2. **Transient allocation.** If different subresources of the same image had genuinely different lifetimes, TaskGraph could not treat the image as a single transient allocation and alias its memory — it would need to track each subresource independently, breaking the aliasing model entirely. If two subresources of a conceptual "image" are truly accessed so differently that their lifetimes diverge, the right answer is to create them as two separate task images rather than fighting the granularity of the tracking system.

## 17. [ADVANCED] Optional Task Views

Some tasks have genuinely optional resource parameters - a post-process pass that can optionally read a debug overlay, a compute task that conditionally writes to an auxiliary buffer, or a head shared between variants where some slots may not always be needed. The natural instinct is to leave the attachment slot empty, but Daxa validates that all registered attachments are backed by a real task view and will error on an empty one.

The solution is `daxa::NullTaskBuffer` and `daxa::NullTaskImage` - sentinel values that explicitly communicate intent. When a null view is passed to an attachment, TaskGraph understands it as an intentional opt-out: that attachment is excluded from all tracking, synchronization, and resource lifetime management. Inside the callback, any id or device address retrieved for a null attachment returns zero, which shaders can test to skip the optional work:

```c++
daxa::TaskImageView task_debug_overlay = daxa::NullTaskImage;
if (debug_mode)
    task_debug_overlay = task_graph.create_task_image({/* ... */});

/* ... other code fills debug overlay ... */

task_graph.add_task(daxa::Task::Compute("composite")
    .reads(task_color)
    .reads(task_debug_overlay)  // excluded from tracking when NullTaskImage
    .executes([=](daxa::TaskInterface ti)
    {
        ti.recorder.push_constant(CompositePush{
            .color   = ti.id(task_color),
            .overlay = ti.id(task_debug_overlay),  // zero when null
        });
        ti.recorder.dispatch(/* ... */);
    }));
```

```glsl
void main()
{
    vec4 result = imageLoad(daxa_image2D(push.color), coord);
    if (push.overlay != 0)  // skip when no overlay is bound
        result = mix(result, imageLoad(daxa_image2D(push.overlay), coord), 0.5);
    imageStore(daxa_image2D(push.color), coord, result);
}
```

This also works with task heads: pass `daxa::NullTaskImage` (or `daxa::NullTaskBuffer`) into the corresponding slot in `.head_views({...})` and the same rules apply - the slot is excluded from tracking and reads as zero inside the callback.

## 18. [ADVANCED] TaskGraph Construction Options

`TaskGraphInfo` has a number of fields beyond `device` and `name`. Most stay at their defaults; this section covers what they do and when to change them.

**Swapchain** (`swapchain`, default: empty): provide a swapchain if any task uses a swapchain image. This enables the automatic present-layout transitions TaskGraph needs to produce a presentable image.

**Task reordering** (`reorder_tasks`, default: `true`): allows TaskGraph to reorder independent tasks to improve GPU utilization. Disable this when debugging to make callback execution match recording order exactly.

**Transient lifetime optimization** (`optimize_transient_lifetimes`, default: `true`): reorders tasks to minimize how long transient resources stay alive, which allows more of them to share memory. This typically also clusters clears into batches near first use.

**Transient aliasing** (`alias_transients`, default: `false`): allows TaskGraph to reuse the same physical memory for transient resources whose lifetimes do not overlap. Can significantly reduce peak VRAM usage on complex graphs. Off by default because it makes memory layout less predictable.

**Command labels** (`enable_command_labels`, default: `true`): inserts profiler markers around graph, batch, and individual task execution. These appear in NSight, RenderDoc, and similar tools. The three `*_label_color` fields set the marker colors at each level.

**AMD RDNA3/4 image barrier fix** (`amd_rdna3_4_image_barrier_fix`, default: `true`): works around a hardware bug on RDNA3 and RDNA4 GPUs where global barriers do not correctly flush image caches. When enabled, TaskGraph emits image-specific barriers for image synchronization instead. Safe to leave on for all hardware.

**Staging memory pool** (`staging_memory_pool_size`, default: 128 KiB): size of the per-frame linear allocator for device-local, host-visible memory. Tasks access it via `ti.allocator` for small per-task scratch data without manual staging buffers. Set to 0 to disable the allocator entirely (and the features that depend on it). Increase if tasks are uploading more than 128 KiB per frame.

**Task memory pool** (`task_memory_pool_size`, default: 512 KiB): CPU memory reserved for task metadata and internal bookkeeping. Rarely needs adjustment.

**Additional image usage flags** (`additional_image_usage_flags`, default: none): extra Vulkan usage flags added to every transient image the graph creates. Useful when an external debugging tool needs to sample or read images that are otherwise write-only in the graph.

**Per-task callbacks** (`pre_task_callback`, `post_task_callback`): functions called immediately before and after every task executes. Useful for inserting custom profiling spans, validation passes, or debug logging around individual tasks.

**Default queue** (`default_queue`, default: `QUEUE_MAIN`): the Vulkan queue used for task submission. Individual tasks can override this with `.uses_queue(...)` at recording time.

## 19. [ADVANCED] The General Task

All the task types used so far — `Task::Compute`, `Task::Raster`, `Task::Transfer`, `Task::RayTracing` — have a fixed default stage that plain `.reads(...)` / `.writes(...)` attach to. `daxa::Task` without a type suffix creates a **general task**, which has no default stage at all:

```c++
task_graph.add_task(daxa::Task("mixed work")
    .uses(TaskAccessConsts::COMPUTE_SHADER::READ,  task_particles)
    .uses(TaskAccessConsts::RAY_TRACING_SHADER::READ, task_blas)
    .uses(TaskAccessConsts::COLOR_ATTACHMENT,      task_color)
    .executes([=](daxa::TaskInterface ti) { /* ... */ }));
```

Because there is no default, every attachment must go through `.uses(TaskAccess, ...)` or a stage sub-object — the plain `.reads(...)` / `.writes(...)` helpers are not available. This makes general tasks more verbose, but they are the right choice when:

- **Mixed pipeline work**: a single task that touches resources from multiple pipeline stages — a raster pass that also dispatches a compute shader inline, or a ray tracing task that additionally reads from a compute-written buffer at a stage that the `RayTracing` type would not default to correctly.
- **Programmatic tasks**: tasks built from data at runtime, where the stages and accesses aren't known until graph recording time and must be assembled by code.

General tasks are also the default for task heads declared with `DAXA_DECL_TASK_HEAD_BEGIN` (as opposed to `DAXA_DECL_COMPUTE_TASK_HEAD_BEGIN` etc.), for the same reason: the head DSL already specifies the exact stage for each attachment via the access constants in each macro line, so no per-task-type default is needed or useful.

## 20. [ADVANCED] From an Inline Task to a Task Head

In a large taskgraph, writing every callback as an inline lambda starts to clutter the graph recording. The graph recording ideally reads as a high-level view of the frame - which tasks run, what resources they touch, in what order. Inline lambdas filled with pipeline binding, push constants, and dispatch calls turn into noise there; you are no longer reading the frame, you are reading task implementations. Many people, myself included, prefer to define callbacks as named functions in a separate place - typically a feature-specific `.cpp` file that lives alongside the shader it drives. This improves encapsulation and keeps the graph recording focused on what it is actually for.

The awkward part is that with inline tasks, a function defined elsewhere has no way to look up the actual GPU resources for the attachments - those are only resolvable through `ti`, which only exists inside the callback. So every task resource view must be threaded through as a function parameter, and passed again at the call site. Task heads eliminate this problem entirely.

Consider the "render particles" task from section 5 written out fully this way. The shader:

```glsl
// render_particles.glsl
#include "render_particles.inl"

DAXA_DECL_PUSH_CONSTANT(RenderParticlesPush, push)

layout(local_size_x = 8, local_size_y = 8) in;
void main()
{
    CameraData cam = deref(push.camera);
    Particle p     = deref(push.particles[gl_GlobalInvocationID.x]);
    imageStore(daxa_image2D(push.color), ivec2(gl_GlobalInvocationID.xy), /* ... */);
}
```

The `daxa_BufferPtr`, `daxa_ImageViewId`, and `daxa_u32vec2` types are part of Daxa's cross-language type system - they expand to the correct type in both C++ and GLSL from the same source. See [Code Sharing via `daxa_` Types](/wiki/shader-integration/#code-sharing-via-daxa_-types) for the full picture. The bindless access patterns (`deref(push.camera)`, `daxa_image2D(push.color)`) are covered in [Bindless Access](/wiki/shader-integration/#bindless-access-images--buffers).

The shared `.inl` the shader includes defines the push constant struct:

```c
#include "daxa.inl"
// render_particles.inl  (included by both shader and C++)
struct RenderParticlesPush
{
    daxa_BufferPtr(Particle)   particles;  // (3) push constant field
    daxa_BufferPtr(CameraData) camera;     // (3) push constant field
    daxa_ImageViewId           color;      // (3) push constant field
    daxa_u32vec2               render_size;
};
```

And the C++ side - callback function defined elsewhere, views passed as parameters:

```c++
// Callback defined in a task-specific cpp file...
void render_particles_task(
    daxa::TaskInterface &  ti,
    daxa::TaskBufferView   task_particles,  // (4) function parameter
    daxa::TaskBufferView   task_camera,     // (4) function parameter
    daxa::TaskImageView    task_color)      // (4) function parameter
{
    auto const sz = ti.device.info(ti.get(task_color).id).value().size;
    ti.recorder.set_pipeline(*render_particles_pipeline);
    ti.recorder.push_constant(RenderParticlesPush{
        .particles   = ti.device_address(task_particles).value(),  // (2) attachment → push constant
        .camera      = ti.device_address(task_camera).value(),     // (2) attachment → push constant
        .color       = ti.id(task_color),                          // (2) attachment → push constant
        .render_size = {sz.x, sz.y},
    });
    ti.recorder.dispatch({.x = sz.x / 8, .y = sz.y / 8});
}

// Graph Recording in different file...
task_graph.add_task(daxa::Task::Compute("render particles")
    .reads(task_particles)  // (1) attachment
    .reads(task_camera)     // (1) attachment
    .writes(task_color)     // (1) attachment
    .executes(
        render_particles_task, 
        task_particles, task_camera, task_color)); // (5) pass to function
```

Each resource now appears in **five** places: **(1)** the attachment declaration, **(2)** the push constant piping, **(3)** the push constant struct field, **(4)** the function parameter, and **(5)** passing the view at the call site. The real problem is that **(1)** and **(3)** are two separate descriptions of the same thing - one says "this task accesses resource X", the other says "resource X has this shader type and name" - and they must be kept in sync manually. **(2)**, **(4)**, and **(5)** are purely mechanical piping that follows from the other two.

[Task Heads](/wiki/taskgraph-how-why/#taskhead-and-attachment-shader-blob) fix this by merging **(1)** and **(3)** into a single centralized description per resource, eliminating **(2)** entirely, and removing **(4)** and **(5)** by making attachments accessible via `AT.resource_name` inside any callback without passing views as parameters. The head macros form a small DSL where each line simultaneously declares the attachment and its shader-side name and type - one place to change when a resource changes. From this declaration the macros generate two things:

- **`RenderParticlesHead::Info`** — a C++ struct holding attachment metadata that TaskGraph uses for synchronization and to identify which task resources correspond to which slots
- **A shader-side struct** — with one field per attachment, typed to match (`daxa_BufferPtr(Particle)` for a buffer pointer, `daxa_ImageViewId` for an image id, etc.), ready to be embedded in a push constant and accessed directly in the shader

Both are produced from the same `.inl` source, so the shader type for each resource is defined exactly once and shared between C++ and GLSL.

The head for "render particles" looks like this, with the push constant struct defined in the same `.inl` file:

```c
// render_particles.inl
DAXA_DECL_COMPUTE_TASK_HEAD_BEGIN(RenderParticlesHead)
DAXA_TH_BUFFER_PTR(CS::READ,  daxa_BufferPtr(Particle),   particles)
DAXA_TH_BUFFER_PTR(CS::READ,  daxa_BufferPtr(CameraData), camera)
DAXA_TH_IMAGE_ID(  CS::WRITE, REGULAR_2D,                 color)
DAXA_DECL_TASK_HEAD_END

struct RenderParticlesPush
{
    daxa_u32vec2 render_size;
    DAXA_TH_BLOB(RenderParticlesHead, attachments);  // expands to the shader-side resource struct
};
```

Each line is the single centralized description for that resource: it covers both the attachment declaration and the shader-side field in one place. `DAXA_TH_BLOB` embeds the generated shader struct into the push constant alongside any non-attachment data, and since the whole `.inl` file is shared, C++ and GLSL see the same layout.

With a head, the callback function needs no view parameters at all. Attachments are accessible inside any function via `RenderParticlesHead::Info::AT.resource_name`, and `using namespace RenderParticlesHead::Info` brings `AT` into scope directly. Because the function takes only `ti`, it can also be passed directly to `.executes` - the same style as the inline example above:

```c++
void render_particles_task(daxa::TaskInterface & ti)
{
    using namespace RenderParticlesHead::Info;
    // AT.particles, AT.camera, AT.color are directly accessible - no parameters needed.
    // ti.attachment_shader_blob fills the entire push constant resource struct automatically.
    auto const sz = ti.device.info(ti.id(AT.color)).value().size;
    ti.recorder.set_pipeline(*render_particles_pipeline);
    ti.recorder.push_constant(RenderParticlesPush{
        .render_size = {sz.x, sz.y},
        .attachments = ti.attachment_shader_blob,
    });
    ti.recorder.dispatch({.x = sz.x / 8, .y = sz.y / 8});
}

task_graph.add_task(daxa::HeadTask<RenderParticlesHead::Info>("render particles")
    .head_views({
        .particles = task_particles,
        .camera    = task_camera,
        .color     = task_color,
    })
    .executes(render_particles_task));
```

`.head_views({...})` assigns the task resource views to the named attachment slots - the only per-resource lines remaining, and they live at the graph recording site rather than scattered across function signatures. No `.reads(...)`/`.writes(...)` declarations needed, no view parameters, no push constant piping.

`ti.attachment_shader_blob` is the key piece: it is a copy of the shader-side struct declared by the head macros, with every field already filled in. TaskGraph produces this by reflecting the head's C++ metadata (`RenderParticlesHead::Info`) to know the layout and type of each field, then writing the correct resource handle or device address into each slot. This work even happens at **graph compilation** (`complete()`), not at execution time - TaskGraph pre-fills the blob and pre-creates any image views that attachments require during compilation, so that `execute()` only needs to copy the pre-built blob into the push constant. The callback just passes `ti.attachment_shader_blob` straight through; there is nothing left to resolve at dispatch time.

This also eliminates an entire class of bugs. With inline tasks, forgetting to assign a resource in the push constant compiles and runs - the shader just reads whatever was in memory at that slot. With task heads there is no assignment to forget: TaskGraph fills every field unconditionally from the head declaration. If a resource is in the head, it is in the blob. There is no gap between what the attachment declares and what the shader receives.

Everything covered so far - timelines, dependencies, reordering, concurrent writes - works identically for head tasks. The only thing that changes is how attachments and shader-side handles are declared.

## 21. [ADVANCED] Special Task Head Attachments

The head macros offer several variants of `DAXA_TH_IMAGE_*` and `DAXA_TH_BUFFER_*` that control what ends up in the shader blob and how much push constant space it costs. Choosing the right variant matters when push constants are tight or when the task needs per-mip shader access.

### No shader access: `DAXA_TH_IMAGE` and `DAXA_TH_BUFFER`

`DAXA_TH_IMAGE(ACCESS, VIEW_TYPE, NAME)` and `DAXA_TH_BUFFER(ACCESS, NAME)` declare attachments that TaskGraph tracks for synchronization but that contribute **zero bytes** to the shader blob. This is the right choice for resources that a task transitions or uses in a way that doesn't need a bindless handle in the shader — for example, a color attachment that the hardware writes to automatically during rasterization, or a buffer only accessed via indirect draw parameters.

### ID vs Index for images

`DAXA_TH_IMAGE_ID` embeds a full `ImageViewId` in the blob — that is **8 bytes** per image attachment. `DAXA_TH_IMAGE_INDEX` embeds only a **32-bit index** into the global descriptor array instead, halving the cost to **4 bytes** per image.

The difference is only in the push constant layout. In the shader, both let you access the image via Daxa's bindless accessors — `DAXA_TH_IMAGE_ID` gives you a `daxa_ImageViewId` field, while `DAXA_TH_IMAGE_INDEX` gives you a plain `daxa_u32`. Which one to use in the accessor depends on the macro you used. When push constant space is tight — for example, a task with many sampled textures — switching from ID to Index for each image saves 4 bytes per attachment.

### TYPED for Slang

`DAXA_TH_IMAGE_TYPED(ACCESS, VIEW_TYPE, NAME)` is the Slang-specific variant. Instead of a plain `VIEW_TYPE` enum value, it takes a Slang image type. The Slang type carries both the image view type (2D, 2D array, cube, etc.) and whether the blob field should be an index or a full ID — the macro derives both from the Slang type's metadata. For GLSL shaders, use `DAXA_TH_IMAGE_ID` or `DAXA_TH_IMAGE_INDEX` directly. For Slang shaders, `DAXA_TH_IMAGE_TYPED` is the preferred form since the type itself encodes the representation.

### MIP_ARRAY for per-mip shader access

`DAXA_TH_IMAGE_ID_MIP_ARRAY(ACCESS, VIEW_TYPE, NAME, SIZE)` tells TaskGraph to generate one separate image view per mip level, up to `SIZE` levels. The shader blob then contains an array of `SIZE` view IDs — one entry per mip — instead of a single view.

This is important for storage images. Most GPUs, including NVIDIA hardware, do not support a single image view that spans all mip levels when the image is used as a storage image (read/write in a compute shader). Each mip level must be accessed via its own dedicated view. With a plain `DAXA_TH_IMAGE_ID`, you can only reach whatever single mip the `TaskImageView` covers. With `DAXA_TH_IMAGE_ID_MIP_ARRAY`, TaskGraph auto-generates all per-mip views during `complete()`, fills the array in the shader blob, and cleans them up automatically after execution. The shader then accesses any mip by indexing into the array:

```c
// render_particles.inl
DAXA_DECL_COMPUTE_TASK_HEAD_BEGIN(DownsampleHead)
DAXA_TH_IMAGE_ID_MIP_ARRAY(CS::WRITE, REGULAR_2D, output, 8)  // up to 8 mip levels
DAXA_DECL_TASK_HEAD_END

struct DownsamplePush
{
    daxa_u32 mip_count;
    DAXA_TH_BLOB(DownsampleHead, attachments);
};
```

```c++
// shader
void main()
{
    for (uint mip = 0; mip < push.mip_count; ++mip)
    {
        // push.attachments.output[mip] is the ImageViewId for that mip level
        imageStore(daxa_image2D(push.attachments.output[mip]), coord >> mip, value);
    }
}
```

`DAXA_TH_IMAGE_INDEX_MIP_ARRAY` and `DAXA_TH_IMAGE_TYPED_MIP_ARRAY` are the same concept in the index and Slang-typed forms respectively, saving push constant space in the same way as their non-array counterparts.

## 22. [ADVANCED] Async Compute and Transfer

Modern GPUs expose multiple independent command queues: a main queue that can run graphics, compute, and transfer work, plus dedicated async compute queues and async transfer queues. Work submitted to different queues can run concurrently on physically separate parts of the GPU.

Daxa exposes these as `daxa::Queue` constants:

- `QUEUE_MAIN` — the main graphics/compute/transfer queue (default for all tasks)
- `QUEUE_COMPUTE_0` through `QUEUE_COMPUTE_3` — up to four async compute queues
- `QUEUE_TRANSFER_0` and `QUEUE_TRANSFER_1` — up to two async DMA transfer queues

Not all GPUs expose all queues. Whether a queue is available depends on the hardware and driver; query queue support through the device before relying on a specific queue being present.

**Cross-queue synchronization requires explicit submit points.** Unlike same-queue synchronization (which TaskGraph handles fully automatically with barriers), synchronization *between* queues in PC-level graphics APIs like Vulkan requires semaphores tied to queue submissions — and submissions are expensive. TaskGraph does not auto-generate cross-queue submissions; those must be placed by the user. Instead, TaskGraph models async compute as *sections between submissions*: tasks on different queues that are recorded between two submit calls are allowed to diverge and run concurrently, then reconverge at the next submit boundary.

The model looks like this:

```
submit(QUEUE_MAIN)        // sync point — all queues converge here
  [tasks on QUEUE_MAIN and QUEUE_COMPUTE_0 run concurrently]
submit(QUEUE_MAIN)        // sync point — all queues converge again
```

Between two submit points, tasks on different queues can freely run in parallel. At each submit boundary, TaskGraph resolves all cross-queue resource dependencies and inserts the necessary semaphores. Any resource that would need a barrier *between* submit points across queues — such as writing on one queue and reading on another at the same time without a submission between them — is a validation error: there is no way to correctly synchronize it without adding a submission point.

**Assigning a task to a queue** is done with `.uses_queue(queue)` at recording time:

```c++
task_graph.add_task(daxa::Task::Compute("build acceleration structures")
    .reads_writes(task_blas)
    .uses_queue(daxa::QUEUE_COMPUTE_0)
    .executes([=](daxa::TaskInterface ti) { /* ... */ }));

task_graph.add_task(daxa::Task::Transfer("stream textures")
    .writes(task_texture_atlas)
    .uses_queue(daxa::QUEUE_TRANSFER_0)
    .executes([=](daxa::TaskInterface ti) { /* ... */ }));
```

The `default_queue` field in `TaskGraphInfo` sets the queue for all tasks that do not call `.uses_queue(...)` explicitly.

TaskGraph has extensive validation for cross-queue misuse. Writing to the same resource on two different queues between submit points — where no semaphore can be inserted — is caught and reported as an error, since there is no safe way to order those accesses without a submission boundary between them.

The main practical consideration is that async compute and transfer queues cannot run arbitrary commands — compute queues cannot issue draw calls, and transfer queues can only issue copy/clear operations. TaskGraph does not validate this; assigning a raster task to a compute queue will produce a Vulkan validation error at runtime.
