---
title: TaskGraph
description: TaskGraph
slug: wiki/taskgraph
---

## TaskGraph

As Vulkan and Daxa require manual synchronization, using Daxa and Vulkan can become quite complex and error-prone.

A common way to abstract and improve synchronization with low-level APIs is using a RenderGraph. Daxa provides a render graph called TaskGraph.

With TaskGraph, you can create task resource handles and names for the resources you have in your program. You can then list a series of tasks.
Each task contains a list of used resources and a callback to the operations the task should perform.

A core idea of TaskGraph (and other render graphs) is that you record a high-level description of a series of operations and execute these operations later. In TaskGraph, you record tasks, "complete" (compile), and later run them. The callbacks in each task are called during execution.

This "two-phase" design allows render graphs to optimize the operations, unlike how a compiler would optimize a program before execution. It also allows render graphs to determine optimal synchronization automatically based on the declared resource used in each task.
In addition, task graphs are reusable. You can, for example, record your main render loop as a task graph and let the task graph optimize the tasks only once and then reuse the optimized execution plan every frame.
All in all, this allows for automatically optimized, low CPU cost synchronization generation.

Overview of the workflow for the task graph:

- Create task resources
- Create tasks, referencing the task resources in their attachments
- Add tasks to graph
- Complete task graph
- Execute task graph
- (optional) Repeatedly reassign resources (ImageId/BufferId) to external task resources
- (optional) Repeatedly execute task graph

## Task Resources

When constructing a task graph, it's essential not to use the real resource IDs used in execution but virtual representatives at record time. This is the simple reason that the task graph is reusable between executions. Making the reusability viable is only possible when resources can change between executions. The graph takes virtual resources - TaskImage and TaskBuffer, as well as TaskBlas and TaskTlas for acceleration structures. Real ImageIds, BufferIds, BlasIds and TlasIds can be assigned to these task resources and changed between executions of the task graph.

### Task Resource Views

Referring to only a part of an image or buffer is convenient. For example, to specify specific mip levels in an image in a mip map generator.

For this purpose, Daxa has TaskImageViews. A TaskImageView, similarly to an ImageView, contains a slice of the TaskImage, specifying the subresource.

All Tasks take in views instead of the resources themselves. Resources implicitly convert to their corresponding view type - `.view()` performs this conversion explicitly when needed. Views likewise have a `.view()` function that returns themselves, for symmetry with resources, and additional functions like `.mips(...)`/`.layers(...)` to derive a new, narrower view.

### Task Resource Data Dependencies

One of the main functions of the task graph is automatically generate sync and to automatically optimize execution by reordering task callbacks and their recorded commands.

To know how to generate sync and when its safe to reorder commands, the task graph (`tg` for short) builds a literal graph of resource uses between the tasks. Based on this graph we can infer optimal ordering and sync.

#### Usage Implications

When a task is added, tg will immediately form new access dependencies for all resources assigned to attachments of that task.

Recording order only matters between tasks that access the same resource. Every resource can be thought of as having its own timeline running through the task graph: each attachment access to that resource is placed onto this timeline in the order its task was recorded, forming a dependency on whichever access(es) came before it on that same timeline. Tasks that don't touch any of the same resources - or that only touch shared resources concurrently (see [Concurrent Access](#concurrent-access)) - have no entries on a shared timeline and therefore no dependency between them, so tg is free to reorder them relative to each other.

Example (in the notation below, `->` denotes an enforced ordering, while tasks listed next to each other have no ordering between them and may run in any order or concurrently):

`TaskA(write Img0), TaskB(read Img0, write Img1), TaskC(read Img1)`
Here, TaskB reads Img0, and tg sees that TaskA writing Img0 was recorded before TaskB. Tg forms a write -> read dependency when adding TaskB, forcing TaskB to be executed after TaskA. The same happens for TaskC, which reads Img1 after TaskB wrote it. This leaves only one possible execution order:
`TaskA -> TaskB -> TaskC`


