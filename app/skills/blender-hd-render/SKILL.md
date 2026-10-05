---
name: blender-hd-render
description: High-definition render presets for Blender 5.x through the Blender MCP server — Preview, Product (1080p), Hero 4K, Animation and Transparent — with Cycles samples, denoising, GPU, AgX colour and light-path settings. Use when the user wants a sharper, cleaner, more realistic or higher-resolution render, or "make it look professional".
---

# HD render presets

Load `blender-basics` first if you haven't. Apply a preset with one `execute_python` call,
check with `render_image`, then adjust.

## Pick a preset

| Preset | Engine | Size | Samples | When |
|---|---|---|---|---|
| **Preview** | EEVEE | 1280×720 at 50% | 32 | Checking light and framing, fast |
| **Product** | Cycles | 1920×1080 | 256, adaptive 0.01 | Default for stills |
| **Hero 4K** | Cycles | 3840×2160 | 1024, adaptive 0.005 | Final key image, posters |
| **Animation** | Cycles | 1920×1080 | 128, adaptive 0.02 | Turntables and camera moves |
| **Transparent** | (any) | (any) | (any) | Add on top: no background, PNG with alpha |

A 4K Cycles frame can take minutes. Tell the user before starting one, and always check at
Preview or 25% first.

## Apply a preset (Product shown; change the four values for the others)

```python
scene = bpy.context.scene
r = scene.render
r.engine = 'CYCLES'
r.resolution_x, r.resolution_y, r.resolution_percentage = 1920, 1080, 100
c = scene.cycles
c.samples = 256
c.use_adaptive_sampling = True
c.adaptive_threshold = 0.01
c.use_denoising = True
c.denoiser = 'OPENIMAGEDENOISE'
c.max_bounces = 12
c.diffuse_bounces = 4
c.glossy_bounces = 6
c.transmission_bounces = 12
c.transparent_max_bounces = 8
c.caustics_reflective = False
c.caustics_refractive = False
c.blur_glossy = 0.5
c.sample_clamp_indirect = 10.0
# GPU when there is one (falls back to CPU silently).
gpu = 'CPU'
prefs = bpy.context.preferences.addons['cycles'].preferences
for kind in ('OPTIX', 'CUDA', 'HIP', 'ONEAPI', 'METAL'):
    try:
        prefs.compute_device_type = kind
        prefs.get_devices()
        found = False
        for d in prefs.devices:
            if d.type == kind:
                found = True
        if found:
            for d in prefs.devices:
                d.use = d.type == kind
            gpu = kind
            break
    except Exception:
        pass
c.device = 'GPU' if gpu != 'CPU' else 'CPU'
# Colour: AgX keeps bright highlights from clipping to flat white.
vs = scene.view_settings
vs.view_transform = 'AgX'
for look in ('AgX - Medium High Contrast', 'Medium High Contrast'):
    try:
        vs.look = look
        break
    except Exception:
        pass
vs.exposure = 0.0
vs.gamma = 1.0
r.image_settings.file_format = 'PNG'
r.image_settings.color_depth = '16'
{'engine': r.engine, 'size': (r.resolution_x, r.resolution_y), 'samples': c.samples, 'device': gpu, 'look': vs.look}
```

Values for the other presets:

- **Hero 4K**: `3840, 2160`, `samples = 1024`, `adaptive_threshold = 0.005`, `sample_clamp_indirect = 6.0`.
- **Animation**: `samples = 128`, `adaptive_threshold = 0.02`, and set
  `r.use_motion_blur = True; r.motion_blur_shutter = 0.5` for camera moves.
  Same seed every frame avoids flicker: `c.use_animated_seed = False`.
- **Preview** (EEVEE):

```python
scene = bpy.context.scene
r = scene.render
for engine in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
    try:
        r.engine = engine
        break
    except Exception:
        pass
r.resolution_x, r.resolution_y, r.resolution_percentage = 1280, 720, 50
e = scene.eevee
e.taa_render_samples = 32
for attr, value in (('use_raytracing', True), ('use_shadows', True), ('use_gtao', True)):
    try:
        setattr(e, attr, value)
    except Exception:
        pass
scene.view_settings.view_transform = 'AgX'
{'engine': r.engine, 'percent': r.resolution_percentage}
```

- **Transparent** (add after any preset):

```python
r = bpy.context.scene.render
r.film_transparent = True
r.image_settings.file_format = 'PNG'
r.image_settings.color_mode = 'RGBA'
{'transparent': r.film_transparent}
```

## Reading the render (what to fix)

| You see | Fix |
|---|---|
| Grainy / speckles ("fireflies") | Raise samples, lower `sample_clamp_indirect` to 3-6, keep denoising on |
| Blotchy, smeared detail | Too much denoising on too few samples: raise samples |
| Flat, washed-out | Look `AgX - High Contrast`, or more contrast between key and fill light |
| Highlights clip to white | `vs.exposure = -0.5`, or lower the key light |
| Glass looks black | Raise `transmission_bounces` to 16+, check the glass material's IOR |
| Too slow | Preview at 25-50% first; adaptive threshold 0.02; GPU on |

## Final render

Set `resolution_percentage = 100`, then `render_image` with `format: "PNG"`. The result
is attached and saved in the workspace's `renders/` folder: tell the user where.
