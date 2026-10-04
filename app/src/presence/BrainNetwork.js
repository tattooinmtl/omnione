// The brain network: everything Omi-One has done, as neurons around a brain.
//
//   brain ──► emotion ──► action (tool / skill) ──► conversation
//
// A 3D brain sits at the centre. Around it, close in, a ring of emotion
// neurons (the same 26 the emotion engine runs, glowing with the same live
// activation). Further out, one neuron per conversation (orange), linked to
// the brain, and one per tool (blue) and skill (green), linked to every
// conversation that used them. Emotions link to the actions they were felt
// during, so the path an action took is: brain → what it felt → what it did
// → where it did it.
//
// When the agent acts, that path lights up: pulses run along it, the edges
// it crossed stay warm for a while, and the neurons in use glow and pulse
// until the call finishes. A conversation or link that did not exist yet is
// grown on the spot.
//
// Drag to rotate, wheel to zoom (only while the pointer is over the view:
// the wheel listener belongs to this canvas).

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { EMOTIONS } from './emotion/core.js';
import { EMOTION_COLORS } from './emotion/face.js';

export const KIND_COLORS = {
  brain: 0xd9ccff,
  conversation: 0xff8a2a,
  skill: 0x3dff7a,
  tool: 0x3fc8ff,
};

const BRAIN_R = 1.15;     // the brain mesh's scale
const EMOTION_R = 1.75;   // the emotion ring
const SHELL = { conversation: 2.7, tool: 3.9, skill: 4.1 };
const HOP_S = 0.38;       // seconds for a pulse to cross one edge
const HEAT_HALF_S = 6;    // how long a taken edge stays lit
const ACT_HALF_S = 1.6;   // how long a fired neuron keeps glowing
const MAX_PULSES = 256;

const half = (dt, h) => Math.pow(0.5, dt / h);

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function emotionColor(e) { return EMOTION_COLORS[e] ?? 0xffffff; }
export function colorOf(n) {
  return n.kind === 'emotion' ? emotionColor(n.key) : (KIND_COLORS[n.kind] ?? 0xffffff);
}

/* The brain, procedurally: a displaced ellipsoid with gyri ridges, a
 * longitudinal fissure, temporal lobes and a cerebellum. After the example
 * brain view; here as a real mesh so the GPU shades and the camera orbits it. */
