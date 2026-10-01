// Your voice, drawn: after ProductionEXAMPLES/TTS.jpg.
//
// A glowing waveform that runs cyan on the left to magenta on the right,
// over a faint network of drifting nodes. It shows the microphone only —
// the agent's own voice is drawn on its mouth — and rests as a faint idle
// shimmer while you are not talking.
// Canvas 2D with additive blending is plenty for this, and leaves the GPU
// to the face.

const NODES = 70;

export class VoiceWave {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.time = 0;
    this.level = 0;
    this.samples = null;   // Float32Array of -1..1, or null for idle
    this.mode = 'idle';    // 'idle' | 'speaking' | 'listening'
    this.hue = 0.1;
    this.nodes = Array.from({ length: NODES }, () => ({
      x: Math.random(),
      y: 0.5 + (Math.random() - 0.5) * 0.55,
      vx: (Math.random() - 0.5) * 0.01,
      vy: (Math.random() - 0.5) * 0.01,
      r: 1 + Math.random() * 2.2,
    }));
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = this.canvas.clientWidth || 1;
    this.h = this.canvas.clientHeight || 1;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* Feed one frame of audio (time-domain samples) and its RMS level. */
  setAudio(samples, level, mode) {
    this.samples = samples;
    this.level = level;
    this.mode = mode;
  }

  #colorAt(t, alpha) {
    // Cyan → blue-white → magenta across the width.
    const stops = [[47, 245, 230], [140, 170, 255], [224, 77, 255]];
    const seg = t < 0.5 ? 0 : 1;
    const k = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
    const a = stops[seg];
    const b = stops[seg + 1];
    return `rgba(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',')},${alpha})`;
  }

  render(dt) {
    this.time += dt;
    const { ctx, w, h } = this;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(3, 6, 14, 0.35)';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    // Node network.
    const pts = this.nodes;
    for (const n of pts) {
      n.x += n.vx * dt * (1 + this.level * 6);
      n.y += n.vy * dt * (1 + this.level * 6);
      if (n.x < 0 || n.x > 1) n.vx *= -1;
      if (n.y < 0.2 || n.y > 0.8) n.vy *= -1;
    }
    ctx.lineWidth = 0.6;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = (pts[i].x - pts[j].x) * w;
        const dy = (pts[i].y - pts[j].y) * h;
        const d = Math.hypot(dx, dy);
        if (d > 90) continue;
        ctx.strokeStyle = this.#colorAt(pts[i].x, 0.12 * (1 - d / 90));
        ctx.beginPath();
        ctx.moveTo(pts[i].x * w, pts[i].y * h);
        ctx.lineTo(pts[j].x * w, pts[j].y * h);
        ctx.stroke();
      }
    }
    for (const n of pts) {
      ctx.fillStyle = this.#colorAt(n.x, 0.45);
      ctx.beginPath();
      ctx.arc(n.x * w, n.y * h, n.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Waveform: a few layered strokes with different gains, like the
    // stacked traces in the reference.
    const mid = h / 2;
    const S = 220;
    const amp = h * 0.42;
    const src = this.samples;
    const idle = !src || this.level < 0.01;
    const layers = [[1, 1.6, 0.9], [0.65, 1, 0.5], [0.35, 0.7, 0.3]];
    for (const [gain, width, alpha] of layers) {
      ctx.lineWidth = width;
      ctx.shadowBlur = 12;
      for (let seg = 0; seg < 4; seg++) {
        const from = Math.floor((S * seg) / 4);
        const to = Math.floor((S * (seg + 1)) / 4);
        const t0 = from / S;
        const grad = ctx.createLinearGradient(t0 * w, 0, (to / S) * w, 0);
        grad.addColorStop(0, this.#colorAt(t0, alpha));
        grad.addColorStop(1, this.#colorAt(to / S, alpha));
        ctx.strokeStyle = grad;
        ctx.shadowColor = this.#colorAt((t0 + to / S) / 2, 0.8);
        ctx.beginPath();
        for (let i = from; i <= to; i++) {
          const t = i / S;
          // Envelope: louder toward the ends, quiet at the centre where the mic sits.
          const env = 0.25 + 0.75 * Math.pow(Math.abs(t - 0.5) * 2, 0.8);
          let y;
          if (idle) {
            y = Math.sin(t * 38 + this.time * 2.2) * Math.sin(t * 7 - this.time * 0.7) * 0.025;
          } else {
            const s = src[Math.floor(t * (src.length - 1))] || 0;
            y = s * (0.6 + this.level * 3);
          }
          const yy = mid + y * amp * env * gain * (this.mode === 'listening' ? 0.8 : 1);
          if (i === from) ctx.moveTo(t * w, yy);
          else ctx.lineTo(t * w, yy);
        }
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;

    // Baseline.
    const base = ctx.createLinearGradient(0, 0, w, 0);
    base.addColorStop(0, this.#colorAt(0, 0.7));
    base.addColorStop(1, this.#colorAt(1, 0.7));
    ctx.strokeStyle = base;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
  }
}
