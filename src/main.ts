import './style.css';
// First thing: prove to the inline watchdog in index.html that we're running.
(window as unknown as { __pulseStage: string }).__pulseStage = 'script';
import { Application } from 'pixi.js';
import { ASSETS, Feed, assetById, iconUrl, type Asset, type FeedStatus } from './feed';
import { Chart, dur, type ChartMode, type Dir, type TradeView } from './chart';
import { sfx } from './sound';
import { glide, installRipples, retrigger } from './ui';

// Practice-only prototype: trades settle in the browser. A real product must
// settle on the server against its own recorded price.
const START_BALANCE = 10_000;
const STAKE_CHIPS = [10, 50, 100, 500, 1000];
const STAKE_STEPS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const CANDLE_SECS = [5, 15, 30, 60];
const BLITZ_SECS = [5, 15, 30];
const TURBO_SLOTS = 5; // selectable expiries: the next five whole minutes
const PURCHASE_CLOSE_MS = 30_000; // Turbo buying closes 30s before expiry

type Expiry = { kind: 'turbo'; idx: number } | { kind: 'blitz'; sec: number };

interface Trade extends TradeView {
  assetId: string;
  close?: number;
}

const state = {
  tabs: ['btcusdt', 'ethusdt', 'solusdt'],
  assetId: 'btcusdt',
  stake: 100,
  exp: { kind: 'turbo', idx: 0 } as Expiry,
  mode: 'area' as ChartMode,
  candleSec: 5,
  zoom: 3,
  balance: START_BALANCE,
  hover: null as Dir | null,
  trades: [] as Trade[],
  drawer: null as null | 'open' | 'history',
};
let seq = 0;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const asset = () => assetById(state.assetId);
const money = (v: number) =>
  '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const priceFmt = (a: Asset, v: number) =>
  v.toLocaleString('en-US', { minimumFractionDigits: a.decimals, maximumFractionDigits: a.decimals });
const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const pctOf = (a: Asset) => `${Math.round(a.payout * 100)}%`;

function turboExpiry(now: number, idx: number) {
  // First whole minute whose purchase window (expiry − 30s) is still open.
  const first = Math.floor((now + PURCHASE_CLOSE_MS) / 60_000) * 60_000 + 60_000;
  return first + idx * 60_000;
}

function resolveExpiry(now: number) {
  const e = state.exp;
  if (e.kind === 'blitz') {
    return { expT: now + e.sec * 1000, deadlineT: null, main: `0:${pad(e.sec)}`, sub: 'Blitz' };
  }
  const expT = turboExpiry(now, e.idx);
  return { expT, deadlineT: expT - PURCHASE_CLOSE_MS, main: hhmm(expT), sub: dur(Math.ceil((expT - now) / 1000)) };
}

// ---------------------------------------------------------------------------
// Pixi + feed boot
// ---------------------------------------------------------------------------
const host = $('#canvasHost');
const loadingEl = $('#loading');
const loadingMsg = loadingEl.querySelector('span')!;

