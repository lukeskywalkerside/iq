// Tiny synthesized sound effects — no audio files needed.

let ctx: AudioContext | null = null;
let muted = false;

function tone(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number) {
  if (muted) return;
  ctx ??= new AudioContext();
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur);
}

export const sfx = {
  place(dir: 'up' | 'down') {
    if (dir === 'up') tone(520, 0.14, 'triangle', 0.08, 820);
    else tone(420, 0.14, 'triangle', 0.08, 240);
  },
  win() {
    [660, 880, 1320].forEach((f, i) => setTimeout(() => tone(f, 0.22, 'triangle', 0.07), i * 85));
  },
  lose() {
    tone(240, 0.4, 'sawtooth', 0.035, 110);
  },
  tie() {
    tone(440, 0.2, 'sine', 0.05);
  },
  error() {
    tone(150, 0.16, 'square', 0.03);
  },
  toggle() {
    muted = !muted;
    return muted;
  },
};
