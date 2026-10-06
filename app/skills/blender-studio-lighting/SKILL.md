---
name: blender-studio-lighting
description: Studio lighting presets for Blender 5.x through the Blender MCP server — three-point, softbox product, dramatic rim, HDRI world, and an infinite floor with shadow catcher. Use when a render looks flat, dark or amateur, or the user asks for studio, product, cinematic or dramatic lighting.
---

# Studio lighting presets

Load `blender-basics` first. Each preset is one `execute_python` call. Lights aim at a
target point with a Track To constraint, so they stay pointed when you move them.

Before lighting, find the subject: `scene_info`, then use its name and size below. Light
sizes and distances scale with the subject: the numbers are for an object about 1-2 m
across. For a 10 cm product, divide distances by 10 and multiply nothing else.

## Presets

| Preset | Look | Lights |
|---|---|---|
| **Three-point** | Clean, neutral, works for almost anything | Key 45° front-left, fill front-right at 1/3, rim behind |
| **Softbox product** | Soft, glossy reflections, catalog look | Two big softboxes left/right, one overhead strip |
| **Dramatic rim** | Dark, moody, edges glow | Strong rim behind, faint key, black world |
| **HDRI** | Realistic reflections from a real place | An HDR image as the world light |

## Three-point (copy, set SUBJECT)

```python
import math
from mathutils import Vector
SUBJECT = 'Cube'   # the object to light
scene = bpy.context.scene
target = bpy.data.objects.get(SUBJECT)
center = target.matrix_world.translation.copy() if target else Vector((0, 0, 0))
rig = [
    # name, location offset, energy (W), size (m), colour
    ('Key', (-3.0, -3.0, 3.0), 800, 1.5, (1.0, 0.96, 0.9)),
    ('Fill', (3.5, -2.5, 1.5), 250, 2.5, (0.9, 0.95, 1.0)),
    ('Rim', (0.5, 4.0, 3.5), 600, 1.0, (1.0, 1.0, 1.0)),
]
made = []
for name, off, energy, size, color in rig:
    data = bpy.data.lights.get(name) or bpy.data.lights.new(name, 'AREA')
    data.type = 'AREA'
    data.energy = energy
    data.size = size
    data.color = color
    obj = bpy.data.objects.get(name) or bpy.data.objects.new(name, data)
    if obj.name not in scene.collection.objects and not obj.users_collection:
        scene.collection.objects.link(obj)
    obj.location = center + Vector(off)
    con = obj.constraints.get('Aim') or obj.constraints.new('TRACK_TO')
    con.name = 'Aim'
    con.target = target
    con.track_axis = 'TRACK_NEGATIVE_Z'
    con.up_axis = 'UP_Y'
    made.append(name)
{'lights': made, 'aimed_at': SUBJECT}
```

## Softbox product

Same script with this `rig` (soft, wide sources make smooth reflections on glossy products):

```python
rig = [
    ('Softbox_L', (-3.0, -1.0, 1.8), 600, 3.0, (1.0, 0.98, 0.95)),
    ('Softbox_R', (3.0, -1.0, 1.8), 500, 3.0, (0.95, 0.98, 1.0)),
    ('Strip_Top', (0.0, 0.5, 4.0), 400, 1.0, (1.0, 1.0, 1.0)),
]
```

For the overhead strip, after the loop: `bpy.data.lights['Strip_Top'].shape = 'RECTANGLE'`
and `.size_y = 4.0`.

## Dramatic rim

```python
rig = [
    ('Rim_L', (-2.5, 3.0, 2.0), 1500, 0.5, (1.0, 0.85, 0.7)),
    ('Rim_R', (2.5, 3.0, 2.0), 1500, 0.5, (0.7, 0.85, 1.0)),
    ('Key_Faint', (-2.0, -3.0, 2.5), 120, 2.0, (1.0, 1.0, 1.0)),
]
```

Then make the world black: `bpy.context.scene.world.color = (0, 0, 0)` and, if it has a
Background node, set its Strength to 0.

## HDRI world

HDRIs give the most realistic reflections. Poly Haven's are free (CC0). Download one into
the workspace first (it asks the user, it's a command), e.g. a 2K studio HDRI:

`curl -L -o hdri/studio_small_09_2k.hdr https://dl.polyhaven.com/file/ph-assets/HDRIs/hdr/2k/studio_small_09_2k.hdr`

Good choices: `studio_small_09` (soft studio), `brown_photostudio_02` (warm studio),
`kloofendal_48d_partly_cloudy_puresky` (outdoor daylight), `moonless_golf` (night).
Then, with the **absolute** path:

```python
import math
HDRI = r'C:\path\to\workspace\hdri\studio_small_09_2k.hdr'
STRENGTH = 1.0
ROTATE_DEG = 0
scene = bpy.context.scene
world = scene.world or bpy.data.worlds.new('World')
scene.world = world
world.use_nodes = True
nt = world.node_tree
env = nt.nodes.get('HDRI') or nt.nodes.new('ShaderNodeTexEnvironment')
env.name = 'HDRI'
env.image = bpy.data.images.load(HDRI, check_existing=True)
mapping = nt.nodes.get('HDRI Mapping') or nt.nodes.new('ShaderNodeMapping')
mapping.name = 'HDRI Mapping'
coords = nt.nodes.get('HDRI Coords') or nt.nodes.new('ShaderNodeTexCoord')
coords.name = 'HDRI Coords'
bg = nt.nodes.get('Background') or nt.nodes.new('ShaderNodeBackground')
out = nt.nodes.get('World Output') or nt.nodes.new('ShaderNodeOutputWorld')
nt.links.new(coords.outputs['Generated'], mapping.inputs['Vector'])
nt.links.new(mapping.outputs['Vector'], env.inputs['Vector'])
nt.links.new(env.outputs['Color'], bg.inputs['Color'])
nt.links.new(bg.outputs['Background'], out.inputs['Surface'])
bg.inputs['Strength'].default_value = STRENGTH
mapping.inputs['Rotation'].default_value[2] = math.radians(ROTATE_DEG)
{'hdri': env.image.name, 'strength': STRENGTH}
```

Rotate the HDRI (`ROTATE_DEG`) to move the brightest part of the sky to where you want
the main reflection. HDRI and area lights combine well: HDRI for reflections, one area
light as the key.

## Floor with a shadow catcher

An invisible floor that only keeps the shadow: the product "sits" on any background, and
with a transparent render it drops onto any page.

```python
SUBJECT = 'Cube'
scene = bpy.context.scene
target = bpy.data.objects.get(SUBJECT)
z = 0.0
if target and target.type == 'MESH':
    z = 1e9
    for v in target.data.vertices:
        z = min(z, (target.matrix_world @ v.co).z)
bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, z))
floor = bpy.context.active_object
floor.name = 'Floor'
floor.is_shadow_catcher = True
# Otherwise chrome and gloss reflect it as a flat white area.
floor.visible_glossy = False
floor.visible_transmission = False
{'floor_z': round(z, 4)}
```

For a visible studio sweep instead of a catcher, skip `is_shadow_catcher` and give the
floor a light grey material (`blender-pbr-materials`, "Matte studio backdrop").

## Check

`render_image` at 25-50%. Look for: the subject's shape reads clearly (light side vs dark
side), there is a bright edge separating it from the background, highlights aren't clipped.
Adjust energies by ×1.5 or ×0.66 steps, not tiny nudges.