// Anything that goes wrong while booting is shown in the overlay, so a broken
// deployment says why instead of spinning forever.
function bootError(what: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  loadingEl.classList.add('failed');
  loadingMsg.innerHTML = `<b>${what}</b>${msg}<br><br>Try a different browser, or disable extensions / VPN and reload.`;
  console.error(what, err);
}
window.addEventListener('error', (e) => bootError('Something broke', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => bootError('Something broke', e.reason));

const app = new Application();
loadingMsg.textContent = 'Starting graphics…';
try {
  await app.init({
    resizeTo: host,
    antialias: true,
    backgroundAlpha: 0,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
} catch (err) {
  bootError('Graphics failed to start (WebGL/WebGPU unavailable?)', err);
  throw err;
}
host.appendChild(app.canvas);
loadingMsg.textContent = 'Connecting to the price feed…';
// Pixi's resizeTo only watches the window; the host also changes size on its
// own (positions bar, drawer, mobile layout), so track it directly.
new ResizeObserver(() => app.resize()).observe(host);
const chart = new Chart(app);

const feed = new Feed();
const statusEl = $('#feedStatus');
feed.onStatus = (s: FeedStatus) => {
  statusEl.className = `status ${s}`;
  statusEl.textContent =
    s === 'live' ? 'LIVE · Binance' : s === 'simulated' ? 'Simulated prices' : 'connecting…';
};
const slow = window.setTimeout(() => (loadingMsg.textContent = 'Still connecting to the price feed…'), 3000);
// Belt and braces: even if the feed misbehaves, show the room after 10s.
await Promise.race([feed.start(), new Promise((r) => setTimeout(r, 10_000))]);
window.clearTimeout(slow);
loadingEl.classList.add('hidden-fade');

// ---------------------------------------------------------------------------
// Asset tabs + picker
// ---------------------------------------------------------------------------
const tabsEl = $('#tabs');
function renderTabs() {
  const kind = state.exp.kind === 'turbo' ? 'Turbo' : 'Blitz';
  tabsEl.innerHTML =
    state.tabs
      .map((id) => {
        const a = assetById(id);
        return `<button class="tab ${id === state.assetId ? 'active' : ''}" data-id="${id}">
          <img src="${iconUrl(a)}" alt="">
          <span class="tab-txt"><span class="tab-sym">${a.symbol}</span><span class="tab-meta">${kind} · <b>${pctOf(a)}</b></span></span>
          ${state.tabs.length > 1 ? `<span class="tab-x" data-close="${id}" title="Close">✕</span>` : ''}
        </button>`;
      })
      .join('') + `<button class="tab-add" id="tabAdd" title="Add asset">+</button>`;
}
tabsEl.addEventListener('click', (e) => {
  const el = e.target as HTMLElement;
  const close = el.closest<HTMLElement>('[data-close]');
  if (close) {
    const id = close.dataset.close!;
    const i = state.tabs.indexOf(id);
    state.tabs.splice(i, 1);
    if (id === state.assetId) selectAsset(state.tabs[Math.max(0, i - 1)]);
    else renderTabs();
    return;
  }
  if (el.closest('#tabAdd')) return openPicker();
  const tab = el.closest<HTMLElement>('.tab');
  if (tab) selectAsset(tab.dataset.id!);
});

function selectAsset(id: string) {
  if (!state.tabs.includes(id)) state.tabs.push(id);
  state.assetId = id;
  const a = asset();
  ($('#assetIcon') as HTMLImageElement).src = iconUrl(a);
  $('#assetName').textContent = a.symbol;
  $('#watermark').textContent = a.symbol;
  const pct = $('#pct');
  if (pct.textContent !== '+' + pctOf(a)) {
    pct.textContent = '+' + pctOf(a);
    retrigger(pct, 'pop');
  }
  renderTabs();
  updateProfit();
  updateSentiment();
}

const picker = $('#picker');
const pickerList = $('#pickerList');
const pickerSearch = $<HTMLInputElement>('#pickerSearch');
function openPicker() {
  picker.classList.remove('hidden');
  pickerSearch.value = '';
  renderPicker();
  pickerSearch.focus();
}
function closePicker() {
  picker.classList.add('hidden');
}
function renderPicker() {
  const q = pickerSearch.value.trim().toLowerCase();
  const rows = ASSETS.filter((a) => !q || a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q));
  pickerList.innerHTML = rows.length
    ? rows
        .map(
          (a, i) => `<button class="p-row ${state.tabs.includes(a.id) ? 'open' : ''}" data-id="${a.id}" style="--i:${i}">
            <span class="p-asset"><img src="${iconUrl(a)}" alt=""><span>${a.symbol}<small>${a.name}</small></span></span>
            <span class="mono" data-pprice="${a.id}"></span>
            <span class="mono" data-pchg="${a.id}"></span>
            <span class="p-pay">${pctOf(a)}</span>
          </button>`,
        )
        .join('')
    : `<div class="empty">Nothing matches “${q}”.</div>`;
  updatePickerPrices();
}
function updatePickerPrices() {
  if (picker.classList.contains('hidden')) return;
  for (const a of ASSETS) {
    const p = feed.last.get(a.id);
    const pe = pickerList.querySelector(`[data-pprice="${a.id}"]`);
    if (pe && p !== undefined) pe.textContent = priceFmt(a, p);
    const ce = pickerList.querySelector<HTMLElement>(`[data-pchg="${a.id}"]`);
    const c = feed.change24.get(a.id);
    if (ce && c !== undefined) {
      ce.textContent = `${c >= 0 ? '+' : ''}${c.toFixed(2)}%`;
      ce.className = `mono ${c >= 0 ? 'p-pos' : 'p-neg'}`;
    }
  }
}
pickerSearch.addEventListener('input', renderPicker);
pickerList.addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.p-row');
  if (!row) return;
  selectAsset(row.dataset.id!);
  closePicker();
});
$('#pickerClose').addEventListener('click', closePicker);
picker.addEventListener('click', (e) => {
  if (e.target === picker) closePicker();
});