`TaskA(write Img0), TaskB(read Img0, write Img1), TaskC(write Img2), TaskD(read Img2)`
TaskC and TaskD only touch Img2, which TaskA and TaskB never use, so there is no dependency between {TaskC, TaskD} and {TaskA, TaskB}. This allows the task graph to move the execution of TaskC and TaskD earlier, reducing the number of barriers:
`TaskA TaskC -> TaskB TaskD`

Dependencies are always formed immediately when a task is added, based on the given task resource views.

### Concurrent Access

Sometimes it is undesirable that two tasks that write the same resource form a `write -> write` ordering dependency. For example it could be the case that TaskA writes the left half of an image and TaskB the right half, or that the access is synchronized via atomics.

Tg will form dependencies here by default. To avoid this, use a concurrent task access for all tasks that you want to allow to execute at the same time.

Example:
`TaskA(write ImgA), TaskB(concurrent write ImgA), TaskC(concurrent write ImgA), TaskD(write ImgA)`, 
Likely execution order generated by tg:
`TaskA -> TaskB TaskC -> TaskD`

Notice here that there are still dependencies formed to writes not marked as concurrent. So while B and C execute together, A and D form strong ordering dependencies to the concurrent writes.

> NOTE: There is no extra concurrent read access, as all reads are implicitly concurrent already. Multiple reads will be scheduled independently of each other.

## Task

The core part of any render graph is the nodes in the graph. In the case of Daxa, these nodes are called tasks.

A task is a unit of work. It might be a single compute dispatch or multiple dispatches/render passes/raytracing dispatches. What limits the size of a task is resource dependencies that require synchronization.

Synchronization is only inserted _between_ tasks. If dispatch A writes an image and dispatch B needs to read the finished content, both dispatches _must_ be within different tasks, so task graph is able to synchronize.

A Task consists of four parts:

1. A description of how graph resources are used, the so called "Attachments".
2. A task resource view for each attachment, telling the graph which resource belongs to which attachment.
3. User data - for inline tasks (used throughout this page) this is simply whatever the `.executes([=](daxa::TaskInterface ti){...})` lambda captures by value, e.g. pointers to context/pipelines and any other parameters needed to record the task.
4. The callback, describing how the work should be recorded for the task.

Notably, the graph works in two phases: the recording and the execution. The callbacks of tasks are only ever called in the execution of the graph, not the recording.

Example of a task:

```cpp
daxa::TaskImageView src = ...;
daxa::TaskImageView dst = ...;
int blur_width = ...;
task_graph.add_task(daxa::Task::Transfer("example task")
    .reads(src)     // adds attachment for src to the task
    .writes(dst)    // adds attachment for dst to the task
    .executes([=](daxa::TaskInterface ti){
        copy_image_to_image(ti.recorder, ti.id(src), ti.id(dst), blur_width);
    }));
```

> Note: The lambda passed to `.executes(...)` is copied and stored inside the task graph, so its captures must be trivially destructible, copy constructible, and small (the total capture is limited to a few hundred bytes). Capture plain data, pointers and handles - not owning types like `std::function`, `std::vector` or `std::shared_ptr`.

### Task Attachments

Attachments describe a list of used graph resources that might require synchronization between tasks.

> Note: Only make attachments for resources that need sync. Textures that are uploaded and synced once after upload for example should be ignored in the graph.

Each attachment consists of:
- the resources type (image/buffer/acceleration structure)
- the resources access (stage + read/write/sampled)
- the resources shader usage (id/index/ptr + image view type)

TaskGraph will use this information to automatically generate sync, reorder tasks and automatically fill push constants with your resources.

> the automatic push constant/buffer fill is only available via TaskHeads (described later)

### TaskInterface

The resources assigned to each attachment of tasks are not available or even created yet when recording the task. They might also change between graph executions!

So the only up to date and correct information about each task resource and attachment is available ONLY when the task callback is executed and ONLY accessible via the task interface.

