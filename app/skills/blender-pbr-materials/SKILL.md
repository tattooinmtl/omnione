---
name: blender-pbr-materials
description: Ready-made physically based (Principled BSDF) material presets for Blender 5.x through the Blender MCP server — polished and brushed metals, gold, copper, chrome, glass, frosted glass, car paint, glossy and matte plastic, rubber, ceramic, wood, fabric, skin, emissive. Use when the user wants an object to look like a real material, or a render looks "plasticky" or fake.
---

# PBR material presets

Load `blender-basics` first. One `execute_python` call creates (or updates) a named
material from the table and assigns it.

## The script (set PRESET and OBJECT)

```python
PRESET = 'brushed_aluminium'
OBJECT = 'Cube'
P = {
    #  name                 base colour (linear RGB)    metal rough  extra
    'chrome':             ((0.90, 0.90, 0.90), 1.0, 0.05, {}),
    'polished_steel':     ((0.56, 0.57, 0.58), 1.0, 0.12, {}),
    'brushed_aluminium':  ((0.91, 0.92, 0.92), 1.0, 0.32, {'Anisotropic': 0.8}),
    'gold':               ((1.00, 0.77, 0.34), 1.0, 0.18, {}),
    'copper':             ((0.95, 0.64, 0.54), 1.0, 0.25, {}),
    'black_anodized':     ((0.03, 0.03, 0.035), 1.0, 0.35, {}),
    'clear_glass':        ((1.00, 1.00, 1.00), 0.0, 0.0, {'Transmission Weight': 1.0, 'IOR': 1.5}),
    'frosted_glass':      ((0.95, 0.97, 1.00), 0.0, 0.35, {'Transmission Weight': 1.0, 'IOR': 1.5}),
    'car_paint_red':      ((0.55, 0.02, 0.02), 0.6, 0.35, {'Coat Weight': 1.0, 'Coat Roughness': 0.03}),
    'car_paint_black':    ((0.01, 0.01, 0.012), 0.5, 0.3, {'Coat Weight': 1.0, 'Coat Roughness': 0.02}),
    'glossy_plastic':     ((0.80, 0.80, 0.80), 0.0, 0.18, {'Specular IOR Level': 0.5}),
    'matte_plastic':      ((0.80, 0.80, 0.80), 0.0, 0.55, {}),
    'rubber':             ((0.02, 0.02, 0.02), 0.0, 0.85, {}),
    'ceramic_white':      ((0.85, 0.85, 0.83), 0.0, 0.08, {'Coat Weight': 0.5, 'Coat Roughness': 0.05}),
    'wood_oak':           ((0.45, 0.28, 0.15), 0.0, 0.55, {}),
    'fabric':             ((0.30, 0.32, 0.40), 0.0, 0.90, {'Sheen Weight': 0.6, 'Sheen Roughness': 0.4}),
    'skin':               ((0.80, 0.55, 0.45), 0.0, 0.45, {'Subsurface Weight': 0.3, 'Subsurface Scale': 0.02}),
    'studio_backdrop':    ((0.70, 0.70, 0.70), 0.0, 0.9, {}),
    'emissive_neon':      ((0.0, 0.0, 0.0), 0.0, 0.5, {'Emission Color': (0.1, 0.6, 1.0, 1.0), 'Emission Strength': 15.0}),
}
color, metal, rough, extra = P[PRESET]
mat = bpy.data.materials.get(PRESET) or bpy.data.materials.new(PRESET)
mat.use_nodes = True
bsdf = None
for node in mat.node_tree.nodes:
    if node.type == 'BSDF_PRINCIPLED':
        bsdf = node
if bsdf is None:
    bsdf = mat.node_tree.nodes.new('ShaderNodeBsdfPrincipled')
bsdf.inputs['Base Color'].default_value = (color[0], color[1], color[2], 1.0)
bsdf.inputs['Metallic'].default_value = metal
bsdf.inputs['Roughness'].default_value = rough
skipped = []
for key, value in extra.items():
    if key in bsdf.inputs:
        bsdf.inputs[key].default_value = value
    else:
        skipped.append(key)
obj = bpy.data.objects.get(OBJECT)
if obj is not None:
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)
{'material': mat.name, 'object': OBJECT if obj else None, 'not_in_this_blender': skipped}
```

To change the colour of a preset (a blue car paint, a green plastic), copy the row with a
new name and new base colour. Colours are **linear**, not sRGB: a mid grey is about 0.2,
not 0.5. Divide familiar 0-255 sRGB values by 255 and raise to the power 2.2.

## Making it look real

Perfectly clean materials look CG. Small changes make the biggest difference:

- **Rounded edges catch light.** Add a bevel (`add_modifier` type `BEVEL`, width 0.002-0.01 m,
  segments 3) to every hard-surface object. See `blender-product-shot`.
- **Roughness variation.** Add a Noise Texture → ColorRamp (0.25 to 0.45) into Roughness for
  metals and plastics. Very subtle.
- **Glass** needs something to refract: put a backdrop or HDRI behind it, and raise
  `transmission_bounces` (see `blender-hd-render`).
- **Image textures** (wood grain, labels): `set_texture` with the image path and the input
  (`base_color`, `roughness`, `normal`). Poly Haven has free CC0 textures.

## Check

`render_image` at 50%. Metals should show the lights as sharp or soft highlights (if they
look grey and dull, they need something bright to reflect: an HDRI or a softbox).