// ---------------------------------------------------------------------------
// Account menu, deposit, sound
// ---------------------------------------------------------------------------
const acctMenu = $('#acctMenu');
$('#acctBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#balance2').textContent = money(state.balance);
  const hidden = acctMenu.classList.toggle('hidden');
  $('#acct').classList.toggle('menu-open', !hidden);
});
$('#refill').addEventListener('click', () => {
  setBalance(START_BALANCE);
  acctMenu.classList.add('hidden');
});
$('#deposit').addEventListener('click', () =>
  toast('Deposits aren’t part of this MVP — practice money only', 'info'),
);
$('#mute').addEventListener('click', () => {
  const muted = sfx.toggle();
  $('#muteWave').style.display = muted ? 'none' : '';
});

// ---------------------------------------------------------------------------
// Amount
// ---------------------------------------------------------------------------
const stakeInput = $<HTMLInputElement>('#stake');
const stakeChips = $('#stakeChips');
stakeChips.innerHTML = STAKE_CHIPS.map((v) => `<button class="chip" data-v="${v}">${v >= 1000 ? v / 1000 + 'k' : v}</button>`).join('');
stakeChips.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.chip');
  if (b) setStake(Number(b.dataset.v));
});
document.querySelectorAll<HTMLElement>('[data-stake]').forEach((b) =>
  b.addEventListener('click', () => {
    const up = b.dataset.stake === '+';
    const next = up
      ? STAKE_STEPS.find((s) => s > state.stake) ?? state.stake
      : [...STAKE_STEPS].reverse().find((s) => s < state.stake) ?? state.stake;
    setStake(next);
  }),
);
stakeInput.addEventListener('input', () => {
  const v = Number(stakeInput.value.replace(/\D/g, ''));
  setStake(Math.min(100_000, Math.max(1, v || 1)), false);
});
stakeInput.addEventListener('blur', () => setStake(state.stake));

function setStake(v: number, writeInput = true) {
  state.stake = v;
  if (writeInput) stakeInput.value = String(v);
  stakeChips.querySelectorAll<HTMLElement>('.chip').forEach((c) =>
    c.classList.toggle('active', Number(c.dataset.v) === v),
  );
  glide(stakeChips);
  retrigger($('.stepper'), 'pop');
  updateProfit();
}
function updateProfit() {
  const el = $('#profitAmt');
  const next = '+' + money(state.stake * asset().payout);
  if (el.textContent !== next) {
    el.textContent = next;
    retrigger(el, 'pop');
  }
}