The interface has functions to query all information on the resources behind the attachments, such as: id, image view, buffer device/host address, image layout, resource info, task view.

Aside from getting attachment information, the interface is used to get:
* current device
* current command recorder
* current buffer suballocator (may be used to allocate small sections of a ring buffer in each task)
* current task metadata (name, index, queue)
* current attachment shader blob (described later)

### TaskHead and Attachment Shader Blob

When using shader resources like buffers and images, one must transport the image id or buffer pointer to the shader. In traditional apis one would bind buffers and images to an index but in daxa these need to be in a struct that is either stored inside another buffer or directly within a push constant.

This means that in traditional APIs you must list the attachments many times:
1. once in shaders, either as indices/pointers in a push constant OR direct bindings
2. once in the attachments of the task
3. when assigning the indices/bindings for the API
4. once when assigning task buffer/task image views to the attachments

Daxa can help you a lot here by reducing the redundancy with task heads. Task heads allow you to declare a struct in shader containing all indices/pointers to resources AS WELL AS the attachments for a task in one go! With task heads you only need to:
1. list resource in attachment
2. assign view to attachment

That's it. Daxa will do all the other logic for you.

But how do task heads work?

Essentially task head declarations consist of a set of macros that are valid in shaders as well as c/c++.
In each language the macros have different definitions. 
The task head declaration either describes a struct with indices/pointers in the shader OR
a namespace containing constexpr metadata about the attachments and their use in the shader.
The metadata is enough to properly fill the shader struct in the task graph internals.

An example of a task head:

```c
// within the shared file
DAXA_DECL_TASK_HEAD_BEGIN(MyTaskHead)
DAXA_TH_BUFFER_PTR(CS::READ,  daxa_BufferPtr(daxa_u32), src_buffer)
DAXA_TH_IMAGE_ID(  CS::WRITE, REGULAR_2D,               dst_image)
DAXA_DECL_TASK_HEAD_END
```

> NOTE: `CS::READ` and `CS::WRITE` come from `daxa::TaskAccessConsts`. `CS` is short for `COMPUTE_SHADER` - one of several per-stage namespaces (`VS`, `FS`, `CS`, `RT`, `TF`, `H`, ...), each providing access constants like `READ`/`WRITE`/`READ_WRITE`/`READ_WRITE_CONCURRENT`/`SAMPLE`/`SAMPLE_WRITE`/... (with shorthands `R`/`W`/`RW`/`RWC`/`S`/`SW`/...). The macros implicitly run with `using namespace daxa::TaskAccessConsts;`, so writing `CS::READ` is enough - no extra include or qualification needed.

> NOTE: There are also stage-independent "joker" constants at the top level of `daxa::TaskAccessConsts` (`READ`, `WRITE`, `READ_WRITE`, `SAMPLE`, ...) that simply use whatever stage the task itself runs at. These are handy for simple task heads, e.g. `DAXA_TH_BUFFER(READ, buffer0)`.

This task head declaration will translate to the following glsl shader struct:

```c
struct MyTaskHead
{
    daxa_BufferPtr(daxa_u32)  src_buffer;
    daxa_ImageViewId          dst_image;
};
```

Or the following Slang-HLSL:

```c
struct MyTaskHead
{
    daxa::u32*         src_buffer;
    daxa::ImageViewId  dst_image;
};
```

Extended example using a task head:

```c
// within shared file

DAXA_DECL_COMPUTE_TASK_HEAD_BEGIN(ExampleTaskHead)
    DAXA_TH_BUFFER_PTR(     READ,       daxa_BufferPtr(daxa_u32),       src_buffer)
    DAXA_TH_IMAGE_ID(       WRITE,      REGULAR_2D,                     dst_image)
DAXA_DECL_TASK_HEAD_END

// This push constant is shared in shader and c++!
struct MyPushStruct
{
    daxa_u32vec2 size;
    daxa_u32 settings_bitfield;
    // The head field is an aligned byte array in c++ and the attachment struct in shader:
    DAXA_TH_BLOB(ExampleTaskHead, attachments);
};
```

