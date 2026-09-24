// The trading chart, drawn every frame on the GPU with PixiJS (WebGL).
// Everything eases toward its target (price, zoom, scale) so motion is smooth
// no matter how irregular the price ticks are.

import { Application, Container, Graphics, Sprite, Text, Texture, type TextStyleFontWeight } from 'pixi.js';
import type { Point } from './feed';

export type Dir = 'up' | 'down';
export type TradeStatus = 'open' | 'won' | 'lost' | 'tie' | 'sold';
export type ChartMode = 'area' | 'candles';

export interface TradeView {
  id: number;
  dir: Dir;
  stake: number;
  payout: number;
  entry: number;
  openT: number;
  expT: number;
  status: TradeStatus;
  closedAt?: number;
  /** Net result of an early sell, signed. */
  soldPnl?: number;
}

export interface Frame {
  key: string;
  decimals: number;
  points: Point[];
  price: number;
  now: number;
  /** When a trade bought right now would expire. */
  expT: number;
  /** Last moment to buy for that expiry (Turbo); null for Blitz. */
  deadlineT: number | null;
  hover: Dir | null;
  trades: TradeView[];
  mode: ChartMode;
  candleSec: number;
  /** 1 = tight around the next expiry; larger shows more history. */
  zoom: number;
}

const AXIS_W = 88;
const TIME_H = 28;
const PAD_T = 18;
const C = {
  line: 0xf1f4f9,
  up: 0x22c55e,
  down: 0xef4444,
  tie: 0x8f98ad,
  grid: 0xffffff,
  text: 0x8f98ad,
  amber: 0xf2b544,
  ink: 0x161b26, // dark text on solid colour blocks
  tag: 0x2c3446, // neutral label background
};
const FONT = 'Geist Mono, JetBrains Mono, ui-monospace, monospace';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: number;
  ring?: boolean;
}

