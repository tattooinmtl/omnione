// Real-time voice: speech out, speech in, and the level that moves the mouth.
//
// Out: the text goes to /api/speak (MiniMax TTS, with the emotion, speed and
// pitch the emotion engine chose), and the MP3 plays through a Web Audio
// analyser. The analyser's loudness drives the jaw every frame, so the mouth
// moves with the actual audio, syllable by syllable. If the server cannot
// speak (no key, network, quota), it falls back to the browser's own speech
// synthesis; that exposes no audio stream, so the mouth follows word
// boundaries and a synthetic syllable rhythm instead.
//
// In: the browser's SpeechRecognition (Chrome and Edge). The microphone also
// goes through an analyser, so the waveform and the face react while you talk.

export class Voice {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.buf = null;
    this.source = null;
    this.audio = null;
    this.mode = 'idle';
    this.fallbackLevel = 0;
    this.fallbackUntil = 0;
    this.recognition = null;
    this.micStream = null;
    this.micAnalyser = null;
    this.queue = Promise.resolve();
    this.onState = () => {};
  }

  #ensureCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.5;
      this.analyser.connect(this.ctx.destination);
      this.buf = new Float32Array(this.analyser.fftSize);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  get canListen() {
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  #setMode(m) {
    this.mode = m;
    this.onState(m);
  }

  /* Queue speech, so replies never talk over each other. */
  speak(text, delivery = {}) {
    this.queue = this.queue.then(() => this.#speakNow(text, delivery)).catch(() => {});
    return this.queue;
  }

  stop() {
    try { this.audio?.pause(); } catch { /* already stopped */ }
    try { window.speechSynthesis?.cancel(); } catch { /* unsupported */ }
    this.queue = Promise.resolve();
    this.#setMode('idle');
  }

  async #speakNow(text, { emotion, speed, pitch, voice_id } = {}) {
    const t = String(text || '').trim();
    if (!t) return;
    this.#ensureCtx();
    try {
      const r = await fetch('/api/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t, emotion, speed, pitch, voice_id }),
      });
      if (!r.ok) throw new Error(`speak ${r.status}`);
      const blob = await r.blob();
      await this.#play(URL.createObjectURL(blob));
    } catch {
      await this.#browserSpeak(t, { speed, pitch });
    }
  }

  #play(url) {
    return new Promise((resolve) => {
      const audio = new Audio(url);
      audio.crossOrigin = 'anonymous';
      this.audio = audio;
      try {
        const src = this.ctx.createMediaElementSource(audio);
        src.connect(this.analyser);
      } catch { /* no analyser: still plays */ }
      const done = () => { URL.revokeObjectURL(url); this.#setMode('idle'); resolve(); };
      audio.onended = done;
      audio.onerror = done;
      this.#setMode('speaking');
      audio.play().catch(done);
    });
  }

  #browserSpeak(text, { speed = 1, pitch = 0 } = {}) {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      if (!synth) { resolve(); return; }
      const u = new SpeechSynthesisUtterance(text);
      u.rate = speed || 1;
      u.pitch = 1 + (pitch || 0) * 0.08;
      u.onboundary = () => { this.fallbackLevel = 0.9; };
      u.onend = () => { this.fallbackUntil = 0; this.#setMode('idle'); resolve(); };
      u.onerror = u.onend;
      this.fallbackUntil = Infinity;
      this.#setMode('speaking');
      synth.speak(u);
    });
  }

  /* Current audio frame: { samples, level } for whatever is audible. */
  frame(time) {
    if (this.mode === 'speaking' && this.analyser && this.audio && !this.audio.paused) {
      this.analyser.getFloatTimeDomainData(this.buf);
      return { samples: this.buf, level: rms(this.buf) * 3.2, mode: 'speaking' };
    }
    if (this.mode === 'speaking' && this.fallbackUntil) {
      // Browser TTS: pulse on word boundaries with a syllable rhythm between.
      this.fallbackLevel *= 0.9;
      const syll = 0.35 + 0.35 * Math.max(0, Math.sin(time * 18));
      return { samples: null, level: Math.min(1, this.fallbackLevel * 0.5 + syll * 0.6), mode: 'speaking' };
    }
    if (this.mode === 'listening' && this.micAnalyser) {
      this.micAnalyser.getFloatTimeDomainData(this.micBuf);
      return { samples: this.micBuf, level: rms(this.micBuf) * 3, mode: 'listening' };
    }
    return { samples: null, level: 0, mode: 'idle' };
  }

  /* Listen for one utterance. Resolves with the transcript ('' if none). */
  async listen({ lang = 'en-US', onInterim } = {}) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw new Error('Speech recognition is not available in this browser. Use Chrome or Edge.');
    this.stop();
    const ctx = this.#ensureCtx();
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (ctx) {
        this.micAnalyser = ctx.createAnalyser();
        this.micAnalyser.fftSize = 1024;
        this.micBuf = new Float32Array(this.micAnalyser.fftSize);
        ctx.createMediaStreamSource(this.micStream).connect(this.micAnalyser);
      }
    } catch { /* the recogniser can still work without the visual */ }

    return new Promise((resolve, reject) => {
      const rec = new SR();
      this.recognition = rec;
      rec.lang = lang;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      let finalText = '';
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        onInterim?.(finalText + interim);
      };
      const end = () => {
        this.micStream?.getTracks().forEach((t) => t.stop());
        this.micStream = null;
        this.micAnalyser = null;
        this.recognition = null;
        this.#setMode('idle');
      };
      rec.onerror = (e) => { end(); if (e.error === 'no-speech' || e.error === 'aborted') resolve(''); else reject(new Error(e.error)); };
      rec.onend = () => { end(); resolve(finalText.trim()); };
      this.#setMode('listening');
      rec.start();
    });
  }

  stopListening() {
    try { this.recognition?.stop(); } catch { /* not listening */ }
  }
}

function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.min(1, Math.sqrt(s / buf.length));
}

/* Split speech into sentence-sized pieces. The first one comes back from the
 * TTS quickly, so the face starts talking sooner, and the queue plays the
 * rest back to back. */
export function speechChunks(text, max = 280) {
  const sentences = String(text || '').match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [];
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > max && cur) {
      out.push(cur.trim());
      cur = '';
    }
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max).trim());
    } else {
      cur += s;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/* Turn an agent answer into something worth saying aloud: no code, no file
 * markers, no markdown, and short — the full answer is on screen. */
export function speakable(text, maxChars = 320) {
  let t = String(text || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, (m) => m.slice(1, -1))
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_>|~-]{1,}/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  t = end > maxChars * 0.4 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
  return t;
}