```c++
daxa::TaskBufferView src = ...;
daxa::TaskImageView dst = ...;

task_graph.add_task(daxa::HeadTask<ExampleTaskHead::Info>("example task")
    .head_views({.src_buffer = src})     // assign the view to the attachment, access is defined in head
    .head_views({.dst_image = dst})      // assign the view to the attachment, access is defined in head
    .executes([=](daxa::TaskInterface ti){
        ti.recorder.set_pipeline(...);
        ti.recorder.push_constant(MyPushStruct{
            .size = ...,
            .settings_bitfield = ...,
            // Here you assign the graph generated attachment shader blob into your pushconstant
            .attachments = ti.attachment_shader_blob,
        });
        ti.recorder.dispatch(...);
    }));
```

> Note: `.head_views(...)` can be called multiple times, each assigning a subset of the attachments. Any attachment field left unset in a given call (e.g. `dst_image` in the first call above) is left untouched rather than being reset, so it can be assigned by a later call.

### TaskInterface and Attachment Information

The ATTACHMENTS or AT constants declared within the task head contain all metadata about the attachments.
But they also contain named indices for each attachment!

In the above code these named indices are used to refer to the attachments.
You can refer to any attachment with `HEAD_NAME::AT.attachment_name`.

These `HEAD_NAME::AT.attachment_name` indices can be passed wherever a task resource view is expected - e.g. to `.reads(...)`, `.writes(...)`, `ti.get(...)` - exactly like a `TaskBufferView`/`TaskImageView` would be. This is what lets the same accessor functions work for both head tasks (named attachments) and inline tasks (plain views).

The indices can also be used to access information of attachments within the task callback:

```c++
void example_task_callback(daxa::TaskInterface ti)
{
    auto const & AI = ExampleTaskHead::Info::AT;

    // There are two ways to get the info for any attachment:
    {
        // daxa::TaskBufferAttachmentIndex index:
        daxa::TaskBufferAttachmentInfo const & buffer0_attachment0 = ti.get(AI.buffer0);
        // daxa::TaskBufferView assigned to the buffer attachment:
        daxa::TaskBufferAttachmentInfo const & buffer0_attachment1 = ti.get(buffer0_attachment0.view);
    }
    // The Buffer Attachment info contents:
    {
        daxa::BufferId id = ti.get(AI.buffer0).id;
        char const * name = ti.get(AI.buffer0).name;
        daxa::TaskAccess access = ti.get(AI.buffer0).task_access;
        daxa::TaskBufferView view = ti.get(AI.buffer0).view;
    }
    // The Image Attachment info contents:
    {
        char const * name = ti.get(AI.image0).name;
        daxa::TaskAccess access = ti.get(AI.image0).task_access;
        daxa::ImageViewType view_type = ti.get(AI.image0).view_type;
        u8 shader_array_size = ti.get(AI.image0).shader_array_size;
        bool is_mip_array = ti.get(AI.image0).is_mip_array;
        daxa::TaskImageView view = ti.get(AI.image0).view;
        daxa::ImageId id = ti.get(AI.image0).id;
        std::span<daxa::ImageViewId const> view_ids = ti.get(AI.image0).view_ids;
    }
    // The interface has multiple convenience functions for easier access to the underlying resources attributes:
    {
        // Overloaded for buffer, blas, tlas, image
        daxa::BufferInfo info = ti.info(AI.buffer0).value();
        // Overloaded for buffer, blas, tlas
        daxa::DeviceAddress address = ti.device_address(AI.buffer0).value();

        std::byte * host_address = ti.buffer_host_address(AI.buffer0).value();
        daxa::ImageViewInfo img_view_info = ti.image_view_info(AI.image0).value();

        // In case the task resource has an array of real resources, one can use the optional second parameter to access those:
        daxa::BufferInfo info2 = ti.info(AI.buffer0, 123 /*resource index*/).value();
    }
    // The attachment infos are also provided, directly via a span:
    for (daxa::TaskAttachmentInfo const & attach : ti.attachment_infos)
    {
    }
    // The tasks shader side struct of ids and addresses is automatically filled and serialized to a blob:
    auto generated_blob = ti.attachment_shader_blob;
    // The head also declared an aligned struct with the right size as a dummy on the c++ side.
    // This can be used to declare shader/c++ shared structs containing this blob:
    ExampleTaskHead::AttachmentShaderBlob blob = {};
    // The blob also declares a constructor and assignment operator to take in the byte span generated by the taskgraph:
    blob = generated_blob;
    ExampleTaskHead::AttachmentShaderBlob blob2{ti.attachment_shader_blob};
}
```

