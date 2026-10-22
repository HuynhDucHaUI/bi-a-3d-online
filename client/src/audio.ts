// Âm thanh tổng hợp bằng Web Audio (không cần file âm thanh).
let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;
let muted = false;
let unlocked = false;
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => { unlocked = true; }, { capture: true, once: true });

function ac(): AudioContext | null {
  if (muted || !unlocked) return null;
  if (!ctx) {
    const C = window.AudioContext || (window as any).webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    const len = ctx.sampleRate * 0.5;
    noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function unlockAudio(): void {
  unlocked = true;
  ac();
}

export function setMuted(m: boolean): void {
  muted = m;
}

export function isMuted(): boolean {
  return muted;
}

function burst(c: AudioContext, opts: { freq: number; q?: number; type?: BiquadFilterType; gain: number; dur: number; pitch?: number; pitchTo?: number }): void {
  const t = c.currentTime;
  const g = c.createGain();
  g.gain.setValueAtTime(opts.gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
  g.connect(c.destination);
  if (noise) {
    const src = c.createBufferSource();
    src.buffer = noise;
    const f = c.createBiquadFilter();
    f.type = opts.type ?? 'bandpass';
    f.frequency.value = opts.freq;
    f.Q.value = opts.q ?? 1;
    src.connect(f).connect(g);
    src.start(t, Math.random() * 0.3, opts.dur + 0.02);
  }
  if (opts.pitch) {
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(opts.pitch, t);
    if (opts.pitchTo) o.frequency.exponentialRampToValueAtTime(opts.pitchTo, t + opts.dur);
    o.connect(g);
    o.start(t);
    o.stop(t + opts.dur + 0.02);
  }
}

/** Bi va chạm bi. speed: m/s */
export function playBall(speed: number): void {
  const c = ac();
  if (!c) return;
  const v = Math.min(1, speed / 4);
  burst(c, { freq: 3000 + v * 1500, q: 2, gain: 0.08 + 0.5 * v, dur: 0.06, pitch: 2200 + v * 800, pitchTo: 1500 });
}

export function playCushion(speed: number): void {
  const c = ac();
  if (!c) return;
  const v = Math.min(1, speed / 3);
  burst(c, { freq: 500, q: 0.8, type: 'lowpass', gain: 0.05 + 0.45 * v, dur: 0.12, pitch: 140, pitchTo: 70 });
}

export function playPocket(): void {
  const c = ac();
  if (!c) return;
  burst(c, { freq: 400, type: 'lowpass', gain: 0.45, dur: 0.35, pitch: 320, pitchTo: 70 });
  setTimeout(() => ac() && burst(c, { freq: 1800, q: 3, gain: 0.12, dur: 0.05, pitch: 1500, pitchTo: 900 }), 260);
}

export function playCue(power: number): void {
  const c = ac();
  if (!c) return;
  burst(c, { freq: 2500, q: 1.5, gain: 0.2 + 0.4 * power, dur: 0.05, pitch: 1800, pitchTo: 1200 });
}

export function playTick(): void {
  const c = ac();
  if (!c) return;
  burst(c, { freq: 1200, q: 4, gain: 0.12, dur: 0.04, pitch: 900 });
}
