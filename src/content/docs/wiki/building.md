---
title: Building
description: Building Daxa from source, configuring optional utilities, and consuming Daxa from your own CMake project
slug: wiki/building
---

## Getting Started

This page covers building **Daxa itself** from source - useful if you want to contribute to Daxa, run its test suite, or try out unreleased code.

If you're starting a new project that *uses* Daxa, you don't need to follow this page at all: the [Development Environment](/tutorial/introduction/development-environment/) tutorial sets you up with the [app template](https://github.com/learndaxa/tutorial-starting-point), which pulls in Daxa automatically via CMake's `FetchContent` and builds it as part of your project.

Either way, first work through [Installing Dependencies](/tutorial/introduction/installing-dependencies/) - you'll need CMake, Ninja, a C++20 compiler, and the Vulkan SDK.

## Building Daxa

Daxa's `CMakePresets.json` provides a configure preset per supported compiler/platform combination - `cl-x86_64-windows-msvc`, `clang-x86_64-windows-msvc`, `gcc-x86_64-linux-gnu`, and `clang-x86_64-linux-gnu` - each with matching `-debug`, `-relwithdebinfo`, and `-release` build presets.

### Windows

```batch
cmake --preset=cl-x86_64-windows-msvc
cmake --build --preset=cl-x86_64-windows-msvc-debug
```

### Linux

```shell
cmake --preset=gcc-x86_64-linux-gnu
cmake --build --preset=gcc-x86_64-linux-gnu-debug
```

Swap `-debug` for `-relwithdebinfo` or `-release` to build an optimized binary instead.

## Running a sample

The presets above enable `DAXA_ENABLE_TESTS`, which also builds the sample/test executables under `tests/`.

### Windows

```batch
./build/cl-x86_64-windows-msvc/tests/Debug/daxa_test_2_daxa_api_5_swapchain
```

### Linux

```shell
./build/gcc-x86_64-linux-gnu/tests/Debug/daxa_test_2_daxa_api_5_swapchain
```

## Configuring Optional Utilities

Most of Daxa's `daxa/utils/*` headers are **optional utilities** that have to be explicitly enabled via CMake cache variables before Daxa is configured. If a util's header is included without its option enabled, it fails fast with a clear compile-time error:

```text
#error "[build error] You must build Daxa with the DAXA_ENABLE_UTILS_TASK_GRAPH CMake option enabled"
```

This is the same mechanism for every util: the CMake option (e.g. `DAXA_ENABLE_UTILS_TASK_GRAPH`) controls whether Daxa is *built* with that util's source files and dependencies, and a matching `DAXA_BUILT_WITH_UTILS_*` compile definition is propagated to anything linking against `daxa::daxa` so the header can check it.

| CMake option | Enables | See also |
|---|---|---|
| `DAXA_ENABLE_UTILS_TASK_GRAPH` | `daxa/utils/task_graph.hpp` - automatic synchronization, transient resource aliasing. Implies `DAXA_ENABLE_UTILS_MEM`. | [TaskGraph](/wiki/taskgraph/) |
| `DAXA_ENABLE_UTILS_MEM` | `daxa/utils/mem.hpp` - ring buffer / `TransferMemoryPool` staging allocators. | [TransferMemoryPool](/wiki/buffer-texture-upload-and-mipmaps/#transfermemorypool-a-ready-made-reusable-staging-buffer) |
| `DAXA_ENABLE_UTILS_PIPELINE_MANAGER_GLSLANG` | GLSL shader compilation in the [Pipeline Manager](/wiki/pipeline-manager/), via glslang. | [Pipeline Manager](/wiki/pipeline-manager/) |
| `DAXA_ENABLE_UTILS_PIPELINE_MANAGER_SLANG` | Slang shader compilation in the [Pipeline Manager](/wiki/pipeline-manager/), via a prebuilt Slang release. | [Pipeline Manager](/wiki/pipeline-manager/) |
| `DAXA_ENABLE_UTILS_PIPELINE_MANAGER_SPIRV_VALIDATION` | Validates pipeline manager output with `SPIRV-Tools` (must be findable via `find_package`). | - |
| `DAXA_ENABLE_UTILS_IMGUI` | `daxa/utils/imgui.hpp` - Dear ImGui + implot renderer integration. | - |
| `DAXA_ENABLE_UTILS_FSR2` | `daxa/utils/fsr2.hpp` - AMD FSR2 upscaling. | - |
| `DAXA_ENABLE_TESTS` | Builds the sample/test executables under `tests/` (also fetches GLFW). | - |
| `DAXA_ENABLE_TOOLS` | Builds the `daxa_tools_compile_*` shader-precompilation helper executables. | - |
| `DAXA_ENABLE_STATIC_ANALYSIS` | Runs `cppcheck`/`clang-tidy` over Daxa's sources during the build, if installed. | - |
| `DAXA_USE_STATIC_CRT` | (MSVC only) Links Daxa against the static CRT (`/MT`/`/MTd`) instead of the default dynamic CRT. | - |

All of these are plain CMake cache variables and default to `OFF` unless set. They must be set **before** Daxa's `CMakeLists.txt` runs - i.e. before `add_subdirectory(...)` or `FetchContent_MakeAvailable(daxa)` - since they decide both what gets compiled into the `daxa` library and which extra dependencies `cmake/deps.cmake` fetches.

### Where the extra dependencies come from

`cmake/deps.cmake` uses CMake's [FetchContent](https://cmake.org/cmake/help/latest/module/FetchContent.html) to fetch exactly the dependencies needed by whichever utils are enabled:

- Always: the Vulkan SDK (`find_package(Vulkan REQUIRED)`) and [Vulkan Memory Allocator](https://github.com/GPUOpen-LibrariesAndSDKs/VulkanMemoryAllocator).
- `..._GLSLANG`: [glslang](https://github.com/KhronosGroup/glslang).
- `..._SLANG`: a prebuilt [Slang](https://github.com/shader-slang/slang) release archive.
- `..._IMGUI`: [Dear ImGui](https://github.com/ocornut/imgui) and [implot](https://github.com/epezent/implot).
- `DAXA_ENABLE_TESTS`: [GLFW](https://github.com/glfw/glfw).

Each `FetchContent_Declare`/`FetchContent_MakeAvailable` call is guarded with `if (... AND NOT TARGET ...)`, so if your own project already provides one of these targets (e.g. you fetch your own GLFW for windowing), Daxa reuses your target instead of fetching a second copy.

## Using Daxa in Your Own Project

The [app template](https://github.com/learndaxa/tutorial-starting-point) used in the tutorial already sets this up for you, but the pattern is simple enough to add to any CMake project:

```cmake
# cmake/deps.cmake (or directly in CMakeLists.txt)
include(FetchContent)

# Enable exactly the Daxa utils your project needs *before* fetching Daxa.
set(DAXA_ENABLE_UTILS_TASK_GRAPH ON)
set(DAXA_ENABLE_UTILS_PIPELINE_MANAGER_GLSLANG ON)
set(DAXA_ENABLE_UTILS_IMGUI ON)

FetchContent_Declare(
    daxa
    GIT_REPOSITORY https://github.com/Ipotrick/Daxa
    GIT_TAG        v3.0.2 # or a commit/branch
)
FetchContent_MakeAvailable(daxa)
```

```cmake
# CMakeLists.txt
target_link_libraries(my_app PRIVATE daxa::daxa)
target_compile_features(my_app PRIVATE cxx_std_20)
```

A git submodule pointing at the Daxa repo plus `add_subdirectory(deps/daxa)` works just as well - either way, the important part is that the `DAXA_ENABLE_UTILS_*` variables from the table above are set *before* Daxa's `CMakeLists.txt` is processed, since that's what `cmake/deps.cmake` and the `#if DAXA_BUILT_WITH_UTILS_*` checks key off of.

## Custom Validation

> **Note**: The following steps are only meant for Daxa maintainers. They are not needed if you simply want to use Daxa in a project.

You must build this repo (Debug is fine; you get symbols)

```shell
git clone https://github.com/KhronosGroup/Vulkan-ValidationLayers
```

Open up Vulkan Configurator and add a new layer profile:
![Screenshot 2022-10-02 110620](https://user-images.githubusercontent.com/28205981/193466792-96e243a4-ee97-440e-8617-b01fce8af100.png)

Add a user-defined path:
![Screenshot 2022-10-02 110800](https://user-images.githubusercontent.com/28205981/193466859-19dc5cdc-6dce-4a0f-bf67-aabd36a55003.png)

For me, it's at `C:/dev/projects/cpp/Vulkan-ValidationLayers/build/debug-windows/layers`
![Screenshot 2022-10-02 110934](https://user-images.githubusercontent.com/28205981/193466910-7e0c6be9-7eb2-4d99-b60e-2fe5b38b64bb.png)

And then override the validation layer:
![Screenshot 2022-10-02 111055](https://user-images.githubusercontent.com/28205981/193467005-4fa15b24-0f77-4eee-a0b5-0f19e7fb5876.png)

And that should be it!
