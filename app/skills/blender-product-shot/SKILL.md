---
name: blender-product-shot
description: Start-to-finish recipe for a high-definition product or hero render in Blender 5.x through the Blender MCP server — import or pick the model, clean shading and bevels, floor, studio light, materials, camera, preview, fix, final 4K. Use when the user asks for a product shot, packshot, hero image, showcase render, or "make this model look amazing".
---

# Product shot, start to finish

This strings the other Blender skills together. Load `blender-basics`, then follow the steps.
Show the user a 25-50% render after steps 4 and 6 and ask before the final 4K render.

## 1. The subject

- A file: `import_asset` with its path (GLB/GLTF/FBX/OBJ/STL/USD).
- Already in the scene: `scene_info`, then `get_object` on it.
- From scratch: `autonomous-modeling`.

Note its name, size (dimensions) and lowest point.

## 2. Clean up: what separates CG from a photo

```python
import math
SUBJECT = 'Model'
BEVEL = 0.003          # metres; ~0.2-0.5% of the object's size
obj = bpy.data.objects[SUBJECT]
bpy.ops.object.select_all(action='DESELECT')
obj.select_set(True)
bpy.context.view_layer.objects.active = obj
done = []
if obj.type == 'MESH':
    obj.data.shade_smooth()
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(30))
        done.append('smooth by angle 30°')
    except Exception as e:
        done.append('smooth by angle unavailable: ' + str(e))
    bev = obj.modifiers.get('Edge Bevel') or obj.modifiers.new('Edge Bevel', 'BEVEL')
    bev.width = BEVEL
    bev.segments = 3
    bev.limit_method = 'ANGLE'
    bev.angle_limit = math.radians(30)
    bev.harden_normals = True
    done.append('bevel')
# Sit it on the ground and centre it.
bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')
obj.location = (0, 0, obj.dimensions.z / 2)
{'object': SUBJECT, 'dimensions': (round(obj.dimensions.x, 3), round(obj.dimensions.y, 3), round(obj.dimensions.z, 3)), 'done': done}
```

Skip the bevel on organic or already-detailed scanned models (it would do nothing useful).

Curved low-poly meshes (primitives, simple game models) show facets on their silhouette in a
close-up. Add a Subdivision Surface modifier: `sub = obj.modifiers.new('Subdivision', 'SUBSURF')`,
`sub.levels = 2`, `sub.render_levels = 3`. Tested on a UV sphere: it removes the faceted edge.

## 3. Floor

Shadow-catcher floor from `blender-studio-lighting` (for a transparent PNG to place on any
background), or a visible backdrop with the `studio_backdrop` material for a studio look.

A shadow catcher still shows up in reflections as a flat white area on chrome and gloss.
Hide it from them: `floor.visible_glossy = False` and `floor.visible_transmission = False`.

**Chrome and polished metal reflect their surroundings and nothing else.** Against a plain
grey world they render as a dark, flat ball with a few light spots (tested). Give them an HDRI
(`blender-studio-lighting`) or a visible studio backdrop and big softboxes to reflect.

## 4. Light, then look

`blender-studio-lighting`: **Softbox product** for glossy products, **Three-point** for
everything else, an **HDRI** when there is chrome or glass. Then the **Preview** preset
(`blender-hd-render`) and `render_image`. Fix light before materials: a good material
under bad light still looks bad.

## 5. Materials

`blender-pbr-materials`. One material per visible part. Products usually combine one hero
material (anodized metal, glossy plastic) with one or two supporting ones (rubber, glass).

## 6. Camera

The rig from `blender-camera-moves` with `LENS = 85` and `aperture_fstop = 5.6`: a long lens
flattens perspective the way product photographers do. Classic angles:

| Angle | Pivot rotation z | Camera height | Feel |
|---|---|---|---|
| Three-quarter front | -35° | 0.35 × distance | The default packshot |
| Hero low | -20° | 0.05 × distance | Big, powerful |
| Top-down | 0° | 1.0 × distance, look straight down | Flat lay |
| Profile | -90° | 0.2 × distance | Shape and silhouette |

`render_image` at 50% with **Product** settings. Check: sharp where it matters, no clipped
highlights, a bright rim separating it from the background, nothing cut off at the frame edge.

## 7. Final

Ask the user, then **Hero 4K** (`blender-hd-render`), `+ Transparent` if they want a cut-out,
and `render_image`. Report the file in `renders/` and how long it took.

For a video: `blender-camera-moves` → Turntable.