// ---------------------------------------------------------------------------
// Expiration
// ---------------------------------------------------------------------------
const expMenu = $('#expMenu');
$('#expBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const hidden = expMenu.classList.toggle('hidden');
  $('.box.exp').classList.toggle('menu-open', !hidden);
  if (hidden) return;
  renderExpMenu();
});
function renderExpMenu() {
  const now = Date.now();
  const e = state.exp;
  let html = '<div class="menu-sec">Turbo · whole minute</div>';
  for (let i = 0; i < TURBO_SLOTS; i++) {
    const t = turboExpiry(now, i);
    const active = e.kind === 'turbo' && e.idx === i;
    html += `<button class="menu-item opt ${active ? 'active' : ''}" data-turbo="${i}"><span class="mono">${hhmm(t)}</span><small>${i + 1} min</small></button>`;
  }
  html += '<div class="menu-sec">Blitz · seconds</div>';
  for (const s of BLITZ_SECS) {
    const active = e.kind === 'blitz' && e.sec === s;
    html += `<button class="menu-item opt ${active ? 'active' : ''}" data-blitz="${s}"><span class="mono">0:${pad(s)}</span><small>${s}s</small></button>`;
  }
  expMenu.innerHTML = html;
}
expMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  const b = (e.target as HTMLElement).closest<HTMLElement>('.menu-item');
  if (!b) return;
  state.exp = b.dataset.turbo !== undefined
    ? { kind: 'turbo', idx: Number(b.dataset.turbo) }
    : { kind: 'blitz', sec: Number(b.dataset.blitz) };
  expMenu.classList.add('hidden');
  $('.box.exp').classList.remove('menu-open');
  $('#modeTag').textContent = state.exp.kind === 'turbo' ? 'Turbo' : 'Blitz';
  renderTabs();
  updateExpiryLabel();
});
function updateExpiryLabel() {
  const r = resolveExpiry(Date.now());
  $('#expLabel').textContent = r.main;
  $('#expSub').textContent = r.sub;
}

document.addEventListener('click', () => {
  acctMenu.classList.add('hidden');
  expMenu.classList.add('hidden');
  $('#acct').classList.remove('menu-open');
  $('.box.exp').classList.remove('menu-open');
});

// ---------------------------------------------------------------------------
// Chart tools
// ---------------------------------------------------------------------------
const modeSeg = $('#modeSeg');
const candleSeg = $('#candleSeg');
candleSeg.innerHTML = CANDLE_SECS.map((s) => `<button data-cs="${s}">${s < 60 ? s + 's' : s / 60 + 'm'}</button>`).join('');
modeSeg.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]');
  if (b) setMode(b.dataset.mode as ChartMode);
});
candleSeg.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-cs]');
  if (!b) return;
  state.candleSec = Number(b.dataset.cs);
  setMode('candles');
});
function setMode(m: ChartMode) {
  state.mode = m;
  modeSeg.querySelectorAll<HTMLElement>('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  candleSeg.classList.toggle('hidden', m !== 'candles');
  candleSeg.querySelectorAll<HTMLElement>('button').forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.cs) === state.candleSec),
  );
  glide(modeSeg);
  if (m === 'candles') glide(candleSeg);
}

// Mouse wheel over the chart zooms the time axis; buttons in the toolbar too.
const ZOOM_MIN = 1;
const ZOOM_MAX = 8; // ~15 min of history at a 1-min expiry; more would show empty space
function setZoom(z: number) {
  state.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}
host.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    setZoom(state.zoom * (e.deltaY > 0 ? 1.18 : 1 / 1.18));
  },
  { passive: false },
);
$('#zoomIn').addEventListener('click', () => setZoom(state.zoom / 1.4));
$('#zoomOut').addEventListener('click', () => setZoom(state.zoom * 1.4));

// ---------------------------------------------------------------------------
// Sentiment bar
// ---------------------------------------------------------------------------
function updateSentiment() {
  const up = Math.round(feed.sentiment(state.assetId) * 100);
  $('#sUp').textContent = `${up}%`;
  $('#sDown').textContent = `${100 - up}%`;
  $('#sFill').style.height = `${up}%`;
}
window.setInterval(updateSentiment, 1000);

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------
const btnUp = $('#btnUp');
const btnDown = $('#btnDown');
for (const [btn, dir] of [[btnUp, 'up'], [btnDown, 'down']] as const) {
  btn.addEventListener('mouseenter', () => (state.hover = dir));
  btn.addEventListener('mouseleave', () => (state.hover = null));
  btn.addEventListener('click', () => place(dir));
}

