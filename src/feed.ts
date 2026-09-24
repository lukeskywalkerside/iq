// Live prices from Binance's public market-data endpoints (no key needed).
// If they can't be reached within a few seconds we fall back to a simulated
// random walk, so the prototype always has something moving on screen.

export interface Asset {
  id: string; // Binance symbol, lowercase
  symbol: string;
  name: string;
  icon: string;
  decimals: number;
  base: number; // starting price for the simulator
  payout: number; // profit on a winning trade, as a fraction of the stake
}

export const ASSETS: Asset[] = [
  { id: 'btcusdt', symbol: 'BTC/USD', name: 'Bitcoin', icon: 'btc', decimals: 2, base: 65000, payout: 0.86 },
  { id: 'ethusdt', symbol: 'ETH/USD', name: 'Ethereum', icon: 'eth', decimals: 2, base: 3200, payout: 0.85 },
  { id: 'solusdt', symbol: 'SOL/USD', name: 'Solana', icon: 'sol', decimals: 3, base: 150, payout: 0.84 },
  { id: 'bnbusdt', symbol: 'BNB/USD', name: 'BNB', icon: 'bnb', decimals: 2, base: 600, payout: 0.82 },
  { id: 'xrpusdt', symbol: 'XRP/USD', name: 'XRP', icon: 'xrp', decimals: 4, base: 0.6, payout: 0.83 },
  { id: 'dogeusdt', symbol: 'DOGE/USD', name: 'Dogecoin', icon: 'doge', decimals: 5, base: 0.15, payout: 0.8 },
  { id: 'adausdt', symbol: 'ADA/USD', name: 'Cardano', icon: 'ada', decimals: 4, base: 0.45, payout: 0.81 },
  { id: 'ltcusdt', symbol: 'LTC/USD', name: 'Litecoin', icon: 'ltc', decimals: 2, base: 80, payout: 0.8 },
  { id: 'linkusdt', symbol: 'LINK/USD', name: 'Chainlink', icon: 'link', decimals: 3, base: 15, payout: 0.82 },
  { id: 'dotusdt', symbol: 'DOT/USD', name: 'Polkadot', icon: 'dot', decimals: 3, base: 6, payout: 0.8 },
  { id: 'trxusdt', symbol: 'TRX/USD', name: 'TRON', icon: 'trx', decimals: 5, base: 0.12, payout: 0.79 },
];

export const assetById = (id: string) => ASSETS.find((a) => a.id === id)!;

export const iconUrl = (a: Asset) =>
  `https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color/${a.icon}.svg`;

export interface Point {
  t: number; // ms epoch
  p: number;
}

export type FeedStatus = 'connecting' | 'live' | 'simulated';

const API = 'https://data-api.binance.vision/api/v3';
const WS = 'wss://data-stream.binance.vision/stream?streams=';
const KEEP_MS = 20 * 60_000;
const SAMPLE_MS = 200;
const FLOW_WINDOW_S = 60;

export class Feed {
  readonly history = new Map<string, Point[]>();
  readonly last = new Map<string, number>();
  readonly change24 = new Map<string, number>();
  status: FeedStatus = 'connecting';
  onStatus: (s: FeedStatus) => void = () => {};

  private ws: WebSocket | null = null;
  private gotMessage = false;
  // Per-second buckets of [second, buyVolume, sellVolume] for the sentiment bar.
  private flow = new Map<string, number[][]>();
  // The chart line is lightly smoothed so single-tick jumps draw as short
  // ramps instead of cliffs. Settlement always uses the raw `last` price.
  private smooth = new Map<string, number>();

  async start() {
    await Promise.all(ASSETS.map((a) => this.seed(a)));
    this.connect();
    window.setInterval(() => this.sample(), SAMPLE_MS);
    void this.refresh24();
    window.setInterval(() => void this.refresh24(), 60_000);
  }

  /** Share of taker-buy volume over the last minute, 0..1. */
  sentiment(id: string) {
    const arr = this.flow.get(id);
    if (!arr) return 0.5;
    const from = Math.floor(Date.now() / 1000) - FLOW_WINDOW_S;
    let buy = 0;
    let sell = 0;
    for (const [s, b, v] of arr) {
      if (s < from) continue;
      buy += b;
      sell += v;
    }
    return buy + sell > 0 ? buy / (buy + sell) : 0.5;
  }