### TaskHead Attachment Declarations

There are multiple ways to declare how a resource is used within the shader:

```c
// CPU only attachments. These are not present in the attachment byte blob:
#define DAXA_TH_IMAGE(TASK_ACCESS, VIEW_TYPE, NAME)
#define DAXA_TH_BUFFER(TASK_ACCESS, NAME)
#define DAXA_TH_BLAS(TASK_ACCESS, NAME)
#define DAXA_TH_TLAS(TASK_ACCESS, NAME)

// _ID Attachments will be represented by the first id.
#define DAXA_TH_IMAGE_ID(TASK_ACCESS, VIEW_TYPE, NAME) 
#define DAXA_TH_BUFFER_ID(TASK_ACCESS, NAME) 
#define DAXA_TH_TLAS_ID(TASK_ACCESS, NAME)

// _INDEX Attachments will be represented by the index of the first id.
// This is useful for having lots of image attachments.
// Index attachments take only 4 bytes, id attachments need 8 bytes.
#define DAXA_TH_IMAGE_INDEX(TASK_ACCESS, VIEW_TYPE, NAME) 

// _TYPED Attachments will be represented either as a (RW)TextureXId<T> or (RW)TextureXIndex<T>.
// These Typed id/index handles are Slang only.
#define DAXA_TH_IMAGE_TYPED(TASK_ACCESS, TEX_TYPE, NAME)

// _MIP_ARRAY Attachments will be represented as an array of ids/indices where each array element
// views a mip level of the first image in the runtime array.
// This can be useful for mip map generation, as storage image views can only see one mip at a time.
// It is allowed to have an image bound to the attachment that has less mips then the array is in size,
// The remaining array elements will be filled with 0s.
#define DAXA_TH_IMAGE_ID_MIP_ARRAY(TASK_ACCESS, VIEW_TYPE, NAME, SIZE)
#define DAXA_TH_IMAGE_INDEX_MIP_ARRAY(TASK_ACCESS, VIEW_TYPE, NAME, SIZE)
#define DAXA_TH_IMAGE_TYPED_MIP_ARRAY(TASK_ACCESS, TEX_TYPE, NAME, SIZE)

// Ptr Attachments are represented by a device address.
#define DAXA_TH_BUFFER_PTR(TASK_ACCESS, PTR_TYPE, NAME)
#define DAXA_TH_TLAS_PTR(TASK_ACCESS, NAME)
```

> Note: Some permutations are missing here. BLAS for example has no \_ID, \_INDEX or \_PTR version. This is intentional, as some resources can not be used in certain ways inside shaders.

### Additional Usage Rules

- A task may use the same image multiple times, as long as the TaskImageView's slices don't overlap. This allows, for example, reading one mip level of an image while writing another in the same task.
- A task may only ever have one use of a TaskBuffer - buffers can't be sliced, so a second attachment for the same TaskBuffer would be redundant and is disallowed.
- All task uses must have a valid TaskResource or TaskResourceView assigned to them when adding a task. An unassigned (empty) view on an attachment is a validation error.
- All task resources must have valid image and buffer IDs assigned to them on execution. For transient resources this is done automatically by the graph; for persistent/external resources you must assign real IDs yourself before executing.