window.addEventListener('keydown', (e) => {
  if (e.repeat || e.target instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'arrowup') { e.preventDefault(); place('up'); }
  if (k === 's' || k === 'arrowdown') { e.preventDefault(); place('down'); }
  if (k === 'escape') closePicker();
});

function place(dir: Dir) {
  const a = asset();
  const price = feed.last.get(a.id);
  const btn = dir === 'up' ? btnUp : btnDown;
  if (price === undefined) return;
  if (state.stake > state.balance) {
    retrigger(btn, 'shake');
    toast('Not enough practice balance', 'info');
    sfx.error();
    return;
  }
  const now = Date.now();
  const { expT } = resolveExpiry(now);
  state.trades.unshift({
    id: ++seq,
    assetId: a.id,
    dir,
    stake: state.stake,
    payout: a.payout,
    entry: price,
    openT: now,
    expT,
    status: 'open',
  });
  state.trades.length = Math.min(state.trades.length, 80);
  setBalance(state.balance - state.stake);
  retrigger(btn, 'fire');
  sfx.place(dir);
  renderDrawer();
  renderStrip();
}

function settle(t: Trade) {
  const close = feed.last.get(t.assetId)!;
  t.close = close;
  t.closedAt = Date.now();
  const diff = close - t.entry;
  if (diff === 0) {
    t.status = 'tie';
    setBalance(state.balance + t.stake);
    toast('TIE<small>STAKE REFUNDED</small>', 'tie');
    sfx.tie();
  } else if (diff > 0 === (t.dir === 'up')) {
    t.status = 'won';
    setBalance(state.balance + t.stake * (1 + t.payout));
    toast(`+${money(t.stake * t.payout)}<small>YOU WON</small>`, 'won');
    sfx.win();
  } else {
    t.status = 'lost';
    toast(`−${money(t.stake)}<small>BETTER LUCK NEXT TIME</small>`, 'lost');
    sfx.lose();
  }
  if (t.assetId === state.assetId) chart.burst(t.expT, close, t.status as 'won' | 'lost' | 'tie');
  if (t.status !== 'tie') {
    const flash = $('#flash');
    flash.className = 'flash';
    void flash.offsetWidth;
    flash.classList.add(t.status);
    if (t.status === 'lost') retrigger($('#chartWrap'), 'shake-x');
  }
  renderDrawer();
}

window.setInterval(() => {
  const now = Date.now();
  for (const t of state.trades) if (t.status === 'open' && now >= t.expT) settle(t);
}, 50);

// Early close. The price we offer follows how far the trade has run: a winning
// trade earns a growing share of its payout, a losing one refunds a shrinking
// share of the stake. Never more than the full payout, never less than 5%.
function sellValue(t: Trade, now: number) {
  const cur = feed.last.get(t.assetId) ?? t.entry;
  const winning = t.dir === 'up' ? cur > t.entry : cur < t.entry;
  const prog = Math.min(1, Math.max(0, (now - t.openT) / (t.expT - t.openT)));
  const v = winning ? t.stake * (1 + t.payout * (0.15 + 0.75 * prog)) : t.stake * (0.9 - 0.85 * prog);
  return Math.max(t.stake * 0.05, v);
}

function sell(t: Trade, quiet = false) {
  if (t.status !== 'open') return;
  const now = Date.now();
  const value = sellValue(t, now);
  t.status = 'sold';
  t.close = feed.last.get(t.assetId);
  t.closedAt = now;
  t.soldPnl = value - t.stake;
  setBalance(state.balance + value);
  if (!quiet) {
    const sign = t.soldPnl >= 0 ? '+' : '−';
    toast(`${sign}${money(Math.abs(t.soldPnl))}<small>SOLD EARLY</small>`, t.soldPnl >= 0 ? 'won' : 'lost');
    sfx.tie();
  }
  if (t.assetId === state.assetId) chart.burst(now, t.close ?? t.entry, 'sold');
  renderDrawer();
}