interface Candle {
  b: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export class Chart {
  private grid = new Graphics();
  private zone = new Graphics();
  private areaMask = new Graphics();
  private area: Sprite;
  private line = new Graphics();
  private marks = new Graphics();
  private head = new Graphics();
  private fx = new Graphics();
  private texts = new Container();
  private priceLabels: Text[] = [];
  private timeLabels: Text[] = [];
  private tagText: Text; // live price on the axis, dark text on a white block
  private expText: Text;
  private buyText: Text;
  private tradeTexts = new Map<number, Text>();
  private stakeTexts = new Map<number, Text>();
  private particles: Particle[] = [];

  private yMin = 0;
  private yMax = 1;
  private past = 80;
  private future = 50;
  private disp = 0;
  private key = '';
  private pulse = 0;
  private plotW = 1;
  private xOf: ((t: number) => number) | null = null;
  private yOf: ((p: number) => number) | null = null;

  constructor(private app: Application) {
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 256;
    const ctx = c.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, 'rgba(241,244,249,0.22)');
    g.addColorStop(0.6, 'rgba(241,244,249,0.06)');
    g.addColorStop(1, 'rgba(241,244,249,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 2, 256);
    this.area = new Sprite(Texture.from(c));
    this.area.mask = this.areaMask;

    app.stage.addChild(
      this.grid, this.zone, this.areaMask, this.area, this.line,
      this.marks, this.head, this.fx, this.texts,
    );

    for (let i = 0; i < 16; i++) {
      const t = label(11, C.text);
      t.anchor.set(0, 0.5);
      this.priceLabels.push(t);
      this.texts.addChild(t);
    }
    for (let i = 0; i < 16; i++) {
      const t = label(11, C.text);
      t.anchor.set(0.5, 0.5);
      this.timeLabels.push(t);
      this.texts.addChild(t);
    }
    this.tagText = label(12, C.ink, '600');
    this.tagText.anchor.set(0, 0.5);
    this.expText = label(11, 0xffffff, '600');
    this.expText.anchor.set(0.5, 0.5);
    this.buyText = label(11, C.ink, '600');
    this.buyText.anchor.set(0.5, 0.5);
    this.texts.addChild(this.tagText, this.expText, this.buyText);
  }

  render(f: Frame, dt: number) {
    const W = this.app.screen.width;
    const H = this.app.screen.height;
    const plotW = W - AXIS_W;
    const plotH = H - TIME_H - PAD_T;
    const bottom = PAD_T + plotH;
    this.plotW = plotW;

    const reset = f.key !== this.key;
    if (reset) {
      this.key = f.key;
      this.disp = f.price;
      this.particles.length = 0;
    }
    const ease = (rate: number) => (reset ? 1 : 1 - Math.exp(-dt * rate));
    const now = f.now;

    // --- smoothed price + time window -------------------------------------
    this.disp += (f.price - this.disp) * ease(10);

    let horizon = (f.expT - now) / 1000;
    for (const t of f.trades) if (t.status === 'open') horizon = Math.max(horizon, (t.expT - now) / 1000);
    const fut = (horizon + 14) * (0.7 + 0.3 * f.zoom);
    const pst = Math.max(60, (horizon + 14) * 1.3) * f.zoom;
    this.future += (fut - this.future) * ease(3);
    this.past += (pst - this.past) * ease(3);
    const pps = plotW / (this.past + this.future);
    const nowX = this.past * pps;
    const xOf = (t: number) => nowX + ((t - now) / 1000) * pps;

    // --- vertical auto-scale ----------------------------------------------
    const pts = f.points;
    const cutoff = now - (this.past + 2) * 1000;
    let i0 = pts.length;
    while (i0 > 0 && pts[i0 - 1].t >= cutoff) i0--;
    let lo = this.disp;
    let hi = this.disp;
    for (let i = i0; i < pts.length; i++) {
      const p = pts[i].p;
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
    for (const t of f.trades) {
      if (t.status !== 'open') continue;
      lo = Math.min(lo, t.entry);
      hi = Math.max(hi, t.entry);
    }
    const minRange = this.disp * 0.0003;
    if (hi - lo < minRange) {
      const mid = (hi + lo) / 2;
      lo = mid - minRange / 2;
      hi = mid + minRange / 2;
    }
    const range = hi - lo;
    this.yMin += (lo - range * 0.22 - this.yMin) * ease(4);
    this.yMax += (hi + range * 0.22 - this.yMax) * ease(4);
    const yMin = this.yMin;
    const yMax = this.yMax;
    const yOf = (p: number) => PAD_T + ((yMax - p) / (yMax - yMin)) * plotH;
    this.xOf = xOf;
    this.yOf = yOf;
    const headY = yOf(this.disp);

    // --- grid + axis labels ------------------------------------------------
    const g = this.grid;
    g.clear();
    const step = niceStep((yMax - yMin) / 6);
    // Keep the drawn line and labels the same colour family as the CSS.
    const dec = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step)) + 1), f.decimals);
    let li = 0;
    for (let v = Math.ceil(yMin / step) * step; v <= yMax && li < this.priceLabels.length; v += step) {
      const y = yOf(v);
      if (y < PAD_T || y > bottom) continue;
      g.moveTo(0, y).lineTo(plotW, y);
      const t = this.priceLabels[li++];
      t.visible = Math.abs(y - headY) > 14;
      setText(t, fmt(v, dec));
      t.position.set(plotW + 12, y);
    }
    for (; li < this.priceLabels.length; li++) this.priceLabels[li].visible = false;
    g.stroke({ width: 1, color: C.grid, alpha: 0.09 });

    const tStep = [5, 10, 15, 30, 60, 120, 300].find((s) => s * pps >= 110) ?? 600;
    let ti = 0;
    const tStart = Math.ceil((now - this.past * 1000) / (tStep * 1000)) * tStep * 1000;
    for (let t = tStart; t <= now + this.future * 1000 && ti < this.timeLabels.length; t += tStep * 1000) {
      const x = xOf(t);
      if (x < 28 || x > plotW - 28) continue; // keep centred labels fully inside the plot
      g.moveTo(x, PAD_T).lineTo(x, bottom);
      const tx = this.timeLabels[ti++];
      tx.visible = true;
      setText(tx, clock(t));
      tx.position.set(x, bottom + TIME_H / 2);
    }
    for (; ti < this.timeLabels.length; ti++) this.timeLabels[ti].visible = false;
    g.stroke({ width: 1, color: C.grid, alpha: 0.06 });
    g.moveTo(plotW, 0).lineTo(plotW, H).stroke({ width: 1, color: C.grid, alpha: 0.1 });

    // --- hover preview: tint the zone the trade would win in ---------------
    const z = this.zone;
    z.clear();
    if (f.hover === 'up') {
      z.rect(0, PAD_T, plotW, Math.max(0, headY - PAD_T)).fill({ color: C.up, alpha: 0.06 });
    } else if (f.hover === 'down') {
      z.rect(0, headY, plotW, Math.max(0, bottom - headY)).fill({ color: C.down, alpha: 0.06 });
    }

    // --- price: area line or candles ---------------------------------------
    const L = this.line;
    L.clear();
    const A = this.areaMask;
    A.clear();

    if (f.mode === 'area') {
      this.area.visible = true;
      const xs: number[] = [];
      const ys: number[] = [];
      let lastX = -Infinity;
      for (let i = Math.max(0, i0 - 1); i < pts.length; i++) {
        const p = pts[i];
        if (p.t > now - 40) break;
        const x = xOf(p.t);
        if (x - lastX < 1.2) continue;
        xs.push(x);
        ys.push(yOf(p.p));
        lastX = x;
      }
      xs.push(nowX);
      ys.push(headY);

      const trace = () => {
        L.moveTo(xs[0], ys[0]);
        for (let i = 1; i < xs.length; i++) L.lineTo(xs[i], ys[i]);
      };
      trace();
      L.stroke({ width: 1.5, color: C.line, alpha: 1, join: 'miter', cap: 'square' });

      A.moveTo(xs[0], bottom);
      for (let i = 0; i < xs.length; i++) A.lineTo(xs[i], ys[i]);
      A.lineTo(nowX, bottom).closePath().fill({ color: 0xffffff });
      this.area.position.set(0, PAD_T);
      this.area.width = plotW;
      this.area.height = plotH;
    } else {
      this.area.visible = false;
      const candles = buildCandles(pts, i0, now, f.candleSec * 1000, this.disp);
      const ms = f.candleSec * 1000;
      const bw = Math.max(1.5, (ms / 1000) * pps * 0.66);
      for (const [color, rising] of [[C.up, true], [C.down, false]] as const) {
      // Flat, solid candles — no glow layers.
        let any = false;
        for (const c of candles) {
          if (c.c >= c.o !== rising) continue;
          const x = xOf(c.b * ms + ms / 2);
          L.moveTo(x, yOf(c.h)).lineTo(x, yOf(c.l));
          any = true;
        }
        if (!any) continue;
        L.stroke({ width: 1, color, alpha: 0.9 });
        for (const c of candles) {
          if (c.c >= c.o !== rising) continue;
          const x = xOf(c.b * ms + ms / 2);
          const top = yOf(Math.max(c.o, c.c));
          L.rect(x - bw / 2, top, bw, Math.max(1.2, yOf(Math.min(c.o, c.c)) - top));
        }
        L.fill({ color });
      }
    }

    // --- purchase / expiry lines for the next trade -------------------------
    const M = this.marks;
    M.clear();
    const ex = xOf(f.expT);
    // Amber -> accent: purchase-deadline line uses the same lime as the UI.
    if (f.deadlineT !== null) {
      const dx = xOf(f.deadlineT);
      M.rect(dx, PAD_T, Math.max(0, ex - dx), plotH).fill({ color: 0xffffff, alpha: 0.025 });
      dashV(M, dx, PAD_T + 22, bottom);
      M.stroke({ width: 1, color: C.amber, alpha: 0.6 });
      setText(this.buyText, `PURCHASE ${dur(Math.max(0, Math.ceil((f.deadlineT - now) / 1000)))}`);
      const bw = this.buyText.width + 16;
      M.rect(dx - bw / 2, PAD_T, bw, 20).fill({ color: C.amber });
      this.buyText.position.set(dx, PAD_T + 10);
      this.buyText.visible = true;
    } else {
      this.buyText.visible = false;
    }
    M.moveTo(ex, PAD_T + 22).lineTo(ex, bottom).stroke({ width: 1, color: 0xffffff, alpha: 0.35 });
    setText(this.expText, `EXPIRY ${dur(Math.max(0, Math.ceil((f.expT - now) / 1000)))}`);
    const ew = this.expText.width + 16;
    const ey = f.deadlineT !== null && ex - xOf(f.deadlineT) < ew + 90 ? PAD_T + 26 : PAD_T;
    M.rect(ex - ew / 2, ey, ew, 20).fill({ color: C.tag }).stroke({ width: 1, color: 0xffffff, alpha: 0.2 });
    this.expText.position.set(ex, ey + 10);

    // --- open trades ---------------------------------------------------------
    const seen = new Set<number>();
    const placed: { x: number; y: number; w: number }[] = [];
    for (const t of f.trades) {
      const done = t.status !== 'open';
      const age = done ? now - (t.closedAt ?? now) : 0;
      if (done && age > 2600) continue;
      const fade = done ? 1 - Math.max(0, (age - 1600) / 1000) : 1;
      const winning = done
        ? t.status === 'won' || (t.status === 'sold' && (t.soldPnl ?? 0) >= 0)
        : t.dir === 'up' ? f.price > t.entry : f.price < t.entry; // raw price, same as settlement
      const dirCol = t.dir === 'up' ? C.up : C.down;
      const col = t.status === 'tie' ? C.tie : winning ? C.up : C.down;
      const x0 = xOf(t.openT);
      const x1 = Math.min(xOf(done ? (t.closedAt ?? t.expT) : t.expT), plotW);
      const y = yOf(t.entry);

      // Entry line + shaded band from entry to expiry, in the direction colour.
      M.rect(x0, PAD_T, Math.max(0, x1 - x0), plotH).fill({ color: dirCol, alpha: 0.035 * fade });
      M.moveTo(x0, y).lineTo(plotW, y).stroke({ width: 1.5, color: dirCol, alpha: 0.85 * fade });
      dashV(M, x1, PAD_T + 22, bottom);
      M.stroke({ width: 1.5, color: col, alpha: 0.5 * fade });

      // Stake bubble at the entry point. Springs in over the first 400ms.
      const born = (now - t.openT) / 1000;
      const k = Math.min(1, born / 0.4);
      const scale = k < 1 ? 1 + 2.7 * Math.pow(k - 1, 3) + 1.7 * Math.pow(k - 1, 2) : 1; // easeOutBack
      let st = this.stakeTexts.get(t.id);
      if (!st) {
        st = label(12, 0xffffff, '600');
        st.anchor.set(0, 0.5);
        this.texts.addChild(st);
        this.stakeTexts.set(t.id, st);
        setText(st, `$${t.stake}`);
      }
      const bh = 24 * scale;
      const bw = (st.width + 34) * scale;
      const bx = x0 - bw + 10 * scale; // bubble sits left of the entry point
      const by = y - bh / 2;
      M.rect(bx, by, bw, bh).fill({ color: dirCol, alpha: fade });
      // Direction notch: small triangle on the line, pointing up or down.
      const s = t.dir === 'up' ? 1 : -1;
      M.poly([x0 - 4, y + s * 3, x0 + 4, y + s * 3, x0, y - s * 4]).fill({ color: 0xffffff, alpha: fade });
      // Clock glyph inside the bubble.
      const cx = bx + bw - 12 * scale;
      M.circle(cx, y, 5 * scale).stroke({ width: 1.5, color: 0xffffff, alpha: fade });
      M.moveTo(cx, y - 3 * scale).lineTo(cx, y).lineTo(cx + 2.5 * scale, y).stroke({ width: 1.5, color: 0xffffff, alpha: fade });
      st.alpha = fade;
      st.scale.set(scale);
      st.position.set(bx + 8 * scale, y);

      let tx = this.tradeTexts.get(t.id);
      if (!tx) {
        tx = label(12, 0xffffff, '600');
        tx.anchor.set(0, 0.5);
        this.texts.addChild(tx);
        this.tradeTexts.set(t.id, tx);
      }
      const profit = t.stake * t.payout;
      const pnl = t.soldPnl ?? 0;
      const text = done
        ? t.status === 'won' ? `WIN +$${profit.toFixed(2)}`
        : t.status === 'tie' ? 'TIE — refunded'
        : t.status === 'sold' ? `SOLD ${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(2)}`
        : `LOSS −$${t.stake}`
        : `${winning ? '+' : '−'}$${(winning ? profit : t.stake).toFixed(2)}  ${dur(Math.max(0, Math.ceil((t.expT - now) / 1000)))}`;
      setText(tx, text);
      tx.alpha = fade;
      const w = tx.width + 18;
      const px = Math.max(x0 + 12, x1 - w - 8);
      let py = Math.max(PAD_T + 60, Math.min(bottom - 14, y + (t.dir === 'up' ? 22 : -22)));
      // Stack labels that would overlap an earlier one.
      const nudge = py > (PAD_T + bottom) / 2 ? -26 : 26;
      for (let tries = 0; tries < 8 && placed.some((r) => Math.abs(r.y - py) < 24 && px < r.x + r.w && px + w > r.x); tries++) {
        py += nudge;
      }
      placed.push({ x: px, y: py, w });
      M.rect(px, py - 11, w, 22).fill({ color: col, alpha: fade });
      tx.position.set(px + 9, py);
      seen.add(t.id);
    }
    for (const map of [this.tradeTexts, this.stakeTexts]) {
      for (const [id, tx] of map) {
        if (!seen.has(id)) {
          tx.destroy();
          map.delete(id);
        }
      }
    }

    // --- live head: pulse dot, dashed guide, price tag ----------------------
    const Hd = this.head;
    Hd.clear();
    dashH(Hd, nowX, plotW, headY);
    Hd.stroke({ width: 1, color: C.line, alpha: 0.3 });
    this.pulse = (this.pulse + dt * 0.9) % 1;
    const r = 4 + this.pulse * 12;
    Hd.rect(nowX - r, headY - r, r * 2, r * 2).stroke({ width: 1, color: C.line, alpha: 0.5 * (1 - this.pulse) });
    Hd.rect(nowX - 4, headY - 4, 8, 8).fill({ color: C.line });
    Hd.rect(plotW + 1, headY - 12, AXIS_W - 2, 24).fill({ color: C.line });
    setText(this.tagText, fmt(this.disp, f.decimals));
    this.tagText.position.set(plotW + 12, headY);

    // --- particles -----------------------------------------------------------
    const F = this.fx;
    F.clear();
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      const a = p.life / p.max;
      if (p.ring) {
        const rr = (1 - a) * 80 + 6;
        F.rect(p.x - rr, p.y - rr, rr * 2, rr * 2).stroke({ width: 3 * a + 0.5, color: p.color, alpha: a });
      } else {
        p.vy += 260 * dt;
        p.vx *= 0.985;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const sz = p.size * a + 0.6;
        F.rect(p.x - sz, p.y - sz, sz * 2, sz * 2).fill({ color: p.color, alpha: a });
      }
    }
  }

  burst(t: number, price: number, kind: 'won' | 'lost' | 'tie' | 'sold') {
    if (!this.xOf || !this.yOf) return;
    const x = Math.min(this.xOf(t), this.plotW - 4);
    const y = this.yOf(price);
    const color = kind === 'won' ? C.up : kind === 'lost' ? C.down : kind === 'sold' ? C.line : C.tie;
    this.particles.push({ x, y, vx: 0, vy: 0, life: 0.8, max: 0.8, size: 0, color, ring: true });
    const n = kind === 'won' ? 56 : 16;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = kind === 'won' ? 120 + Math.random() * 300 : 40 + Math.random() * 110;
      const life = 0.6 + Math.random() * 0.7;
      this.particles.push({
        x, y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - (kind === 'won' ? 120 : 0),
        life, max: life,
        size: 1.5 + Math.random() * 2.5,
        color: Math.random() < 0.25 ? 0xffffff : color,
      });
    }
  }
}

