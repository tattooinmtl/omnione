---
name: autonomous-modeling
description: Use this skill to autonomously design and model complex 3D objects in Blender. Perfect for generating chassis, robots, and environment props from natural language.
---

# Autonomous Modeling Skill

**Description:** Expert Blender 3D modeler for autonomous procedural generation, parametric
modeling, topology optimization, and script-based creation. Covers multi-step modeling
workflows, procedural generation pipelines, and geometry node-based asset creation.

Works through the Blender MCP server (port 8765). Load `blender-basics` first for the tool
list and the rules `execute_python` enforces.

## Trigger Phrases

- "Model a [object] with [features]"
- "Generate a procedural [part/asset]"
- "Create a parametric [object] with adjustable parameters"
- "Design a [style] [object] with detailed [elements]"
- "Optimize topology on this mesh"
- "Generate a low-poly version of [object]"
- "Create a modular kit of [theme] parts"

## Tools

These are the tools the Blender MCP add-on actually has (as `mcp__blender__<name>`):

- `scene_info()` and `get_addon_info()` — current scene state: objects, active object, render
  engine, frame range; the add-on's version and tools.
- `list_objects()`, `get_object(name)` — what exists, one object's mesh, modifiers, materials.
- `create_object(type, name, location, rotation, scale)` — add primitives: cube, sphere,
  plane, cylinder, cone, torus, empty, camera, light.
- `add_modifier(object, type, ...)` / `remove_modifier` — subdivision, mirror, solidify,
  array, bevel.
- `set_material(object, ...)` — create or assign a Principled BSDF material
  (presets: `blender-pbr-materials`).
- `transform_object`, `delete_object`.
- `execute_python(code)` — everything else: booleans, extrusions, bmesh edits, geometry
  nodes, mesh checks. One script per modeling stage keeps approvals few.
- `screenshot_viewport()` / `render_image()` — look at the result (the picture comes back to you).

There is no single "do the whole workflow" tool: you are the planner. Plan, then build in
stages with the tools above, and look after each stage.

## Workflow

1. **Discovery**: `scene_info()` to assess the scene. `get_addon_info()` if unsure what's available.
2. **Planning**: Write a short plan for the user before touching Blender: the parts
   (body, joints, details), their rough sizes in metres, the modeling approach for each
   (primitive + modifiers, boolean cuts, extrusion, array), and the materials.
3. **Execution**: Build the base forms (one `execute_python` script, or `create_object`
   for a few parts), refine with `add_modifier` (mirror for symmetry, bevel for edges,
   solidify for panels, array for repeats), and assign materials with `set_material`.
   Name every object clearly (`Robot_Torso`, `Robot_Arm_L`) and parent parts to an empty
   named after the whole object.
4. **Refinement**: If the model is too simple, do a detail pass with `execute_python`:
   edge loops, insets and extrusions with `bmesh`, panel lines by boolean, bolts and
   vents by array. `screenshot_viewport` after each pass.
5. **Validation**: Check mesh integrity before finishing (the script below): non-manifold
   edges, zero-area faces, n-gons, flipped normals. Fix what it reports, then a final
   `render_image` (lighting from `blender-studio-lighting` if the scene has none).

### Mesh check

```python
import bmesh
NAME = 'Robot_Torso'
obj = bpy.data.objects[NAME]
bm = bmesh.new()
bm.from_mesh(obj.data)
non_manifold = 0
for e in bm.edges:
    if not e.is_manifold:
        non_manifold += 1
zero_area = 0
ngons = 0
for f in bm.faces:
    if f.calc_area() < 1e-8:
        zero_area += 1
    if len(f.verts) > 4:
        ngons += 1
counts = {'verts': len(bm.verts), 'faces': len(bm.faces), 'non_manifold_edges': non_manifold, 'zero_area_faces': zero_area, 'ngons': ngons}
bm.free()
counts
```

Fixes: `bpy.ops.mesh.normals_make_consistent(inside=False)` in edit mode for normals,
`bpy.ops.mesh.dissolve_degenerate()` for zero-area faces, and "Merge by Distance" with
`bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0001)` then `bm.to_mesh(obj.data)`.

## Examples

### Creating a Sci-Fi Robot
"I need a steampunk robot with exposed gears and copper plates." → plan torso, head, arms,
legs, gear joints → base forms with `execute_python` (cylinders and boxes, mirror modifier
for left/right) → gears as cylinders with an array of teeth (array modifier around an empty)
→ `set_material` copper (`blender-pbr-materials`: copper, black_anodized) → `screenshot_viewport`
→ detail pass on the joints → mesh check → render.

### Modular Environment Kit
"Create a modular sci-fi wall panel with indented vents, 4 units wide." → one panel exactly
1 × 1 m with its origin at a corner (so pieces snap) → vents by boolean difference with an
arrayed cutter → bevel modifier → verify repeatability with an array modifier of count 4
→ apply nothing until the user is happy.

### Parametric Object
"Generate a parametric gear with adjustable teeth count and radius." → `execute_python`
script with `TEETH`, `RADIUS`, `THICKNESS` at the top that builds the gear (a cylinder plus
one tooth and an array modifier with an empty rotated 360/TEETH degrees). Tell the user the
three numbers to change and offer to rebuild with new values. Geometry Nodes are possible
through `execute_python` too, but a scripted build is easier to adjust in conversation.