document.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-sell]');
  if (!b) return;
  const t = state.trades.find((x) => x.id === Number(b.dataset.sell));
  if (t) sell(t);
});

// ---------------------------------------------------------------------------
// Balance, toast
// ---------------------------------------------------------------------------
const balanceEl = $('#balance');
const acctEl = $('#acct');
let balShown = state.balance;
let balFrom = state.balance;
let balStart = 0;

function setBalance(v: number) {
  if (v > state.balance) retrigger(acctEl, 'bump-up');
  else if (v < state.balance) retrigger(acctEl, 'bump-down');
  balFrom = balShown;
  state.balance = v;
  balStart = performance.now();
}

function tickBalance() {
  if (balShown === state.balance) return;
  const k = Math.min(1, (performance.now() - balStart) / 650);
  const e = 1 - Math.pow(1 - k, 3);
  balShown = k === 1 ? state.balance : balFrom + (state.balance - balFrom) * e;
  balanceEl.textContent = money(balShown);
}

const toastEl = $('#toast');
function toast(html: string, kind: string) {
  toastEl.innerHTML = html;
  toastEl.className = 'toast';
  void toastEl.offsetWidth;
  toastEl.className = `toast show ${kind}`;
}

// ---------------------------------------------------------------------------
// Sidebar drawer: open trades / history
// ---------------------------------------------------------------------------
const drawer = $('#drawer');
const drawerList = $('#drawerList');
const statsEl = $('#stats');
document.querySelectorAll<HTMLElement>('[data-drawer]').forEach((b) =>
  b.addEventListener('click', () => {
    const which = b.dataset.drawer as 'open' | 'history';
    setDrawer(state.drawer === which ? null : which);
  }),
);
$('#drawerClose').addEventListener('click', () => setDrawer(null));

function setDrawer(which: typeof state.drawer) {
  state.drawer = which;
  drawer.classList.toggle('open', which !== null);
  document.querySelectorAll<HTMLElement>('[data-drawer]').forEach((b) =>
    b.classList.toggle('active', b.dataset.drawer === which),
  );
  if (which) {
    $('#drawerTitle').textContent = which === 'open' ? 'Open trades' : 'Trade history';
    drawerList.innerHTML = '';
    cards.clear();
    renderDrawer();
  }
}

// One card element per trade, updated in place, so the entry animation only
// plays once when the card first appears.
const cards = new Map<number, HTMLElement>();
function renderDrawer() {
  const open = state.trades.filter((t) => t.status === 'open');
  const countEl = $('#openCount');
  countEl.textContent = String(open.length);
  countEl.classList.toggle('hidden', open.length === 0);

  const closed = state.trades.filter((t) => t.status !== 'open');
  const wins = closed.filter((t) => t.status === 'won').length;
  const losses = closed.filter((t) => t.status === 'lost').length;
  const net = closed.reduce(
    (s, t) =>
      s + (t.status === 'won' ? t.stake * t.payout : t.status === 'lost' ? -t.stake : t.status === 'sold' ? (t.soldPnl ?? 0) : 0),
    0,
  );
  statsEl.innerHTML = `<span>Won <b>${wins}</b></span><span>Lost <b>${losses}</b></span>
    <span>P&amp;L <b class="${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : '−'}${money(Math.abs(net))}</b></span>`;

  if (!state.drawer) return;
  const list = state.drawer === 'open' ? open : closed;
  const now = Date.now();
  const live = new Set(list.map((t) => t.id));
  for (const [id, el] of cards) {
    if (!live.has(id)) {
      el.remove();
      cards.delete(id);
    }
  }
  drawerList.querySelector('.empty')?.remove();
  if (!list.length) {
    drawerList.innerHTML =
      state.drawer === 'open'
        ? `<div class="empty">No open trades.<br>Hit <b>Higher</b> or <b>Lower</b> — or press W / S.</div>`
        : `<div class="empty">No finished trades yet.</div>`;
    return;
  }
  // Oldest first, prepending new ones, so the newest card ends up on top.
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i];
    let el = cards.get(t.id);
    if (!el) {
      el = document.createElement('div');
      cards.set(t.id, el);
      drawerList.prepend(el);
    }
    const { cls, inner } = cardHtml(t, now);
    if (el.dataset.html !== inner) {
      el.innerHTML = inner;
      el.dataset.html = inner;
    }
    el.className = `tcard ${cls}`;
  }
}

