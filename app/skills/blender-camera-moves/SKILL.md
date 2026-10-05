---
name: blender-camera-moves
description: Camera animation presets for Blender 5.x through the Blender MCP server — turntable (seamless 360° loop), dolly in, crane up, orbit with tilt, slow zoom — plus lens and depth-of-field settings and turning rendered frames into an MP4. Use when the user wants a video, showcase animation, spin, orbit or "cinematic" camera.
---

# Camera move presets

Load `blender-basics` first, and set the **Animation** preset from `blender-hd-render`.

## Shared setup: camera on a pivot

Every move below uses the same rig: an empty at the subject's centre (`CamPivot`), the
camera parented to it and aimed at it. Moves animate the pivot, the camera, or both.

```python
import math
from mathutils import Vector
SUBJECT = 'Cube'
DISTANCE = 6.0      # metres from the subject
HEIGHT = 1.5        # camera height above the subject's centre
LENS = 50           # mm: 35 wide, 50 natural, 85 flattering product, 135 compressed
scene = bpy.context.scene
target = bpy.data.objects.get(SUBJECT)
center = target.matrix_world.translation.copy() if target else Vector((0, 0, 0))
pivot = bpy.data.objects.get('CamPivot') or bpy.data.objects.new('CamPivot', None)
if not pivot.users_collection:
    scene.collection.objects.link(pivot)
pivot.location = center
pivot.rotation_euler = (0, 0, 0)
cam_data = bpy.data.cameras.get('ShotCam') or bpy.data.cameras.new('ShotCam')
cam = bpy.data.objects.get('ShotCam') or bpy.data.objects.new('ShotCam', cam_data)
if not cam.users_collection:
    scene.collection.objects.link(cam)
cam.parent = pivot
cam.location = (0, -DISTANCE, HEIGHT)
cam_data.lens = LENS
cam_data.clip_end = 1000
aim = cam.constraints.get('Aim') or cam.constraints.new('TRACK_TO')
aim.name = 'Aim'
aim.target = pivot
aim.track_axis = 'TRACK_NEGATIVE_Z'
aim.up_axis = 'UP_Y'
# Soft background: focus on the subject.
cam_data.dof.use_dof = True
cam_data.dof.focus_object = target
cam_data.dof.aperture_fstop = 4.0
scene.camera = cam
{'camera': cam.name, 'lens': LENS, 'distance': DISTANCE}
```

Check the framing with `render_image` at 25% before animating. The subject should fill
60-80% of the frame height. Move closer with `DISTANCE`, not by changing the lens.

f-stop: 2.8 very soft background, 4-5.6 product (whole object sharp), 8+ everything sharp.

## Moves

Each move: set the frame range, switch new keyframes to linear (constant speed, a loop
with no stutter), insert keys, switch back. **5 seconds at 24 fps = frames 1-120.**

### Turntable (360°, loops perfectly)

```python
import math
FRAMES = 120
scene = bpy.context.scene
scene.frame_start, scene.frame_end = 1, FRAMES
scene.render.fps = 24
pivot = bpy.data.objects['CamPivot']
edit = bpy.context.preferences.edit
edit.keyframe_new_interpolation_type = 'LINEAR'
pivot.rotation_euler = (0, 0, 0)
pivot.keyframe_insert('rotation_euler', index=2, frame=1)
# The last key one frame past the end, so frame 1 and frame FRAMES+1 are the same pose:
# the loop has no repeated frame.
pivot.rotation_euler = (0, 0, math.radians(360))
pivot.keyframe_insert('rotation_euler', index=2, frame=FRAMES + 1)
edit.keyframe_new_interpolation_type = 'BEZIER'
{'frames': FRAMES, 'move': 'turntable'}
```

### Dolly in (push towards the subject)

Animate the camera's distance: key `cam.location` at `(0, -DISTANCE, HEIGHT)` on frame 1 and
`(0, -DISTANCE * 0.6, HEIGHT * 0.8)` on the last frame. Keep the default (Bezier)
interpolation here: easing in and out looks like a real dolly.

### Crane up (rise and look down)

Key `cam.location` from `(0, -DISTANCE, 0.2)` on frame 1 to `(0, -DISTANCE * 0.8, DISTANCE * 0.9)`
on the last frame. Bezier.

### Orbit with tilt (hero reveal)

Combine: pivot `rotation_euler` z from -30° to +30° (Bezier), and camera height from
`HEIGHT * 0.3` to `HEIGHT * 1.5`. 6-8 seconds.

### Slow zoom (subtle, for stills turned into video)

Key `cam.data.lens` from `LENS` on frame 1 to `LENS * 1.25` on the last frame
(`cam.data.keyframe_insert('lens', frame=...)`). Linear.

## Render the frames, then make a video

Rendering an animation takes a long time: tell the user how many frames and roughly how
long (time one frame with `render_image` first, multiply). Render to Blender's temp folder:

```python
import bpy
scene = bpy.context.scene
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = bpy.app.tempdir + 'omnione_move/frame_'
bpy.ops.render.render(animation=True)
{'frames_in': bpy.app.tempdir + 'omnione_move', 'count': scene.frame_end - scene.frame_start + 1}
```

Then encode with ffmpeg (a command: it asks the user), writing into the workspace:

`ffmpeg -y -framerate 24 -i "<frames_in>/frame_%04d.png" -c:v libx264 -pix_fmt yuv420p -crf 16 media/turntable.mp4`

For a transparent background (with the Transparent render preset) use ProRes 4444:
`-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le media/turntable.mov`.

Then `view_video` on the MP4 to check a few frames, and tell the user where it is.