  // Backfill ~15 minutes of 1-second candles so the chart isn't empty.
  private async seed(a: Asset) {
    try {
      const res = await fetch(`${API}/klines?symbol=${a.id.toUpperCase()}&interval=1s&limit=1000`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as unknown[][];
      const now = Date.now();
      const pts = rows
        .map((r) => ({ t: Number(r[0]) + 1000, p: Number(r[4]) }))
        .filter((pt) => pt.t <= now);
      if (!pts.length) throw new Error('empty');
      this.history.set(a.id, pts);
      this.last.set(a.id, pts[pts.length - 1].p);
    } catch {
      const pts = fakeHistory(a.base);
      this.history.set(a.id, pts);
      this.last.set(a.id, pts[pts.length - 1].p);
    }
  }

  private async refresh24() {
    try {
      const symbols = JSON.stringify(ASSETS.map((a) => a.id.toUpperCase()));
      const res = await fetch(`${API}/ticker/24hr?symbols=${encodeURIComponent(symbols)}`);
      if (!res.ok) return;
      const rows = (await res.json()) as { symbol: string; priceChangePercent: string }[];
      for (const r of rows) this.change24.set(r.symbol.toLowerCase(), Number(r.priceChangePercent));
    } catch {
      // Not critical — the picker just shows no 24h change.
    }
  }

  private connect() {
    const streams = ASSETS.map((a) => `${a.id}@aggTrade`).join('/');
    this.gotMessage = false;
    try {
      this.ws = new WebSocket(WS + streams);
    } catch {
      this.simulate();
      return;
    }
    const timeout = window.setTimeout(() => {
      if (!this.gotMessage) this.simulate();
    }, 6000);

    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as {
        data?: { s: string; p: string; q: string; m: boolean };
      };
      const d = msg.data;
      if (!d) return;
      if (!this.gotMessage) {
        this.gotMessage = true;
        window.clearTimeout(timeout);
        this.setStatus('live');
      }
      const id = d.s.toLowerCase();
      const price = Number(d.p);
      this.last.set(id, price);
      // `m` = buyer was the maker, i.e. the aggressive side was a seller.
      this.addFlow(id, !d.m, price * Number(d.q));
    };
    this.ws.onclose = () => {
      if (this.status === 'simulated') return;
      if (this.status === 'live') {
        this.setStatus('connecting');
        window.setTimeout(() => this.connect(), 2000);
      } else {
        this.simulate();
      }
    };
  }

  private addFlow(id: string, buy: boolean, volume: number) {
    const sec = Math.floor(Date.now() / 1000);
    let arr = this.flow.get(id);
    if (!arr) this.flow.set(id, (arr = []));
    let last = arr[arr.length - 1];
    if (!last || last[0] !== sec) {
      arr.push((last = [sec, 0, 0]));
      if (arr.length > FLOW_WINDOW_S * 2) arr.shift();
    }
    last[buy ? 1 : 2] += volume;
  }

  private simulate() {
    if (this.status === 'simulated') return;
    this.setStatus('simulated');
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    const drift = new Map<string, number>();
    window.setInterval(() => {
      for (const a of ASSETS) {
        const p = this.last.get(a.id) ?? a.base;
        const d = (drift.get(a.id) ?? 0) * 0.97 + gauss() * 0.00002;
        drift.set(a.id, d);
        this.last.set(a.id, p * (1 + d + gauss() * 0.00008));
        this.addFlow(a.id, Math.random() < 0.5 + d * 4000, 1);
      }
    }, 100);
  }

  private sample() {
    const now = Date.now();
    for (const a of ASSETS) {
      const raw = this.last.get(a.id);
      if (raw === undefined) continue;
      const prev = this.smooth.get(a.id) ?? raw;
      const p = prev + (raw - prev) * 0.45;
      this.smooth.set(a.id, p);
      const arr = this.history.get(a.id)!;
      arr.push({ t: now, p });
      if (arr[0].t < now - KEEP_MS) {
        let cut = 0;
        while (cut < arr.length && arr[cut].t < now - KEEP_MS) cut++;
        arr.splice(0, cut);
      }
    }
  }

  private setStatus(s: FeedStatus) {
    this.status = s;
    this.onStatus(s);
  }
}

function gauss() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

function fakeHistory(base: number): Point[] {
  const out: Point[] = [];
  const now = Date.now();
  let p = base;
  for (let i = 900; i > 0; i--) {
    p *= 1 + gauss() * 0.00025;
    out.push({ t: now - i * 1000, p });
  }
  return out;
}