function cardHtml(t: Trade, now: number) {
  const a = assetById(t.assetId);
  const cur = t.close ?? feed.last.get(t.assetId) ?? t.entry;
  const winning = t.dir === 'up' ? cur > t.entry : cur < t.entry;
  let cls: string = t.status;
  let right: string;
  let pnl: string;
  let sellBtn = '';
  if (t.status === 'open') {
    cls += winning ? ' winning' : ' losing';
    right = dur(Math.max(0, Math.ceil((t.expT - now) / 1000)));
    pnl = winning
      ? `<span class="pnl pos dim">+${money(t.stake * t.payout)}</span>`
      : `<span class="pnl neg dim">−${money(t.stake)}</span>`;
    sellBtn = `<button class="sell" data-sell="${t.id}">Sell for ${money(sellValue(t, now))}</button>`;
  } else {
    right = `${t.status.toUpperCase()} · ${hhmm(t.closedAt ?? t.expT)}`;
    const sp = t.soldPnl ?? 0;
    pnl =
      t.status === 'won' ? `<span class="pnl pos">+${money(t.stake * t.payout)}</span>`
      : t.status === 'lost' ? `<span class="pnl neg">−${money(t.stake)}</span>`
      : t.status === 'sold' ? `<span class="pnl ${sp >= 0 ? 'pos' : 'neg'}">${sp >= 0 ? '+' : '−'}${money(Math.abs(sp))}</span>`
      : `<span class="pnl">${money(0)}</span>`;
  }
  const inner = `<span class="sym"><img src="${iconUrl(a)}" alt="">${a.symbol}</span><span class="sub mono">${right}</span>
    <span class="dir ${t.dir}">${t.dir === 'up' ? '▲ Higher' : '▼ Lower'} · $${t.stake}</span>${pnl}
    <span class="sub mono" style="grid-column: span 2">${priceFmt(a, t.entry)} → ${priceFmt(a, cur)}</span>${sellBtn}`;
  return { cls, inner };
}