// --- helpers -----------------------------------------------------------------

// Each candle opens at the previous close so the series reads as continuous.
function buildCandles(pts: Point[], i0: number, now: number, ms: number, live: number): Candle[] {
  const out: Candle[] = [];
  let j = i0;
  const first = pts[i0]?.t ?? now;
  const startT = Math.floor(first / ms) * ms;
  while (j > 0 && pts[j - 1].t >= startT) j--;
  for (let i = j; i < pts.length; i++) {
    const p = pts[i];
    if (p.t > now) break;
    const b = Math.floor(p.t / ms);
    let c = out[out.length - 1];
    if (!c || c.b !== b) {
      const o = c ? c.c : p.p;
      c = { b, o, h: Math.max(o, p.p), l: Math.min(o, p.p), c: p.p };
      out.push(c);
    } else {
      c.c = p.p;
      if (p.p > c.h) c.h = p.p;
      if (p.p < c.l) c.l = p.p;
    }
  }
  const bNow = Math.floor(now / ms);
  let c = out[out.length - 1];
  if (!c || c.b !== bNow) {
    const o = c ? c.c : live;
    out.push((c = { b: bNow, o, h: Math.max(o, live), l: Math.min(o, live), c: live }));
  }
  c.c = live;
  c.h = Math.max(c.h, live);
  c.l = Math.min(c.l, live);
  return out;
}

function label(size: number, fill: number, weight: TextStyleFontWeight = '500') {
  return new Text({ text: '', style: { fontFamily: FONT, fontSize: size, fill, fontWeight: weight } });
}

function setText(t: Text, s: string) {
  if (t.text !== s) t.text = s;
}

function niceStep(raw: number) {
  const e = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / e;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * e;
}

const fmtCache = new Map<number, Intl.NumberFormat>();
function fmt(v: number, dec: number) {
  let nf = fmtCache.get(dec);
  if (!nf) {
    nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    fmtCache.set(dec, nf);
  }
  return nf.format(v);
}

function clock(t: number) {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function dur(sec: number) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function dashV(g: Graphics, x: number, y0: number, y1: number) {
  for (let y = y0; y < y1; y += 8) g.moveTo(x, y).lineTo(x, Math.min(y + 4, y1));
}

function dashH(g: Graphics, x0: number, x1: number, y: number) {
  for (let x = x0; x < x1; x += 8) g.moveTo(x, y).lineTo(Math.min(x + 4, x1), y);
}
