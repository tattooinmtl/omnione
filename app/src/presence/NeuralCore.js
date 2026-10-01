// The emotion engine, visible: after ProductionEXAMPLES/emotionengine.jpg.
//
// A layered network drawn as a glowing tangle:
//
//   SOURCE ──► APPRAISAL ──► EMOTION ──► FACE ──► OUT
//   user        relevance      joy …       brows     face
//   agent       unexpected…    (12)        eyes      voice
//   tool        goal impact                mouth
//   system      social tone                head
//   vision      certainty                  gaze
//                                          light
//
// Every trace from the emotion runtime becomes a wave of pulses that runs
// the path the event actually took: from its source, through the appraisal
// checks that fired hardest, into the emotions it moved, out through the
// face regions those emotions drive, to the face and the voice. Edges a
// pulse crossed take on the colour of the emotion it carried and cool slowly,
// so the route from prompt to output stays mapped for a while afterwards.
// Emotion nodes glow and pulse with their live activation; faster when
// arousal is high.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { EMOTIONS, FAMILIES } from './emotion/core.js';
import { APPRAISAL_DIMS } from './emotion/appraisal.js';
import { EMOTION_COLORS, channelsFor } from './emotion/face.js';

const SOURCES = ['user', 'agent', 'tool', 'system', 'vision'];
const REGIONS = {
  brows: ['browInnerUp', 'browDown', 'browAsym'],
  eyes: ['eyeWide', 'eyeSquint', 'blink'],
  mouth: ['smile', 'frown', 'smirk', 'jawOpen'],
  head: ['headTilt', 'headNod', 'headTurn'],
  gaze: ['gazeX', 'gazeY'],
  light: ['glow', 'glitch'],
};
const OUTPUTS = ['face', 'voice'];
const DIM_LABEL = { relevance: 'relevance', unexpectedness: 'surprise', goalImpact: 'goal impact', socialTone: 'social tone', certainty: 'certainty' };

const SEGS = 26;          // points per edge curve
const HOP_S = 0.42;       // seconds for a pulse to cross one edge
const HEAT_HALF_S = 7;    // how long a taken path stays lit

const BASE_EDGE = new THREE.Color(0x1f3a7a);
const NODE_BASE = new THREE.Color(0x6fd6ff);

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
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
    gl_PointSize = size * pixelRatio * (4.0 / -mv.z);
  }
`;
const NODE_FRAG = /* glsl */`
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float core = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vColor * (core * core * 1.6 + core * 0.4), core);
  }