Violating any of these rules triggers a `DAXA_DBG_ASSERT_TRUE_M` validation error when the task is added or the graph is executed.

## Example: A Deferred Renderer Task Graph

The following sketches the resources, tasks and main loop of a small deferred renderer: a depth prepass, a shadow map pass, SSAO, a gbuffer pass, a deferred lighting pass and a composite pass that writes into the swapchain.

Only task resources and task attachments are shown - the usual setup (instance/device/pipeline creation), callback bodies and shaders are left out.

### Task Resources

The swapchain is represented in the graph by an `ExternalTaskImage`. It is created once and re-assigned every frame:

```c++
daxa::ExternalTaskImage task_swapchain_image{{.is_swapchain_image = true, .name = "swapchain"}};
daxa::ImageId swapchain_image = {};
```

All other resources are owned by the task graph itself and created with `create_task_image`/`create_task_buffer`. Neither call specifies a `lifetime_type`, so all of these resources default to `TaskResourceLifetimeType::TRANSIENT` - the graph allocates (and may alias) their memory internally and only guarantees their contents within a single `execute()` call. That's exactly what's needed here, since the depth buffer, gbuffer, shadow map, ssao and hdr targets are all fully recomputed every frame:

```c++
auto record_tasks(daxa::Device device, daxa::Swapchain swapchain, daxa::Extent3D render_size, daxa::u32 shadow_map_size) -> daxa::TaskGraph
{
    daxa::TaskGraph task_graph = daxa::TaskGraph({
        .device = device,
        .swapchain = swapchain,
        .name = "deferred renderer",
    });

    task_graph.register_image(task_swapchain_image);

    // SceneData is an application-defined struct, e.g. containing camera matrices and light parameters.
    daxa::TaskBufferView task_scene = task_graph.create_task_buffer({
        .size = sizeof(SceneData),
        .name = "scene data",
    });

    daxa::TaskImageView task_depth = task_graph.create_task_image({
        .format = daxa::Format::D32_SFLOAT,
        .size = render_size,
        .name = "depth",
    });

    daxa::TaskImageView task_shadow_map = task_graph.create_task_image({
        .format = daxa::Format::D32_SFLOAT,
        .size = {shadow_map_size, shadow_map_size, 1},
        .name = "shadow map",
    });

    daxa::TaskImageView task_albedo = task_graph.create_task_image({
        .format = daxa::Format::R8G8B8A8_SRGB,
        .size = render_size,
        .name = "gbuffer albedo",
    });

    daxa::TaskImageView task_normal = task_graph.create_task_image({
        .format = daxa::Format::R16G16B16A16_SFLOAT,
        .size = render_size,
        .name = "gbuffer normal",
    });

    daxa::TaskImageView task_material = task_graph.create_task_image({
        .format = daxa::Format::R8G8B8A8_UNORM,
        .size = render_size,
        .name = "gbuffer material",
    });

    daxa::TaskImageView task_ssao = task_graph.create_task_image({
        .format = daxa::Format::R8_UNORM,
        .size = render_size,
        .name = "ssao",
    });

    daxa::TaskImageView task_hdr = task_graph.create_task_image({
        .format = daxa::Format::R16G16B16A16_SFLOAT,
        .size = render_size,
        .name = "hdr",
    });
```

### Tasks

`task_scene` is only ever read by the tasks below, so something needs to write it first. Here that's a small host-side upload task, recorded first so every later read of `task_scene` depends on it:

```c++
    // Uploads this frame's camera/light data into the scene buffer.
    task_graph.add_task(daxa::Task::Transfer("upload scene data")
        .host.writes(task_scene)
        .executes([=](daxa::TaskInterface ti)
        {
            // map task_scene and write this frame's SceneData into it
        }));

    // Fills the depth buffer with the opaque scene geometry.
    task_graph.add_task(daxa::Task::Raster("depth prepass")
        .vertex_shader.reads(task_scene)
        .depth_stencil_attachment.writes(task_depth)
        .executes([=](daxa::TaskInterface ti)
        {
            // record depth-only draws of the opaque scene
        }));

    // Renders the scene from the light's point of view into the shadow map.
    task_graph.add_task(daxa::Task::Raster("shadow draw")
        .vertex_shader.reads(task_scene)
        .depth_stencil_attachment.writes(task_shadow_map)
        .executes([=](daxa::TaskInterface ti)
        {
            // record draws of shadow casters from the light's perspective
        }));

    // Derives an ambient occlusion term from the depth buffer.
    task_graph.add_task(daxa::Task::Compute("ssao")
        .compute_shader.samples(task_depth)
        .compute_shader.writes(task_ssao)
        .executes([=](daxa::TaskInterface ti)
        {
            // dispatch the ssao compute shader
        }));

    // Rasterizes the opaque scene into the albedo/normal/material targets, reusing the prepass depth.
    task_graph.add_task(daxa::Task::Raster("gbuffer")
        .vertex_shader.reads(task_scene)
        .fragment_shader.reads(task_scene)
        .depth_stencil_attachment.reads_writes(task_depth)
        .color_attachment.writes(task_albedo)
        .color_attachment.writes(task_normal)
        .color_attachment.writes(task_material)
        .executes([=](daxa::TaskInterface ti)
        {
            // record draws of the opaque scene, writing the gbuffer targets
        }));

    // Combines the gbuffer, shadow map and ssao into an hdr lighting result.
    task_graph.add_task(daxa::Task::Compute("deferred lighting")
        .compute_shader.samples(task_depth)
        .compute_shader.samples(task_albedo)
        .compute_shader.samples(task_normal)
        .compute_shader.samples(task_material)
        .compute_shader.samples(task_shadow_map)
        .compute_shader.samples(task_ssao)
        .compute_shader.writes(task_hdr)
        .executes([=](daxa::TaskInterface ti)
        {
            // dispatch the deferred lighting compute shader
        }));

    // Tonemaps the hdr lighting result into the swapchain image.
    task_graph.add_task(daxa::Task::Raster("composite")
        .fragment_shader.samples(task_hdr)
        .color_attachment.writes(task_swapchain_image)
        .executes([=](daxa::TaskInterface ti)
        {
            // record a fullscreen triangle that tonemaps hdr into the swapchain image
        }));

    task_graph.submit({});
    task_graph.present({});
    task_graph.complete({});
    return task_graph;
}
```

Note that the order tasks are added to the graph above is not the order they will execute in - as described in [Usage Implications](#usage-implications), recording order only forms dependencies between tasks that touch the same resource. In this example, the shadow draw task only shares `task_scene` with the other passes, and that access is a read on all sides (which is implicitly concurrent), so tg is free to move shadow draw earlier or later relative to the depth prepass, ssao and gbuffer tasks.

### Swapchain and Main Loop

The task graph is recorded once via `record_tasks`. Every frame, a new swapchain image is acquired and assigned to `task_swapchain_image`, then the graph is executed:

```c++
daxa::TaskGraph task_graph = record_tasks(device, swapchain, render_size, shadow_map_size);

while (keep_running())
{
    swapchain_image = swapchain.acquire_next_image();
    if (swapchain_image.is_empty())
    {
        // swapchain is being resized, skip this frame
        continue;
    }
    task_swapchain_image.set_image(swapchain_image);

    task_graph.execute({});

    device.collect_garbage();
}
```

`execute` takes an `ExecutionInfo`, which is left empty here. Its other fields cover more advanced use cases not shown in this example: `permutation_condition_values` selects between precompiled permutations of the graph (e.g. to skip whole tasks based on a runtime condition), while `debug_ui`/`record_debug_string` are for inspecting/visualizing the recorded graph.

`device.collect_garbage()` frees up resources (such as the transient resources owned by the task graph) once the GPU has finished using them. It should be called once per frame, after `execute`, so the graph's internal memory doesn't grow unbounded.