export function brainGeometry(lon, lat) {
  const pos = [];
  const idx = [];
  const ring = (verts, l, n, fn) => {
    const base = verts.length / 3;
    for (let i = 0; i <= l; i++) {
      const phi = (i / l) * Math.PI;
      for (let j = 0; j <= n; j++) verts.push(...fn(phi, (j / n) * Math.PI * 2));
    }
    const stride = n + 1;
    for (let a = 0; a < l; a++) {
      for (let b = 0; b < n; b++) {
        const i0 = base + a * stride + b;
        idx.push(i0, i0 + stride, i0 + 1, i0 + 1, i0 + stride, i0 + stride + 1);
      }
    }
  };
  ring(pos, lat, lon, (phi, th) => {
    const sp = Math.sin(phi); const cp = Math.cos(phi);
    let rad = 1
      + 0.055 * Math.sin(9 * th + 2.5 * phi)
      + 0.040 * Math.sin(13 * phi + 1.7)
      + 0.028 * Math.sin(17 * th - 3.1 * phi)
      + 0.020 * Math.sin(23 * phi + 5 * th);
    const x = sp * Math.cos(th); const y = cp; const z = sp * Math.sin(th);
    rad -= Math.exp(-((x * 6.5) ** 2)) * Math.max(0, y) * 0.30;
    rad += 0.17 * Math.exp(-(((y + 0.35) * 2.6) ** 2)) * Math.exp(-((z * 1.1) ** 2)) * Math.abs(x);
    rad *= 1 - 0.10 * Math.max(0, -z) * Math.max(0, y);
    rad *= 1 + 0.06 * Math.max(0, z);
    if (y < -0.55) rad *= 1 - 0.22 * (Math.abs(y) - 0.55);
    return [x * rad * 0.80, y * rad * 0.74, z * rad * 1.06];
  });
  ring(pos, Math.max(6, lat / 3 | 0), Math.max(10, lon / 3 | 0), (phi, th) => {
    const r = 0.40 + 0.055 * Math.sin(22 * phi) + 0.02 * Math.sin(9 * th);
    return [Math.sin(phi) * Math.cos(th) * r * 0.92, Math.cos(phi) * r * 0.48 - 0.46, Math.sin(phi) * Math.sin(th) * r * 0.78 - 0.62];
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const NODE_VERT = /* glsl */`
  attribute float size;
  attribute vec3 color;
  varying vec3 vColor;
  uniform float pixelRatio;
  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = size * pixelRatio * (9.0 / -mv.z);
  }
`;
const NODE_FRAG = /* glsl */`
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float core = smoothstep(0.5, 0.0, d);
    float ring = smoothstep(0.5, 0.42, d) * smoothstep(0.30, 0.42, d);
    gl_FragColor = vec4(vColor * (core * core * 1.7 + core * 0.35 + ring * 0.5), core);
  }
`;

export class BrainNetwork {
  constructor(canvas, labelLayer = null, { onPath } = {}) {
    this.canvas = canvas;
    this.labelLayer = labelLayer;
    this.onPath = onPath;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x04030f);
    this.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 120);
    this.camera.position.set(2.8, 1.8, 9.2);
    this.time = 0;
    this.energy = 0.2;
    this.emotions = {};

    this.nodes = [];          // { id, kind, key, label, detail, weight, pos, vel, act, held, idx }
    this.byId = new Map();
    this.links = [];          // { a, b, weight, heat }
    this.linkKey = new Set();
    this.pulses = [];
    this.pending = [];
    this.settle = 0;          // layout iterations still to run
    this.dirty = true;

    // Controls: drag rotates, wheel zooms, both only on this canvas.
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 2.4;
    this.controls.maxDistance = 22;
    this.controls.rotateSpeed = 0.7;
    this.controls.zoomSpeed = 0.9;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.35;
    let resume = 0;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; clearTimeout(resume); });
    this.controls.addEventListener('end', () => { resume = setTimeout(() => { this.controls.autoRotate = true; }, 9000); });
    this._clearResume = () => clearTimeout(resume);

    this.#buildBrain();
    this.#buildStars();
    this.#buildEmotions();
    this.#buildBuffers();

    this.hovered = null;
    this._onMove = (e) => this.#hover(e);
    this._onLeave = () => { this.hovered = null; };
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerleave', this._onLeave);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.5, 0.22);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.resize();
  }

  // --- scene pieces -------------------------------------------------------------

  #buildBrain() {
    const solid = brainGeometry(72, 48);
    this.brainMat = new THREE.MeshStandardMaterial({
      color: 0x7a5ce0, emissive: 0x3a1fa0, emissiveIntensity: 0.4,
      roughness: 0.55, metalness: 0.1, transparent: true, opacity: 0.9,
    });
    this.brain = new THREE.Group();
    this.brain.add(new THREE.Mesh(solid, this.brainMat));
    // The lattice over it: a coarser copy's wireframe, light and additive.
    const lattice = new THREE.WireframeGeometry(brainGeometry(40, 26));
    this.latticeMat = new THREE.LineBasicMaterial({ color: 0xe6dcff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false });
    const wire = new THREE.LineSegments(lattice, this.latticeMat);
    wire.scale.setScalar(1.012);
    this.brain.add(wire);
    this.brain.scale.setScalar(BRAIN_R);
    this.scene.add(this.brain);
    this.scene.add(new THREE.AmbientLight(0x6c5cff, 0.45));
    const key = new THREE.PointLight(0xbfa8ff, 14, 0, 2);
    key.position.set(-3, 4, 5);
    this.scene.add(key);
    const rim = new THREE.PointLight(0x2ff5e6, 6, 0, 2);
    rim.position.set(4, -2, -4);
    this.scene.add(rim);
  }

  #buildStars() {
    const r = rng(42);
    const pts = [];
    for (let i = 0; i < 700; i++) {
      const a = r() * Math.PI * 2; const b = Math.acos(r() * 2 - 1); const d = 30 + r() * 30;
      pts.push(d * Math.sin(b) * Math.cos(a), d * Math.sin(b) * Math.sin(a), d * Math.cos(b));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8a7cff, size: 0.09, transparent: true, opacity: 0.55, depthWrite: false })));
  }

  #buildEmotions() {
    this.#ensureNode({ id: 'brain', kind: 'brain', label: 'Central Brain' });
    // A Fibonacci sphere: evenly spread, fixed, close around the brain.
    const n = EMOTIONS.length;
    EMOTIONS.forEach((e, i) => {
      const y = 1 - (i / (n - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = i * Math.PI * (3 - Math.sqrt(5));
      const node = this.#ensureNode({ id: `emotion:${e}`, kind: 'emotion', key: e, label: e });
      node.pos.set(Math.cos(th) * r * EMOTION_R, y * EMOTION_R * 0.8, Math.sin(th) * r * EMOTION_R);
      node.fixed = true;
      this.#ensureLink('brain', node.id, 1);
    });
  }

  #buildBuffers() {
    this.nodeGeo = new THREE.BufferGeometry();
    this.nodeMat = new THREE.ShaderMaterial({
      vertexShader: NODE_VERT, fragmentShader: NODE_FRAG,
      uniforms: { pixelRatio: { value: this.renderer.getPixelRatio() } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.nodeGeo, this.nodeMat);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    this.edgeGeo = new THREE.BufferGeometry();
    this.edgeMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    this.edges = new THREE.LineSegments(this.edgeGeo, this.edgeMat);
    this.edges.frustumCulled = false;
    this.scene.add(this.edges);

    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PULSES * 3), 3));
    pg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_PULSES * 3), 3));
    pg.setAttribute('size', new THREE.BufferAttribute(new Float32Array(MAX_PULSES), 1));
    this.pulseGeo = pg;
    this.pulsePoints = new THREE.Points(pg, this.nodeMat);
    this.pulsePoints.frustumCulled = false;
    this.scene.add(this.pulsePoints);
  }

  #rebuild() {
    const n = this.nodes.length;
    this.nodeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.nodeGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.nodeGeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(n), 1));
    const m = this.links.length;
    this.edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m * 6), 3));
    this.edgeGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(m * 6), 3));
    // Degree, for sizing and for which labels earn a place.
    for (const node of this.nodes) node.degree = 0;
    for (const l of this.links) { l.a.degree += 1; l.b.degree += 1; }
    this.dirty = false;
  }

  // --- graph --------------------------------------------------------------------

  #ensureNode({ id, kind, key, label, detail, weight }) {
    let n = this.byId.get(id);
    if (n) {
      if (label) n.label = label;
      if (detail) n.detail = detail;
      if (typeof weight === 'number') n.weight = weight;
      return n;
    }
    const r = rng(hash(id));
    const shell = SHELL[kind] ?? 3;
    // Start on its shell, spread all the way round, so the first frames
    // already look like the settled graph instead of a burst from the centre.
    const th = r() * Math.PI * 2;
    const y = (r() * 2 - 1) * 0.9;
    const rr = Math.sqrt(1 - y * y);
    n = {
      id, kind, key: key ?? id.split(':').slice(1).join(':'), label: label || id, detail: detail || '',
      weight: weight || 0, idx: this.nodes.length, act: 0, held: 0, degree: 0, fixed: id === 'brain',
      // The brain node is the brain itself: at the centre, where its links meet.
      pos: kind === 'brain' ? new THREE.Vector3(0, 0, 0) : new THREE.Vector3(Math.cos(th) * rr * shell, y * shell * 0.75, Math.sin(th) * rr * shell),
      vel: new THREE.Vector3(),
    };
    this.nodes.push(n);
    this.byId.set(id, n);
    this.dirty = true;
    this.settle = Math.max(this.settle, 160);
    return n;
  }

  #ensureLink(a, b, weight = 1) {
    const A = this.byId.get(a); const B = this.byId.get(b);
    if (!A || !B || A === B) return null;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (this.linkKey.has(k)) {
      const l = this.links.find((x) => x.key === k);
      if (l && weight > l.weight) l.weight = weight;
      return l;
    }
    const l = { key: k, a: A, b: B, weight, heat: 0, color: null };
    this.links.push(l);
    this.linkKey.add(k);
    this.dirty = true;
    this.settle = Math.max(this.settle, 120);
    return l;
  }

  /* The graph from /api/brain. Merged in: neurons already on screen keep
   * their place, so a refresh never reshuffles the view. */
  setGraph(graph) {
    for (const n of graph?.nodes || []) this.#ensureNode(n);
    for (const l of graph?.links || []) {
      // An emotion link names an emotion the engine knows; the view made those.
      this.#ensureLink(l.source, l.target, l.weight || 1);
    }
    this.counts = { conversations: 0, tools: 0, skills: 0 };
    for (const n of this.nodes) {
      if (n.kind === 'conversation') this.counts.conversations += 1;
      else if (n.kind === 'tool') this.counts.tools += 1;
      else if (n.kind === 'skill') this.counts.skills += 1;
    }
  }

  addConversation(id, label) {
    const n = this.#ensureNode({ id, kind: 'conversation', label });
    this.#ensureLink('brain', id, 1);
    if (this.counts && n.idx === this.nodes.length - 1) this.counts.conversations += 1;
    return n;
  }

  addAction(id, kind, label) {
    return this.#ensureNode({ id, kind, label });
  }

  has(id) { return this.byId.has(id); }

  /* The engine's live state: emotion neurons glow with their activation. */
  setEmotions(emotions, arousal = 0.2) {
    this.emotions = emotions || {};
    this.energy = arousal;
  }

  /* Send a wave of pulses along `path` (node ids). Missing links are grown,
   * since the path is something that just happened. */
  fire(path, color) {
    const ids = path.filter((id) => this.byId.has(id));
    if (ids.length === 0) return;
    const c = new THREE.Color(color ?? colorOf(this.byId.get(ids[ids.length - 1])));
    this.byId.get(ids[0]).act = 1;
    for (let i = 0; i + 1 < ids.length; i++) {
      const l = this.#ensureLink(ids[i], ids[i + 1], 1);
      if (!l) continue;
      this.pending.push({ at: this.time + i * HOP_S, from: this.byId.get(ids[i]), to: this.byId.get(ids[i + 1]), link: l, color: c.clone() });
    }
    this.onPath?.(ids.map((id) => this.byId.get(id).label));
  }

  /* A neuron in use (a tool call that hasn't returned): it pulses until released. */
  hold(id, on) {
    const n = this.byId.get(id);
    if (!n) return;
    n.held = on ? (n.held || 0) + 1 : Math.max(0, (n.held || 0) - 1);
    if (on) n.act = 1;
  }

  releaseAll() { for (const n of this.nodes) n.held = 0; }

  // --- layout -------------------------------------------------------------------

  #relax(iterations) {
    const N = this.nodes;
    const tmp = new THREE.Vector3();
    for (let it = 0; it < iterations; it++) {
      // Repulsion: everything pushes everything, briefly.
      for (let i = 0; i < N.length; i++) {
        const a = N[i];
        for (let j = i + 1; j < N.length; j++) {
          const b = N[j];
          tmp.subVectors(a.pos, b.pos);
          const d2 = Math.max(0.04, tmp.lengthSq());
          if (d2 > 16) continue;
          tmp.multiplyScalar(0.03 / d2);
          a.vel.add(tmp);
          b.vel.sub(tmp);
        }
      }
      // Springs along links.
      for (const l of this.links) {
        const rest = l.a.kind === 'brain' || l.b.kind === 'brain' ? 1.6 : 1.3;
        tmp.subVectors(l.b.pos, l.a.pos);
        const d = Math.max(0.01, tmp.length());
        tmp.multiplyScalar(((d - rest) / d) * 0.005);
        l.a.vel.add(tmp);
        l.b.vel.sub(tmp);
      }
      // Each kind keeps to its shell, and out of the brain.
      for (const n of N) {
        if (n.fixed) { n.vel.set(0, 0, 0); continue; }
        const shell = SHELL[n.kind] ?? 3;
        const d = Math.max(0.01, n.pos.length());
        n.vel.addScaledVector(n.pos, ((shell - d) / d) * 0.06);
        n.pos.addScaledVector(n.vel, 1);
        n.vel.multiplyScalar(0.72);
      }
    }
  }

  // --- interaction --------------------------------------------------------------

  #hover(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const v = new THREE.Vector3();
    let best = null;
    let bestD = 14 * 14;
    for (const n of this.nodes) {
      if (n.kind === 'brain') continue;
      v.copy(n.pos).project(this.camera);
      if (v.z > 1) continue;
      const sx = (v.x + 1) / 2 * rect.width;
      const sy = (1 - v.y) / 2 * rect.height;
      const d = (sx - mx) ** 2 + (sy - my) ** 2;
      if (d < bestD) { bestD = d; best = n; }
    }
    this.hovered = best;
  }

  // --- frame --------------------------------------------------------------------

  resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.bloom?.resolution.set(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.small = w < 420;
  }

  render(dt) {
    this.time += dt;
    if (this.dirty) this.#rebuild();
    if (this.settle > 0) {
      const k = Math.min(this.settle, this.nodes.length > 300 ? 2 : 4);
      this.#relax(k);
      this.settle -= k;
    }
    this.controls.update();

    // Pulses scheduled by fire() start when their hop comes up.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (p.at <= this.time) {
        this.pending.splice(i, 1);
        if (this.pulses.length < MAX_PULSES) this.pulses.push({ ...p, t: 0 });
      }
    }
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      p.t += dt / HOP_S;
      p.link.heat = 1;
      p.link.color = p.color;
      if (p.t >= 1) { p.to.act = 1; this.pulses.splice(i, 1); }
    }

    // Nodes.
    const pos = this.nodeGeo.getAttribute('position');
    const col = this.nodeGeo.getAttribute('color');
    const size = this.nodeGeo.getAttribute('size');
    const c = new THREE.Color();
    const beat = 0.5 + 0.5 * Math.sin(this.time * (5 + this.energy * 6));
    for (const n of this.nodes) {
      n.act *= half(dt, ACT_HALF_S);
      if (n.held) n.act = Math.max(n.act, 0.75 + 0.25 * beat);
      const i = n.idx;
      pos.setXYZ(i, n.pos.x, n.pos.y, n.pos.z);
      c.setHex(colorOf(n));
      let s;
      let glow;
      if (n.kind === 'brain') { s = 0; glow = 0; } else if (n.kind === 'emotion') {
        const a = Math.min(1, this.emotions[n.key] || 0);
        glow = 0.35 + a * 1.4 + n.act * 1.2;
        s = 5 + a * 9 + n.act * 6;
      } else {
        const used = n.degree > 0 ? 1 : 0;
        glow = (used ? 0.75 : 0.38) + n.act * 1.6;
        s = (n.kind === 'conversation' ? 6.5 : 5) + Math.min(6, Math.sqrt(n.weight || n.degree || 0) * 1.4) + n.act * 7;
        if (n.held) s *= 1 + 0.35 * beat;
      }
      if (n === this.hovered) { glow += 0.6; s += 3; }
      col.setXYZ(i, c.r * glow, c.g * glow, c.b * glow);
      size.setX(i, s);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    size.needsUpdate = true;

    // Edges: a dim blend of their ends, warmed by the pulses that crossed them.
    const ep = this.edgeGeo.getAttribute('position');
    const ec = this.edgeGeo.getAttribute('color');
    const ca = new THREE.Color();
    const cb = new THREE.Color();
    this.links.forEach((l, i) => {
      l.heat *= half(dt, HEAT_HALF_S);
      ep.setXYZ(i * 2, l.a.pos.x, l.a.pos.y, l.a.pos.z);
      ep.setXYZ(i * 2 + 1, l.b.pos.x, l.b.pos.y, l.b.pos.z);
      const toBrain = l.a.kind === 'brain' || l.b.kind === 'brain';
      const base = toBrain ? 0.10 : 0.16 + Math.min(0.12, (l.weight || 1) * 0.02);
      ca.setHex(colorOf(l.a)).multiplyScalar(base);
      cb.setHex(colorOf(l.b)).multiplyScalar(base);
      if (l.heat > 0.01 && l.color) {
        ca.lerp(l.color, Math.min(1, l.heat)).multiplyScalar(1 + l.heat);
        cb.lerp(l.color, Math.min(1, l.heat)).multiplyScalar(1 + l.heat);
      }
      ec.setXYZ(i * 2, ca.r, ca.g, ca.b);
      ec.setXYZ(i * 2 + 1, cb.r, cb.g, cb.b);
    });
    ep.needsUpdate = true;
    ec.needsUpdate = true;

    // Pulses.
    const pp = this.pulseGeo.getAttribute('position');
    const pc = this.pulseGeo.getAttribute('color');
    const ps = this.pulseGeo.getAttribute('size');
    for (let i = 0; i < MAX_PULSES; i++) {
      const p = this.pulses[i];
      if (!p) { ps.setX(i, 0); continue; }
      const v = new THREE.Vector3().lerpVectors(p.from.pos, p.to.pos, p.t);
      pp.setXYZ(i, v.x, v.y, v.z);
      pc.setXYZ(i, p.color.r * 2.2, p.color.g * 2.2, p.color.b * 2.2);
      ps.setX(i, 9);
    }
    pp.needsUpdate = true;
    pc.needsUpdate = true;
    ps.needsUpdate = true;

    // The brain breathes, and works harder when the agent does.
    const busy = this.nodes.some((n) => n.held);
    const e = Math.min(1, this.energy + (busy ? 0.5 : 0));
    this.brainMat.emissiveIntensity = 0.32 + e * 0.5 + 0.06 * Math.sin(this.time * 1.4);
    this.latticeMat.opacity = 0.2 + e * 0.2;
    this.brain.rotation.y = Math.sin(this.time * 0.2) * 0.08;

    this.composer.render();
    this.#labels();
  }

  #labels() {
    const layer = this.labelLayer;
    if (!layer) return;
    if (!this.labelEls) this.labelEls = new Map();
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const dist = this.camera.position.length();
    // More names as you zoom in; the busiest neurons get them first.
    const budget = Math.round(Math.min(140, (this.small ? 14 : 34) * (9.8 / dist) ** 2));
    const ranked = this.nodes
      .filter((n) => n.kind === 'conversation' || n.kind === 'tool' || n.kind === 'skill')
      .sort((a, b) => (b.weight + b.degree) - (a.weight + a.degree))
      .slice(0, budget);
    const show = new Set(ranked);
    for (const n of this.nodes) {
      if (n.kind === 'brain' || n.act > 0.08 || n.held || n === this.hovered) show.add(n);
      else if (n.kind === 'emotion' && (this.emotions[n.key] || 0) > 0.12) show.add(n);
    }
    const v = new THREE.Vector3();
    for (const [id, el] of this.labelEls) {
      const n = this.byId.get(id);
      if (!n || !show.has(n)) { if (el.style.display !== 'none') el.style.display = 'none'; }
    }
    for (const n of show) {
      v.copy(n.pos).project(this.camera);
      let el = this.labelEls.get(n.id);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) { if (el) el.style.display = 'none'; continue; }
      if (!el) {
        el = document.createElement('div');
        el.className = `brain-label is-${n.kind}`;
        el.style.setProperty('--c', `#${colorOf(n).toString(16).padStart(6, '0')}`);
        layer.appendChild(el);
        this.labelEls.set(n.id, el);
      }
      const text = n.kind === 'conversation' ? `Conversation: ${n.label}` : n.label;
      if (el.textContent !== text) el.textContent = text;
      el.style.display = '';
      const x = (v.x + 1) / 2 * w;
      const y = (1 - v.y) / 2 * h;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      el.classList.toggle('is-active', n.act > 0.08 || n.held > 0 || n === this.hovered);
      el.style.opacity = n.kind === 'brain' ? '1' : String(Math.max(0.35, Math.min(1, 1.6 - v.z * 0.8)));
    }
  }

  dispose() {
    this._clearResume?.();
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerleave', this._onLeave);
    this.controls.dispose();
    for (const el of this.labelEls?.values() || []) el.remove();
    this.scene.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) [].concat(o.material).forEach((m) => m.dispose?.());
    });
    this.composer.dispose?.();
    this.renderer.dispose();
  }
}