`;

export class NeuralCore {
  constructor(canvas, labelLayer = null) {
    this.canvas = canvas;
    this.labelLayer = labelLayer;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05041c);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 30);
    this.camera.position.set(0, 0, 4.4);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.time = 0;
    this.state = { valence: 0.3, energy: 0.7, arousal: 0.2, emotions: {} };
    this.pulses = [];
    this.pending = [];

    this.#layout();
    this.#buildTangle();
    this.#buildEdges();
    this.#buildNodes();
    this.#buildPulses();
    this.#buildLabels();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.9, 0.55, 0.12);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.resize();
  }

  // --- structure ----------------------------------------------------------------

  #layout() {
    const r = rng(7);
    this.nodes = [];
    this.byKey = new Map();
    const add = (layer, key, pos, color, label) => {
      const n = { layer, key, pos, color: new THREE.Color(color), label, flash: 0, idx: this.nodes.length };
      this.nodes.push(n);
      this.byKey.set(`${layer}:${key}`, n);
    };
    const column = (layer, keys, x, spread, colorOf, labelOf) => {
      keys.forEach((k, i) => {
        const t = keys.length === 1 ? 0 : i / (keys.length - 1) - 0.5;
        add(layer, k, new THREE.Vector3(x + (r() - 0.5) * 0.12, t * spread, (r() - 0.5) * 0.5), colorOf(k), labelOf(k));
      });
    };
    column('source', SOURCES, -1.75, 1.9, () => 0x7fe9ff, (k) => k);
    column('appraisal', APPRAISAL_DIMS, -1.1, 1.9, () => 0x9aa8ff, (k) => DIM_LABEL[k]);
    // Emotions: a loose ring in the middle — the heart of the tangle —
    // wide enough that every label has room.
    // Emotions: rows by family — positive on top, then cognitive and social,
    // negative at the bottom — so valence reads top to bottom and twenty-six
    // labels have room. Second rows are staggered so it stays a tangle, not a
    // table.
    const rows = [
      [FAMILIES.positive.slice(0, 4), 1.0],
      [FAMILIES.positive.slice(4), 0.68],
      [FAMILIES.cognitive.slice(0, 3), 0.36],
      [FAMILIES.cognitive.slice(3), 0.06],
      [FAMILIES.social, -0.26],
      [FAMILIES.negative.slice(0, 4), -0.6],
      [FAMILIES.negative.slice(4), -0.92],
    ];
    rows.forEach(([names, y], ri) => {
      names.forEach((e, j) => {
        const t = (j + 0.5 + (ri % 2 ? 0.35 : 0)) / (names.length + 0.35);
        // The social row is short but its names are long: give it the most width.
        const span = names === FAMILIES.social ? 2.0 : 1.7;
        const x = 0.1 - span / 2 + t * span;
        add('emotion', e, new THREE.Vector3(x, y + (r() - 0.5) * 0.08, (r() - 0.5) * 0.5), EMOTION_COLORS[e], e);
      });
    });
    column('region', Object.keys(REGIONS), 1.25, 1.9, () => 0x8ff0ff, (k) => k);
    column('output', OUTPUTS, 1.85, 0.9, () => 0xffffff, (k) => k);
  }

  #buildTangle() {
    // Decorative filaments, dim, so the structured paths read on top of them.
    const r = rng(11);
    const pos = [];
    const pt = () => {
      const u = r() * 2 - 1;
      const th = r() * Math.PI * 2;
      const rad = 0.35 + r() * 1.3;
      const s = Math.sqrt(1 - u * u);
      return new THREE.Vector3(rad * s * Math.cos(th) * 1.25, rad * s * Math.sin(th), rad * u * 0.8);
    };
    for (let f = 0; f < 90; f++) {
      const c = new THREE.CatmullRomCurve3([pt(), pt(), pt(), pt()]);
      const p = c.getPoints(30);
      for (let i = 0; i < 30; i++) pos.push(p[i].x, p[i].y, p[i].z, p[i + 1].x, p[i + 1].y, p[i + 1].z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.tangleMat = new THREE.LineBasicMaterial({ color: 0x3a3fae, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false });
    this.group.add(new THREE.LineSegments(g, this.tangleMat));
  }

  #buildEdges() {
    const r = rng(23);
    this.edges = [];
    this.edgeKey = new Map();
    const link = (a, b) => {
      const A = this.byKey.get(a);
      const B = this.byKey.get(b);
      // A curve that wanders a little off the straight line: a tangle, not a diagram.
      const mid = A.pos.clone().lerp(B.pos, 0.5).add(new THREE.Vector3((r() - 0.5) * 0.35, (r() - 0.5) * 0.45, (r() - 0.5) * 0.6));
      const curve = new THREE.QuadraticBezierCurve3(A.pos, mid, B.pos);
      const e = { from: A, to: B, curve, pts: curve.getPoints(SEGS), heat: 0, color: BASE_EDGE.clone(), idx: this.edges.length };
      this.edges.push(e);
      this.edgeKey.set(`${a}>${b}`, e);
    };
    for (const s of SOURCES) for (const d of APPRAISAL_DIMS) link(`source:${s}`, `appraisal:${d}`);
    for (const d of APPRAISAL_DIMS) for (const e of EMOTIONS) link(`appraisal:${d}`, `emotion:${e}`);
    // Only the regions an emotion actually moves: the network shows the real
    // wiring, not a complete graph.
    for (const e of EMOTIONS) {
      const chans = channelsFor(e);
      for (const reg of Object.keys(REGIONS)) {
        if (REGIONS[reg].some((c) => chans.includes(c))) link(`emotion:${e}`, `region:${reg}`);
      }
    }
    for (const reg of Object.keys(REGIONS)) link(`region:${reg}`, 'output:face');
    for (const e of EMOTIONS) link(`emotion:${e}`, 'output:voice');

    const n = this.edges.length * SEGS * 2;
    this.edgePos = new Float32Array(n * 3);
    this.edgeCol = new Float32Array(n * 3);
    let k = 0;
    for (const e of this.edges) {
      for (let i = 0; i < SEGS; i++) {
        for (const p of [e.pts[i], e.pts[i + 1]]) {
          this.edgePos[k++] = p.x; this.edgePos[k++] = p.y; this.edgePos[k++] = p.z;
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.edgePos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.edgeCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.edgeLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.group.add(this.edgeLines);
  }

  #buildNodes() {
    const N = this.nodes.length;
    this.nodePos = new Float32Array(N * 3);
    this.nodeCol = new Float32Array(N * 3);
    this.nodeSize = new Float32Array(N);
    this.nodes.forEach((n, i) => {
      this.nodePos[i * 3] = n.pos.x; this.nodePos[i * 3 + 1] = n.pos.y; this.nodePos[i * 3 + 2] = n.pos.z;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.nodePos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.nodeCol, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.nodeSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.nodeMat = new THREE.ShaderMaterial({
      vertexShader: NODE_VERT,
      fragmentShader: NODE_FRAG,
      uniforms: { pixelRatio: { value: this.renderer.getPixelRatio() } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.nodePoints = new THREE.Points(g, this.nodeMat);
    this.group.add(this.nodePoints);
  }

  #buildPulses() {
    const MAX = 160;
    this.pulsePos = new Float32Array(MAX * 3);
    this.pulseCol = new Float32Array(MAX * 3);
    this.pulseSize = new Float32Array(MAX);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pulsePos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.pulseCol, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.pulseSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.pulsePoints = new THREE.Points(g, this.nodeMat);
    this.pulsePoints.frustumCulled = false;
    this.group.add(this.pulsePoints);
    this.maxPulses = MAX;
  }

  #buildLabels() {
    if (!this.labelLayer) return;
    this.labelLayer.innerHTML = '';
    this.labelEls = this.nodes.map((n) => {
      const el = document.createElement('span');
      el.className = `ncore-label is-${n.layer}`;
      el.textContent = n.label;
      el.style.setProperty('--c', `#${n.color.getHexString()}`);
      this.labelLayer.appendChild(el);
      return el;
    });
    this.headerEls = ['SOURCE', 'APPRAISAL', 'EMOTION', 'FACE', 'OUT'].map((t) => {
      const el = document.createElement('span');
      el.className = 'ncore-header';
      el.textContent = t;
      this.labelLayer.appendChild(el);
      return el;
    });
  }

  // --- input ----------------------------------------------------------------------

  /* valence, energy, arousal, emotions (activation map). */
  setState(s) {
    Object.assign(this.state, s);
  }

  /**
   * Animate the path of one trace from the emotion runtime:
   * { source, appraisal: {relevance, unexpectedness, goalImpact, socialTone, certainty},
   *   emotions: [{emotion, impact}], channels: {emotion: [channel…]}, kind }
   */
  addTrace(trace) {
    if (!trace?.emotions?.length) return;
    const src = SOURCES.includes(trace.source) ? trace.source : 'agent';
    const a = trace.appraisal || {};
    // The appraisal checks that fired hardest carry the event onward.
    const dims = APPRAISAL_DIMS
      .map((d) => ({ d, v: Math.abs(Number(a[d]) || 0) }))
      .sort((x, y) => y.v - x.v)
      .filter((x, i) => i < 3 && x.v > 0.15);
    if (!dims.length) dims.push({ d: 'relevance', v: 0.5 });

    const t0 = this.time;
    const colorOf = (e) => new THREE.Color(EMOTION_COLORS[e] || 0xffffff);
    const lead = trace.emotions[0].emotion;

    // Hop 1: source → appraisal, coloured by the strongest emotion it will become.
    for (const { d, v } of dims) this.#schedule(`source:${src}>appraisal:${d}`, t0, colorOf(lead), 0.4 + v * 0.6);
    // Hop 2: appraisal → each emotion moved.
    for (const m of trace.emotions) {
      for (const { d, v } of dims) this.#schedule(`appraisal:${d}>emotion:${m.emotion}`, t0 + HOP_S, colorOf(m.emotion), Math.min(1, m.impact * 1.4) * (0.5 + v * 0.5));
    }
    // Hop 3: emotion → the face regions its channels live in.
    const regionsHit = new Set();
    for (const m of trace.emotions) {
      const chans = trace.channels?.[m.emotion] || [];
      const regs = Object.keys(REGIONS).filter((r) => REGIONS[r].some((c) => chans.includes(c)));
      for (const reg of regs) {
        regionsHit.add(reg);
        this.#schedule(`emotion:${m.emotion}>region:${reg}`, t0 + HOP_S * 2, colorOf(m.emotion), Math.min(1, m.impact * 1.5));
      }
      // Speech, and anything strong, also reaches the voice.
      if (trace.kind === 'speech' || trace.kind === 'done' || m.impact > 0.35) {
        this.#schedule(`emotion:${m.emotion}>output:voice`, t0 + HOP_S * 2, colorOf(m.emotion), Math.min(1, m.impact * 1.5));
      }
    }
    // Hop 4: regions → the face.
    for (const reg of regionsHit) this.#schedule(`region:${reg}>output:face`, t0 + HOP_S * 3, colorOf(lead), 0.8);
    this.byKey.get(`source:${src}`).flash = 1;
  }

  #schedule(edgeKey, at, color, strength) {
    const e = this.edgeKey.get(edgeKey);
    if (e) this.pending.push({ e, at, color, strength });
  }

  // --- frame -------------------------------------------------------------------------

  resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.w = w;
    this.h = h;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    // Fit the whole network — both edge columns and the labels past them —
    // whatever the panel's shape. The sway adds a little depth, hence the margin.
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const halfW = 2.3;
    const halfH = 1.5;
    this.camera.position.z = Math.max(halfH / tanV, halfW / (tanV * this.camera.aspect)) + 0.5;
    this.camera.updateProjectionMatrix();
    // In a wide band, stretch the layers apart so the network fills it from
    // side to side instead of sitting as a knot in the middle.
    const visibleW = 2 * tanV * this.camera.aspect * (this.camera.position.z - 0.5);
    this.group.scale.x = Math.max(1, Math.min(4, (visibleW * 0.9) / (2 * halfW)));
    this.labelLayer?.classList.toggle('is-small', w < 360);
  }

  render(dt) {
    this.time += dt;
    const { arousal = 0.2, energy = 0.7, emotions = {} } = this.state;

    // Launch scheduled pulses.
    this.pending = this.pending.filter((p) => {
      if (p.at > this.time) return true;
      if (this.pulses.length < this.maxPulses) this.pulses.push({ e: p.e, t: 0, color: p.color, strength: p.strength });
      return false;
    });

    // Move pulses; on arrival, heat the edge with the emotion's colour and flash the node.
    const decay = Math.pow(0.5, dt / HEAT_HALF_S);
    for (const e of this.edges) e.heat *= decay;
    this.pulses = this.pulses.filter((p) => {
      p.t += dt / HOP_S;
      const e = p.e;
      // The edge lights up behind the pulse as it travels.
      e.heat = Math.max(e.heat, p.strength * Math.min(1, p.t) * 0.9);
      e.color.lerp(p.color, Math.min(1, dt * 6));
      if (p.t >= 1) {
        e.to.flash = Math.max(e.to.flash, p.strength);
        return false;
      }
      return true;
    });

    // Edge colours: base blue, or the colour of what last crossed it, by heat.
    const col = this.edgeCol;
    let k = 0;
    const tmp = new THREE.Color();
    for (const e of this.edges) {
      const h = e.heat;
      // Travelling highlight near an in-flight pulse on this edge.
      const live = this.pulses.filter((p) => p.e === e);
      for (let i = 0; i < SEGS; i++) {
        let glow = 0;
        for (const p of live) glow = Math.max(glow, Math.exp(-(((i / SEGS) - p.t) ** 2) / 0.006) * p.strength);
        tmp.copy(BASE_EDGE).multiplyScalar(0.28).lerp(e.color, Math.min(1, h * 1.2)).multiplyScalar(0.35 + h * 1.4 + glow * 2.2);
        for (let v = 0; v < 2; v++) { col[k++] = tmp.r; col[k++] = tmp.g; col[k++] = tmp.b; }
      }
    }
    this.edgeLines.geometry.attributes.color.needsUpdate = true;

    // Nodes: emotion nodes glow and pulse with their activation; others flash on arrival.
    const beat = 3 + arousal * 7;
    this.nodes.forEach((n, i) => {
      n.flash *= Math.pow(0.5, dt / 0.6);
      const act = n.layer === 'emotion' ? (emotions[n.key] || 0) : 0;
      const pulse = act > 0.05 ? 1 + 0.35 * act * Math.sin(this.time * beat + i) : 1;
      const lit = Math.min(1.6, 0.25 + act * 1.3 + n.flash);
      tmp.copy(n.layer === 'emotion' ? n.color : NODE_BASE).multiplyScalar(lit);
      this.nodeCol[i * 3] = tmp.r; this.nodeCol[i * 3 + 1] = tmp.g; this.nodeCol[i * 3 + 2] = tmp.b;
      const base = n.layer === 'emotion' ? 10 : n.layer === 'output' ? 11 : 7;
      this.nodeSize[i] = (base + act * 16 + n.flash * 8) * pulse;
    });
    this.nodePoints.geometry.attributes.color.needsUpdate = true;
    this.nodePoints.geometry.attributes.size.needsUpdate = true;

    // Pulse sprites.
    let j = 0;
    for (const p of this.pulses) {
      const pt = p.e.curve.getPoint(Math.min(1, p.t));
      this.pulsePos[j * 3] = pt.x; this.pulsePos[j * 3 + 1] = pt.y; this.pulsePos[j * 3 + 2] = pt.z;
      tmp.copy(p.color).multiplyScalar(1.8);
      this.pulseCol[j * 3] = tmp.r; this.pulseCol[j * 3 + 1] = tmp.g; this.pulseCol[j * 3 + 2] = tmp.b;
      this.pulseSize[j] = 9 + p.strength * 9;
      j++;
    }
    this.pulsePoints.geometry.setDrawRange(0, j);
    this.pulsePoints.geometry.attributes.position.needsUpdate = true;
    this.pulsePoints.geometry.attributes.color.needsUpdate = true;
    this.pulsePoints.geometry.attributes.size.needsUpdate = true;

    // A slow sway, enough to read depth, never enough to lose the layout.
    this.group.rotation.y = Math.sin(this.time * 0.18) * 0.32;
    this.group.rotation.x = Math.sin(this.time * 0.11) * 0.08;
    this.tangleMat.opacity = 0.1 + arousal * 0.15;
    this.bloom.strength = 0.7 + arousal * 0.5 + energy * 0.1;

    this.composer.render(dt);
    this.#placeLabels(emotions);
  }

  #placeLabels(emotions) {
    if (!this.labelEls) return;
    const v = new THREE.Vector3();
    this.group.updateMatrixWorld();
    this.nodes.forEach((n, i) => {
      v.copy(n.pos).applyMatrix4(this.group.matrixWorld).project(this.camera);
      const el = this.labelEls[i];
      const x = (v.x * 0.5 + 0.5) * this.w;
      const y = (-v.y * 0.5 + 0.5) * this.h;
      const act = n.layer === 'emotion' ? (emotions[n.key] || 0) : 0;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      el.style.opacity = String(Math.min(1, 0.4 + act * 1.5 + n.flash));
      el.classList.toggle('is-active', act > 0.15 || n.flash > 0.3);
    });
    ['source', 'appraisal', 'emotion', 'region', 'output'].forEach((layer, i) => {
      const nodes = this.nodes.filter((n) => n.layer === layer);
      const cx = nodes.reduce((a, n) => a + n.pos.x, 0) / nodes.length;
      v.set(cx, 1.28, 0).applyMatrix4(this.group.matrixWorld).project(this.camera);
      this.headerEls[i].style.transform = `translate(${((v.x * 0.5 + 0.5) * this.w).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * this.h).toFixed(1)}px)`;
    });
  }

  dispose() {
    this.renderer.dispose();
    this.scene.traverse((o) => {
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    });
    if (this.labelLayer) this.labelLayer.innerHTML = '';
  }
}
