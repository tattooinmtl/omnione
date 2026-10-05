---
name: blender-basics
description: Read this first for any Blender work through the Blender MCP server (port 8765). Lists the tools, the rules execute_python enforces, the render-look-fix loop, and which blender-* preset skill to load next. Use when the user mentions Blender, 3D models, scenes, renders, materials or animation.
---

# Blender through MCP: the basics

OmniOne talks to Blender 5.2 through the Blender MCP add-on (from `C:\blender_addon_mcp`),
an MCP server inside Blender at `http://127.0.0.1:8765/mcp`. Its tools appear as
`mcp__blender__<tool>`.

## If the tools are missing

The tools only exist while Blender is open with the server started. If no `mcp__blender__*`
tool is available, tell the user:

1. Open Blender.
2. Edit → Preferences → Add-ons → **Blender MCP** → **Start Server** (or the Blender MCP
   panel in the 3D view's sidebar, N key).
3. In OmniOne: Settings → Connections → Blender → **Test**.

Don't try to start Blender yourself.

## The tools

| Tool | Use | Asks the user? |
|---|---|---|
| `get_addon_info` | Call first: version and tool list | no |
| `scene_info` | Objects, lights, cameras, frame range, render engine | no |
| `list_objects`, `get_object` | What's in the scene, one object's details | no |
| `create_object` | Primitive: cube, sphere, plane, cylinder, cone, torus, empty, camera, light | yes |
| `transform_object` | Location / rotation (radians) / scale | yes |
| `delete_object` | Delete by name (the only way to delete: see the rules below) | yes |
| `set_material`, `set_texture` | Principled BSDF material, image textures | yes |
| `add_modifier`, `remove_modifier` | Subdivision, mirror, solidify, array, bevel | yes |
| `import_asset`, `export_asset` | GLB/GLTF/FBX/OBJ/STL/PLY/USD… | yes |
| `frame_get`, `frame_set` | Timeline | get: no |
| `render_image` | Render one frame; **you get the picture back** | yes |
| `screenshot_viewport` | Fast look at the viewport; **you get the picture back** | yes |
| `execute_python` | Anything else in `bpy`. Always asks. | yes |

Prefer the dedicated tools for simple steps. Use `execute_python` for anything bigger:
one script that builds a whole lighting rig is one approval, twenty tool calls are twenty.

## Rules `execute_python` enforces

The add-on screens the code before running it. Code that breaks these is rejected:

- **No** `import os`, `sys`, `subprocess`, `shutil`, `pathlib`-style file work, `open(...)`.
- **No** calls or attributes named `remove`, `unlink`, `run`, `call`, `exec`, `eval`, `compile`,
  `system`, `popen`. So `bpy.data.objects.remove(...)` is refused: use `delete_object`.
- At most 200 top-level statements.
- Available names: `bpy`, `math`, and normal built-ins (`range`, `len`, `min`, `max`, `round`…).
  `import mathutils` and `from mathutils import Vector, Euler` work.
- The code runs with separate globals and locals: **don't define functions** that use your
  own variables, and don't use generator expressions or comprehensions over them (they can't
  see your variables). Write plain `for` loops.
- Names are matched exactly: `remove_doubles`, `remove_modifier` are fine; `.remove(...)` is not.
- **End with an expression** (a dict or a string): it is what you get back. `print` output
  is not returned.

## The loop for good-looking results

1. `scene_info` to see where things stand.
2. Build or change the scene (one `execute_python` script per step).
3. Look: `screenshot_viewport` for a quick check, or `render_image` at **25-50%
   resolution** for lighting and materials. The picture is attached to the result and saved
   in the workspace under `renders/`.
4. Say what you see that's wrong (too dark, blown highlights, flat materials, bad framing),
   fix it, and look again. Two or three rounds are normal.
5. Only then render at full quality.

## Version notes (Blender 5.x)

- Engines: `'CYCLES'`, `'BLENDER_EEVEE'` (4.2-4.4 called it `'BLENDER_EEVEE_NEXT'`), `'BLENDER_WORKBENCH'`.
- Actions are layered since 4.4 and `action.fcurves` is gone in 5.0. To make keyframes
  linear, set `bpy.context.preferences.edit.keyframe_new_interpolation_type = 'LINEAR'`
  **before** inserting them, then set it back to `'BEZIER'`.
- `material.use_nodes` / `world.use_nodes` are always on in 5.x; setting them is harmless.
- Shade smooth: `obj.data.shade_smooth()`; smooth by angle: add the "Smooth by Angle"
  modifier with `bpy.ops.object.shade_smooth_by_angle(angle=math.radians(30))` on the
  selected object.

## Preset skills

| Skill | For |
|---|---|
| `blender-hd-render` | Render settings: Cycles/EEVEE quality presets, 1080p/4K, denoise, colour |
| `blender-studio-lighting` | Three-point, softbox, rim, HDRI world, shadow catcher floor |
| `blender-pbr-materials` | Ready Principled BSDF values: metals, glass, car paint, plastics, wood… |
| `blender-camera-moves` | Turntable, dolly, crane, orbit, slow zoom; frames to video |
| `blender-product-shot` | The whole product/hero shot recipe, start to finish |
| `autonomous-modeling` | Modeling objects from a description |
