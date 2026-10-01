// The face: a live wireframe head, after ProductionEXAMPLES/face1.jpg.
//
// No model file. The head is a parametric surface — a lathe-like profile
// swept around the vertical axis, with the features (brow, eye sockets,
// nose, cheeks, lips, chin, ears) added as smooth bumps on the front. Every
// frame the expression parameters from the emotion engine reshape that
// surface on the CPU: brows lift and knit, cheeks rise with a smile, mouth
// corners turn up or down, the jaw drops with the voice. Then it is drawn
// three ways:
//   * grid lines along both parameter directions — the wireframe,
//   * a dark occluder mesh with a fresnel rim, so back lines are hidden and
//     the face has a faint inner glow,
//   * glowing eyelids, lashes and pupils as their own bright geometry,
// plus a drifting dust of particles, and bloom over the lot.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

// Signal-loss glitch: RGB split plus horizontal bands that jump sideways.
// Off at 0; a cue's "subtle_glitch" is about 0.3, anger adds a little.
const GlitchShader = {
  uniforms: { tDiffuse: { value: null }, amount: { value: 0 }, time: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float amount; uniform float time; varying vec2 vUv;
    float rnd(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 uv = vUv;
      float band = floor(uv.y * 38.0 + floor(time * 14.0) * 7.0);
      float jump = step(1.0 - amount * 0.35, rnd(vec2(band, floor(time * 14.0))));
      uv.x += (rnd(vec2(band, time)) - 0.5) * 0.08 * amount * jump;
      float split = 0.006 * amount * (0.4 + jump);
      vec4 c = texture2D(tDiffuse, uv);
      c.r = texture2D(tDiffuse, uv + vec2(split, 0.0)).r;
      c.b = texture2D(tDiffuse, uv - vec2(split, 0.0)).b;
      gl_FragColor = c;
    }`,
};

const U = 76;   // around
const V = 74;   // top to shoulders
const Y_TOP = 1.12;
const Y_BOT = -1.55;

// Cross-section keyframes: y, half-width, front depth, back depth, z-centre.
const PROFILE = [
  [0.35, 0.86, 0.88, 0.95, 0.00],
  [0.00, 0.84, 0.90, 0.92, 0.00],
  [-0.35, 0.79, 0.88, 0.82, 0.00],
  [-0.65, 0.63, 0.82, 0.66, 0.00],
  [-0.90, 0.42, 0.66, 0.50, -0.02],
  [-1.05, 0.36, 0.32, 0.42, -0.12],
  [-1.28, 0.38, 0.34, 0.40, -0.18],
  [-1.55, 0.58, 0.44, 0.44, -0.20],
];

const smooth = (t) => t * t * (3 - 2 * t);

function crossSection(y) {
  if (y >= PROFILE[0][0]) {
    // Cranium: a rounded cap over the top keyframe.
    const [, rx, zf, zb, cz] = PROFILE[0];
    const s = Math.sqrt(Math.max(0, 1 - ((y - PROFILE[0][0]) / (Y_TOP - PROFILE[0][0])) ** 2));
    return [rx * s, zf * s, zb * s, cz];
  }
  for (let i = 0; i < PROFILE.length - 1; i++) {
    const a = PROFILE[i];
    const b = PROFILE[i + 1];
    if (y <= a[0] && y >= b[0]) {
      const t = smooth((a[0] - y) / (a[0] - b[0]));
      return [1, 2, 3, 4].map((k) => a[k] + (b[k] - a[k]) * t);
    }
  }
  const last = PROFILE.at(-1);
  return [last[1], last[2], last[3], last[4]];
}

const g2 = (x, y, cx, cy, sx, sy) => Math.exp(-(((x - cx) ** 2) / (2 * sx * sx) + ((y - cy) ** 2) / (2 * sy * sy)));
const MOUTH_Y = -0.47;

/* Feature displacement on the front of the face: [dx, dy, dz, glow]. */
function features(x, y, p) {
  const ax = Math.abs(x);
  const smile = p.smile || 0;
  const jaw = p.jawOpen || 0;
  let dx = 0;
  let dy = 0;
  let dz = 0;
  let glow = 0;

  // One brow up — scepticism, a smirk's partner.
  dy += (p.browAsym || 0) * 0.075 * g2(x, y, 0.28, 0.27, 0.14, 0.09);

  // Brow ridge, lifted and knit by the expression.
  const browY = 0.28 + (p.browRaise || 0) * 0.06;
  dz += 0.05 * g2(ax, y, 0.28, browY, 0.2, 0.05);
  dy += (p.browRaise || 0) * 0.06 * g2(ax, y, 0.28, 0.27, 0.22, 0.09);
  dy -= (p.browFurrow || 0) * 0.05 * g2(ax, y, 0.13, 0.25, 0.1, 0.07);
  dz += (p.browFurrow || 0) * 0.025 * g2(ax, y, 0.1, 0.24, 0.08, 0.06);

  // Eye sockets; a squint lifts the lower rim.
  dz -= 0.095 * g2(ax, y, 0.3, 0.12, 0.13, 0.085);
  dy += (p.squint || 0) * 0.02 * g2(ax, y, 0.3, 0.05, 0.12, 0.04);
  glow += 0.35 * g2(ax, y, 0.3, 0.12, 0.16, 0.06);
  glow += 0.25 * g2(x, y, 0, -0.14, 0.09, 0.14); // nose

  // Nose: bridge, tip and wings.
  dz += 0.1 * g2(x, y, 0, 0.0, 0.05, 0.2);
  dz += 0.2 * g2(x, y, 0, -0.2, 0.075, 0.085);
  dz += 0.06 * g2(ax, y, 0.1, -0.25, 0.05, 0.04);

  // Cheeks rise with a smile.
  const cheek = g2(ax, y, 0.36, -0.2, 0.13, 0.11);
  dz += (0.05 + Math.max(0, smile) * 0.035) * cheek;
  dy += smile * 0.03 * cheek;

  // Lips.
  const upper = g2(x, y, 0, -0.42, 0.17, 0.035);
  const lower = g2(x, y, 0, -0.525, 0.15, 0.042);
  dz += 0.07 * upper + 0.075 * lower;
  glow += 0.9 * (upper + lower) + (p.jawOpen || 0) * 0.8 * g2(x, y, 0, MOUTH_Y, 0.16, 0.08);

  // Mouth corners: up for a smile, down for a frown, and a little wider.
  const corner = g2(ax, y, 0.19, MOUTH_Y, 0.07, 0.07);
  dy += smile * 0.055 * corner;
  // A smirk lifts one corner (the viewer's right) and pulls the other flat.
  const smirk = p.smirk || 0;
  dy += smirk * 0.06 * g2(x, y, 0.19, MOUTH_Y, 0.07, 0.07);
  dy -= smirk * 0.012 * g2(x, y, -0.19, MOUTH_Y, 0.07, 0.07);
  dz += Math.max(0, smirk) * 0.02 * g2(x, y, 0.3, -0.3, 0.1, 0.1);
  dx += Math.sign(x) * Math.max(0, smile) * 0.02 * corner;

  // The jaw: everything below the lip line drops with the voice, most at the
  // centre, fading toward the ears and into the neck.
  if (y < MOUTH_Y) {
    const below = smooth(Math.min(1, (MOUTH_Y - y) / 0.04));
    const reach = Math.exp(-(x * x) / (2 * 0.34 * 0.34)) * (1 - smooth(Math.min(1, Math.max(0, (-0.95 - y) / 0.25))));
    dy -= jaw * 0.15 * below * reach;
    dz -= jaw * 0.03 * below * reach;
  }
  // The mouth interior sinks as it opens.
  dz -= jaw * 0.08 * g2(x, y, 0, MOUTH_Y - jaw * 0.05, 0.12, 0.03 + jaw * 0.04);

  // Chin.
  dz += 0.08 * g2(x, y, 0, -0.84, 0.14, 0.08);

  return [dx, dy, dz, glow];
}

/* One point on the head surface for parameter (u around, v down). */
function headPoint(u, v, p, out) {
  const theta = (u - 0.5) * Math.PI * 2; // 0 = facing the camera
  let y = Y_TOP + (Y_BOT - Y_TOP) * v;
  const [rx, zf, zb, cz] = crossSection(y);
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  let x = rx * s;
  let z = cz + (c >= 0 ? zf : zb) * c;
  let glow = 0;

  // Features only on the face side, faded out toward the ears.
  const front = c > 0 ? smooth(Math.min(1, c * 1.6)) : 0;
  if (front > 0 && y > -1.05) {
    const [dx, dy, dz, gl] = features(x, y, p);
    x += dx * front;
    y += dy * front;
    z += dz * front;
    glow = gl * front;
  }
  // Ears.
  const ear = g2(y, 0, 0.03, 0, 0.13, 1) * Math.pow(Math.abs(s), 8) * (c > -0.3 ? 1 : 0);
  x += Math.sign(s) * 0.06 * ear;

  out.x = x;
  out.y = y;
  out.z = z;
  out.glow = glow;
  out.rim = Math.abs(s);
  return out;
}

/* The surface z of the face at (x, y), for placing the eyes on it. */
function faceZ(x, y, p) {
  const [rx, zf, , cz] = crossSection(y);
  const s = Math.max(-1, Math.min(1, x / rx));
  const c = Math.cos(Math.asin(s));
  return cz + zf * c + features(x, y, p)[2];
}

const PARTICLE_VERT = /* glsl */`
  attribute float seed;
  attribute vec3 dir;
  uniform float time;
  uniform float agitation;
  uniform float pixelRatio;
  varying float vAlpha;
  void main() {
    float t = time * (0.15 + agitation * 0.6) + seed * 40.0;
    float drift = fract(t * 0.05 + seed);
    vec3 p = position + dir * (0.02 + drift * (0.25 + agitation * 0.9) * seed)
      + vec3(sin(t + seed * 6.0), cos(t * 0.8 + seed * 3.0), sin(t * 0.6)) * 0.012 * (1.0 + agitation * 3.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (1.2 + seed * 2.2) * pixelRatio * (3.0 / -mv.z);
    vAlpha = (1.0 - drift) * (0.35 + 0.65 * seed);
  }
`;
const PARTICLE_FRAG = /* glsl */`
  uniform vec3 color;
  uniform float glow;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    gl_FragColor = vec4(color, vAlpha * (0.22 + glow * 0.3) * smoothstep(0.5, 0.0, d));
  }
`;

const SKIN_VERT = /* glsl */`
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const SKIN_FRAG = /* glsl */`
  uniform vec3 color;
  uniform float glow;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float f = pow(1.0 - max(dot(normalize(vN), normalize(vV)), 0.0), 2.2);
    vec3 base = vec3(0.004, 0.03, 0.045);
    gl_FragColor = vec4(base + color * (0.015 + f * 0.09) * (0.6 + glow), 1.0);
  }
`;

// The mouth, while the agent speaks: Siri-style lobes — a few overlapping
// sine waves under a bell envelope, each filled top and bottom, each with its
// own frequency, drift and colour, their height following the voice.
const MOUTH_COLS = 72;
const MOUTH_HALF_W = 0.24;
const MOUTH_WAVES = [
  { color: 0x2ff5e6, freq: 1.6, speed: 5.2, gain: 1.0, phase: 0.0 },
  { color: 0x4d7bff, freq: 2.3, speed: -4.1, gain: 0.8, phase: 1.7 },
  { color: 0xe04dff, freq: 3.1, speed: 6.3, gain: 0.65, phase: 3.1 },
  { color: 0xffffff, freq: 1.2, speed: -3.0, gain: 0.35, phase: 4.4 },
];

const MOUTH_VERT = 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
const MOUTH_FRAG = 'uniform vec3 color; uniform float opacity; varying float vA; void main(){ gl_FragColor = vec4(color * 0.55, vA * opacity); }';

const CYAN = new THREE.Color(0x2ff5e6);
const MAGENTA = new THREE.Color(0xe04dff);

export class FaceScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x020b12, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x01070c);
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    this.camera.position.set(0, -0.15, 5.6);

    this.head = new THREE.Group();
    this.scene.add(this.head);
    this.params = { smile: 0, browRaise: 0, browFurrow: 0, eyeOpen: 0.7, squint: 0, gazeX: 0, gazeY: 0, headTilt: 0, headTurn: 0, headNod: 0, glow: 0.6, agitation: 0.2, hue: 0.1, jawOpen: 0 };
    this.color = CYAN.clone();
    this.time = 0;

    this.#buildGrid();
    this.#buildEyes();
    this.#buildMouthWave();
    this.#buildParticles();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.6, 0.45, 0.35);
    this.composer.addPass(this.bloom);
    this.glitch = new ShaderPass(GlitchShader);
    this.composer.addPass(this.glitch);
    this.composer.addPass(new OutputPass());

    this.resize();
  }

  #buildGrid() {
    this.pts = new Array(U * V);
    for (let i = 0; i < this.pts.length; i++) this.pts[i] = { x: 0, y: 0, z: 0, glow: 0, rim: 0 };

    const segs = U * V + U * (V - 1);
    this.linePos = new Float32Array(segs * 2 * 3);
    this.lineCol = new Float32Array(segs * 2 * 3);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute('color', new THREE.BufferAttribute(this.lineCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.lines.frustumCulled = false;
    this.head.add(this.lines);

    // Occluder skin: same grid as triangles, pushed slightly back in depth so
    // the lines on the surface win the depth test and lines behind lose it.
    this.skinPos = new Float32Array(U * V * 3);
    const idx = [];
    for (let v = 0; v < V - 1; v++) {
      for (let u = 0; u < U; u++) {
        const a = v * U + u;
        const b = v * U + ((u + 1) % U);
        const c = (v + 1) * U + u;
        const d = (v + 1) * U + ((u + 1) % U);
        idx.push(a, c, b, b, c, d);
      }
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.skinPos, 3).setUsage(THREE.DynamicDrawUsage));
    sg.setIndex(idx);
    this.skinGeo = sg;
    this.skinMat = new THREE.ShaderMaterial({
      vertexShader: SKIN_VERT,
      fragmentShader: SKIN_FRAG,
      uniforms: { color: { value: CYAN.clone() }, glow: { value: 0.6 } },
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    });
    this.skin = new THREE.Mesh(sg, this.skinMat);
    this.skin.frustumCulled = false;
    this.skin.renderOrder = -1;
    this.head.add(this.skin);
  }

  #buildEyes() {
    // Two lids, lashes and a pupil ring per eye, rebuilt each frame.
    this.eyeSeg = 28;
    const lashes = 18;
    const perEye = (this.eyeSeg * 2) * 2 + lashes * 2 + 24 * 2;
    this.eyePos = new Float32Array(perEye * 2 * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.eyePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.eyeMat = new THREE.LineBasicMaterial({ color: 0x9ffff6, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.eyes = new THREE.LineSegments(g, this.eyeMat);
    this.eyes.frustumCulled = false;
    this.head.add(this.eyes);
  }

  #buildMouthWave() {
    this.voiceLevel = 0;
    this.mouthOn = 0;
    this.mouthGroup = new THREE.Group();
    this.mouthWaves = MOUTH_WAVES.map((w) => {
      // A strip of quads: one top and one bottom vertex per column.
      const pos = new Float32Array(MOUTH_COLS * 2 * 3);
      const alpha = new Float32Array(MOUTH_COLS * 2);
      const idx = [];
      for (let i = 0; i < MOUTH_COLS - 1; i++) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
      g.setIndex(idx);
      const mat = new THREE.ShaderMaterial({
        vertexShader: MOUTH_VERT,
        fragmentShader: MOUTH_FRAG,
        uniforms: { color: { value: new THREE.Color(w.color) }, opacity: { value: 0 } },
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 10;
      this.mouthGroup.add(mesh);
      return { ...w, mesh, pos, alpha, level: 0 };
    });
    // The thin bright centre line the lobes grow out of.
    const lp = new Float32Array(MOUTH_COLS * 3);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(lp, 3).setUsage(THREE.DynamicDrawUsage));
    this.mouthLineMat = new THREE.LineBasicMaterial({ color: 0xcffcff, transparent: true, opacity: 0, depthTest: false, blending: THREE.AdditiveBlending });
    this.mouthLine = new THREE.Line(lg, this.mouthLineMat);
    this.mouthLine.frustumCulled = false;
    this.mouthLine.renderOrder = 11;
    this.mouthLinePos = lp;
    this.mouthGroup.add(this.mouthLine);
    this.head.add(this.mouthGroup);
  }

  /* The agent's voice level (0..1), shown as the mouth waveform. */
  setVoice(level) {
    this.voiceLevel = Math.max(0, Math.min(1, level || 0));
  }

  #updateMouthWave(dt) {
    const p = this.params;
    const cy = MOUTH_Y - 0.015 + (p.smile || 0) * 0.012;
    // The whole waveform fades in with speech and lingers a moment after it.
    const target = this.voiceLevel > 0.02 ? 1 : 0;
    this.mouthOn += (target - this.mouthOn) * (1 - Math.exp(-(target ? 10 : 3) * dt));
    const on = this.mouthOn;

    for (const w of this.mouthWaves) {
      // Each lobe follows the voice with its own lag, so they never move in lockstep.
      const lvl = this.voiceLevel * w.gain * (0.75 + 0.25 * Math.sin(this.time * (2 + w.freq) + w.phase));
      w.level += (lvl - w.level) * (1 - Math.exp(-(lvl > w.level ? 18 : 6) * dt));
      const amp = 0.01 + w.level * 0.11;
      let k = 0;
      for (let i = 0; i < MOUTH_COLS; i++) {
        const t = i / (MOUTH_COLS - 1);
        const x = (t * 2 - 1) * MOUTH_HALF_W;
        // Siri's attenuation, (K / (K + x^4))^K: a bell with flat shoulders.
        const nx = (t * 2 - 1) * 2;
        const env = Math.pow(4 / (4 + nx ** 4), 4);
        const h = Math.abs(Math.sin(nx * w.freq * 1.4 + this.time * w.speed + w.phase)) * amp * env;
        const z = faceZ(x, cy, p) + 0.035;
        w.pos[k] = x; w.pos[k + 1] = cy + h; w.pos[k + 2] = z;
        w.pos[k + 3] = x; w.pos[k + 4] = cy - h; w.pos[k + 5] = z;
        k += 6;
        w.alpha[i * 2] = 0.35 + 0.65 * env;
        w.alpha[i * 2 + 1] = 0.35 + 0.65 * env;
      }
      w.mesh.geometry.attributes.position.needsUpdate = true;
      w.mesh.geometry.attributes.alpha.needsUpdate = true;
      w.mesh.material.uniforms.opacity.value = 0.42 * on;
    }
    for (let i = 0; i < MOUTH_COLS; i++) {
      const t = i / (MOUTH_COLS - 1);
      const x = (t * 2 - 1) * MOUTH_HALF_W * 1.05;
      this.mouthLinePos[i * 3] = x;
      this.mouthLinePos[i * 3 + 1] = cy;
      this.mouthLinePos[i * 3 + 2] = faceZ(x, cy, p) + 0.036;
    }
    this.mouthLine.geometry.attributes.position.needsUpdate = true;
    this.mouthLineMat.opacity = 0.45 * on;
  }

  #buildParticles() {
    const N = 7000;
    const pos = new Float32Array(N * 3);
    const dir = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    const tmp = { x: 0, y: 0, z: 0 };
    const neutral = { ...this.params };
    for (let i = 0; i < N; i++) {
      // Denser on the viewer's right and on the face, like the reference.
      let u = Math.random();
      if (Math.random() < 0.45) u = 0.5 + Math.random() * 0.3;
      const v = Math.pow(Math.random(), 0.9) * 0.92;
      headPoint(u, v, neutral, tmp);
      const len = Math.hypot(tmp.x, tmp.z) || 1;
      const out = 1 + Math.random() * 0.06 + (Math.random() < 0.15 ? Math.random() * 0.5 : 0);
      pos[i * 3] = tmp.x * out;
      pos[i * 3 + 1] = tmp.y;
      pos[i * 3 + 2] = tmp.z * out;
      dir[i * 3] = tmp.x / len + (Math.random() - 0.5) * 0.6 + 0.35;
      dir[i * 3 + 1] = (Math.random() - 0.5) * 0.6;
      dir[i * 3 + 2] = tmp.z / len + (Math.random() - 0.5) * 0.6;
      seed[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('dir', new THREE.BufferAttribute(dir, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    this.particleMat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: {
        time: { value: 0 },
        agitation: { value: 0.2 },
        glow: { value: 0.6 },
        color: { value: CYAN.clone() },
        pixelRatio: { value: this.renderer.getPixelRatio() },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.particles = new THREE.Points(g, this.particleMat);
    this.particles.frustumCulled = false;
    this.head.add(this.particles);
  }

  resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.camera.aspect = w / h;
    // Keep the whole head in frame on tall and wide panels alike.
    this.camera.position.z = w / h < 0.8 ? 5.6 / Math.max(0.55, w / h / 0.8) : 5.6;
    this.camera.updateProjectionMatrix();
  }

  setParams(p) {
    Object.assign(this.params, p);
    // The waveform is the mouth now; the jaw only hints at speech, so the
    // lobes sit on a steady face instead of a gaping one.
    this.params.jawOpen = (p.jawOpen || 0) * 0.3;
  }

  #updateGrid() {
    const p = this.params;
    const pts = this.pts;
    for (let v = 0; v < V; v++) {
      for (let u = 0; u < U; u++) headPoint(u / U, v / (V - 1), p, pts[v * U + u]);
    }

    for (let i = 0; i < pts.length; i++) {
      this.skinPos[i * 3] = pts[i].x;
      this.skinPos[i * 3 + 1] = pts[i].y;
      this.skinPos[i * 3 + 2] = pts[i].z;
    }
    this.skinGeo.attributes.position.needsUpdate = true;
    this.skinGeo.computeVertexNormals();

    // A slow scan band sweeping down the face, and the overall glow.
    const scanY = Y_TOP - ((this.time * 0.22) % 1.4) * (Y_TOP - Y_BOT) * 1.1;
    // Dense additive lines saturate fast: keep the base dim and let the
    // features, the rim and the scan band carry the brightness.
    const base = 0.07 + p.glow * 0.12;
    const col = this.color;
    let k = 0;
    const put = (a) => {
      const shade = Math.min(1.2, base + a.rim * a.rim * 0.16 + a.glow * 0.28 + Math.exp(-((a.y - scanY) ** 2) / 0.004) * 0.22);
      // Fade the shoulders out, like the reference.
      const fade = a.y < -1.3 ? Math.max(0, 1 - (-1.3 - a.y) / 0.42) : 1;
      this.linePos[k] = a.x; this.lineCol[k++] = col.r * shade * fade;
      this.linePos[k] = a.y; this.lineCol[k++] = col.g * shade * fade;
      this.linePos[k] = a.z; this.lineCol[k++] = col.b * shade * fade;
    };
    for (let v = 0; v < V; v++) {
      for (let u = 0; u < U; u++) {
        put(pts[v * U + u]);
        put(pts[v * U + ((u + 1) % U)]);
      }
    }
    for (let u = 0; u < U; u++) {
      for (let v = 0; v < V - 1; v++) {
        put(pts[v * U + u]);
        put(pts[(v + 1) * U + u]);
      }
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
  }

  #updateEyes() {
    const p = this.params;
    const open = Math.max(0, Math.min(1, p.eyeOpen - p.squint * 0.25));
    let k = 0;
    const out = this.eyePos;
    const push = (x, y) => {
      out[k++] = x;
      out[k++] = y;
      out[k++] = faceZ(x, y, p) + 0.012;
    };
    for (const side of [-1, 1]) {
      const cx = side * 0.3;
      const cy = 0.115 + (p.browRaise || 0) * 0.008;
      const w = 0.135;
      const lid = (t, sign) => {
        const x = cx + (t - 0.5) * 2 * w;
        const arch = Math.sin(Math.PI * t);
        // Closed: both lids meet on a gentle downward curve.
        const closed = cy - 0.012 * arch;
        const openY = cy + sign * (sign > 0 ? 0.05 : 0.032) * arch;
        return [x, closed + (openY - closed) * open];
      };
      for (const sign of [1, -1]) {
        for (let i = 0; i < this.eyeSeg; i++) {
          const a = lid(i / this.eyeSeg, sign);
          const b = lid((i + 1) / this.eyeSeg, sign);
          push(a[0], a[1]); push(b[0], b[1]);
        }
      }
      // Lashes hang from the closed lid and fold away as the eye opens.
      const lashLen = 0.03 * Math.max(0, 1 - open / 0.35);
      for (let i = 0; i < 18; i++) {
        const t = 0.1 + (i / 17) * 0.8;
        const [x, y] = lid(t, -1);
        push(x, y);
        push(x + (t - 0.5) * 0.01, y - lashLen * (0.6 + 0.4 * Math.sin(Math.PI * t)));
      }
      // Pupil ring, following the gaze, visible only when the eye is open.
      const r = 0.022 * Math.min(1, open * 1.6);
      const px = cx + p.gazeX * 0.05;
      const py = cy + 0.004 + p.gazeY * 0.018 * open;
      for (let i = 0; i < 24; i++) {
        const a0 = (i / 24) * Math.PI * 2;
        const a1 = ((i + 1) / 24) * Math.PI * 2;
        push(px + Math.cos(a0) * r, py + Math.sin(a0) * r * 0.9);
        push(px + Math.cos(a1) * r, py + Math.sin(a1) * r * 0.9);
      }
    }
    this.eyes.geometry.attributes.position.needsUpdate = true;
    this.eyes.geometry.setDrawRange(0, k / 3);
  }

  render(dt) {
    this.time += dt;
    const p = this.params;
    this.color.copy(CYAN).lerp(MAGENTA, Math.max(0, Math.min(1, p.hue)));

    this.#updateGrid();
    this.#updateEyes();
    this.#updateMouthWave(dt);

    this.head.rotation.set(
      -p.headNod * 0.28 + 0.04,
      p.headTurn * 0.5 + p.gazeX * 0.06,
      -p.headTilt * 0.22,
    );
    this.head.position.y = Math.sin(this.time * 0.8) * 0.015;

    this.skinMat.uniforms.color.value.copy(this.color);
    this.skinMat.uniforms.glow.value = p.glow;
    this.eyeMat.color.copy(this.color).lerp(new THREE.Color(1, 1, 1), 0.35).multiplyScalar(0.8 + p.glow * 0.5);
    this.particleMat.uniforms.time.value = this.time;
    this.particleMat.uniforms.agitation.value = p.agitation;
    this.particleMat.uniforms.glow.value = p.glow;
    this.particleMat.uniforms.color.value.copy(this.color);
    this.bloom.strength = 0.45 + p.glow * 0.4 + (p.jawOpen || 0) * 0.15;
    const g = Math.max(0, Math.min(1, p.glitch || 0));
    this.glitch.enabled = g > 0.02;
    this.glitch.uniforms.amount.value = g;
    this.glitch.uniforms.time.value = this.time;

    this.composer.render(dt);
  }

  dispose() {
    this.renderer.dispose();
    this.composer.dispose?.();
    this.scene.traverse((o) => {
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    });
  }
}
