---
title: Task graph
description: Task graph
slug: "tutorial/drawing-a-triangle/task-graph"
---

## Description

While not entirely necessary, we're going to use TaskGraph, which allows us to compile a list of GPU tasks and their dependencies into a synchronized set of commands. This simplifies your code by making different tasks completely self-contained, while also generating the most optimal synchronization for the tasks you describe. To use TaskGraph, as its also an optional feature, add the include path `<daxa/utils/task_graph.hpp>` at the top of our main file.

## Creating a Rendering task

Before we can use a task graph, we first need to create actual tasks that can be executed. The first task we are going to create will upload vertex data to the GPU.

Each task struct must consist of a child struct 'Uses' that will store all shared resources, as well as a callback function that gets called whenever the task is executed.

For our task, this base task structure will look like this:

```cpp
daxa::Task task = daxa::RasterTask("draw task")
    // adds an attachment:
    // * stage = color_attachment, 
    // * access = reads_writes,
    // * view_type = REGULAR_2D,
    // * task_image_view =  render_target
    .color_attachments.reads_writes(daxa::ImageViewType::REGULAR_2D, render_target) 
    .executes([=](daxa::TaskInterface ti){
        // this callback is executed later when executing the graph after completing recording.
        ....
    });
tg.add_task(task);
```

For the drawing, we need the following within the execute callback.

Within the task callback we have access to the device, a fast transient allocator, a cmd recorder and accessor functions for data around attachments:

```cpp
void draw_swapchain_task_callback(daxa::TaskInterface ti, daxa::RasterPipeline * pipeline, daxa::TaskImageView color_target, daxa::BufferId vertex_buffer)
{
    // The task interface provides a way to get the attachment info:
    auto image_info = ti.info(color_target).value();
    auto image_id = ti.id(color_target);
    auto image_view_id = ti.view(color_target);
    auto image_layout = ti.layout(color_target);

    // When starting a render pass via a rasterization pipeline, daxa "eats" a generic command recorder
    // and turns it into a RenderCommandRecorder.
    // Only the RenderCommandRecorder can record raster commands.
    // The RenderCommandRecorder can only record commands that are valid within a render pass.
    // This way daxa ensures typesafety for command recording.
    daxa::RenderCommandRecorder render_recorder = std::move(ti.recorder).begin_renderpass({
        .color_attachments = std::array{
            daxa::RenderAttachmentInfo{
                .image_view = ti.view(color_target),
                .load_op = daxa::AttachmentLoadOp::CLEAR,
                .clear_value = std::array<daxa::f32, 4>{0.1f, 0.0f, 0.5f, 1.0f},
            },
        },
        .render_area = {.width = image_info.size.x, .height = image_info.size.y},
    });
    // Here, we'll bind the pipeline to be used in the draw call below
    render_recorder.set_pipeline(*pipeline);

    // Very importantly, task graph packs up our attachment shader data into a byte blob.
    // We need to pass this blob to our shader somehow.
    // The typical way to do this is to assign the blob to the push constant.
    render_recorder.push_constant(MyPushConstant{
        .vertices = ti.device.device_address(vertex_buffer).value(),
    });
    // and issue the draw call with the desired number of vertices.
    render_recorder.draw({.vertex_count = 3});

    // VERY IMPORTANT! A renderpass must be ended after finishing!
    // The ending of a render pass returns back the original command recorder.
    // Assign it back to the task interfaces command recorder.
    ti.recorder = std::move(render_recorder).end_renderpass();
};
```

## Creating a Rendering TaskGraph

When using TaskGraph, we must create "virtual" resources (we call them task resources) whose usages are tracked, allowing for correct synchronization for them.

Back in our main method, the first we'll make is the swap chain image task resource. We could immediately give this task image an image ID. But in the case of the swapchain images we need to reacquire a new image every frame.

```cpp
auto task_swapchain_image = daxa::TaskImage{{.swapchain_image = true, .name = "swapchain image"}};
```

We need to create the actual task graph itself:

```cpp
auto loop_task_graph = daxa::TaskGraph({
    .device = device,
    .swapchain = swapchain,
    .name = "loop",
});
```

We need to explicitly declare all uses of persistent task resources because manually marking used resources makes it possible to detect errors in your graph recording.

The vertex buffer is read only after initialization, therefor it needs no runtime sync, it should be ignored by the taskgraph and get no attachment in tasks. It should be passed directly via the push constants.

```cpp
loop_task_graph.use_persistent_image(task_swapchain_image);
```

Since we need the task graph to do something, we add the task that draws to the screen:

```cpp    
auto draw_swapchain_task =
    daxa::RasterTask("draw triangle")
        .color_attachment.reads_writes(daxa::ImageViewType::REGULAR_2D, task_swapchain_image.view())
        .executes(draw_swapchain_task_callback, pipeline.get(), buffer_id);

// Insert the task into the graph:
loop_task_graph.add_task(draw_swapchain_task);
```

Once we have added all the tasks we want, we have to tell the task graph we are done.

```cpp
loop_task_graph.submit({});
// And tell the task graph to do the present step.
loop_task_graph.present({});
// Finally, we complete the task graph, which essentially compiles the
// dependency graph between tasks, and inserts the most optimal synchronization!
loop_task_graph.complete({});
```

We have now created a new task graph that can simply repeat the steps it was given,