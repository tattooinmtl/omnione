// camera_look: Omi-One takes a picture with the live camera, mid-task ("hold
// it closer… now let me look again"). Only while the user has the camera on,
// and never in a run nobody is watching (heartbeat, scheduled tasks).

import { registerTool } from '../toolRegistry.js';
import { takePicture, cameraState, CameraError } from '../camera.js';
import { getMode } from '../permissions.js';

registerTool({
  name: 'camera_look',
  description: 'Take a picture with the live camera right now and look at it (an ESP32 camera or a webcam the user chose). Works only while the user has the camera switched on; each message they send while it is on already includes one picture, so use this to look again after something changed.',
  permission: 'read',
  schema: { type: 'object', properties: {} },
  handler: async (_a, ctx = {}) => {
    if (ctx.sessionId && getMode(ctx.sessionId) === 'autonomous') {
      return { ok: false, error: 'The camera is never used in runs nobody is watching.' };
    }
    try {
      const shot = await takePicture({ signal: ctx.signal });
      return { ok: true, result: { saved: [shot.rel], camera: cameraState().label || 'camera' }, images: [{ path: shot.path, mediaType: 'image/jpeg' }] };
    } catch (e) {
      if (e instanceof CameraError) return { ok: false, error: e.message };
      throw e;
    }
  },
});