// Summary bar across the top of the chart for open trades on the current
// asset: nearest expiry, total invested, expected result, result if sold now,
// and Sell All with a dropdown listing each position.
const stripEl = $('#positions');
let posOpen = false;
const signed = (v: number) => `${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`;
const cls = (v: number) => (v >= 0 ? 'p-pos' : 'p-neg');
function renderStrip() {
  const now = Date.now();
  const open = state.trades.filter((t) => t.status === 'open' && t.assetId === state.assetId);
  stripEl.classList.toggle('hidden', open.length === 0);
  $('#chartWrap').classList.toggle('has-positions', open.length > 0);
  if (!open.length) {
    posOpen = false;
    return;
  }
  const cur = feed.last.get(state.assetId) ?? 0;
  const isWin = (t: Trade) => (t.dir === 'up' ? cur > t.entry : cur < t.entry);
  const total = open.reduce((s, t) => s + t.stake, 0);
  const expected = open.reduce((s, t) => s + (isWin(t) ? t.stake * t.payout : -t.stake), 0);
  const afterSell = open.reduce((s, t) => s + sellValue(t, now) - t.stake, 0);
  const nearest = Math.min(...open.map((t) => t.expT));
  const rows = open
    .map(
      (t) => `<div class="pos-row ${isWin(t) ? 'winning' : 'losing'}">
        <span class="dir ${t.dir}">${t.dir === 'up' ? '▲ Higher' : '▼ Lower'}</span>
        <span class="mono">$${t.stake}</span>
        <span class="mono sub">${dur(Math.max(0, Math.ceil((t.expT - now) / 1000)))}</span>
        <span class="mono ${isWin(t) ? 'p-pos' : 'p-neg'}">${isWin(t) ? '+' + money(t.stake * t.payout) : '−' + money(t.stake)}</span>
        <button class="sell" data-sell="${t.id}">Sell ${money(sellValue(t, now))}</button>
      </div>`,
    )
    .join('');
  stripEl.innerHTML = `
    <div class="stat"><b class="mono">⏱ ${dur(Math.max(0, Math.ceil((nearest - now) / 1000)))}</b><small>Purchase time</small></div>
    <div class="stat"><b class="mono">${money(total)}</b><small>Total investment</small></div>
    <div class="stat"><b class="mono ${cls(expected)}">${signed(expected)}</b><small>Expected profit</small></div>
    <div class="stat"><b class="mono ${cls(afterSell)}">${signed(afterSell)}</b><small>Profit after sell (P/L)</small></div>
    <div class="sell-all">
      <button class="sell primary" data-sell-all>Sell All (${open.length})</button>
      <button class="sell caret ${posOpen ? 'on' : ''}" data-pos-toggle aria-label="Show positions">▾</button>
    </div>
    <div class="pos-list ${posOpen ? '' : 'hidden'}">${rows}</div>`;
}
stripEl.addEventListener('click', (e) => {
  const el = e.target as HTMLElement;
  if (el.closest('[data-pos-toggle]')) {
    posOpen = !posOpen;
    renderStrip();
  } else if (el.closest('[data-sell-all]')) {
    for (const t of state.trades) if (t.status === 'open' && t.assetId === state.assetId) sell(t, true);
    toast('All positions sold', 'info');
    renderStrip();
  }
});

// Countdowns, expiry label, picker prices — 4x a second.
window.setInterval(() => {
  updateExpiryLabel();
  updatePickerPrices();
  renderStrip();
  if (state.trades.some((t) => t.status === 'open')) renderDrawer();
}, 250);

// ---------------------------------------------------------------------------
// Render loop + FPS meter
// ---------------------------------------------------------------------------
const fpsEl = $('#fps');
let frames = 0;
let fpsT = performance.now();
let worst = 0;

app.ticker.add((ticker) => {
  const dt = Math.min(ticker.deltaMS / 1000, 0.1);
  const a = asset();
  const now = Date.now();
  const { expT, deadlineT } = resolveExpiry(now);
  chart.render(
    {
      key: a.id,
      decimals: a.decimals,
      points: feed.history.get(a.id)!,
      price: feed.last.get(a.id)!,
      now,
      expT,
      deadlineT,
      hover: state.hover,
      trades: state.trades.filter((t) => t.assetId === a.id),
      mode: state.mode,
      candleSec: state.candleSec,
      zoom: state.zoom,
    },
    dt,
  );
  tickBalance();

  frames++;
  worst = Math.max(worst, ticker.deltaMS);
  const t = performance.now();
  if (t - fpsT >= 500) {
    const fps = (frames * 1000) / (t - fpsT);
    fpsEl.textContent = `${Math.round(fps)} FPS`;
    fpsEl.title = `Worst frame in the last half second: ${worst.toFixed(0)}ms`;
    fpsEl.className = `fps ${fps >= 50 ? '' : fps >= 30 ? 'warn' : 'bad'}`;
    frames = 0;
    worst = 0;
    fpsT = t;
  }
});

installRipples('.trade, .chip, .seg button, .side-btn, .tab, .tab-add, .deposit, .icon-btn, .menu-item, .p-row, .exp-btn');
window.addEventListener('resize', () => {
  glide(stakeChips);
  glide(modeSeg);
  if (state.mode === 'candles') glide(candleSeg);
});
selectAsset(state.assetId);
setStake(state.stake);
setMode(state.mode);
updateExpiryLabel();
renderDrawer();
