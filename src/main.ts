import './style.css';
import { computeCosts, STATUTORY, type BrokerRates, type CostBreakdown } from './calc';

type BrokerKey = 'kotak' | 'rupeezy';

interface Cell {
  lev: number;
  ownPct?: number | null;
  maxExposureCr?: number | null;
}

interface Stock {
  symbol: string;
  name: string;
  type: 'equity' | 'etf';
  kotak: Cell | null;
  rupeezy: Cell | null;
  best: BrokerKey[];
  bestLev: number | null;
  change: Record<BrokerKey, number>;
  stub?: boolean; // pinned, but on no broker's MTF list today
}

interface BrokerMeta {
  fetchedAt: string | null;
  count: number;
  matched?: number;
  status: 'ok' | 'stale' | 'failed';
  error: string | null;
}

interface SurvFlag {
  ex: string[]; // 'NSE', 'BSE'
  list: 'ASM' | 'GSM' | 'ESM';
  term: 'short' | 'long' | null;
  stage: string;
  since: string | null; // YYYY-MM-DD
  exact: boolean; // false: first day this site saw it, not the exchange's date
  desc: string;
}

interface CoEvent {
  date: string; // YYYY-MM-DD: meeting date, or ex-date for a corporate action
  kind: 'meeting' | 'action' | 'news' | 'broker' | 'result';
  level?: 'alert' | 'watch' | 'info'; // news and broker-list changes only
  title: string; // 'Results', 'Results · Dividend', 'Ex-dividend', 'Split', ...
  detail: string;
  link: string; // filing on NSE, or the stock's NSE page
}

interface EventsFile {
  ban: { date: string | null; symbols: string[] } | null;
  bands?: Record<string, { band: number | null; series: string }>;
  events: Record<string, CoEvent[]>;
}

interface PriceInfo {
  p: number;
  prev: number | null;
  chg: number | null;
  dayHi: number | null;
  dayLo: number | null;
  hi52: number | null;
  lo52: number | null;
  vol: number | null;
  avgVol: number | null;
  date: string;
  t: number; // unix seconds of the last trade
  closes: [string, number][];
}

interface Deal {
  date: string;
  kind: 'bulk' | 'block';
  client: string;
  side: string;
  qty: number | null;
  price: number | null;
}

interface MarketFile {
  prices: Record<string, PriceInfo>; // pinned stocks only
  var: { date: string | null; rows: Record<string, { m: number | null; adhoc: number | null }> };
  mwpl: { date: string | null; rows: Record<string, { pct: number | null; ban: boolean }> };
  deliv: Record<string, { d: number | null; avg: number | null; date: string }>;
  pledge: Record<string, { pct: number; promoter: number | null; asOf: string | null }>;
  deals: Record<string, Deal[]>;
}

interface WatchAlert {
  at: string; // refresh time (UTC ISO)
  symbol: string;
  name: string;
  level: 'alert' | 'watch' | 'info' | 'good';
  text: string;
  link: string | null;
}

interface SurvSource {
  status: 'ok' | 'stale' | 'failed';
  count?: number;
  fetchedAt?: string | null;
  error?: string | null;
}

interface Meta {
  generatedAt: string;
  brokers: Record<BrokerKey, BrokerMeta>;
  surveillance?: { fetchedAt: string | null; sources: Record<string, SurvSource> };
  events?: { fetchedAt: string | null; sources: Record<string, SurvSource> };
  market?: { fetchedAt: string | null; sources: Record<string, SurvSource> };
  total: number;
  unmatched: number;
}

interface History {
  brokers: BrokerKey[];
  dates: string[];
  rows: Record<string, ((number | null)[] | null)[]>;
}

interface Unmatched {
  broker: BrokerKey;
  name: string;
  symbol: string | null;
  isin: string | null;
  lev: number;
}

const BROKERS: BrokerKey[] = ['kotak', 'rupeezy'];
const BROKER_NAME: Record<BrokerKey, string> = { kotak: 'Kotak Neo', rupeezy: 'Rupeezy' };
const BROKER_SHORT: Record<BrokerKey, string> = { kotak: 'Kotak', rupeezy: 'Rupeezy' };
const SOURCES: Record<BrokerKey, string> = {
  kotak: 'https://www.kotakneo.com/margin-requirement/margin-trading/1/',
  rupeezy: 'https://rupeezy.in/margin-trading-facility/mtf-stock-lists',
};
// Generic starter pins for a new device. Personal lists live only in the browser (or a ?pins= link).
const DEFAULT_PINS = ['RELIANCE', 'HDFCBANK', 'ICICIBANK', 'BHARTIARTL', 'INFY', 'TCS', 'NIFTYBEES'];
// Common names that don't resolve from the company name alone.
const ALIASES: Record<string, string> = {
  AIRTEL: 'BHARTIARTL', 'BHARTI AIRTEL': 'BHARTIARTL', ZOMATO: 'ETERNAL', POLICYBAZAAR: 'POLICYBZR',
  'HITACHI POWER': 'POWERINDIA', 'HITACHI ENERGY': 'POWERINDIA', 'GE VERNOVA': 'GVT&D', TDPS: 'TDPOWERSYS',
  'JUBILANT LIFE SCIENCES': 'JUBLPHARMA', 'JIO FINANCIAL': 'JIOFIN', 'TUBE INVESTMENTS': 'TIINDIA',
  CUMMINS: 'CUMMINSIND', WOCKHARDT: 'WOCKPHARMA', 'TRANSFORMERS AND RECTIFIERS': 'TARIL',
};
const PIN_KEY = 'mtf.pins';
const PASS_KEY = 'mtf.passcode';
const GH_TOKEN_KEY = 'mtf.ghToken';
// Set at build time for GitHub Pages, where there is no /api/refresh: the button calls GitHub directly.
const REFRESH_MODE = import.meta.env.VITE_REFRESH_MODE === 'github' ? 'github' : 'api';
const GH_REPO = import.meta.env.VITE_GITHUB_REPO as string | undefined;
const GH_REF = (import.meta.env.VITE_GITHUB_REF as string | undefined) || 'main';
const REFRESH_KEY = 'mtf.lastRefresh';
const PAGE = 100;
const COOLDOWN_MS = 60 * 1000; // only stops double taps; a running refresh blocks on its own
const POLL_MS = 15 * 1000;
const POLL_MAX_MS = 6 * 60 * 1000;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const state = {
  stocks: [] as Stock[],
  bySymbol: new Map<string, Stock>(),
  meta: null as Meta | null,
  history: null as History | null,
  unmatched: null as Unmatched[] | null,
  pins: [] as string[],
  // The tab you were on survives a refresh or hard reload.
  view: ((v) => (v === 'all' || v === 'positions' ? v : 'pinned'))(store<string>('mtf.view')) as 'pinned' | 'all' | 'positions',
  sort: 'az' as 'az' | 'lev' | 'gap',
  filter: null as BrokerKey | null,
  solo: false, // only stocks where one broker is best on its own
  results: false, // only stocks with results still to come, nearest first
  type: 'equity' as 'equity' | 'etf', // search and the All list show one kind at a time; stocks by default
  query: '',
  limit: PAGE,
  refreshing: false,
  symbols: null as Map<string, string> | null, // every NSE symbol → name, loaded on demand
  surv: {} as Record<string, SurvFlag[]>, // NSE/BSE ASM and GSM flags by symbol
  sheetSym: null as string | null, // stock open in the detail sheet
  alerts: [] as WatchAlert[], // changes to pinned stocks, newest last
  market: null as MarketFile | null, // prices (pins), exchange margin, F&O OI, delivery, pledges, deals
  events: {} as Record<string, CoEvent[]>, // company events from 3 days ago onwards
  ban: null as { date: string; symbols: Set<string> } | null, // NSE F&O ban list
  bands: {} as Record<string, { band: number | null; series: string }>, // tight circuits and T2T series
};

async function loadSymbols(): Promise<Map<string, string>> {
  if (!state.symbols) {
    const list = await getJSON<[string, string][]>('data/symbols.json').catch(() => []);
    state.symbols = new Map(list.map(([s, n]) => [s, titleCase(n)]));
  }
  return state.symbols;
}

function stubStock(sym: string): Stock {
  return {
    symbol: sym, name: state.symbols?.get(sym) ?? '', type: 'equity', kotak: null, rupeezy: null,
    best: [], bestLev: null, change: { kotak: 0, rupeezy: 0 }, stub: true,
  };
}

/* ---------- storage ---------- */

function store<T>(key: string, value?: T): T | null {
  try {
    if (value === undefined) {
      const raw = localStorage.getItem(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    }
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or blocked storage: pins live for this session only */
  }
  return value ?? null;
}

function savePins() {
  store(PIN_KEY, state.pins);
  store(DIRTY_KEY, true);
  scheduleSync();
}

/* ---------- pin sync ----------
   The watchlist lives in data/pins.json in the repo, so every device sees the same list.
   Anyone can read it; saving needs the GitHub token (Contents: read and write) kept in this browser.
   Edits are kept locally first and marked dirty; a push that loses a race re-applies this
   device's adds and removes on top of the newer list instead of overwriting it. */

const PINS_FILE = 'data/pins.json';
const DIRTY_KEY = 'mtf.pinsDirty';
const BASE_KEY = 'mtf.pinsBase';
const SYNC_ON = !!GH_REPO;

type SyncStatus = 'off' | 'syncing' | 'synced' | 'local' | 'error';
const sync = { status: 'off' as SyncStatus, sha: null as string | null, at: 0, timer: 0, busy: false };

const pinsUrl = () => `https://api.github.com/repos/${GH_REPO}/contents/${PINS_FILE}`;

function ghHeaders(): Record<string, string> {
  const token = store<string>(GH_TOKEN_KEY);
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

const b64decode = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
const b64encode = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

async function fetchRemotePins(): Promise<{ pins: string[]; sha: string | null } | null> {
  try {
    const r = await fetch(`${pinsUrl()}?ref=${encodeURIComponent(GH_REF)}`, { headers: ghHeaders(), cache: 'no-store' });
    if (r.status === 404) return { pins: [], sha: null };
    if (r.ok) {
      const body = await r.json();
      return { pins: (JSON.parse(b64decode(body.content)).pins as string[]) ?? [], sha: body.sha };
    }
  } catch {
    /* fall through to the CDN copy */
  }
  // Unauthenticated API calls are rate limited; the raw file still gives a read-only view.
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${GH_REPO}/${GH_REF}/${PINS_FILE}?t=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) return { pins: (await r.json()).pins ?? [], sha: null };
  } catch {
    /* offline */
  }
  return null;
}

// Re-apply this device's unsynced adds and removes (relative to the last list it saw) onto `remote`.
function rebasePins(remote: string[]): string[] {
  // Without a list this device has seen before, nothing counts as removed: only additions apply.
  const base = new Set(store<string[]>(BASE_KEY) ?? []);
  const local = new Set(state.pins);
  const removed = new Set([...base].filter((p) => !local.has(p)));
  const added = state.pins.filter((p) => !base.has(p));
  return [...new Set([...remote.filter((p) => !removed.has(p)), ...added])];
}

async function pullPins(): Promise<void> {
  if (!SYNC_ON) return;
  const remote = await fetchRemotePins();
  if (!remote) return setSync(store(DIRTY_KEY) ? 'local' : 'error');
  if (remote.sha) sync.sha = remote.sha;
  if (store<boolean>(DIRTY_KEY)) {
    state.pins = rebasePins(remote.pins);
    store(PIN_KEY, state.pins);
    store(BASE_KEY, remote.pins);
    ensureHeldPinned();
    render();
    return void pushPins();
  }
  state.pins = remote.pins;
  store(PIN_KEY, state.pins);
  store(BASE_KEY, remote.pins);
  sync.at = Date.now();
  setSync('synced');
  ensureHeldPinned(); // another device's list can't drop a stock you hold here
  render();
}

// Every stock in Positions stays on the watchlist (prices and alerts are only fetched for pins).
function ensureHeldPinned(): boolean {
  const missing = [...new Set(loadPositions().map((p) => p.sym))].filter((sym) => !state.pins.includes(sym));
  if (!missing.length) return false;
  state.pins.push(...missing);
  savePins();
  return true;
}

function scheduleSync() {
  if (!SYNC_ON) return;
  clearTimeout(sync.timer);
  sync.timer = window.setTimeout(pushPins, 1200);
}

async function pushPins(retry = true): Promise<void> {
  if (!SYNC_ON || sync.busy) return;
  if (!store<string>(GH_TOKEN_KEY)) return setSync('local');
  sync.busy = true;
  setSync('syncing');
  try {
    if (!sync.sha) {
      const remote = await fetchRemotePins();
      if (remote?.sha) sync.sha = remote.sha;
      if (remote) state.pins = rebasePins(remote.pins);
    }
    const pins = state.pins.slice();
    const content = b64encode(`${JSON.stringify({ pins }, null, 1)}\n`);
    const r = await fetch(pinsUrl(), {
      method: 'PUT',
      headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `pins: ${pins.length} stocks`,
        content,
        branch: GH_REF,
        ...(sync.sha ? { sha: sync.sha } : {}),
        committer: { name: 'mtf-bot', email: 'mtf-bot@users.noreply.github.com' },
      }),
    });
    if ((r.status === 409 || r.status === 422) && retry) {
      // Another device saved first: take its list, re-apply ours, try once more.
      sync.sha = null;
      sync.busy = false;
      return pushPins(false);
    }
    if (r.status === 401 || r.status === 403) {
      setSync('local');
      toast('Your GitHub token can’t save pins. Add “Contents: Read and write” to it.');
      return;
    }
    if (!r.ok) throw new Error(String(r.status));
    sync.sha = (await r.json()).content?.sha ?? null;
    store(BASE_KEY, pins);
    // Only clear dirty if nothing changed while the save was in flight.
    if (pins.join() === state.pins.join()) store(DIRTY_KEY, false);
    else scheduleSync();
    sync.at = Date.now();
    setSync('synced');
    render();
  } catch {
    setSync('error');
  } finally {
    sync.busy = false;
  }
}

function setSync(status: SyncStatus) {
  sync.status = status;
  const el = document.getElementById('sync');
  if (el) el.outerHTML = syncHTML();
}

function syncHTML(): string {
  if (!SYNC_ON) return '<p class="muted small" id="sync">Pins are saved in this browser.</p>';
  const msg: Record<SyncStatus, string> = {
    off: 'Loading pins…',
    syncing: 'Saving…',
    synced: 'Synced across your devices',
    local: 'Saved on this device only.',
    error: 'Couldn’t reach GitHub. Changes are kept here and will sync later.',
  };
  const action = sync.status === 'local' ? ' <button class="link-btn" data-connect>Connect GitHub to sync</button>' : '';
  return `<p class="sync ${sync.status}" id="sync"><span class="dot ${sync.status === 'synced' ? 'ok' : sync.status === 'syncing' || sync.status === 'off' ? '' : 'stale'}"></span>${msg[sync.status]}${action}</p>`;
}

function connectGitHub() {
  const token = prompt(
    'GitHub token (fine-grained, this repo only, with Actions and Contents: Read and write). It is saved only in this browser.',
  )?.trim();
  if (!token) return;
  store(GH_TOKEN_KEY, token);
  store(DIRTY_KEY, true);
  pullPins();
}

function togglePin(sym: string) {
  const i = state.pins.indexOf(sym);
  if (i >= 0 && loadPositions().some((p) => p.sym === sym)) {
    toast(`${sym} is in your positions, so it stays on the watchlist`);
    return;
  }
  if (i >= 0) state.pins.splice(i, 1);
  else state.pins.push(sym);
  savePins();
  render();
}

/* ---------- formatting ---------- */

// Links from scraped data only ever open http(s) pages: a javascript: or data: URL becomes inert.
const safeUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u.trim()) ? u.trim() : '#');
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Multipliers are shown, and compared for "best", to one decimal: 4.23 → 4.2, 5.89 → 5.9.
const round1 = (n: number) => Math.round((n + Number.EPSILON) * 10) / 10;
const fmtLev = (n: number) => `${round1(n)}×`;
const TIE_GAP = 0.2;
const fmtNum = (n: number) => n.toLocaleString('en-IN');
const isFunded = (c: Cell | null): c is Cell => !!c && c.lev > 1;

function fmtTime(iso: string | null, withDay = true): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();
  const today = new Date();
  if (!withDay || d.toDateString() === today.toDateString()) return time;
  const yest = new Date(today);
  yest.setDate(today.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `yesterday ${time}`;
  return `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, ${time}`;
}

function fmtAge(iso: string | null): string {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const titleCase = (s: string) =>
  /[a-z]/.test(s) ? s : s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

/* ---------- data ---------- */

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(import.meta.env.BASE_URL + path.replace(/^\//, ''), { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

async function loadData() {
  const [stocks, meta] = await Promise.all([getJSON<Stock[]>('/data/mtf.json'), getJSON<Meta>('/data/meta.json')]);
  setData(stocks, meta);
  loadExtras();
}

// Alerts, events and surveillance load after the main table; the page works without them.
function loadExtras() {
  getJSON<MarketFile>('data/market.json')
    .then((m) => {
      state.market = m;
      migrateLotCash();
      reconcileFromBrokers();
      render();
      if ($<HTMLDialogElement>('#sheet').open && state.sheetSym) openSheet(state.sheetSym);
    })
    .catch(() => {});
  // Watchlist change alerts drive the bell.
  getJSON<WatchAlert[]>('data/alerts.json')
    .then((a) => {
      state.alerts = a;
      renderBell();
    })
    .catch(() => {});
  // Events and the F&O ban list are extra too.
  getJSON<EventsFile>('data/events.json')
    .then((ev) => {
      state.events = ev.events ?? {};
      state.ban = ev.ban?.date ? { date: ev.ban.date, symbols: new Set(ev.ban.symbols) } : null;
      state.bands = ev.bands ?? {};
      render();
    })
    .catch(() => {});
  // Surveillance flags are extra: the page works without them.
  getJSON<Record<string, SurvFlag[]>>('data/surveillance.json')
    .then((surv) => {
      state.surv = surv;
      render();
    })
    .catch(() => {});
}

/* ---------- surveillance flags ---------- */

const survLabel = (f: SurvFlag) =>
  f.list === 'ASM' ? `${f.term === 'short' ? 'ST' : 'LT'}-ASM ${f.stage}` : `${f.list} ${f.stage}`;
const survName = (f: SurvFlag) =>
  f.list === 'GSM' ? 'Graded surveillance (GSM)' : f.list === 'ESM' ? 'Enhanced surveillance (ESM)' : `${f.term === 'short' ? 'Short-term' : 'Long-term'} ASM`;
// Stage I / 0 is the mildest step; anything later is drawn in red.
const survSevere = (f: SurvFlag) => !['I', '0'].includes(f.stage);

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function survSince(f: SurvFlag): string {
  return f.exact ? `added ${fmtDate(f.since)}` : `on list since at least ${fmtDate(f.since)}`;
}

const BAN_LINK = 'https://nsearchives.nseindia.com/content/fo/fo_secban.csv';
const EVENT_LOOKBACK_DAYS = 3;

function localISO(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgoISO(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localISO(d);
}

// Events from 3 days ago onwards, soonest first (the file can be a few hours old, so filter here too).
function stockEvents(sym: string): CoEvent[] {
  const from = daysAgoISO(EVENT_LOOKBACK_DAYS);
  return (state.events[sym] ?? []).filter((e) => e.date >= from).sort((a, b) => a.date.localeCompare(b.date));
}

// The ban list is for one trade date; show it while that date is recent.
function inBan(sym: string): boolean {
  return !!state.ban && state.ban.date >= daysAgoISO(EVENT_LOOKBACK_DAYS) && state.ban.symbols.has(sym);
}

const shortDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

// Next board meeting that will consider results (today or later).
function nextResult(sym: string): CoEvent | undefined {
  const today = localISO();
  return stockEvents(sym).find((e) => e.kind === 'meeting' && e.title.includes('Results') && e.date >= today);
}

function eventFlagsHTML(sym: string): string {
  const out: string[] = [];
  if (inBan(sym)) out.push(`<span class="flag severe" title="In NSE F&amp;O ban for ${fmtDate(state.ban!.date)}">F&amp;O ban</span>`);
  const all = stockEvents(sym);
  // Most serious flagged news or broker-list change first, then the next scheduled event.
  for (const level of ['alert', 'watch'] as const) {
    const hits = all.filter((e) => e.level === level);
    if (hits.length) {
      const more = hits.length > 1 ? ` +${hits.length - 1}` : '';
      const tip = hits.map((e) => `${fmtDate(e.date)}: ${e.title}`).join('\n');
      out.push(`<span class="flag${level === 'alert' ? ' severe' : ''}" title="${esc(tip)}">${esc(hits[0].title)}${more}</span>`);
      break;
    }
  }
  const band = state.bands[sym];
  if (band?.series === 'BE' || band?.series === 'BZ') {
    out.push(`<span class="flag${band.series === 'BZ' ? ' severe' : ''}" title="Trade-to-trade segment (${band.series}): every trade settles by delivery">T2T</span>`);
  }
  if (band?.band && band.band <= 5) {
    out.push(`<span class="flag${band.band <= 2 ? ' severe' : ''}" title="Price band ${band.band}%: the stock can move at most ${band.band}% in a day">${band.band}% band</span>`);
  }
  const evs = all.filter((e) => e.kind === 'meeting' || e.kind === 'action' || e.kind === 'result');
  if (evs.length) {
    const today = localISO();
    const next = evs.find((e) => e.date >= today) ?? evs[evs.length - 1];
    const past = next.date < today;
    const more = evs.length > 1 ? ` +${evs.length - 1}` : '';
    const title = evs.map((e) => `${fmtDate(e.date)}: ${e.title}`).join('\n');
    out.push(`<span class="flag event${past ? ' past' : ''}" title="${esc(title)}">${esc(next.title.split(' · ')[0])} ${shortDate(next.date)}${more}</span>`);
  }
  return out.join('');
}

function marketFlagsHTML(sym: string): string {
  const m = state.market;
  if (!m) return '';
  const out: string[] = [];
  const px = m.prices[sym];
  const band = state.bands[sym]?.band;
  if (px?.chg != null && Math.abs(px.chg) >= 5) {
    out.push(`<span class="flag${px.chg < 0 ? ' severe' : ' good'}" title="Change today">${px.chg < 0 ? '▼' : '▲'}${Math.abs(px.chg).toFixed(1)}%</span>`);
  }
  if (px && px.prev && band) {
    if (px.p <= px.prev * (1 - band / 100) * 1.01) out.push('<span class="flag severe" title="At or near the lower circuit: selling may not fill">Lower circuit</span>');
    else if (px.p >= px.prev * (1 + band / 100) * 0.99) out.push('<span class="flag good" title="At or near the upper circuit">Upper circuit</span>');
  }
  if (px?.lo52 && px.p <= px.lo52 * 1.005) out.push('<span class="flag" title="At a 52-week low">52w low</span>');
  else if (px?.hi52 && px.p >= px.hi52 * 0.995) out.push('<span class="flag good" title="At a 52-week high">52w high</span>');
  const oi = m.mwpl.rows[sym];
  if (oi?.pct != null && oi.pct >= 80 && !inBan(sym)) {
    out.push(`<span class="flag${oi.pct >= 90 ? ' severe' : ''}" title="F&amp;O open interest as % of the market-wide limit; ban at 95%">OI ${oi.pct.toFixed(0)}%</span>`);
  }
  const vm = m.var.rows[sym]?.m;
  if (vm != null && vm >= 40) out.push(`<span class="flag${vm >= 60 ? ' severe' : ''}" title="Exchange margin (VaR + ELM + ad hoc); brokers fund at most about 100 ÷ this">Margin ${vm.toFixed(0)}%</span>`);
  if (px?.vol && px.avgVol && px.vol >= 3 * px.avgVol) out.push(`<span class="flag event" title="Volume vs 20-day average">Vol ${(px.vol / px.avgVol).toFixed(1)}×</span>`);
  return out.join('');
}

const PILL_RANK = (html: string) =>
  html.includes('severe') ? 0 : html.includes(' past') ? 4 : html.includes(' good') ? 3 : html.includes(' event') ? 2 : 1;

// Every flag for a stock, most serious first. Rows show the first `max` and a quiet "+N".
function flagsHTML(sym: string, max = Infinity): string {
  const all = (eventFlagsHTML(sym) + marketFlagsHTML(sym) + (state.surv[sym] ?? [])
    .map((f) => {
      const title = `${f.ex.join(' + ')} · ${survName(f)} · Stage ${f.stage} · ${survSince(f)}`;
      return `<span class="flag${survSevere(f) ? ' severe' : ''}" title="${esc(title)}">${esc(survLabel(f))}</span>`;
    })
    .join(''))
    .match(/<span class="flag[^"]*"[^>]*>.*?<\/span>/g) ?? [];
  const sorted = all.map((h, i) => [PILL_RANK(h), i, h] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
  if (sorted.length <= max) return sorted.join('');
  return sorted.slice(0, max).join('') + `<span class="flag more" title="Open the stock for all ${sorted.length} flags">+${sorted.length - max}</span>`;
}

function setData(stocks: Stock[], meta: Meta) {
  for (const s of stocks) {
    s.name = titleCase(s.name);
    // Every broker within TIE_GAP of the top (at display precision) counts as best, so a
    // broker only "wins" when it beats the others by more than that.
    const levs = BROKERS.filter((b) => isFunded(s[b])).map((b) => round1(s[b]!.lev));
    s.bestLev = levs.length ? Math.max(...levs) : null;
    s.best = BROKERS.filter((b) => isFunded(s[b]) && s.bestLev! - round1(s[b]!.lev) <= TIE_GAP + 1e-9);
  }
  state.stocks = stocks;
  state.bySymbol = new Map(stocks.map((s) => [s.symbol, s]));
  state.meta = meta;
  state.history = null;
  state.unmatched = null;
}

/* ---------- search & sort ---------- */

function search(q: string, type = state.type): Stock[] {
  const query = q.trim().toUpperCase();
  if (!query) return [];
  const words = query.split(/\s+/);
  const scored: [number, Stock][] = [];
  for (const s of state.stocks) {
    if (s.type !== type) continue;
    const name = s.name.toUpperCase();
    let score = -1;
    if (s.symbol === query) score = 100;
    else if (s.symbol.startsWith(query)) score = 80 - (s.symbol.length - query.length);
    else if (name.startsWith(query)) score = 60;
    else if (words.every((w) => name.split(/[\s.&-]+/).some((t) => t.startsWith(w)))) score = 50;
    else if (s.symbol.includes(query)) score = 40;
    else if (name.includes(query)) score = 30;
    if (score >= 0) scored.push([score + (s.bestLev ? 1 : 0), s]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].symbol.localeCompare(b[1].symbol));
  return scored.slice(0, 50).map(([, s]) => s);
}

// Spread between the most and least generous broker that lists the stock (unfunded counts as 1×).
function gap(s: Stock): number {
  if (!s.bestLev) return 0;
  const levs = BROKERS.filter((b) => s[b]).map((b) => Math.max(1, s[b]!.lev));
  return s.bestLev - Math.min(...levs);
}

// True when at least one listing broker offers less than the best, so the winner is worth tagging.
const contested = (s: Stock) => BROKERS.some((b) => s[b] && !s.best.includes(b));

function sorted(list: Stock[]): Stock[] {
  const out = list.filter(
    (s) =>
      (!state.filter || s.best.includes(state.filter)) &&
      (!state.solo || s.best.length === 1) &&
      (!state.results || !!nextResult(s.symbol)),
  );
  if (state.results) {
    // Nearest results date first; the chosen sort breaks ties.
    const byDate = (a: Stock, b: Stock) => nextResult(a.symbol)!.date.localeCompare(nextResult(b.symbol)!.date);
    const tie = state.sort === 'lev' ? (a: Stock, b: Stock) => (b.bestLev ?? 0) - (a.bestLev ?? 0) : (a: Stock, b: Stock) => a.symbol.localeCompare(b.symbol);
    return out.sort((a, b) => byDate(a, b) || tie(a, b));
  }
  const az = (a: Stock, b: Stock) => a.symbol.localeCompare(b.symbol);
  if (state.sort === 'lev') out.sort((a, b) => (b.bestLev ?? 0) - (a.bestLev ?? 0) || az(a, b));
  else if (state.sort === 'gap') out.sort((a, b) => gap(b) - gap(a) || az(a, b));
  else out.sort(az);
  return out;
}

/* ---------- rendering ---------- */

const ICON = {
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
  up: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 2 9 8H1z"/></svg>',
  down: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 8 1 2h8z"/></svg>',
};

function changeMark(lev: number, delta: number): string {
  const move = round1(lev) - round1(lev - delta);
  if (!delta || !round1(move)) return ''; // too small to show at one decimal
  const up = move > 0;
  return `<span class="chg ${up ? 'up' : 'down'}" title="${up ? '+' : ''}${round1(move)}× since yesterday">${up ? ICON.up : ICON.down}</span>`;
}

function levCell(s: Stock, b: BrokerKey): string {
  const c = s[b];
  const best = s.best.includes(b);
  const win = best && contested(s);
  let inner: string;
  if (!c) inner = '<span class="none" title="Not on this broker\'s MTF list">—</span>';
  else if (!isFunded(c)) inner = '<span class="nf">Not funded</span>';
  else inner = `<span class="lev">${fmtLev(c.lev)}</span>${win ? '<span class="tag">Best</span>' : ''}`;
  const cls = `${best ? ' is-best' : ''}${win ? ' is-win' : ''}${c && !isFunded(c) ? ' is-nf' : ''}`;
  return `<div class="cell${cls}" data-broker="${BROKER_SHORT[b]}">${inner}${c ? changeMark(c.lev, s.change?.[b] ?? 0) : ''}</div>`;
}

function rowHTML(s: Stock): string {
  const pinned = state.pins.includes(s.symbol);
  const same = s.best.every((b) => round1(s[b]!.lev) === s.bestLev);
  const who = !contested(s)
    ? s.best.length > 1 ? (same ? 'Same everywhere' : `All within ${TIE_GAP}×`) : `Only ${BROKER_SHORT[s.best[0]]}`
    : s.best.map((b) => BROKER_SHORT[b]).join(' · ');
  const best = s.best.length
    ? `<span class="best-lev">${fmtLev(s.bestLev!)}</span><span class="best-who">${who}</span>`
    : `<span class="none">${s.stub ? 'Not on MTF lists' : 'No funding'}</span>`;
  return `<div class="row${s.stub ? ' is-stub' : ''}" role="listitem" data-sym="${esc(s.symbol)}" tabindex="0">
    <div class="stock">
      <div class="sym">${esc(s.symbol)}${s.type === 'etf' ? '<span class="pill">ETF</span>' : ''}${flagsHTML(s.symbol, 2)}</div>
      <div class="name">${esc(s.name)}</div>
    </div>
    ${BROKERS.map((b) => levCell(s, b)).join('')}
    <div class="best">${best}</div>
    <button class="star${pinned ? ' on' : ''}" data-pin="${esc(s.symbol)}" aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(s.symbol)}">${ICON.star}</button>
  </div>`;
}

function renderStatus() {
  const m = state.meta;
  if (!m) return;
  const dots = BROKERS.map((b) => {
    const info = m.brokers[b];
    const age = info.status === 'stale' ? ` <span class="age">${fmtAge(info.fetchedAt)}</span>` : '';
    // With account sync on, the dot also turns amber when the account sync needs attention.
    const acct = accountSyncState(b);
    const dot = info.status !== 'ok' ? info.status : acct === 'attention' ? 'stale' : 'ok';
    return `<button class="dot-btn" data-broker="${b}" aria-label="${BROKER_NAME[b]}: ${dot}"><span class="dot ${dot}"></span>${BROKER_SHORT[b]}${age}</button>`;
  }).join('');
  $('#status').innerHTML = `<span class="updated">Updated ${fmtTime(m.generatedAt)}</span>${runHTML()}<span class="dots">${dots}</span>`;
}

/* ---------- live refresh status ----------
   The page asks GitHub whether the refresh workflow is running (scheduled or from the button), so
   "Updated" is never mistaken for current while a run is in flight. When a run finishes, the new
   data loads by itself. Checks every 30 s while running, every 3 min otherwise, only while visible. */

type RunState = { status: 'unknown' | 'idle' | 'running' | 'failed'; startedAt?: string; url?: string };
const run: RunState = { status: 'unknown' };
let runTimer = 0;
const RUN_ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

function runHTML(): string {
  if (run.status === 'running') {
    const mins = run.startedAt ? Math.max(0, Math.round((Date.now() - new Date(run.startedAt).getTime()) / 60000)) : 0;
    return `<span class="run-live" title="A refresh is running on GitHub; new data loads here when it finishes"><span class="spin" aria-hidden="true"></span>Refreshing now${mins ? ` · ${mins} min` : ''}</span>`;
  }
  if (run.status === 'failed') {
    return `<a class="run-failed" href="${esc(run.url ?? '#')}" target="_blank" rel="noopener" title="The last refresh run failed; the page shows the data from the run before">Last refresh failed</a>`;
  }
  return '';
}

async function checkRun(): Promise<void> {
  clearTimeout(runTimer);
  if (!GH_REPO || document.visibilityState !== 'visible') return;
  let next = 180_000;
  try {
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/actions/workflows/refresh.yml/runs?per_page=1`, {
      headers: ghHeaders(),
      cache: 'no-store',
    });
    if (r.status === 403 || r.status === 429) next = 600_000; // rate limited: back off
    else if (r.ok) {
      const last = (await r.json()).workflow_runs?.[0];
      const was = run.status;
      if (last && RUN_ACTIVE.has(last.status)) {
        Object.assign(run, { status: 'running', startedAt: last.run_started_at ?? last.created_at, url: last.html_url });
        next = 30_000;
      } else if (last?.conclusion === 'failure' && state.meta && last.created_at > state.meta.generatedAt) {
        Object.assign(run, { status: 'failed', url: last.html_url });
      } else {
        run.status = 'idle';
      }
      if (was === 'running' && run.status !== 'running') await reloadAfterRun();
      renderStatus();
      updateRefreshCooldown();
    }
  } catch {
    /* offline: try again later */
  }
  runTimer = window.setTimeout(checkRun, next);
}

// The run deploys the site as its last step; the CDN can lag a little, so retry once if needed.
async function reloadAfterRun(retry = true): Promise<void> {
  const before = state.meta?.generatedAt;
  try {
    const meta = await getJSON<Meta>('/data/meta.json');
    if (meta.generatedAt === before) {
      if (retry) window.setTimeout(() => reloadAfterRun(false), 20_000);
      return;
    }
    const stocks = await getJSON<Stock[]>('/data/mtf.json');
    setData(stocks, meta);
    renderAll();
    loadExtras();
    toast(`Updated ${fmtTime(meta.generatedAt, false)}`);
  } catch {
    /* keep current data */
  }
}

function renderSummary() {
  const counts = BROKERS.map((b) => ({
    b,
    covered: state.stocks.filter((s) => isFunded(s[b])).length,
    wins: state.stocks.filter((s) => s.best.includes(b)).length,
    solo: state.stocks.filter((s) => s.best.length === 1 && s.best[0] === b).length,
  }));
  const maxWins = Math.max(...counts.map((c) => c.wins));
  const funded = state.stocks.filter((s) => s.bestLev).length || 1;
  $('#summary').innerHTML = counts
    .map(
      (c) => `<div class="stat${c.wins === maxWins ? ' lead' : ''}">
      <div class="stat-top"><span class="stat-name"><span class="long">${BROKER_NAME[c.b]}</span><span class="short">${BROKER_SHORT[c.b]}</span></span>${c.wins === maxWins ? '<span class="tag">Most generous</span>' : ''}</div>
      <div class="stat-num">${fmtNum(c.wins)}<span class="stat-unit">best</span></div>
      <div class="bar" aria-hidden="true"><span style="width:${((c.wins / funded) * 100).toFixed(1)}%"></span></div>
      <div class="stat-sub">${fmtNum(c.covered)} funded<span class="long"> · ${fmtNum(c.solo)} sole best</span></div>
    </div>`,
    )
    .join('');
}

function renderChips() {
  const pendingResults = state.pins.filter((p) => nextResult(p)).length;
  $('#chips').innerHTML = '<span class="chips-label">Best on</span>' + BROKERS.map(
    (b) =>
      `<button class="chip${state.filter === b ? ' on' : ''}" data-filter="${b}" aria-pressed="${state.filter === b}" aria-label="Best on ${BROKER_SHORT[b]}"><span class="chip-pre">Best on </span>${BROKER_SHORT[b]}</button>`,
  ).join('') +
    `<button class="chip chip-solo${state.solo ? ' on' : ''}" data-solo aria-pressed="${state.solo}">Sole best</button>` +
    `<button class="chip${state.results ? ' on' : ''}" data-results aria-pressed="${state.results}" title="Pinned stocks with results still to come">Results due${pendingResults ? ` <span class="count">${pendingResults}</span>` : ''}</button>`;
}

function emptyState(): string {
  if (state.query) {
    const other = state.type === 'etf' ? 'equity' : 'etf';
    const n = search(state.query, other).length;
    const hint = n
      ? `<div class="chips"><button class="chip" data-type="${other}">Show ${n === 50 ? '50+' : n} ${other === 'etf' ? 'ETF' : 'stock'} match${n === 1 ? '' : 'es'}</button></div>`
      : '';
    return `<div class="empty"><p class="empty-title">No ${state.type === 'etf' ? 'ETF' : 'stock'} matches “${esc(state.query)}”</p><p>None of the three brokers lists it for MTF, or it trades under another symbol.</p>${hint}</div>`;
  }
  if (state.view === 'pinned' && !state.pins.length) {
    return `<div class="empty"><p class="empty-title">Nothing pinned yet</p><p>Search a stock and tap the star, or add several at once.</p>
      <div class="chips"><button class="chip" data-add>+ Add stocks</button></div></div>`;
  }
  if (state.results && !state.filter && !state.solo) {
    return `<div class="empty"><p class="empty-title">No results due</p><p>None of your ${state.view === 'pinned' ? 'pinned ' : ''}stocks has a results date announced on NSE yet.</p></div>`;
  }
  const where = state.filter ? ` on ${BROKER_NAME[state.filter]}` : '';
  const what = state.solo ? `is best${where} alone (by more than ${TIE_GAP}×)` : `has its best multiplier${where}`;
  return `<div class="empty"><p class="empty-title">No stocks here</p><p>No ${state.view === 'pinned' ? 'pinned ' : ''}stock ${what}.</p></div>`;
}

function renderList() {
  const searching = !!state.query.trim();
  document.body.classList.toggle('positions-view', !searching && state.view === 'positions');
  store('mtf.view', state.view);
  positionsBadge();
  if (!searching && state.view === 'positions') {
    document.body.classList.remove('searching');
    $('#list').innerHTML = positionsViewHTML();
    $('#list-head').hidden = true;
    $('#list-foot').innerHTML = `<details class="manage"${loadPositions().length ? '' : ' open'}><summary>Manage positions</summary><div class="pin-actions"><button class="btn btn-primary" data-import-holdings>Import holdings</button><button class="btn btn-ghost" id="pos-export">Export file</button><label class="btn btn-ghost">Import file<input type="file" id="pos-import" accept="application/json,.json" hidden /></label>${loadPositions().length ? '<button class="btn btn-ghost btn-danger" id="pos-clear">Remove all positions</button>' : ''}</div>${posSyncHTML()}</details>`;
    $('#pin-count').textContent = state.pins.length ? String(state.pins.length) : '';
    return;
  }
  let list: Stock[];
  if (searching) list = search(state.query);
  else if (state.view === 'pinned') list = sorted(state.pins.map((p) => state.bySymbol.get(p) ?? stubStock(p)));
  else list = sorted(state.stocks.filter((s) => s.type === state.type));

  // Pins no broker funds are shown as empty rows; fetch their names once.
  if (!searching && state.view === 'pinned' && !state.symbols && state.pins.some((p) => !state.bySymbol.has(p))) {
    loadSymbols().then(renderList);
  }

  document.body.classList.toggle('searching', searching);
  const shown = searching || state.view === 'pinned' ? list : list.slice(0, state.limit);
  $('#list').innerHTML = shown.length ? shown.map(rowHTML).join('') : emptyState();
  $('#list-head').hidden = !shown.length;

  const foot: string[] = [];
  if (searching && list.length === 50) foot.push('<p class="muted">Showing the top 50 matches. Keep typing to narrow it down.</p>');
  if (!searching && state.view === 'pinned' && state.pins.length) {
    foot.push('<button class="btn btn-ghost" data-add>+ Add or edit pinned stocks</button>', syncHTML());
  }
  if (!searching && state.view === 'all' && list.length > shown.length) {
    foot.push(`<button class="btn btn-ghost" id="more">Show more <span class="muted">${fmtNum(shown.length)} of ${fmtNum(list.length)}</span></button>`);
  }
  $('#list-foot').innerHTML = foot.join('');
  $('#pin-count').textContent = state.pins.length ? String(state.pins.length) : '';
}

function survSourcesHTML(m: Meta): string {
  const src = m.surveillance?.sources;
  if (!src) return '';
  const link = { NSE: 'https://www.nseindia.com/reports/asm' } as Record<string, string>;
  return Object.entries(src)
    .map(
      ([ex, i]) =>
        `<li><a href="${link[ex] ?? '#'}" target="_blank" rel="noopener">${ex} ASM / GSM</a><span class="muted">${i.status === 'ok' ? '' : `${i.status} · `}${fmtNum(i.count ?? 0)} rows · fetched ${fmtTime(i.fetchedAt ?? null)}</span></li>`,
    )
    .join('');
}

function eventSourcesHTML(m: Meta): string {
  const src = m.events?.sources;
  if (!src) return '';
  const rows: [string, string, SurvSource | undefined][] = [
    ['NSE F&amp;O ban list', BAN_LINK, src.ban],
    ['NSE price bands and T2T series', 'https://nsearchives.nseindia.com/content/equities/sec_list.csv', src.bands],
    ['NSE board meetings, corporate actions and announcements', 'https://www.nseindia.com/companies-listing/corporate-filings-event-calendar', src.events],
  ];
  return rows
    .filter(([, , i]) => i)
    .map(([label, link, i]) => `<li><a href="${link}" target="_blank" rel="noopener">${label}</a><span class="muted">${i!.status === 'ok' ? '' : `${i!.status} · `}fetched ${fmtTime(i!.fetchedAt ?? null)}</span></li>`)
    .join('');
}

function marketSourcesHTML(m: Meta): string {
  const src = m.market?.sources;
  if (!src) return '';
  const rows: [string, string, SurvSource | undefined][] = [
    ['Prices for pinned stocks (Yahoo Finance)', 'https://finance.yahoo.com/', src.prices],
    ['NSE exchange margin (VaR + ELM)', 'https://www.nseindia.com/all-reports', src.var],
    ['NSE F&amp;O open interest vs limit', 'https://www.nseindia.com/all-reports-derivatives', src.mwpl],
    ['NSE delivery % (bhavcopy)', 'https://www.nseindia.com/all-reports', src.deliv],
    ['NSE bulk and block deals', 'https://www.nseindia.com/report-detail/display-bulk-and-block-deals', src.deals],
    ['NSE promoter pledges', 'https://www.nseindia.com/companies-listing/corporate-filings-pledged-data', src.pledge],
  ];
  return rows
    .filter(([, , i]) => i)
    .map(([label, link, i]) => `<li><a href="${link}" target="_blank" rel="noopener">${label}</a><span class="muted">${i!.status === 'ok' ? '' : `${i!.status} · `}fetched ${fmtTime(i!.fetchedAt ?? null)}</span></li>`)
    .join('');
}

function renderFooter() {
  const m = state.meta;
  if (!m) return;
  const fetches = BROKERS.map((b) => {
    const i = m.brokers[b];
    return `<li><a href="${SOURCES[b]}" target="_blank" rel="noopener">${BROKER_NAME[b]}</a><span class="muted">${fmtNum(i.count)} rows · fetched ${fmtTime(i.fetchedAt)}</span></li>`;
  }).join('');
  $('#footer').innerHTML = `
    <div class="foot-grid">
      <div>
        <h2>Sources</h2>
        <ul class="sources">${fetches}${survSourcesHTML(m)}${eventSourcesHTML(m)}${marketSourcesHTML(m)}</ul>
      </div>
      <div>
        <h2>Pins</h2>
        <div class="pin-actions">
          <button class="btn btn-ghost" id="copy-link">Copy pin link</button>
          <button class="btn btn-ghost" id="export">Export</button>
          <label class="btn btn-ghost">Import<input type="file" id="import" accept="application/json,.json" hidden /></label>
        </div>
        <p class="muted small">${SYNC_ON ? 'Pins are shared by every device through data/pins.json in the repo. Editing them needs your GitHub token on that device.' : 'Pins are saved in this browser. Open the pin link on another device to carry them over.'}</p>
      </div>
    </div>
    ${
      m.unmatched
        ? `<details class="unmatched" id="unmatched"><summary>Needs matching <span class="count">${fmtNum(m.unmatched)}</span></summary><div class="unmatched-body"><p class="muted small">Loading…</p></div></details>`
        : ''
    }
    <p class="disclaimer">For personal reference. Check the broker app before placing an order.</p>`;
}

function render() {
  renderStatus();
  renderList();
  renderChips();
  document.querySelectorAll<HTMLButtonElement>('.seg [data-view]').forEach((btn) => {
    btn.setAttribute('aria-selected', String(btn.dataset.view === state.view));
  });
}

function renderAll() {
  renderSummary();
  renderFooter();
  render();
}

function setType(type: 'equity' | 'etf') {
  state.type = type;
  state.limit = PAGE;
  document.querySelectorAll<HTMLButtonElement>('.type-seg [data-type]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.type === type));
  });
  $<HTMLInputElement>('#q').placeholder = type === 'etf' ? 'Search ETFs' : 'Search stocks';
  renderList();
}

/* ---------- watchlist alerts ---------- */

const SEEN_KEY = 'mtf.alertsSeen';

function unseenAlerts(): WatchAlert[] {
  const seen = store<string>(SEEN_KEY) ?? '';
  return state.alerts.filter((a) => a.at > seen);
}

function renderBell() {
  const n = unseenAlerts().length;
  const badge = $('#bell-count');
  badge.hidden = !n;
  badge.textContent = n > 99 ? '99+' : String(n);
  $('#bell').setAttribute('aria-label', n ? `Watchlist alerts, ${n} new` : 'Watchlist alerts');
}

const ALERT_FILTER_KEY = 'mtf.alertsFilter';
const ALERT_LEVEL_KEY = 'mtf.alertsLevel';
let freshAlerts = new Set<WatchAlert>(); // unseen when the panel was opened; kept while switching filters

function openAlerts(switching = false) {
  const sheet = $<HTMLDialogElement>('#sheet');
  if (!switching) freshAlerts = new Set(unseenAlerts());
  const fresh = freshAlerts;
  // "Portfolio only" keeps alerts for stocks you hold (positions on this device).
  const held = new Set(loadPositions().map((p) => p.sym));
  const portfolio = store<string>(ALERT_FILTER_KEY) === 'portfolio';
  const shown = portfolio ? state.alerts.filter((a) => held.has(a.symbol)) : state.alerts;
  const heldCount = state.alerts.filter((a) => held.has(a.symbol)).length;
  const heldNew = [...fresh].filter((a) => held.has(a.symbol)).length;
  // Level filter: tap a count to see only serious, watch, good or info changes.
  const LEVELS: [WatchAlert['level'], string][] = [['alert', 'Serious'], ['watch', 'Watch'], ['good', 'Good'], ['info', 'Info']];
  const lvl = store<string>(ALERT_LEVEL_KEY);
  const level = LEVELS.some(([k]) => k === lvl) ? (lvl as WatchAlert['level']) : null;
  const listed = level ? shown.filter((a) => a.level === level) : shown;
  const today = localISO();
  const yesterday = localISO(new Date(Date.now() - 86_400_000));
  const byDay = new Map<string, WatchAlert[]>();
  for (const a of [...listed].sort((p, q) => q.at.localeCompare(p.at))) {
    const d = localISO(new Date(a.at));
    const day = d === today ? 'Today' : d === yesterday ? 'Yesterday' : new Date(a.at).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    byDay.set(day, [...(byDay.get(day) ?? []), a]);
  }
  // One card per stock per refresh, most serious line first.
  const rank: Record<WatchAlert['level'], number> = { alert: 0, watch: 1, good: 2, info: 3 };
  const groupsOf = (items: WatchAlert[]) => {
    const g = new Map<string, WatchAlert[]>();
    for (const a of items) g.set(`${a.at}|${a.symbol}`, [...(g.get(`${a.at}|${a.symbol}`) ?? []), a]);
    return [...g.values()].map((x) => x.sort((p, q) => rank[p.level] - rank[q.level]));
  };
  const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const list = [...byDay]
    .map(
      ([day, items]) => `<h3 class="al-day">${day}<span>${items.length}</span></h3><div class="al-list">${groupsOf(items)
        .map((g) => {
          const top = g[0].level;
          const isNew = g.some((a) => fresh.has(a));
          const name = state.bySymbol.get(g[0].symbol)?.name || (g[0].name !== g[0].symbol ? g[0].name : '');
          return `<article class="al is-${top}${isNew ? ' is-new' : ''}">
            <header class="al-head">
              <div class="al-title">
                <span class="al-symrow"><button class="al-sym" data-open="${esc(g[0].symbol)}">${esc(g[0].symbol)}</button>${held.has(g[0].symbol) ? '<span class="al-held">Held</span>' : ''}</span>
                ${name ? `<span class="al-name">${esc(name)}</span>` : ''}
              </div>
              <div class="al-meta">${isNew ? '<span class="al-new">New</span>' : ''}<time>${time(g[0].at)}</time></div>
            </header>
            <ul class="al-lines">${g
              .map((a) => `<li class="al-line is-${a.level}"><span class="al-tag">${LEVELS.find(([k]) => k === a.level)![1]}</span><span class="al-text">${esc(a.text)}${a.link ? ` <a class="al-link" href="${esc(safeUrl(a.link))}" target="_blank" rel="noopener">Read filing</a>` : ''}</span></li>`)
              .join('')}</ul>
          </article>`;
        })
        .join('')}</div>`,
    )
    .join('');
  const counts = Object.fromEntries(LEVELS.map(([k]) => [k, shown.filter((a) => a.level === k).length]));
  const levelChips = shown.length
    ? `<div class="al-levels">${LEVELS.filter(([k]) => counts[k] || level === k)
        .map(([k, label]) => `<button class="al-chip is-${k}${level === k ? ' on' : ''}" data-alert-level="${level === k ? '' : k}" aria-pressed="${level === k}">${label}<b>${counts[k]}</b></button>`)
        .join('')}</div>`
    : '';
  sheet.innerHTML = `
    <div class="sheet-inner al-sheet">
      <div class="sheet-head">
        <div><div class="sym big">Alerts</div><div class="name">What changed for your pinned stocks, last 30 days</div></div>
        <div class="sheet-actions"><button class="icon-btn" data-close aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
      </div>
      <div class="seg alert-filter" role="tablist" aria-label="Which alerts">
        <button role="tab" data-alert-filter="all" aria-selected="${!portfolio}">All watchlist <span class="count">${state.alerts.length || ''}</span></button>
        <button role="tab" data-alert-filter="portfolio" aria-selected="${portfolio}">Portfolio only <span class="count${heldNew ? ' warn-count' : ''}">${heldNew ? `${heldNew} new` : heldCount || ''}</span></button>
      </div>
      ${levelChips}
      ${list ||
        (level
          ? '<div class="empty"><p class="empty-title">Nothing at this level</p><p>Tap the highlighted chip again to see every alert.</p></div>'
          : portfolio
          ? `<div class="empty"><p class="empty-title">No alerts for your positions</p><p>${held.size ? 'Nothing has changed for the stocks you hold in the last 30 days.' : 'Add positions in the Positions tab to see their alerts here.'}</p></div>`
          : '<div class="empty"><p class="empty-title">No changes yet</p><p>You will see multiplier changes, ASM/GSM/ESM moves, F&amp;O ban, price band changes and new events for your pinned stocks here.</p></div>')}
      <p class="al-foot">Get these on your phone: add Telegram or ntfy secrets to the repo (see the README).</p>
    </div>`;
  if (!sheet.open) sheet.showModal();
  state.sheetSym = null;
  // Opening the panel marks everything as seen on this device.
  const latest = state.alerts.reduce((m, a) => (a.at > m ? a.at : m), '');
  if (latest) store(SEEN_KEY, latest);
  renderBell();
}

/* ---------- my positions (this device only) ---------- */

interface Position {
  id: string;
  sym: string;
  broker: BrokerKey;
  qty: number;
  price: number; // average buy price
  date: string; // buy date YYYY-MM-DD
  lev: number; // leverage the position was taken at
  orig?: number; // quantity bought, once part of it has been sold
  src?: 'broker'; // added by a broker sync (date = first seen, leverage = broker's rate that day)
  cash?: number; // money you actually put in for this lot; the rest of its margin came from the account's
  //              spare margin (e.g. unrealised gains). Missing = the full margin (value ÷ leverage) was new money.
}

// The cash a lot was bought with: by default its whole margin (value ÷ leverage).
const lotMargin = (p: Position) => (p.qty * p.price) / Math.max(1, p.lev);
const lotCash = (p: Position) => Math.min(lotMargin(p), Math.max(0, p.cash ?? lotMargin(p)));
// Keep a lot's cash in step when its quantity changes (a partial sale sells cash and margin alike).
const resizeLot = (p: Position, qty: number): Position => ({ ...p, qty, orig: p.orig ?? p.qty, ...(p.cash != null ? { cash: (p.cash * qty) / p.qty } : {}) });

// Buy-side fees charged once per buy order (flat brokerage, pledge, their GST). After a partial sale each
// part carries its share, so booked + open adds up to the same total as before the sale.
function shareBuyFees(c: CostBreakdown, r: BrokerRates, share: number): CostBreakdown {
  const cut = (r.brokFlat + r.pledge) * (1 + STATUTORY.gst / 100) * (1 - Math.min(1, Math.max(0, share)));
  if (!cut) return c;
  return { ...c, total: c.total - cut, fixed: c.fixed - cut, buySide: c.buySide - cut };
}

interface PosMetrics {
  marginAtBuy: number; // the margin this lot needed when bought (value ÷ leverage)
  debt: number; // what you owe on it: the broker's MTF loan plus any margin borrowed against gains
  buyValue: number; // quantity × trade price
  invested: number; // quantity × trade price, for every broker (charges are counted in net P&L)
  own: number;
  funded: number;
  days: number;
  interest: number;
  ltp: number | null;
  value: number | null;
  net: number | null; // P&L if sold now, after every charge and interest so far
  roi: number | null; // net as % of own funds
  callPrice: number | null; // price at which equity falls below the margin needed
  callDist: number | null; // % the price can fall from now before that
  marginPct: number; // margin the broker asks for this stock today, % of value
  marginFrom: 'live' | 'entry' | 'dropped'; // today's broker rate, the entry leverage (no data yet), or no longer funded
  spare: number | null; // this stock's part of the account margin: equity − margin needed (negative = uses others' cushion)
  breakEven: number | null; // sell price that covers all costs so far
  costs: CostBreakdown;
  gross: number | null; // value now − total investment, before charges (the broker apps' unrealised P&L)
  day: number | null; // today's change: since the previous close, or since the buy price if bought today
  dayBase: number | null; // value the day's change is measured from
  perDay: number; // interest the broker's money costs each day
}

const POS_KEY = 'mtf.positions';
const CALL_WARN = 3; // % above the top-up price that counts as close

const loadPositions = (): Position[] => store<Position[]>(POS_KEY) ?? [];
const savePositions = (list: Position[]) => {
  store(POS_KEY, list);
  positionsChanged();
};
// Filled in by private sync: called whenever positions, closed trades or rates change.
let positionsChanged: () => void = () => {};

function posMetrics(pos: Position): PosMetrics {
  const r = brokerRates()[pos.broker];
  const lev = Math.max(1, pos.lev);
  const buyValue = pos.qty * pos.price;
  const marginAtBuy = buyValue / lev;
  const own = lotCash(pos); // real money in; less than the margin when spare margin paid for part of it
  const funded = buyValue - marginAtBuy; // the broker's MTF loan, which carries MTF interest
  const debt = buyValue - own;
  const invested = buyValue;
  // The broker's margin for this stock right now, from the hourly MTF data (Rupeezy publishes the exact %).
  // A stock the broker has stopped funding needs its full value: convert to delivery or sell.
  const cur = state.stocks.length ? state.bySymbol.get(pos.sym)?.[pos.broker] ?? null : undefined;
  const marginFrom = cur === undefined ? 'entry' : isFunded(cur) ? 'live' : 'dropped';
  const marginPct = marginFrom === 'live' ? (cur!.ownPct ?? 100 / cur!.lev) : marginFrom === 'dropped' ? 100 : 100 / lev;
  const days = Math.max(0, Math.floor((Date.parse(localISO()) - Date.parse(pos.date)) / 86_400_000));
  const interest = (funded * r.interest * days) / 36500;
  const perDay = (funded * r.interest) / 36500;
  const ltp = state.market?.prices[pos.sym]?.p ?? null;
  // Charges are known even without a price (sale assumed at the buy price until one arrives).
  const costs = shareBuyFees(computeCosts(r, marginAtBuy, lev, days, ltp == null ? 0 : (ltp / pos.price - 1) * 100), r, pos.qty / (pos.orig ?? pos.qty));
  if (ltp == null) {
    return { marginAtBuy, debt, buyValue, invested, own, funded, days, interest, ltp, value: null, net: null, roi: null, callPrice: null, callDist: null, marginPct, marginFrom, spare: null, breakEven: null, costs, gross: null, day: null, dayBase: null, perDay };
  }
  const px = state.market!.prices[pos.sym];
  const boughtToday = pos.date >= px.date;
  const dayFrom = boughtToday ? pos.price : px.prev;
  const day = dayFrom ? (ltp - dayFrom) * pos.qty : null;
  const value = ltp * pos.qty;
  const net = value - buyValue - costs.total;
  // Margin call when your equity (value − broker's money − interest) drops below value ÷ leverage,
  // i.e. the same margin share the broker asked for at entry.
  const callPrice = lev > 1 ? (funded + interest) / (pos.qty * (1 - 1 / lev)) : null;
  return {
    marginAtBuy, debt, buyValue, invested, own, funded, days, interest, ltp, value, net,
    roi: own > 0.5 ? (net / own) * 100 : null,
    callPrice,
    callDist: callPrice != null ? ((ltp - callPrice) / ltp) * 100 : null,
    // Equity (value − what you owe − interest) minus the margin the broker asks for today.
    marginPct, marginFrom,
    spare: lev > 1 ? value - debt - interest - (value * marginPct) / 100 : null,
    breakEven: pos.price + costs.total / pos.qty,
    costs,
    gross: value - invested,
    day,
    dayBase: dayFrom ? dayFrom * pos.qty : null,
    perDay,
  };
}

// Brokers check margin for the whole MTF account, not stock by stock: a gain on one stock covers a loss
// on another at the same broker (Kotak and Rupeezy are separate accounts). Per broker:
//   needed = Σ value × the broker's margin % for that stock today,
//   equity = Σ (value − what you owe − interest so far) = cash you put in + unrealised P&L − interest,
//   spare = equity − needed; a negative spare is the top-up the broker will ask for.
// fall = how far every holding at that broker can drop together before spare reaches zero.
interface Account { broker: BrokerKey; n: number; value: number; needed: number; equity: number; spare: number; fall: number | null }

function accounts(list = loadPositions()): Account[] {
  return BROKERS.map((broker) => {
    const ms = list.filter((p) => p.broker === broker).map(posMetrics).filter((m) => m.spare != null);
    const value = ms.reduce((t, m) => t + m.value!, 0);
    const needed = ms.reduce((t, m) => t + (m.value! * m.marginPct) / 100, 0);
    const equity = ms.reduce((t, m) => t + m.value! - m.debt - m.interest, 0);
    const spare = equity - needed;
    const sens = value - needed; // equity lost per 100% fall, net of the lower margin needed
    return { broker, n: ms.length, value, needed, equity, spare, fall: sens > 0 ? (spare / sens) * 100 : null };
  }).filter((a) => a.n);
}

const accountState = (a: Account): 'short' | 'close' | 'ok' => (a.spare < 0 ? 'short' : (a.fall ?? 99) < CALL_WARN ? 'close' : 'ok');


// A stock's own standing inside its account: below its margin share, thin, or comfortable.
type PosState = 'short' | 'close' | 'ok' | 'none';
const posState = (m: PosMetrics): PosState =>
  m.spare == null || m.value == null ? 'none' : m.spare < 0 ? 'short' : m.spare < (m.value * CALL_WARN) / 100 ? 'close' : 'ok';

function positionCardHTML(pos: Position, withSymbol: boolean): string {
  const m = posMetrics(pos);
  const c = m.costs;
  const st = posState(m);
  const sign = (n: number) => (n >= 0 ? '+' : '−');
  const money = (n: number) => `${sign(n)}${inr(Math.abs(n)).replace('−', '')}`;
  const items: [string, number][] = [
    ['Brokerage on buy', c.brokBuy], ['Brokerage on sell', c.brokSell], ['Pledge on buy', c.pledge], ['Unpledge on sell', c.unpledge],
    ['DP charge on sell', c.dp], ['GST on DP and pledge', c.gstDepository], ['STT, buy and sell', c.stt], ['NSE transaction', c.txn],
    ['SEBI fee', c.sebi], ['Stamp duty on buy', c.stamp], ['GST on brokerage and fees', c.gstTrade], [`Interest, ${m.days} day${m.days === 1 ? '' : 's'}`, c.interest],
  ];
  // Three columns, each value above its label, read left to right; P&L is the loudest row.
  const cell = (value: string, label: string, cls = '') => `<div class="pc-cell${cls ? ` ${cls}` : ''}"><b>${value}</b><span>${label}</span></div>`;
  const tone = (n: number | null) => (n == null ? '' : n >= 0 ? 'up' : 'down');
  const pctOf = (n: number, base: number) => `${sign(n)}${Math.abs((n / base) * 100).toFixed(1)}%`;
  // Every return: on total investment first and larger, on your own money smaller below.
  const both = (n: number | null, withTotal = true) => n == null ? ''
    : `${withTotal ? `<em class="pc-t">${pctOf(n, m.invested)} on total</em>` : ''}${m.own > 0.5 ? `<small>${sign(n)}${Math.abs((n / m.own) * 100).toFixed(Math.abs(n / m.own) >= 0.1 ? 0 : 1)}% own money</small>` : '<small>bought with spare margin</small>'}`;
  const name = state.bySymbol.get(pos.sym)?.name;
  const flags = withSymbol ? flagsHTML(pos.sym, 3) : '';
  const pill =
    m.marginFrom === 'dropped' ? `<span class="pc-pill is-short">No longer funded</span>` : '';
  return `<article class="pr pc is-${st}" data-sym="${esc(pos.sym)}">
    ${flags ? `<div class="pc-flags">${flags}</div>` : ''}
    <header class="pc-head">
      <div class="pc-title">
        ${withSymbol ? `<button class="pr-sym pc-sym" data-open-pos="${esc(pos.sym)}">${esc(pos.sym)}</button>` : `<span class="pc-sym">${BROKER_NAME[pos.broker]}</span>`}
        <span class="pc-sub">${withSymbol ? `${BROKER_SHORT[pos.broker]} ${round1(pos.lev)}×${name ? `, ${esc(name)}` : ''}` : `${round1(pos.lev)}× leverage`}</span>
      </div>
      ${pill}
    </header>
    <div class="pc-grid">
      ${cell(pos.qty.toLocaleString('en-IN'), 'Quantity')}
      ${cell(m.ltp != null ? rupee(m.ltp) : '—', 'Last price')}
      ${cell(m.value != null ? lakh(m.value) : '—', 'Current value')}
    </div>
    <div class="pc-grid pc-key">
      ${cell(m.gross != null ? money(m.gross) : '—', 'Unrealised P&amp;L', tone(m.gross))}
      ${cell(m.gross != null ? pctOf(m.gross, m.invested) : '—', `On total${both(m.gross, false)}`, tone(m.gross))}
      ${cell(m.day != null ? money(m.day) : '—', `Day P&amp;L${both(m.day)}`, tone(m.day))}
    </div>
    <div class="pc-grid">
      ${cell(rupee(Math.round((m.invested / pos.qty) * 100) / 100), 'Avg buy price')}
      ${cell(lakh(m.invested), 'Total investment')}
      ${cell(lakh(m.own), m.own < m.marginAtBuy - 0.5 ? `Your cash<small>${lakh(m.marginAtBuy - m.own)} from spare margin</small>` : 'Your cash')}
    </div>
    <div class="pc-grid pc-risk">
      ${cell(m.breakEven != null ? rupeeShort(m.breakEven) : '—', 'Break-even')}
      ${cell(m.spare != null ? `${m.spare >= 0 ? '+' : '−'}${inr(Math.abs(m.spare)).replace('−', '')}` : '—', `${m.spare != null && m.spare < 0 ? 'Margin drawn' : 'Margin spare'}<small>${m.marginFrom === 'dropped' ? 'Not funded now: 100%' : `${round1(m.marginPct)}% margin${Math.abs(m.marginPct - 100 / Math.max(1, pos.lev)) >= 0.5 ? `, was ${round1(100 / Math.max(1, pos.lev))}%` : ''}`}</small>`)}
      ${cell(m.net != null ? money(m.net) : '—', `Net if sold now${both(m.net)}`, tone(m.net))}
    </div>
    <details class="pr-more">
      <summary><span>Money and charges</span><span class="pr-faint">${inr(c.total)} if sold now</span></summary>
      <dl class="pr-dl">
        <dt>Your cash in</dt><dd>${inr(m.own)}${m.own < m.marginAtBuy - 0.5 ? `<small>${inr(m.marginAtBuy - m.own)} of the ${inr(m.marginAtBuy)} margin came from spare margin</small>` : ''}<button class="link-btn" data-cash-edit="${esc(pos.id)}">Change</button></dd>
        <dt>Broker's money</dt><dd>${inr(m.funded)}</dd>
        <dt>Total investment</dt><dd>${inr(m.invested)}${m.value != null ? `<small>Worth ${inr(m.value)} now</small>` : ''}</dd>
        <dt>Fixed charges</dt><dd>${inr2(c.fixed)}<small>${inr2(c.buySide)} at buy, ${inr2(c.sellSide)} on sale</small></dd>
        <dt>Interest so far</dt><dd>${inr2(m.interest)}<small>${m.days ? `${m.days} day${m.days === 1 ? '' : 's'}` : 'Bought today'}</small></dd>
        <dt>Interest cost</dt><dd>${inr2(m.perDay)} a day<small>${inr(m.perDay * 30)} a month</small></dd>
        <dt>Charges if sold now</dt><dd>${inr2(c.total)}</dd>
      </dl>
      <details class="pr-items"><summary>Every charge</summary>
        <dl class="pr-dl">${items.map(([k, v]) => `<dt>${k}</dt><dd>${inr2(v)}</dd>`).join('')}</dl>
      </details>
      <div class="pr-actions">
        <button class="btn btn-ghost btn-sm" data-sell="${esc(pos.id)}">Record sale</button>
        <button class="pr-remove" data-pos-del="${esc(pos.id)}">Remove</button>
      </div>
    </details>
  </article>`;
}

function positionSectionHTML(s: Stock): string {
  if (s.stub) return '';
  const mine = loadPositions().filter((p) => p.sym === s.symbol);
  const funded = BROKERS.filter((b) => isFunded(s[b]));
  const ltp = state.market?.prices[s.symbol]?.p;
  const form = funded.length
    ? `<details class="calc-rates pos-form"${mine.length ? '' : ' open'}>
        <summary>${mine.length ? 'Add another position' : 'Track my position'}</summary>
        <p class="muted small pos-form-note">Saved on this device only.</p>
        <div class="calc-inputs pos-inputs">
          <label><span>Broker</span><span class="calc-field"><select id="pos-broker">${funded.map((b) => `<option value="${b}" data-lev="${s[b]!.lev}">${BROKER_SHORT[b]} · ${fmtLev(s[b]!.lev)}</option>`).join('')}</select></span></label>
          <label><span>Quantity</span><span class="calc-field"><input id="pos-qty" type="number" inputmode="numeric" min="1" step="1" /></span></label>
          <label><span>Avg buy price</span><span class="calc-field"><span class="pre">₹</span><input id="pos-price" type="number" inputmode="decimal" min="0" step="any" value="${ltp ?? ''}" /></span></label>
          <label><span>Buy date</span><span class="calc-field"><input id="pos-date" type="date" value="${localISO()}" max="${localISO()}" /></span></label>
          <label><span>Paid with</span><span class="calc-field"><select id="pos-paid"><option value="cash">New money</option><option value="spare">Spare margin first</option></select></span></label>
          <label><span>Leverage taken</span><span class="calc-field"><input id="pos-lev" type="number" inputmode="decimal" min="1" step="0.01" value="${funded[0] ? s[funded[0]]!.lev : ''}" /><span class="post">×</span></span></label>
        </div>
        <button class="btn btn-primary" data-pos-save="${esc(s.symbol)}">Save position</button>
      </details>`
    : '';
  return `${mine.length ? `<div class="pr-list">${mine.map((p) => positionCardHTML(p, false)).join('')}</div>` : ''}${form}`;
}

type PosSort = 'risk' | 'pnl' | 'pnlBest' | 'today' | 'ret' | 'size' | 'interest' | 'days' | 'az';
interface PosView { mode: 'open' | 'closed'; broker: 'all' | BrokerKey; status: 'all' | 'short' | 'close' | 'ok'; pnl: 'all' | 'up' | 'down'; results: boolean; sort: PosSort }
const POS_VIEW_KEY = 'mtf.posView';
const PS_MORE_KEY = 'mtf.psMore';
const posView = (): PosView => ({ mode: 'open', broker: 'all', status: 'all', pnl: 'all', results: false, sort: 'risk', ...(store<Partial<PosView>>(POS_VIEW_KEY) ?? {}) });


function positionsViewHTML(): string {
  const list = loadPositions();
  const v0 = posView();
  const closedN = loadClosed().length;
  const modes = `<div class="seg pr-modes" role="tablist"><button role="tab" data-posmode="open" aria-selected="${v0.mode === 'open'}">Open <span class="count">${list.length || ''}</span></button><button role="tab" data-posmode="closed" aria-selected="${v0.mode === 'closed'}">Closed <span class="count">${closedN || ''}</span></button></div>`;
  if (v0.mode === 'closed') return modes + closedViewHTML();
  if (!list.length) {
    return modes + `<div class="empty"><p class="empty-title">No positions yet</p><p>Paste your holdings with “Import holdings”, or open any stock and add it from its Position tab. You'll see live P&amp;L, charges, interest so far, break-even and how much cushion is left before a margin top-up. Positions stay on this device.</p></div>`;
  }
  return modes + portfolioHTML(list);
}

/* ---------- Portfolio (open positions) ----------
   Hero (value, today, total), one card per broker account with a margin gauge, then one row per stock
   and broker (lots grouped). Tapping a row opens the stock with its lots and full numbers. */

interface Holding { key: string; sym: string; broker: BrokerKey; lots: Position[]; ms: PosMetrics[]; qty: number; avg: number; lev: number;
  value: number | null; invested: number; own: number; gross: number | null; day: number | null; net: number | null; spare: number | null; ltp: number | null; fromSpare: number }

function holdingsOf(list: Position[]): Holding[] {
  const by = new Map<string, Position[]>();
  for (const p of list) by.set(`${p.broker}|${p.sym}`, [...(by.get(`${p.broker}|${p.sym}`) ?? []), p]);
  return [...by.entries()].map(([key, lots]) => {
    const ms = lots.map(posMetrics);
    const sum = (f: (m: PosMetrics) => number | null) => (ms.some((m) => f(m) == null) ? null : ms.reduce((t, m) => t + (f(m) as number), 0));
    const qty = lots.reduce((t, p) => t + p.qty, 0);
    const invested = ms.reduce((t, m) => t + m.invested, 0);
    return {
      key, sym: lots[0].sym, broker: lots[0].broker, lots, ms, qty, avg: invested / qty,
      lev: invested / ms.reduce((t, m) => t + m.marginAtBuy, 0),
      value: sum((m) => m.value), invested, own: ms.reduce((t, m) => t + m.own, 0), gross: sum((m) => m.gross),
      day: sum((m) => m.day), net: sum((m) => m.net), spare: sum((m) => m.spare), ltp: ms[0].ltp,
      fromSpare: ms.reduce((t, m) => t + Math.max(0, m.marginAtBuy - m.own), 0),
    };
  });
}

const signed = (n: number) => `${n >= 0 ? '+' : '−'}${inr(Math.abs(n)).replace('−', '')}`;
const pctStr = (n: number, base: number, dp = 1) => (base ? `${n >= 0 ? '+' : '−'}${Math.abs((n / base) * 100).toFixed(dp)}%` : '');
const tone = (n: number | null) => (n == null ? '' : n >= 0 ? 'up' : 'down');

function accountCardHTML(a: Account): string {
  const st = accountState(a);
  const used = a.equity > 0 ? Math.min(100, (a.needed / a.equity) * 100) : 100;
  const x = brokerSnap?.brokers[a.broker];
  const sync = !store<string>(POS_PASS_KEY) ? '' : x?.ok ? `Synced ${fmtTime(x.at, false)}` : x ? 'Sync failed' : 'Not connected';
  const head = st === 'short' ? `${inr(-a.spare)} short` : `${inr(a.spare)} spare`;
  const sub = st === 'short' ? 'Add funds or sell to cover it' : `Holdings can fall ${(a.fall ?? 0).toFixed(1)}% together before a top-up`;
  const connect = a.broker === 'rupeezy' && x && !x.ok ? '<button class="btn btn-primary btn-sm acct-connect" data-connect-rupeezy>Connect Rupeezy</button>' : '';
  return `<div class="acct is-${st}" data-acct="${a.broker}" role="button" tabindex="0" aria-label="${BROKER_NAME[a.broker]} account">
      <span class="acct-h"><b>${BROKER_NAME[a.broker]}</b><span class="acct-sync${x && !x.ok ? ' is-bad' : ''}">${sync}</span></span>
      <span class="acct-big">${head}</span>
      <span class="gauge" role="img" aria-label="Margin used ${used.toFixed(0)}%"><span style="width:${used.toFixed(1)}%"></span></span>
      <span class="acct-sub">${sub}</span>
      <span class="acct-kv"><span>Margin used</span><b>${used.toFixed(0)}%</b><span>Needs</span><b>${lakh(a.needed)}</b><span>Equity</span><b>${lakh(a.equity)}</b></span>
      ${brokerFundsLine(a.broker) ? `<span class="acct-broker">${brokerFundsLine(a.broker).trim()}</span>` : ''}
      ${connect}
    </div>`;
}

// A broker with no holdings still gets a card while account sync is on: its status and, for Rupeezy, Connect.
function emptyAccountCardHTML(b: BrokerKey): string {
  const x = brokerSnap?.brokers[b];
  const status = x?.ok ? `Synced ${fmtTime(x.at, false)}` : x ? 'Sync failed' : 'Not connected';
  const connect = b === 'rupeezy' && (!x || !x.ok) ? '<button class="btn btn-primary btn-sm acct-connect" data-connect-rupeezy>Connect Rupeezy</button>' : '';
  return `<div class="acct is-empty" data-acct="${b}" role="button" tabindex="0" aria-label="${BROKER_NAME[b]} account">
      <span class="acct-h"><b>${BROKER_NAME[b]}</b><span class="acct-sync${x && !x.ok ? ' is-bad' : ''}">${status}</span></span>
      <span class="acct-sub">${x?.ok ? 'No MTF holdings here right now.' : x?.error ? esc(x.error) : 'Connect to sync this account.'}</span>
      ${connect}
    </div>`;
}

function holdingRowHTML(h: Holding): string {
  const pct = h.gross != null ? pctStr(h.gross, h.invested) : '';
  const flags = flagsHTML(h.sym, 2);
  // No per-row warning: margin is an account matter (a buy from spare margin is normal), shown on the account cards.
  return `<button class="hr" data-open-pos="${esc(h.sym)}">
      <span class="hr-l">
        <span class="hr-sym">${esc(h.sym)}${flags ? `<span class="hr-flags">${flags}</span>` : ''}</span>
        <span class="hr-sub">${BROKER_SHORT[h.broker]} ${round1(h.lev)}×, ${h.qty.toLocaleString('en-IN')} at ${rupee(Math.round(h.avg * 100) / 100)}${h.lots.length > 1 ? `, ${h.lots.length} lots` : ''}</span>
      </span>
      <span class="hr-r">
        <span class="hr-pnl ${tone(h.gross)}">${h.gross != null ? signed(h.gross) : '—'}<small>${pct}</small></span>
        <span class="hr-sub">${h.ltp != null ? rupee(h.ltp) : '—'}${h.day != null ? ` <span class="${tone(h.day)}">${signed(h.day)} today</span>` : ''}</span>
      </span>
    </button>`;
}

function portfolioHTML(list: Position[]): string {
  const v = posView();
  const all = list.map((p) => ({ p, m: posMetrics(p) }));
  const hs = holdingsOf(list);
  const sum = (f: (m: PosMetrics) => number) => all.reduce((t, x) => t + f(x.m), 0);
  const invested = sum((m) => m.invested);
  const own = sum((m) => m.own);
  const value = sum((m) => m.value ?? m.invested);
  const gross = sum((m) => m.gross ?? 0);
  const day = sum((m) => m.day ?? 0);
  const net = sum((m) => m.net ?? 0);
  const fromSpare = sum((m) => Math.max(0, m.marginAtBuy - m.own));
  const accts = accounts(list);
  const shown = hs.filter((h) =>
    (v.broker === 'all' || h.broker === v.broker) &&
    (v.pnl === 'all' || (v.pnl === 'up' ? (h.gross ?? 0) >= 0 : (h.gross ?? 0) < 0)) &&
    (v.status === 'all' || (v.status === 'short' ? (h.spare ?? 0) < 0 : (h.spare ?? 0) >= 0 && (h.spare ?? 0) < ((h.value ?? 0) * CALL_WARN) / 100)) &&
    (!v.results || !!nextResult(h.sym)));
  const by: Record<PosSort, (a: Holding, b: Holding) => number> = {
    risk: (a, b) => (a.spare ?? 1e12) / (a.value || 1) - (b.spare ?? 1e12) / (b.value || 1),
    pnl: (a, b) => (a.gross ?? 0) - (b.gross ?? 0),
    pnlBest: (a, b) => (b.gross ?? 0) - (a.gross ?? 0),
    today: (a, b) => (a.day ?? 0) - (b.day ?? 0),
    ret: (a, b) => (b.gross ?? 0) / b.invested - (a.gross ?? 0) / a.invested,
    size: (a, b) => b.invested - a.invested,
    interest: (a, b) => b.ms.reduce((t, m) => t + m.interest, 0) - a.ms.reduce((t, m) => t + m.interest, 0),
    days: (a, b) => Math.max(...b.ms.map((m) => m.days)) - Math.max(...a.ms.map((m) => m.days)),
    az: (a, b) => a.sym.localeCompare(b.sym),
  };
  shown.sort((a, b) => by[v.sort](a, b) || a.sym.localeCompare(b.sym));
  const counts: Record<string, number> = {
    kotak: hs.filter((h) => h.broker === 'kotak').length, rupeezy: hs.filter((h) => h.broker === 'rupeezy').length,
    short: hs.filter((h) => (h.spare ?? 0) < 0).length,
    close: hs.filter((h) => (h.spare ?? 0) >= 0 && (h.spare ?? 0) < ((h.value ?? 0) * CALL_WARN) / 100).length,
    up: hs.filter((h) => (h.gross ?? 0) >= 0).length, down: hs.filter((h) => (h.gross ?? 0) < 0).length,
    results: hs.filter((h) => nextResult(h.sym)).length,
  };
  const perDay = sum((m) => m.perDay);
  const rates = brokerRates();
  const saving = (b: BrokerKey) => inr((100000 * rates[b].interest) / 1200);
  return `<section class="hero">
      <div class="hero-main">
        <span class="hero-label">Current value</span>
        <span class="hero-val">${inr(value)}</span>
        <span class="hero-sub">${lakh(invested)} invested, ${lakh(own)} your cash${fromSpare > 0.5 ? `, ${lakh(fromSpare)} from spare margin` : ''}</span>
      </div>
      <div class="hero-stats">
        <div class="hero-stat"><span>Today</span><b class="${tone(day)}">${signed(day)}</b><small>${pctStr(day, invested, 2)} on total</small></div>
        <div class="hero-stat"><span>Total P&amp;L</span><b class="${tone(gross)}">${signed(gross)}</b><small>${pctStr(gross, invested, 2)} on total, ${pctStr(gross, own)} on your cash</small></div>
        <div class="hero-stat"><span>If sold now</span><b class="${tone(net)}">${signed(net)}</b><small>after charges and interest</small></div>
      </div>
    </section>
    ${(() => {
      const cards = BROKERS.map((b) => { const a = accts.find((x) => x.broker === b); return a ? accountCardHTML(a) : store<string>(POS_PASS_KEY) ? emptyAccountCardHTML(b) : ''; }).join('');
      return cards ? `<section class="accts">${cards}</section>` : '';
    })()}
    <section class="hl">
      <div class="hl-head">
        <h2>Holdings <span>${hs.length}</span></h2>
        <label class="select hl-sort"><span class="sr-only">Sort holdings</span><select id="pos-sort">${([
          ['risk', 'Margin risk'], ['pnl', 'Biggest loss'], ['pnlBest', 'Biggest gain'], ['today', "Today's move"], ['ret', 'Return %'],
          ['size', 'Largest'], ['interest', 'Most interest'], ['days', 'Held longest'], ['az', 'A to Z']] as [PosSort, string][])
          .map(([k, l]) => `<option value="${k}"${k === v.sort ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <div class="chips hl-chips">${([
        ['broker', 'kotak', 'Kotak', v.broker === 'kotak', counts.kotak], ['broker', 'rupeezy', 'Rupeezy', v.broker === 'rupeezy', counts.rupeezy],
        ['pnl', 'down', 'Losers', v.pnl === 'down', counts.down], ['pnl', 'up', 'Gainers', v.pnl === 'up', counts.up],
        ['results', '1', 'Results due', v.results, counts.results]] as [string, string, string, boolean, number][])
        .filter(([, , , on, n]) => on || n).map(([k, val, l, on, n]) => `<button class="chip${on ? ' on' : ''}" data-posf="${k}:${val}" aria-pressed="${on}">${l} <span class="count">${n}</span></button>`).join('')}</div>
      <div class="hr-list">${shown.length ? shown.map(holdingRowHTML).join('') : '<p class="empty">No holdings match. Clear a filter to see all.</p>'}</div>
    </section>
    <section class="pf-more">
      ${overallHTML(signed)}
      <div class="pf-stats">
        <div><span>Interest</span><b>${inr(perDay)} a day</b><small>${inr(perDay * 30)} a month, ${inr(sum((m) => m.interest))} so far. Paying back ₹1 L saves ${saving('kotak')} a month at Kotak, ${saving('rupeezy')} at Rupeezy.</small></div>
        <div><span>Charges</span><b>${inr(sum((m) => m.costs.fixed))}</b><small>${inr(sum((m) => m.costs.buySide))} paid, ${inr(sum((m) => m.costs.sellSide))} more when you sell</small></div>
      </div>
    </section>`;
}


// What the broker itself reports for the account (Rupeezy funds; Kotak limits once its night maintenance ends).
function brokerFundsLine(b: BrokerKey): string {
  const raw = brokerSnap?.brokers[b]?.ok ? (brokerSnap.brokers[b].raw as Record<string, any>) : null;
  if (!raw) return '';
  if (b === 'rupeezy') {
    const f = raw.funds?.nse ?? raw.funds?.exchange_combined;
    const avail = num(f?.net_available);
    if (Number.isFinite(avail)) return ` Rupeezy reports ${avail < 0 ? `${inr(-avail)} short` : `${inr(avail)} available`}.`;
  }
  if (b === 'kotak' && raw.limits && !raw._errors?.limits) {
    const net = num(raw.limits.Net ?? raw.limits.net ?? raw.limits.data?.Net);
    if (Number.isFinite(net)) return ` Kotak reports ${net < 0 ? `${inr(-net)} short` : `${inr(net)} available`}.`;
  }
  return '';
}

// Realised P&L so far, after every charge and interest: earlier P&L + sales recorded here. Open positions are not in it.
function overallHTML(amount: (n: number) => string): string {
  const start = store<number>(START_KEY) ?? 0;
  const booked = loadClosed().reduce((t, x) => t + x.pnl, 0);
  const total = start + booked;
  const part = (label: string, n: number) => `<span><i>${label}</i><b class="${n >= 0 ? 'up' : 'down'}">${amount(n)}</b></span>`;
  // Collapsed by default: the total shows in the header; the split opens on tap.
  return `<details class="ps-overall"${store<boolean>(OV_OPEN_KEY) ? ' open' : ''}>
      <summary class="ps-ov-top">
        <span class="ps-label">Realised P&amp;L as of now<small>after every charge and interest</small></span>
        <b class="ps-ov-amt ${total >= 0 ? 'up' : 'down'}">${amount(total)}</b>
      </summary>
      <div class="ps-ov-parts">
        ${part('Booked here', booked)}
        <button class="ps-ov-start" data-pnl-start><i>Earlier</i><b class="${start >= 0 ? 'up' : 'down'}">${start ? amount(start) : 'Add'}</b></button>
      </div>
    </details>`;
}

const OV_OPEN_KEY = 'mtf.realisedOpen';

function setStartPnl() {
  const cur = store<number>(START_KEY) ?? 0;
  const raw = prompt('Realised P&L from trades closed before you recorded them here, after charges and interest (₹). Use a minus sign for a loss. Leave empty for 0.', cur ? String(cur) : '');
  if (raw === null) return;
  const n = raw.trim() === '' ? 0 : Number(raw.replace(/[₹,\s]/g, '').replace('−', '-'));
  if (!Number.isFinite(n)) return toast('Enter a number, like 25000 or -8000.');
  store(START_KEY, n);
  positionsChanged();
  renderList();
}

function positionsBadge() {
  const list = loadPositions();
  const near = accounts(list).some((a) => accountState(a) !== 'ok');
  const el = document.getElementById('pos-count');
  if (el) {
    el.textContent = list.length ? String(list.length) : '';
    el.classList.toggle('warn-count', near);
  }
}

/* ---------- recorded sales (closed trades) ---------- */

interface ClosedTrade {
  id: string;
  sym: string;
  broker: BrokerKey;
  qty: number;
  buy: number;
  sell: number;
  buyDate: string;
  sellDate: string;
  lev: number;
  charges: number; // every charge except interest
  interest: number;
  pnl: number; // after every charge and interest
  own: number; // your money in this part of the position
  est?: boolean; // recorded from a broker sync without the exact sell price: last price used
}

const CLOSED_KEY = 'mtf.closed';
// Realised P&L from before trades were recorded here (after charges and interest), entered once.
const START_KEY = 'mtf.pnlStart';
const loadClosed = (): ClosedTrade[] => store<ClosedTrade[]>(CLOSED_KEY) ?? [];
const saveClosed = (list: ClosedTrade[]) => {
  store(CLOSED_KEY, list);
  positionsChanged();
};

/* ---------- private positions sync ----------
   Positions, closed trades and rates are encrypted in this browser (AES-GCM, key from your
   passphrase via PBKDF2) and saved as data/positions.enc.json. The repo is public, so only the
   ciphertext is visible; the passphrase never leaves your devices (and the repo secret, if you
   add it for top-up warnings). The newest save wins. */

const POS_FILE = 'data/positions.enc.json';
const POS_PASS_KEY = 'mtf.posPass';
const POS_AT_KEY = 'mtf.posAt';
const KDF_ROUNDS = 200_000;
const psync = { status: 'off' as 'off' | 'syncing' | 'synced' | 'error' | 'locked', sha: null as string | null, timer: 0, busy: false };

const posUrl = () => `https://api.github.com/repos/${GH_REPO}/contents/${POS_FILE}`;
const bytesB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const b64Bytes = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

interface EncFile { v: 1; kdf: 'PBKDF2-SHA256'; iter: number; salt: string; iv: string; data: string }
interface PosPayload { at: string; positions: Position[]; closed: ClosedTrade[]; rates: unknown; start?: number }

async function posKey(pass: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encryptPayload(pass: string, payload: PosPayload): Promise<EncFile> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await posKey(pass, salt, KDF_ROUNDS);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload))));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: KDF_ROUNDS, salt: bytesB64(salt), iv: bytesB64(iv), data: bytesB64(data) };
}

async function decryptPayload(pass: string, f: EncFile): Promise<PosPayload> {
  const key = await posKey(pass, b64Bytes(f.salt), f.iter);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64Bytes(f.iv) }, key, b64Bytes(f.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

/* Broker accounts, read from the brokers' APIs by the refresh job (scripts/brokers.py), encrypted with the
   same passphrase. Holdings are shown as synced once their fields are mapped; for now the status shows. */
interface BrokerSnap { at: string; brokers: Record<string, { ok: boolean; at: string | null; error?: string; failedAt?: string; raw?: Record<string, unknown> }> }
let brokerSnap: BrokerSnap | null = null;

async function loadBrokerSnapshot(): Promise<void> {
  const pass = store<string>(POS_PASS_KEY);
  if (!SYNC_ON || !pass) return;
  try {
    // The contents API is live; the raw file server can lag up to 5 minutes behind a new sync.
    let file: EncFile | null = null;
    if (store<string>(GH_TOKEN_KEY)) {
      const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/data/broker.enc.json?ref=${encodeURIComponent(GH_REF)}`, { headers: ghHeaders(), cache: 'no-store' });
      if (r.ok) file = JSON.parse(b64decode((await r.json()).content));
    }
    if (!file) {
      const r = await fetch(`https://raw.githubusercontent.com/${GH_REPO}/${GH_REF}/data/broker.enc.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return;
      file = await r.json();
    }
    brokerSnap = (await decryptPayload(pass, file!)) as unknown as BrokerSnap;
    renderStatus();
    reconcileFromBrokers();
    if (state.view === 'positions' && !state.query.trim()) renderList(); // broker-reported margin and funds
  } catch {
    /* not set up yet, offline, or a different passphrase */
  }
}

/* ---------- positions from the brokers ----------
   Broker data decides which stocks you hold and how many. Your entries keep what the brokers don't report:
   the buy date (for interest) and the leverage taken. New shares are added at once (dated the day they
   first show up, at the broker's leverage that day). Fewer shares are recorded as a sale only after two
   syncs agree, so one empty or glitchy response can never wipe a position. */

interface BrokerHolding { sym: string; qty: number; avg: number; mtf: boolean | null; close: number | null }
const RECON_KEY = 'mtf.recon';
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const cleanSym = (v: unknown) => String(v ?? '').toUpperCase().replace(/-(EQ|BE|BZ|SM|ST)$/, '').trim();
const LABEL_KEYS = ['instrumentType', 'subType', 'securityType', 'securitySubType', 'product', 'prod', 'prdCode'];

// null = the broker didn't say (no MTF marker anywhere in its rows); then MTF is assumed when it funds the stock.
function markerOf(row: Record<string, unknown>): boolean | null {
  const vals = LABEL_KEYS.map((k) => String(row[k] ?? '').toUpperCase()).filter(Boolean);
  if (vals.some((v) => v.includes('MTF') || v.includes('MARGIN'))) return true;
  if (vals.some((v) => /\b(CNC|DELIVERY|NORMAL|NRML)\b/.test(v))) return false;
  return null;
}

function brokerHoldings(b: BrokerKey): BrokerHolding[] | null {
  const x = brokerSnap?.brokers[b];
  const raw = x?.ok ? (x.raw as Record<string, any> | undefined) : undefined;
  if (!raw) return null;
  const rows: BrokerHolding[] = [];
  if (b === 'kotak') {
    if (raw._errors?.holdings || !Array.isArray(raw.holdings?.data)) return null;
    for (const r of raw.holdings.data as Record<string, unknown>[]) {
      if (r.exchangeSegment && !String(r.exchangeSegment).toLowerCase().startsWith('nse')) continue;
      rows.push({ sym: cleanSym(r.symbol ?? r.displaySymbol), qty: num(r.quantity), avg: num(r.averagePrice), mtf: markerOf(r), close: num(r.closingPrice) || null });
    }
  } else {
    if (raw._errors?.positions) return null;
    const net = raw.positions?.data?.net;
    if (!Array.isArray(net)) return null;
    for (const r of net as Record<string, unknown>[]) {
      const prod = String(r.product ?? '').toUpperCase();
      if (/INTRADAY|MIS/.test(prod)) continue;
      const avg = num(r.overnight_average_price) || num(r.average_price) || num(r.buy_price);
      rows.push({ sym: cleanSym(r.symbol), qty: num(r.quantity), avg, mtf: markerOf(r), close: null });
    }
  }
  // One row per stock (a stock can appear once per exchange); bad rows are dropped.
  const by = new Map<string, BrokerHolding>();
  for (const h of rows) if (h.sym && h.qty > 0 && h.avg > 0 && (by.get(h.sym)?.qty ?? 0) < h.qty) by.set(h.sym, h);
  return [...by.values()];
}

// Cash a new lot needs on top of the account's spare margin just before it (never below 0 or above its margin).
function cashFromSpare(lot: Position, before: Position[]): number {
  const spare = accounts(before.filter((p) => p.id !== lot.id)).find((a) => a.broker === lot.broker)?.spare ?? 0;
  return Math.round(Math.max(0, Math.min(lotMargin(lot), lotMargin(lot) - Math.max(0, spare))));
}

// One-off: lots a broker sync added before cash was tracked were counted as all-new money. Price them
// the way the broker did: spare margin first. Runs once prices are in, so spare is known.
function migrateLotCash() {
  if (store<boolean>('mtf.cashMigrated') || !state.market || !state.stocks.length) return;
  let list = loadPositions();
  let changed = false;
  for (const p of list.filter((x) => x.src === 'broker' && x.cash == null).sort((a, b) => a.date.localeCompare(b.date))) {
    const cash = cashFromSpare(p, list.filter((x) => x.id !== p.id && (x.date < p.date || x.date === p.date && x.id < p.id)));
    list = list.map((x) => (x.id === p.id ? { ...x, cash } : x));
    changed = true;
  }
  store('mtf.cashMigrated', true);
  if (changed) {
    savePositions(list);
    render();
  }
}

function editLotCash(id: string) {
  const list = loadPositions();
  const p = list.find((x) => x.id === id);
  if (!p) return;
  const margin = Math.round(lotMargin(p));
  const raw = prompt(`Cash you put in for ${p.qty} ${p.sym} (₹0 to ₹${margin.toLocaleString('en-IN')}). The rest of the ₹${margin.toLocaleString('en-IN')} margin came from spare margin, such as unrealised gains.`, String(Math.round(lotCash(p))));
  if (raw === null) return;
  const n = Number(raw.replace(/[₹,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return toast('Enter an amount like 25000, or 0 if it was all spare margin.');
  savePositions(list.map((x) => (x.id === id ? { ...x, cash: Math.min(n, lotMargin(x)) } : x)));
  if ($<HTMLDialogElement>('#sheet').open && state.sheetSym) openSheet(state.sheetSym);
  render();
}

function reconcileFromBrokers() {
  // Needs prices and broker rates: spare margin decides how new buys were paid, and a sale needs a price.
  // Called again when they arrive.
  if (!brokerSnap || !state.market || !state.stocks.length) return;
  const done = store<Record<string, string>>(RECON_KEY) ?? {};
  const pending = (store<Record<string, Record<string, number>>>(`${RECON_KEY}.pending`) ?? {});
  let list = loadPositions();
  const sales: ClosedTrade[] = [];
  const notes: string[] = [];
  for (const b of BROKERS) {
    const at = brokerSnap.brokers[b]?.at;
    const held = brokerHoldings(b);
    if (!held || !at || done[b] === at) continue;
    done[b] = at;
    const anyMarker = held.some((h) => h.mtf !== null);
    const want = new Map(held.map((h) => [h.sym, h]));
    const mine = list.filter((p) => p.broker === b);
    const syms = new Set([...want.keys(), ...mine.map((p) => p.sym)]);
    const nextPending: Record<string, number> = {};
    let added = 0, sold = 0;
    for (const sym of syms) {
      const h = want.get(sym);
      const lots = mine.filter((p) => p.sym === sym).sort((x, y) => x.date.localeCompare(y.date));
      const have = lots.reduce((t, p) => t + p.qty, 0);
      const brokerQty = h?.qty ?? 0;
      if (brokerQty > have && h) {
        const isMtf = h.mtf ?? (anyMarker ? false : true);
        const cur = state.bySymbol.get(sym)?.[b];
        const lev = isMtf && isFunded(cur ?? null) ? cur!.lev : 1;
        const extra = brokerQty - have;
        // The new shares' price: what the broker's average implies once your tracked lots are taken out.
        const price = have ? Math.max(0.01, (brokerQty * h.avg - lots.reduce((t, p) => t + p.qty * p.price, 0)) / extra) : h.avg;
        const lot: Position = { id: newId(), sym, broker: b, qty: extra, price: Math.round(price * 100) / 100, date: localISO(), lev, src: 'broker' };
        // Brokers pay a new buy's margin from the account's spare margin first (unrealised gains count);
        // only what that doesn't cover is new money.
        list.push({ ...lot, cash: cashFromSpare(lot, list) });
        added += 1;
      } else if (brokerQty < have) {
        const prev = pending[b]?.[sym];
        if (prev !== brokerQty) {
          nextPending[sym] = brokerQty; // confirm on the next sync before booking a sale
          continue;
        }
        let toSell = have - brokerQty;
        const px = state.market?.prices[sym]?.p ?? h?.close ?? lots[0].price;
        for (const lot of lots) {
          if (!toSell) break;
          const q = Math.min(lot.qty, toSell);
          sales.push({ ...saleResult(lot, q, px, localISO()), est: true });
          list = q >= lot.qty ? list.filter((p) => p.id !== lot.id) : list.map((p) => (p.id === lot.id ? resizeLot(p, p.qty - q) : p));
          toSell -= q;
        }
        sold += 1;
      }
    }
    pending[b] = nextPending;
    if (added || sold) notes.push(`${BROKER_SHORT[b]}: ${[added && `${added} added`, sold && `${sold} sold`].filter(Boolean).join(', ')}`);
  }
  store(RECON_KEY, done);
  store(`${RECON_KEY}.pending`, pending);
  if (!notes.length) return;
  if (sales.length) saveClosed([...loadClosed(), ...sales]);
  savePositions(list);
  ensureHeldPinned();
  toast(`Synced from your brokers. ${notes.join('; ')}`);
  render();
}

/* Sign in with Rupeezy: Rupeezy's page sends you back with a one-time ?auth= code. It is saved encrypted
   (data/rupeezy_auth.enc.json) and a quick broker sync turns it into a session with the API key, which
   lives only in repository secrets. */
const RZ_APP_KEY = 'mtf.rupeezyApp';

function connectRupeezy() {
  if (!store<string>(POS_PASS_KEY)) return toast('Turn on private sync first: the session is saved with your passphrase.');
  if (!store<string>(GH_TOKEN_KEY)) return toast('Connect GitHub first (Watchlist tab, below the list).');
  let app = store<string>(RZ_APP_KEY);
  if (!app) {
    app = prompt('Rupeezy application ID (vortex.rupeezy.in → your application). Saved on this device; it is not secret.')?.trim() || null;
    if (!app) return;
    store(RZ_APP_KEY, app);
  }
  location.href = `https://flow.rupeezy.in?applicationId=${encodeURIComponent(app)}&cb_param=mtf`;
}

async function finishRupeezyLogin(auth: string) {
  history.replaceState(null, '', location.pathname);
  const pass = store<string>(POS_PASS_KEY);
  if (!pass || !store<string>(GH_TOKEN_KEY)) return toast('Rupeezy sign-in needs private sync and GitHub connected on this device.');
  toast('Rupeezy signed in. Syncing your account…');
  try {
    const path = 'data/rupeezy_auth.enc.json';
    const url = `https://api.github.com/repos/${GH_REPO}/contents/${path}`;
    const cur = await fetch(`${url}?ref=${encodeURIComponent(GH_REF)}`, { headers: ghHeaders(), cache: 'no-store' });
    const sha = cur.ok ? (await cur.json()).sha : undefined;
    const file = await encryptPayload(pass, { at: new Date().toISOString(), auth } as unknown as PosPayload);
    const put = await fetch(url, {
      method: 'PUT',
      headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'rupeezy: sign-in', content: b64encode(`${JSON.stringify(file)}\n`), branch: GH_REF, ...(sha ? { sha } : {}),
        committer: { name: 'mtf-bot', email: 'mtf-bot@users.noreply.github.com' },
      }),
    });
    if (!put.ok) throw new Error(`save ${put.status}`);
    const run = await fetch(`https://api.github.com/repos/${GH_REPO}/actions/workflows/brokers.yml/dispatches`, {
      method: 'POST', headers: { ...ghHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: GH_REF }),
    });
    if (run.status !== 204) throw new Error(`sync ${run.status}`);
    // The sync takes about half a minute; pick up the new snapshot when it lands.
    for (const wait of [40_000, 30_000, 30_000]) {
      await new Promise((r) => setTimeout(r, wait));
      await loadBrokerSnapshot();
      if (brokerSnap?.brokers.rupeezy?.ok) return toast('Rupeezy connected');
    }
  } catch (e) {
    toast(`Couldn't finish the Rupeezy sign-in (${(e as Error).message}). Try Connect Rupeezy again.`);
  }
}

async function fetchPosFile(): Promise<{ file: EncFile | null; sha: string | null } | null> {
  try {
    const r = await fetch(`${posUrl()}?ref=${encodeURIComponent(GH_REF)}`, { headers: ghHeaders(), cache: 'no-store' });
    if (r.status === 404) return { file: null, sha: null };
    if (r.ok) {
      const body = await r.json();
      return { file: JSON.parse(b64decode(body.content)), sha: body.sha };
    }
  } catch {
    /* offline */
  }
  return null;
}

const localPayload = (): PosPayload => ({
  at: store<string>(POS_AT_KEY) || store(POS_AT_KEY, new Date().toISOString())!, positions: loadPositions(), closed: loadClosed(), rates: store(RATES_KEY) ?? {}, start: store<number>(START_KEY) ?? 0,
});

function applyPayload(p: PosPayload) {
  store(POS_KEY, p.positions ?? []);
  store(CLOSED_KEY, p.closed ?? []);
  store(RATES_KEY, p.rates ?? {});
  store(START_KEY, p.start ?? 0);
  store(POS_AT_KEY, p.at);
}

function setPsync(status: typeof psync.status) {
  psync.status = status;
  const el = document.getElementById('possync');
  if (el) el.outerHTML = posSyncHTML();
}

function posSyncHTML(): string {
  if (!SYNC_ON) return '';
  const on = !!store<string>(POS_PASS_KEY);
  if (!on) {
    return `<p class="sync local" id="possync"><span class="dot stale"></span>Positions are on this device only. <button class="link-btn" data-possync="on">Turn on private sync</button></p>`;
  }
  const msg = {
    off: 'Private sync on', syncing: 'Saving positions (encrypted)…', synced: 'Positions synced, encrypted',
    error: 'Couldn’t reach GitHub. Positions are kept here and will sync later.',
    locked: 'The saved positions use a different passphrase.',
  }[psync.status];
  const dot = psync.status === 'synced' ? 'ok' : psync.status === 'syncing' || psync.status === 'off' ? '' : 'stale';
  const fix = psync.status === 'locked' ? ' <button class="link-btn" data-possync="on">Enter passphrase</button>' : '';
  return `<p class="sync ${psync.status}" id="possync"><span class="dot ${dot}"></span>${msg}.${fix} <button class="link-btn" data-possync="off">Turn off</button></p>`;
}

async function pullPositions(first = false): Promise<void> {
  const pass = store<string>(POS_PASS_KEY);
  if (!SYNC_ON || !pass || psync.busy) return;
  const remote = await fetchPosFile();
  if (!remote) return setPsync('error');
  psync.sha = remote.sha;
  if (!remote.file) return void pushPositions();
  let p: PosPayload;
  try {
    p = await decryptPayload(pass, remote.file);
  } catch {
    return setPsync('locked');
  }
  let localAt = store<string>(POS_AT_KEY) ?? '';
  if (first) {
    // Joining sync: an empty side takes the other; if both have positions, the person picks.
    const mine = loadPositions().length + loadClosed().length;
    const theirs = (p.positions?.length ?? 0) + (p.closed?.length ?? 0);
    const same = JSON.stringify([loadPositions(), loadClosed()]) === JSON.stringify([p.positions ?? [], p.closed ?? []]);
    if (!same && mine && theirs && !confirm(`The synced copy has ${p.positions?.length ?? 0} open positions; this device has ${loadPositions().length}. OK uses the synced copy here. Cancel keeps this device’s and replaces the synced copy.`)) {
      store(POS_AT_KEY, new Date().toISOString());
      return void pushPositions();
    }
    localAt = mine && !theirs ? new Date().toISOString() : '';
    store(POS_AT_KEY, localAt || null);
    if (!localAt) p.at ||= new Date().toISOString();
  }
  if (p.at > localAt) {
    applyPayload(p);
    ensureHeldPinned();
    setPsync('synced');
    render();
  } else if (localAt > p.at) {
    return void pushPositions();
  } else setPsync('synced');
}

async function pushPositions(retry = true): Promise<void> {
  const pass = store<string>(POS_PASS_KEY);
  if (!SYNC_ON || !pass || psync.busy || psync.status === 'locked') return;
  if (!store<string>(GH_TOKEN_KEY)) return setPsync('error');
  psync.busy = true;
  setPsync('syncing');
  try {
    if (!psync.sha) psync.sha = (await fetchPosFile())?.sha ?? null;
    const file = await encryptPayload(pass, localPayload());
    const r = await fetch(posUrl(), {
      method: 'PUT',
      headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'positions: encrypted update',
        content: b64encode(`${JSON.stringify(file)}\n`),
        branch: GH_REF,
        ...(psync.sha ? { sha: psync.sha } : {}),
        committer: { name: 'mtf-bot', email: 'mtf-bot@users.noreply.github.com' },
      }),
    });
    if ((r.status === 409 || r.status === 422) && retry) {
      // Another device saved first: the newer copy wins (pull), then save again if ours is newer.
      psync.sha = null;
      psync.busy = false;
      await pullPositions();
      return;
    }
    if (!r.ok) throw new Error(String(r.status));
    psync.sha = (await r.json()).content?.sha ?? null;
    setPsync('synced');
  } catch {
    setPsync('error');
  } finally {
    psync.busy = false;
  }
}

positionsChanged = () => {
  store(POS_AT_KEY, new Date().toISOString());
  if (!SYNC_ON || !store<string>(POS_PASS_KEY)) return;
  clearTimeout(psync.timer);
  psync.timer = window.setTimeout(pushPositions, 1500);
};

async function setPositionsPassphrase(on: boolean) {
  if (!on) {
    if (!confirm('Turn off private sync on this device? Positions stay here; the encrypted copy stays in the repo.')) return;
    store(POS_PASS_KEY, null);
    return setPsync('off');
  }
  if (!store<string>(GH_TOKEN_KEY)) {
    toast('Connect GitHub first (Watchlist tab, below the list): sync saves through your token.');
    return;
  }
  const pass = prompt('Passphrase for your positions (at least 10 characters). Use the same one on every device, and as the POSITIONS_PASSPHRASE repo secret for top-up warnings. It is never uploaded.')?.trim();
  if (!pass) return;
  if (pass.length < 10) return toast('Use at least 10 characters.');
  store(POS_PASS_KEY, pass);
  psync.status = 'off';
  setPsync('syncing');
  await pullPositions(true);
}

// The result of selling `qty` of a position at `price` on `date`, after every charge and interest to that day.
function saleResult(pos: Position, qty: number, price: number, date: string): ClosedTrade {
  const r = brokerRates()[pos.broker];
  const lev = Math.max(1, pos.lev);
  const own = (lotCash(pos) * qty) / pos.qty; // the cash share of the part sold
  const days = Math.max(0, Math.floor((Date.parse(date) - Date.parse(pos.date)) / 86_400_000));
  const c = shareBuyFees(computeCosts(r, own, lev, days, (price / pos.price - 1) * 100), r, qty / (pos.orig ?? pos.qty));
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    sym: pos.sym, broker: pos.broker, qty, buy: pos.price, sell: price, buyDate: pos.date, sellDate: date, lev,
    charges: c.fixed, interest: c.interest, pnl: (price - pos.price) * qty - c.total, own,
  };
}

let selling: Position | null = null;

function openSellSheet(id: string) {
  const pos = loadPositions().find((p) => p.id === id);
  if (!pos) return;
  selling = pos;
  const ltp = state.market?.prices[pos.sym]?.p ?? pos.price;
  const sheet = $<HTMLDialogElement>('#sheet');
  sheet.innerHTML = `
    <div class="sheet-inner">
      <div class="sheet-head">
        <div><div class="sym big">Record sale</div><div class="name">${esc(pos.sym)}, ${BROKER_NAME[pos.broker]}: ${pos.qty.toLocaleString('en-IN')} at ${rupee(pos.price)}</div></div>
        <div class="sheet-actions"><button class="icon-btn" data-close aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
      </div>
      <div class="calc-inputs pos-inputs sell-inputs">
        <label><span>Quantity sold</span><span class="calc-field"><input id="sell-qty" type="number" inputmode="numeric" min="1" max="${pos.qty}" step="1" value="${pos.qty}" /></span></label>
        <label><span>Sell price</span><span class="calc-field"><span class="pre">₹</span><input id="sell-price" type="number" inputmode="decimal" min="0" step="any" value="${ltp}" /></span></label>
        <label><span>Sell date</span><span class="calc-field"><input id="sell-date" type="date" value="${localISO()}" min="${pos.date}" max="${localISO()}" /></span></label>
      </div>
      <div id="sell-preview"></div>
      <div class="sheet-buttons"><button class="btn btn-primary" id="sell-save">Save sale</button><button class="btn btn-ghost" data-close>Cancel</button></div>
      <p class="muted small">Selling part of the position keeps the rest open. The result counts every charge and the interest up to the sell date.</p>
    </div>`;
  if (!sheet.open) sheet.showModal();
  state.sheetSym = null;
  renderSellPreview();
}

function readSale(): ClosedTrade | null {
  if (!selling) return null;
  const qty = Math.floor(Number(($<HTMLInputElement>('#sell-qty')).value));
  const price = Number(($<HTMLInputElement>('#sell-price')).value);
  const date = ($<HTMLInputElement>('#sell-date')).value || localISO();
  if (!(qty > 0 && qty <= selling.qty) || !(price > 0) || date < selling.date) return null;
  return saleResult(selling, qty, price, date);
}

function renderSellPreview() {
  const box = document.getElementById('sell-preview');
  if (!box) return;
  const t = readSale();
  box.innerHTML = t
    ? `<dl class="pr-dl sell-dl">
        <dt>Price move</dt><dd>${inr2((t.sell - t.buy) * t.qty)}</dd>
        <dt>Charges</dt><dd>−${inr2(t.charges)}</dd>
        <dt>Interest, ${Math.max(0, Math.floor((Date.parse(t.sellDate) - Date.parse(t.buyDate)) / 86_400_000))} days</dt><dd>−${inr2(t.interest)}</dd>
        <dt>Realised P&amp;L</dt><dd><b class="${t.pnl >= 0 ? 'up' : 'down'}">${t.pnl >= 0 ? '+' : '−'}${inr2(Math.abs(t.pnl)).replace('−', '')}</b><small><span class="cl-t">${((t.pnl / (t.qty * t.buy)) * 100).toFixed(1)}% on total</span>${t.own ? `, ${((t.pnl / t.own) * 100).toFixed(1)}% on own money` : ''}</small></dd>
      </dl>`
    : '<p class="muted small">Enter a quantity up to what you hold, a price and a date on or after the buy date.</p>';
  $<HTMLButtonElement>('#sell-save').disabled = !t;
}

function saveSale() {
  const t = readSale();
  if (!t || !selling) return;
  const list = loadPositions();
  const i = list.findIndex((p) => p.id === selling!.id);
  if (i < 0) return;
  if (t.qty >= list[i].qty) list.splice(i, 1);
  else list[i] = resizeLot(list[i], list[i].qty - t.qty);
  savePositions(list);
  saveClosed([t, ...loadClosed()]);
  $<HTMLDialogElement>('#sheet').close();
  toast(`Sale recorded: ${t.pnl >= 0 ? '+' : '−'}${inr(Math.abs(t.pnl)).replace('−', '')} after charges`);
  render();
}

function closedViewHTML(): string {
  const list = loadClosed().sort((a, b) => b.sellDate.localeCompare(a.sellDate));
  if (!list.length) return '<div class="empty"><p class="empty-title">No closed trades yet</p><p>Use “Record sale” on a position to keep its result here, after every charge and interest.</p></div>';
  const total = list.reduce((t, x) => t + x.pnl, 0);
  const invested = list.reduce((t, x) => t + x.qty * x.buy, 0);
  const own = list.reduce((t, x) => t + x.own, 0);
  const charges = list.reduce((t, x) => t + x.charges, 0);
  const interest = list.reduce((t, x) => t + x.interest, 0);
  const wins = list.filter((x) => x.pnl >= 0).length;
  const sign = (n: number) => (n >= 0 ? '+' : '−');
  const rows = list.map((x) => {
    const days = Math.max(0, Math.floor((Date.parse(x.sellDate) - Date.parse(x.buyDate)) / 86_400_000));
    return `<article class="pr cl">
      <div class="pr-line"><span class="pr-sym">${esc(x.sym)}</span><span class="pr-pnl ${x.pnl >= 0 ? 'up' : 'down'}">${sign(x.pnl)}${inr(Math.abs(x.pnl)).replace('−', '')}</span></div>
      <div class="pr-line pr-meta"><span>${BROKER_SHORT[x.broker]} ${round1(x.lev)}×, ${x.qty.toLocaleString('en-IN')} bought ${rupeeShort(x.buy)}, sold ${rupeeShort(x.sell)}${x.est ? ' (last price; broker sync)' : ''}</span><span class="cl-ret"><b>${sign(x.pnl)}${Math.abs((x.pnl / (x.qty * x.buy)) * 100).toFixed(1)}% on total</b>${x.own ? `<small>${sign(x.pnl)}${Math.abs((x.pnl / x.own) * 100).toFixed(1)}% on own money</small>` : ''}</span></div>
      <div class="pr-day">${shortDate(x.buyDate)} to ${shortDate(x.sellDate)}, ${days} day${days === 1 ? '' : 's'}. Charges ${inr(x.charges)}, interest ${inr(x.interest)}</div>
      <div class="pr-actions"><button class="pr-remove" data-closed-del="${esc(x.id)}">Delete record</button></div>
    </article>`;
  });
  return `<section class="ps">
      <div class="ps-top"><div><div class="ps-label">Realised P&amp;L</div><div class="ps-value ${total >= 0 ? 'up' : 'down'}">${sign(total)}${inr(Math.abs(total)).replace('−', '')}</div>
        <div class="ps-sub">${invested ? `<b class="cl-t">${sign(total)}${Math.abs((total / invested) * 100).toFixed(1)}% on ${inr(invested)} invested</b>${own ? `<br />${sign(total)}${Math.abs((total / own) * 100).toFixed(1)}% on ${inr(own)} own money` : ''}<br />After every charge and interest` : ''}</div></div>
        <div class="ps-count">${list.length} trade${list.length === 1 ? '' : 's'}</div></div>
      <div class="ps-grid">
        <div><i>Won</i><b>${wins} of ${list.length}</b></div>
        <div><i>Charges paid</i><b>${inr(charges)}</b></div>
        <div><i>Interest paid</i><b>${inr(interest)}</b></div>
      </div>
    </section>
    <div class="pr-list">${rows.join('')}</div>`;
}

function savePositionFromForm(sym: string) {
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
  const broker = val('pos-broker') as BrokerKey;
  const qty = Number(val('pos-qty'));
  const price = Number(val('pos-price'));
  const date = val('pos-date') || localISO();
  const lev = Number(val('pos-lev'));
  if (!(qty > 0) || !(price > 0) || !(lev >= 1)) return toast('Enter quantity, buy price and leverage');
  const list = loadPositions();
  const lot: Position = { id: newId(), sym, broker, qty, price, date, lev };
  list.push(val('pos-paid') === 'spare' ? { ...lot, cash: cashFromSpare(lot, list) } : lot);
  savePositions(list);
  ensureHeldPinned();
  toast('Position saved on this device');
  openSheet(sym);
  render();
}

/* Bulk import: one holding per line, e.g.
     CDSL, Kotak, 100, 1300, 10-10-2026, 4x
     Tube Investments rupeezy 25 @ 3,450 2026-09-15
   stock (symbol or name), broker, quantity, avg buy price, then optional buy date and leverage (4x). */

interface ParsedHolding {
  input: string;
  sym: string | null;
  name: string;
  broker: BrokerKey | null;
  qty: number;
  price: number;
  date: string;
  lev: number;
  notes: string[]; // assumptions the preview should show
  error: string | null;
}

const BROKER_WORDS: Record<string, BrokerKey> = { kotak: 'kotak', neo: 'kotak', kn: 'kotak', ks: 'kotak', rupeezy: 'rupeezy', rz: 'rupeezy', rupee: 'rupeezy' };
let pendingHoldings: ParsedHolding[] = [];

function parseDateToken(t: string): string | null {
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/); // Indian order: day first
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

function parseHolding(line: string): ParsedHolding {
  const clean = line.replace(/(\d),(?=\d{3}\b)/g, '$1').replace(/[₹@]/g, ' ').replace(/[,\t|;]+/g, ' ').trim();
  const tokens = clean.split(/\s+/);
  const out: ParsedHolding = { input: line.trim(), sym: null, name: '', broker: null, qty: 0, price: 0, date: localISO(), lev: 0, notes: [], error: null };
  const bi = tokens.findIndex((t, i) => i > 0 && BROKER_WORDS[t.toLowerCase()]);
  if (bi < 0) return { ...out, error: 'Add the broker (Kotak or Rupeezy)' };
  out.broker = BROKER_WORDS[tokens[bi].toLowerCase()];
  const rest = tokens.slice(bi + 1).filter((t) => t.toLowerCase() !== 'neo');
  const nums: number[] = [];
  let dated = false;
  for (const t of rest) {
    const d = parseDateToken(t);
    if (d) { out.date = d; dated = true; continue; }
    const lev = t.match(/^(\d+(?:\.\d+)?)[x×]$/i);
    if (lev) { out.lev = Number(lev[1]); continue; }
    const n = Number(t.replace(/^rs\.?/i, ''));
    if (Number.isFinite(n) && n > 0) nums.push(n);
  }
  [out.qty, out.price] = nums;
  if (!out.lev && nums[2] && nums[2] <= 10) out.lev = nums[2];
  const c = resolveLine(tokens.slice(0, bi).join(' '));
  if (!c) return { ...out, error: 'Stock not found: try its NSE symbol' };
  out.sym = c.sym;
  out.name = c.name;
  if (!(out.qty > 0) || !(out.price > 0)) return { ...out, error: 'Needs quantity and buy price' };
  if (out.date > localISO()) return { ...out, error: 'Buy date is in the future' };
  const cur = state.bySymbol.get(out.sym)?.[out.broker];
  if (!out.lev) {
    if (cur && cur.lev > 1) { out.lev = cur.lev; out.notes.push(`leverage ${round1(cur.lev)}× (current)`); }
    else { out.lev = 1; out.notes.push(`${BROKER_SHORT[out.broker]} does not fund it now: add leverage like 3x`); }
  }
  if (!dated) out.notes.push('bought today (add a date for interest so far)');
  return out;
}

function renderPendingHoldings() {
  const box = document.getElementById('h-pending');
  if (!box) return;
  const ok = pendingHoldings.filter((h) => !h.error);
  box.innerHTML = pendingHoldings.length
    ? `<div class="p-list">${pendingHoldings
        .map((h) => {
          const what = h.error
            ? `<span class="neg">${esc(h.error)}</span>`
            : `<b>${esc(h.sym!)}</b> · ${BROKER_SHORT[h.broker!]} · ${h.qty.toLocaleString('en-IN')} @ ${rupee(h.price)} · ${shortDate(h.date)} · ${round1(h.lev)}×${h.notes.length ? `<div class="muted small">${esc(h.notes.join(' · '))}</div>` : ''}`;
          return `<div class="p-row"><div class="p-main"><div class="p-in">${esc(h.input)}</div><div class="p-to">${what}</div></div>${h.error ? '<span class="badge miss">Check</span>' : '<span class="badge new">OK</span>'}</div>`;
        })
        .join('')}</div>`
    : '';
  const add = $<HTMLButtonElement>('#h-add');
  const rep = $<HTMLButtonElement>('#h-replace');
  add.disabled = rep.disabled = !ok.length;
  add.textContent = ok.length ? `Add ${ok.length} position${ok.length === 1 ? '' : 's'}` : 'Add positions';
  rep.textContent = ok.length ? `Replace all with these ${ok.length}` : 'Replace all';
}

async function openHoldingsImport() {
  const sheet = $<HTMLDialogElement>('#sheet');
  sheet.innerHTML = `
    <div class="sheet-inner">
      <div class="sheet-head">
        <div><div class="sym big">Import holdings</div><div class="name">One holding per line: stock, broker, quantity, avg buy price, then buy date and leverage if you know them.</div></div>
        <div class="sheet-actions"><button class="icon-btn" data-close aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
      </div>
      <textarea id="h-paste" rows="5" spellcheck="false" placeholder="CDSL, Kotak, 100, 1300, 10-10-2026, 4x&#10;Tube Investments, Rupeezy, 25, 3450, 15-09-2026&#10;HDFCBANK kotak 50 @ 1,710"></textarea>
      <div id="h-pending"></div>
      <div class="sheet-buttons">
        <button class="btn btn-primary" id="h-add" disabled>Add positions</button>
        <button class="btn btn-ghost" id="h-replace" disabled>Replace all</button>
      </div>
      <p class="muted small">Dates are day-month-year (10-10-2026) or 2026-10-10. Without a leverage, the broker's current multiplier is used. Positions stay on this device.</p>
    </div>`;
  pendingHoldings = [];
  if (!sheet.open) sheet.showModal();
  state.sheetSym = null;
  universe = buildUniverse(await loadSymbols());
  const ta = $<HTMLTextAreaElement>('#h-paste');
  ta.addEventListener('input', () => {
    pendingHoldings = ta.value.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map(parseHolding);
    renderPendingHoldings();
  });
  if (!matchMedia('(pointer: coarse)').matches) ta.focus();
}

function applyHoldings(replace: boolean) {
  const ok = pendingHoldings.filter((h) => !h.error);
  const current = loadPositions();
  if (replace && current.length && !confirm(`Replace your ${current.length} positions with these ${ok.length}?`)) return;
  const fresh: Position[] = ok.map((h, i) => ({
    id: `${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 5)}`,
    sym: h.sym!, broker: h.broker!, qty: h.qty, price: h.price, date: h.date, lev: h.lev,
  }));
  const toPin = new Set(fresh.map((p) => p.sym).filter((sym) => !state.pins.includes(sym)));
  savePositions(replace ? fresh : [...current, ...fresh]);
  ensureHeldPinned();
  $<HTMLDialogElement>('#sheet').close();
  state.view = 'positions';
  render();
  toast(`${replace ? 'Replaced with' : 'Added'} ${fresh.length} position${fresh.length === 1 ? '' : 's'}${toPin.size ? `; added ${toPin.size} to the watchlist` : ''}`);
}

function exportPositions() {
  const blob = new Blob([JSON.stringify({ positions: loadPositions(), exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mtf-positions-${localISO()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking at once can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// Removing everything asks first and offers a backup file, which "Import file" can restore.
function openClearSheet() {
  const n = loadPositions().length;
  if (!n) return;
  const sheet = $<HTMLDialogElement>('#sheet');
  sheet.innerHTML = `
    <div class="sheet-inner clear-sheet">
      <div class="sheet-head">
        <div><div class="sym big">Remove all ${n} position${n === 1 ? '' : 's'}?</div>
        <div class="name">This can't be undone. Save a file first if you may want them back: “Import file” restores it.</div></div>
        <div class="sheet-actions"><button class="icon-btn" data-close aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
      </div>
      <ul class="clear-notes">
        <li>Closed trades and realised P&amp;L stay.</li>
        ${store<string>(POS_PASS_KEY) ? '<li>Private sync is on, so your other devices clear too.</li>' : ''}
      </ul>
      <div class="clear-actions">
        <button class="btn btn-primary" data-clear="export">Save a file, then remove</button>
        <button class="btn btn-ghost btn-danger" data-clear="now">Remove without saving</button>
        <button class="btn btn-ghost" data-close>Cancel</button>
      </div>
    </div>`;
  state.sheetSym = null;
  if (!sheet.open) sheet.showModal();
}

function clearPositions(withExport: boolean) {
  const n = loadPositions().length;
  if (withExport) exportPositions();
  savePositions([]);
  $<HTMLDialogElement>('#sheet').close();
  toast(`${withExport ? 'Saved a file and removed' : 'Removed'} ${n} position${n === 1 ? '' : 's'}`);
  render();
}

async function importPositions(file: File) {
  try {
    const data = JSON.parse(await file.text());
    const list: Position[] = Array.isArray(data) ? data : data.positions;
    if (!Array.isArray(list) || list.some((p) => !p.sym || !p.qty || !p.price)) throw new Error('bad');
    const byId = new Map([...loadPositions(), ...list].map((p) => [p.id, p]));
    savePositions([...byId.values()]);
    ensureHeldPinned();
    render();
    toast(`Imported ${list.length} positions`);
  } catch {
    toast('That file is not a positions export');
  }
}

/* ---------- trade calculator ---------- */

// Defaults: Kotak Neo Trade Free Pro as published; Rupeezy on the owner's custom 10.99% + ₹20 plan.
// Every rate can be edited in the sheet and is remembered on the device.
const DEFAULT_RATES: Record<BrokerKey, BrokerRates> = {
  kotak: { interest: 9.69, brokPct: 0.1, brokFlat: 0, dpPct: 0.04, dpMin: 20, pledge: 20, unpledge: 20 },
  rupeezy: { interest: 10.99, brokPct: 0, brokFlat: 20, dpPct: 0, dpMin: 25, pledge: 25, unpledge: 25 },
};
const CALC_KEY = 'mtf.calc';
const RATES_KEY = 'mtf.calcRates';
const RATE_FIELDS: [keyof BrokerRates, string, string][] = [
  ['interest', 'MTF interest', '% p.a.'],
  ['brokPct', 'Brokerage', '% / order'],
  ['brokFlat', 'Brokerage', '₹ / order'],
  ['dpPct', 'DP on sell', '%'],
  ['dpMin', 'DP minimum', '₹'],
  ['pledge', 'Pledge', '₹'],
  ['unpledge', 'Unpledge', '₹'],
];

function calcInputs(): { funds: number; days: number; move: number } {
  return { funds: 100000, days: 30, move: 0, ...(store<{ funds: number; days: number; move: number }>(CALC_KEY) ?? {}) };
}

function brokerRates(): Record<BrokerKey, BrokerRates> {
  const saved = store<Partial<Record<BrokerKey, Partial<BrokerRates>>>>(RATES_KEY) ?? {};
  return {
    kotak: { ...DEFAULT_RATES.kotak, ...saved.kotak },
    rupeezy: { ...DEFAULT_RATES.rupeezy, ...saved.rupeezy },
  };
}

const inr = (n: number, dp = 0) =>
  `${n < 0 ? '−' : ''}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const inr2 = (n: number) => inr(n, Math.abs(n) < 1000 ? 2 : 0);

function calcSectionHTML(): string {
  const v = calcInputs();
  const rates = brokerRates();
  const rateRows = RATE_FIELDS.map(
    ([k, label, unit]) => `<tr><th>${label} <span class="muted">${unit}</span></th>${BROKERS.map(
      (b) => `<td><input type="number" inputmode="decimal" step="any" min="0" data-rate="${b}.${k}" value="${rates[b][k]}" aria-label="${BROKER_SHORT[b]} ${label} ${unit}" /></td>`,
    ).join('')}</tr>`,
  ).join('');
  return `<h3>Trade calculator</h3>
    <div class="calc-inputs">
      <label><span>Your funds</span><span class="calc-field"><span class="pre">₹</span><input type="number" inputmode="numeric" min="0" step="1000" data-calc="funds" value="${v.funds}" /></span></label>
      <label><span>Hold for</span><span class="calc-field"><input type="number" inputmode="numeric" min="1" step="1" data-calc="days" value="${v.days}" /><span class="post">days</span></span></label>
      <label><span>Sell price move</span><span class="calc-field"><input type="number" inputmode="decimal" step="0.5" data-calc="move" value="${v.move}" /><span class="post">%</span></span></label>
    </div>
    <div id="calc-out"></div>
    <details class="calc-rates">
      <summary>Rates used <span class="muted small">· edit to match your plan</span></summary>
      <div class="table-scroll"><table class="rates-table"><tr><th></th>${BROKERS.map((b) => `<th>${BROKER_SHORT[b]}</th>`).join('')}</tr>${rateRows}</table></div>
      <p class="muted small">Government and exchange (both): STT ${STATUTORY.stt}% buy and sell · NSE transaction ${STATUTORY.txn}% each side · SEBI ₹10/crore · stamp duty ${STATUTORY.stamp}% on buy · GST ${STATUTORY.gst}% on brokerage, transaction and SEBI charges and on DP and pledge charges. No GST on MTF interest. Kotak's ₹249/month Pro plan fee is not included.</p>
      <button class="btn btn-ghost" data-reset-rates>Reset to defaults</button>
    </details>`;
}

const HORIZONS = [7, 30, 90, 180, 365];
let horizonOpen = false; // keep the panel open while inputs re-render it

// Total cost grows in a straight line with days held (only interest depends on days), so the
// day the cheaper broker flips is where the two lines cross.
function horizonHTML(s: Stock, rates: Record<BrokerKey, BrokerRates>, funds: number, move: number): string {
  const funded = BROKERS.filter((b) => isFunded(s[b]));
  const at = (b: BrokerKey, d: number) => computeCosts(rates[b], funds, s[b]!.lev, d, move).total;
  const head = `<tr><th>Hold for</th>${funded.map((b) => `<th>${BROKER_SHORT[b]}</th>`).join('')}</tr>`;
  const body = HORIZONS.map((d) => {
    const totals = funded.map((b) => at(b, d));
    const low = Math.min(...totals);
    return `<tr${d === 365 ? ' class="strong"' : ''}><th>${d === 365 ? '1 year' : `${d} days`}</th>${totals
      .map((t) => `<td class="${funded.length > 1 && Math.abs(t - low) < 0.005 ? 'pos' : ''}">${inr(t)}</td>`)
      .join('')}</tr>`;
  }).join('');

  let verdict = '';
  if (funded.length === 2) {
    const [a, b] = funded;
    const fixedA = at(a, 0), fixedB = at(b, 0);
    const dailyA = at(a, 1) - fixedA, dailyB = at(b, 1) - fixedB;
    const nameA = BROKER_NAME[a], nameB = BROKER_NAME[b];
    if (Math.abs(dailyA - dailyB) < 1e-9) {
      verdict = fixedA <= fixedB ? `${nameA} is cheaper for any holding period.` : `${nameB} is cheaper for any holding period.`;
    } else {
      const cross = (fixedB - fixedA) / (dailyA - dailyB); // day the totals are equal
      const [shortB, longB] = fixedA <= fixedB ? [nameA, nameB] : [nameB, nameA];
      if (cross <= 0) verdict = `${dailyA < dailyB ? nameA : nameB} is cheaper for any holding period.`;
      else verdict = `<b>${shortB}</b> is cheaper for holds up to <b>${Math.floor(cross)} days</b>; <b>${longB}</b> is cheaper beyond that.`;
    }
  }
  return `<details class="calc-rates calc-horizon"${horizonOpen ? ' open' : ''}>
      <summary>Short term vs long term <span class="muted small">· up to 1 year</span></summary>
      ${verdict ? `<p class="horizon-verdict">${verdict}</p>` : ''}
      <div class="table-scroll"><table class="calc-table">${head}${body}</table></div>
      <p class="muted small">Total charges for the same funds and price move, held for each period. Brokerage, pledge, DP and taxes are paid once; only interest grows with time.</p>
    </details>`;
}

function renderCalc() {
  const out = document.getElementById('calc-out');
  const s = state.sheetSym ? state.bySymbol.get(state.sheetSym) : null;
  if (!out || !s) return;
  const { funds, days, move } = calcInputs();
  const rates = brokerRates();
  const res = BROKERS.map((b) => (isFunded(s[b]) ? computeCosts(rates[b], funds, s[b]!.lev, days, move) : null));
  const live = res.filter((r): r is CostBreakdown => !!r);
  const cheapest = live.length > 1 ? Math.min(...live.map((r) => r.total)) : null;

  const cell = (r: CostBreakdown | null, f: (r: CostBreakdown) => string, cls = '') => `<td class="${cls}">${r ? f(r) : '—'}</td>`;
  const row = (label: string, f: (r: CostBreakdown) => string, cls = '') =>
    `<tr class="${cls}"><th>${label}</th>${res.map((r) => cell(r, f)).join('')}</tr>`;
  const group = (label: string) => `<tr class="grp"><th colspan="${BROKERS.length + 1}">${label}</th></tr>`;

  const head = `<tr><th></th>${BROKERS.map((b, i) => `<th>${BROKER_SHORT[b]}${res[i] ? ` <span class="muted">${fmtLev(res[i]!.lev)}</span>` : ''}</th>`).join('')}</tr>`;
  const body = [
    row('You buy for', (r) => inr(r.buyValue), 'strong'),
    row('Broker funds', (r) => inr(r.funded)),
    group('Broker'),
    row('Brokerage on buy', (r) => inr2(r.brokBuy)),
    row('Brokerage on sell', (r) => inr2(r.brokSell)),
    row(`MTF interest · ${days} days`, (r) => inr2(r.interest)),
    group('Depository'),
    row('Pledge on buy', (r) => inr2(r.pledge)),
    row('Unpledge on sell', (r) => inr2(r.unpledge)),
    row('DP charge on sell', (r) => inr2(r.dp)),
    row('GST on DP and pledge', (r) => inr2(r.gstDepository)),
    group('Government and exchange'),
    row('STT (0.1% buy and sell)', (r) => inr2(r.stt)),
    row('NSE transaction', (r) => inr2(r.txn)),
    row('SEBI fee', (r) => inr2(r.sebi)),
    row('Stamp duty (buy)', (r) => inr2(r.stamp)),
    row('GST (brokerage, transaction, SEBI)', (r) => inr2(r.gstTrade)),
    `<tr class="total"><th>Total charges</th>${res
      .map((r) => cell(r, (x) => `${inr2(x.total)}${cheapest !== null && Math.abs(x.total - cheapest) < 0.005 ? '<span class="tag">Cheaper</span>' : ''}`))
      .join('')}</tr>`,
    row(
      'Charges as % of your funds',
      // Second line: everything except MTF interest, i.e. what the trade costs regardless of days held.
      (r) => `${((r.total / funds) * 100).toFixed(2)}%<span class="sub">(${(((r.total - r.interest) / funds) * 100).toFixed(2)}% excl. I)</span>`,
    ),
    row('Break-even price rise', (r) => `≈ ${r.breakEvenPct.toFixed(2)}%`),
    row(`Net P&L if price moves ${move}%`, (r) => `<span class="${r.pnl >= 0 ? 'pos' : 'neg'}">${inr2(r.pnl)}</span><span class="sub">${r.roiPct >= 0 ? '+' : ''}${r.roiPct.toFixed(1)}%</span>`, 'strong'),
  ].join('');

  const missing = BROKERS.filter((_, i) => !res[i]).map((b) => BROKER_NAME[b]);
  const horizon = live.length ? horizonHTML(s, rates, funds, move) : '';
  out.innerHTML = live.length
    ? `<div class="table-scroll"><table class="calc-table">${head}${body}</table></div>
       ${horizon}
       ${missing.length ? `<p class="muted small">${missing.join(' and ')} does not fund this stock for MTF.</p>` : ''}
       <p class="muted small">One buy order and one sell order on NSE, pledged in one request and sold in one go. Interest is charged on the broker's funds for each calendar day held. “excl. I” = excluding MTF interest.</p>`
    : '<p class="muted small">Neither broker funds this stock for MTF.</p>';
}

/* ---------- detail sheet ---------- */

// One timeline line: date column, title, the company's own words (two lines at most), link to the filing.
function eventLineHTML(date: string, title: string, detail: string, link: string | null, dot = ''): string {
  const today = localISO();
  const when = date === 'now' ? 'Now' : date === today ? 'Today' : shortDate(date);
  return `<li class="tl-item${date !== 'now' && date < today ? ' is-past' : ''}">
    <span class="tl-date${date === today ? ' is-today' : ''}">${when}</span>
    <div class="tl-body">
      <div class="tl-title">${dot ? `<span class="a-dot ${dot}" aria-hidden="true"></span>` : ''}${esc(title)}</div>
      ${detail ? `<p class="tl-detail">${esc(detail)}</p>` : ''}
      ${link ? `<a class="tl-link" href="${esc(safeUrl(link))}" target="_blank" rel="noopener">Read the filing</a>` : ''}
    </div>
  </li>`;
}

function eventsSectionHTML(sym: string): string {
  const items = stockEvents(sym).map((e) => {
    const title = e.kind === 'action' ? `${e.title} (ex-date)` : e.title;
    const dot = e.level === 'alert' ? 'severe' : e.level === 'watch' ? 'warn' : '';
    return eventLineHTML(e.date, title, e.detail, e.link, dot);
  });
  return items.length ? `<h3>Events</h3><ul class="timeline">${items.join('')}</ul>` : '';
}

const rupee = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
// Prices in lists: whole rupees from ₹1,000 up, two decimals below.
const lakh = (n: number) => (Math.abs(n) >= 1e5 ? `₹${(n / 1e5).toFixed(2)}L` : inr(n));
const rupeeShort = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: n >= 1000 ? 0 : 2 })}`;
const compact = (n: number) => (n >= 1e7 ? `${(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `${(n / 1e5).toFixed(2)} L` : n.toLocaleString('en-IN'));

// Price move from the close on the results day (or the last session before it) to now.
function sinceResults(sym: string): { date: string; move: number } | null {
  const px = state.market?.prices[sym];
  const res = (state.events[sym] ?? []).filter((e) => e.kind === 'result').sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!px || !res) return null;
  const base = [...px.closes].reverse().find(([d]) => d <= res.date);
  return base ? { date: res.date, move: (px.p / base[1] - 1) * 100 } : null;
}

// A position marker on a track, for ranges (52-week) and limits (F&O open interest).
function trackHTML(pct: number, ticks: number[] = [], cls = ''): string {
  const at = Math.max(0, Math.min(100, pct));
  return `<div class="track ${cls}" aria-hidden="true">${ticks.map((t) => `<span class="track-tick" style="left:${t}%"></span>`).join('')}<span class="track-dot" style="left:${at}%"></span></div>`;
}

function tile(label: string, value: string, hint = '', extra = ''): string {
  return `<div class="tile"><div class="tile-k">${label}</div><div class="tile-v">${value}</div>${extra}${hint ? `<div class="tile-h">${hint}</div>` : ''}</div>`;
}

function marketSectionHTML(sym: string, s: Stock): string {
  const m = state.market;
  if (!m) return '';
  const tiles: string[] = [];
  const px = m.prices[sym];
  if (px) {
    const when = new Date(px.t * 1000).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const chg = px.chg != null ? `<span class="${px.chg >= 0 ? 'pos' : 'neg'}">${px.chg >= 0 ? '+' : ''}${px.chg.toFixed(2)}%</span>` : '';
    tiles.push(tile('Price', `${rupee(px.p)} ${chg}`, `As of ${when}`));
    if (px.lo52 != null && px.hi52 != null && px.hi52 > px.lo52) {
      const pos = ((px.p - px.lo52) / (px.hi52 - px.lo52)) * 100;
      tiles.push(tile('52-week range', `${pos.toFixed(0)}%`, `Of the way from ${rupee(Math.round(px.lo52))} to ${rupee(Math.round(px.hi52))}`, trackHTML(pos)));
    }
    if (px.vol && px.avgVol) tiles.push(tile('Volume', `${(px.vol / px.avgVol).toFixed(1)}× usual`, `${compact(px.vol)} shares today`));
    const band = state.bands[sym]?.band;
    if (band && px.prev) tiles.push(tile('Circuit limits', `${band}% band`, `${rupee(px.prev * (1 - band / 100))} to ${rupee(px.prev * (1 + band / 100))}`));
  }
  const dv = m.deliv[sym];
  if (dv?.d != null) tiles.push(tile('Delivery', `${dv.d.toFixed(0)}%`, dv.avg != null ? `Usually ${dv.avg.toFixed(0)}%, ${shortDate(dv.date)}` : shortDate(dv.date)));
  const v = m.var.rows[sym];
  if (v?.m != null) {
    const cap = v.m > 0 ? 100 / v.m : null;
    tiles.push(tile('Exchange margin', `${v.m.toFixed(1)}%`, `${cap ? `Supports up to about ${round1(cap)}×` : ''}${v.adhoc ? `${cap ? ', ' : ''}incl. ${v.adhoc.toFixed(1)}% ad hoc` : ''}`));
  }
  const oi = m.mwpl.rows[sym];
  if (oi?.pct != null) {
    tiles.push(tile('F&amp;O open interest', `${oi.pct.toFixed(0)}% of limit`, oi.ban ? 'In the ban until it falls below 80%' : 'Ban starts at 95%', trackHTML(oi.pct, [80, 95], oi.pct >= 90 ? 'is-hot' : oi.pct >= 80 ? 'is-warm' : '')));
  }
  if (s.kotak?.maxExposureCr != null) tiles.push(tile('Kotak exposure cap', `₹${s.kotak.maxExposureCr} Cr`, 'Per client'));
  const pl = m.pledge[sym];
  if (pl) tiles.push(tile('Promoter pledge', `${pl.pct.toFixed(1)}%`, pl.promoter != null ? `Of their shares; promoters own ${pl.promoter.toFixed(0)}%` : 'Of promoter shares'));
  const sr = sinceResults(sym);
  if (sr) tiles.push(tile('Since results', `<span class="${sr.move >= 0 ? 'pos' : 'neg'}">${sr.move >= 0 ? '+' : ''}${sr.move.toFixed(1)}%</span>`, `From the close on ${shortDate(sr.date)}`));

  const deals = (m.deals[sym] ?? []).sort((a, b) => b.date.localeCompare(a.date));
  const dealList = deals
    .map((d) => `<li class="deal"><span class="tl-date">${shortDate(d.date)}</span><div><span class="${d.side === 'SELL' ? 'neg' : 'pos'}">${d.side === 'SELL' ? 'Sold' : 'Bought'}</span> ${d.qty ? compact(d.qty) : '?'} shares${d.price ? ` at ${rupee(d.price)}` : ''}<div class="tl-detail">${esc(titleCase(d.client))}, ${d.kind} deal</div></div></li>`)
    .join('');
  if (!tiles.length && !dealList) return '';
  return `${tiles.length ? `<div class="tiles">${tiles.join('')}</div>` : ''}
    ${dealList ? `<h3>Big deals this week</h3><ul class="deals">${dealList}</ul>` : ''}`;
}

function survSectionHTML(sym: string): string {
  const flags = state.surv[sym];
  if (!flags?.length) return '';
  const rows = flags
    .map((f) => eventLineHTML(f.exact && f.since ? f.since : 'now', `${survName(f)}, stage ${f.stage}`,
      `${f.ex.join(' and ')}. ${f.exact ? `Added ${fmtDate(f.since)}.` : `On the list since at least ${fmtDate(f.since)}.`}${f.desc && f.list === 'GSM' ? ` ${f.desc}.` : ''}`,
      null, survSevere(f) ? 'severe' : 'warn'))
    .join('');
  return `<h3>Surveillance</h3><ul class="timeline">${rows}</ul>`;
}

// What needs attention now, in plain words: the overview's short list, most serious first.
function attentionItems(sym: string): { level: 'severe' | 'warn' | 'info'; title: string; detail: string; link: string | null }[] {
  const out: ReturnType<typeof attentionItems> = [];
  if (inBan(sym)) out.push({ level: 'severe', title: 'In the F&O ban', detail: 'No new F&O positions until open interest falls below 80% of the limit.', link: BAN_LINK });
  const band = state.bands[sym];
  if (band?.band && band.band <= 5) out.push({ level: band.band <= 2 ? 'severe' : 'warn', title: `${band.band}% price band`, detail: `It can move at most ${band.band}% a day, so a leveraged position can get stuck at the circuit.`, link: null });
  if (band?.series === 'BE' || band?.series === 'BZ') out.push({ level: band.series === 'BZ' ? 'severe' : 'warn', title: `Trade-to-trade (${band.series})`, detail: 'Every trade settles by delivery; no intraday netting.', link: null });
  for (const f of state.surv[sym] ?? []) {
    out.push({ level: survSevere(f) ? 'severe' : 'warn', title: `${survName(f)}, stage ${f.stage}`, detail: f.exact ? `Added ${fmtDate(f.since)}.` : `On the list since at least ${fmtDate(f.since)}.`, link: null });
  }
  for (const e of stockEvents(sym)) {
    if (e.level === 'alert' || e.level === 'watch') out.push({ level: e.level === 'alert' ? 'severe' : 'warn', title: `${e.title}, ${shortDate(e.date)}`, detail: e.detail, link: e.kind === 'broker' ? null : e.link });
  }
  const m = state.market;
  const px = m?.prices[sym];
  if (px?.prev && band?.band && px.p <= px.prev * (1 - band.band / 100) * 1.01) out.push({ level: 'severe', title: 'At the lower circuit', detail: 'Sell orders may not fill until buyers return.', link: null });
  if (px?.chg != null && px.chg <= -5) out.push({ level: 'warn', title: `Down ${Math.abs(px.chg).toFixed(1)}% today`, detail: `At ${rupee(px.p)}.`, link: null });
  if (px?.lo52 && px.p <= px.lo52 * 1.005) out.push({ level: 'warn', title: 'At a 52-week low', detail: `At ${rupee(px.p)}.`, link: null });
  const oi = m?.mwpl.rows[sym];
  if (oi?.pct != null && oi.pct >= 80 && !inBan(sym)) out.push({ level: oi.pct >= 90 ? 'severe' : 'warn', title: `F&O open interest at ${oi.pct.toFixed(0)}% of the limit`, detail: 'The F&O ban starts at 95%.', link: null });
  const vm = m?.var.rows[sym]?.m;
  if (vm != null && vm >= 40) out.push({ level: vm >= 60 ? 'severe' : 'warn', title: `Exchange margin ${vm.toFixed(0)}%`, detail: `Brokers can fund at most about ${round1(100 / vm)}×.`, link: null });
  return out.sort((a, b) => (a.level === 'severe' ? 0 : 1) - (b.level === 'severe' ? 0 : 1));
}

function overviewHTML(sym: string, s: Stock): string {
  const items = attentionItems(sym);
  const line = (a: (typeof items)[number]) => `<li class="att-item"><span class="a-dot ${a.level}" aria-hidden="true"></span><div><div class="att-title">${esc(a.title)}</div>${a.detail ? `<p class="tl-detail">${esc(a.detail)}</p>` : ''}${a.link ? `<a class="tl-link" href="${esc(safeUrl(a.link))}" target="_blank" rel="noopener">Read the filing</a>` : ''}</div></li>`;
  const shown = items.slice(0, 4).map(line).join('');
  const rest = items.slice(4).map(line).join('');
  const attention = items.length
    ? `<h3>Needs attention</h3><ul class="att">${shown}</ul>${rest ? `<details class="more-list"><summary>${items.length - 4} more</summary><ul class="att">${rest}</ul></details>` : ''}`
    : '';
  const today = localISO();
  const next = stockEvents(sym).filter((e) => (e.kind === 'meeting' || e.kind === 'action') && e.date >= today).slice(0, 3);
  const res = sinceResults(sym);
  const coming = next.map((e) => eventLineHTML(e.date, e.kind === 'action' ? `${e.title} (ex-date)` : e.title, '', e.link)).join('');
  const resultsLine = res ? eventLineHTML(res.date, `Results out, ${res.move >= 0 ? 'up' : 'down'} ${Math.abs(res.move).toFixed(1)}% since`, '', (state.events[sym] ?? []).find((e) => e.kind === 'result')?.link ?? null) : '';
  const upcoming = coming || resultsLine ? `<h3>Coming up</h3><ul class="timeline">${resultsLine}${coming}</ul>` : '';
  const px = state.market?.prices[sym];
  const price = px
    ? `<div class="ov-price"><span class="ov-p">${rupee(px.p)}</span>${px.chg != null ? `<span class="${px.chg >= 0 ? 'pos' : 'neg'}">${px.chg >= 0 ? '+' : ''}${px.chg.toFixed(2)}% today</span>` : ''}</div>`
    : '';
  return `${price}<div class="d-list">${brokerRowsHTML(s)}</div>${attention}${upcoming}`;
}

function brokerRowsHTML(s: Stock): string {
  return BROKERS.map((b) => {
    const c = s[b];
    const own = c ? (b === 'kotak' ? (isFunded(c) ? `${Number((100 / c.lev).toFixed(1))}%` : '100%') : c.ownPct != null ? `${Number(c.ownPct.toFixed(2))}%` : '—') : '—';
    const lev = !c ? '<span class="none">Not listed</span>' : isFunded(c) ? fmtLev(c.lev) : '<span class="nf">Not funded</span>';
    return `<div class="d-row${s.best.includes(b) ? ' is-best' : ''}">
      <div class="d-broker">${BROKER_NAME[b]}</div>
      <div class="d-own">${c ? `<span class="muted small">Your share</span>${own}` : ''}</div>
      <div class="d-lev">${lev}${s.best.includes(b) && contested(s) ? '<span class="tag">Best</span>' : ''}</div>
    </div>`;
  }).join('');
}

type SheetTab = 'overview' | 'position' | 'costs' | 'market';
let sheetTab: SheetTab = 'overview';

async function openSheet(sym: string, tab?: SheetTab) {
  // Pinned stocks no broker funds still open, mainly to show their ASM/GSM status.
  const s = state.bySymbol.get(sym) ?? (state.pins.includes(sym) ? stubStock(sym) : null);
  if (!s) return;
  if (tab) sheetTab = tab;
  if (s.stub && (sheetTab === 'position' || sheetTab === 'costs')) sheetTab = 'overview';
  const sheet = $<HTMLDialogElement>('#sheet');
  const pinned = state.pins.includes(sym);
  const held = loadPositions().filter((p) => p.sym === sym).length;
  const attention = attentionItems(sym).length;
  const tabs: [SheetTab, string, string][] = [
    ['overview', 'Overview', attention ? `<span class="tab-dot" title="${attention} to look at"></span>` : ''],
    ...(s.stub ? [] : ([['position', 'Position', held ? `<span class="count">${held}</span>` : ''], ['costs', 'Costs', '']] as [SheetTab, string, string][])),
    ['market', 'Market', ''],
  ];
  const panel =
    sheetTab === 'position' ? positionSectionHTML(s)
    : sheetTab === 'costs' ? calcSectionHTML()
    : sheetTab === 'market'
      ? `${marketSectionHTML(sym, s)}${eventsSectionHTML(sym)}${survSectionHTML(sym)}<h3>Multiplier, last 7 days</h3><div class="history" id="history"><p class="muted small">Loading…</p></div><p class="muted small">Kotak does not publish an own-funds share; it is 1 ÷ leverage.</p>`
      : overviewHTML(sym, s);
  sheet.innerHTML = `
    <div class="sheet-inner">
      <div class="sheet-head">
        <div>
          <div class="sym big">${esc(s.symbol)}${s.type === 'etf' ? '<span class="pill">ETF</span>' : ''}</div>
          <div class="name">${esc(s.name)}</div>
        </div>
        <div class="sheet-actions">
          <button class="star${pinned ? ' on' : ''}" data-pin="${esc(sym)}" aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(sym)}">${ICON.star}</button>
          <button class="icon-btn" data-close aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        </div>
      </div>
      <div class="sheet-tabs" role="tablist">${tabs.map(([k, label, badge]) => `<button role="tab" data-sheet-tab="${k}" aria-selected="${k === sheetTab}">${label}${badge}</button>`).join('')}</div>
      <div class="sheet-panel">${panel}</div>
    </div>`;
  state.sheetSym = sym;
  renderCalc();
  if (!sheet.open) sheet.showModal();
  if (sheetTab !== 'market') return;
  try {
    state.history ??= await getJSON<History>('/data/history.json');
    renderHistory(sym);
  } catch {
    const el = document.getElementById('history');
    if (el) el.innerHTML = '<p class="muted small">No history yet.</p>';
  }
}

function renderHistory(sym: string) {
  const h = state.history!;
  const series = h.rows[sym];
  const el = document.getElementById('history');
  if (!el) return;
  if (!series || h.dates.length < 2) {
    el.innerHTML = '<p class="muted small">History builds up one day at a time. Check back tomorrow.</p>';
    return;
  }
  const day = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const head = `<tr><th></th>${h.dates.map((d) => `<th>${day(d)}</th>`).join('')}</tr>`;
  const body = h.brokers
    .map((b, bi) => {
      const cells = series.map((snap, i) => {
        const v = snap?.[bi] ?? null;
        const prev = i > 0 ? (series[i - 1]?.[bi] ?? null) : null;
        const cls = prev != null && v != null && round1(v) !== round1(prev) ? (round1(v) > round1(prev) ? 'up' : 'down') : '';
        return `<td class="${cls}">${v == null ? '—' : v > 1 ? round1(v) : '<span class="nf">×</span>'}</td>`;
      });
      return `<tr><th>${BROKER_SHORT[b]}</th>${cells.join('')}</tr>`;
    })
    .join('');
  el.innerHTML = `<div class="table-scroll"><table>${head}${body}</table></div>`;
}

/* ---------- add / edit pins ---------- */

interface Candidate {
  sym: string;
  name: string;
  n: string;
  words: string[];
  funded: boolean;
}

interface Resolved {
  input: string;
  sym: string | null;
  name: string;
}

let universe: Candidate[] | null = null;
let pending: Resolved[] = [];

const normName = (s: string) =>
  s
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[.,'()\-/]/g, ' ')
    .replace(/\b(LTD|LIMITED|THE)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function buildUniverse(symbols: Map<string, string>): Candidate[] {
  const names = new Map(symbols);
  for (const s of state.stocks) names.set(s.symbol, s.name);
  return [...names].map(([sym, name]) => {
    const n = normName(name);
    return { sym, name, n, words: n.split(' '), funded: state.bySymbol.has(sym) };
  });
}

function matchOne(q: string): Candidate | null {
  const Q = normName(q);
  if (!Q || !universe) return null;
  const bySym = (s: string) => universe!.find((c) => c.sym === s) ?? null;
  const alias = ALIASES[Q];
  if (alias) return bySym(alias);
  const exact = bySym(Q) ?? bySym(Q.replace(/\s+/g, ''));
  if (exact) return exact;
  const qWords = Q.split(' ');
  let best: Candidate | null = null;
  let bestScore = 0;
  for (const c of universe) {
    let score = 0;
    if (c.n === Q) score = 90;
    else if (c.n.startsWith(`${Q} `)) score = 70;
    else if (qWords.every((w) => c.words.some((nw) => nw.startsWith(w) || (w.length >= 4 && nw.length >= 4 && w.startsWith(nw))))) score = 60;
    else if (Q.length >= 3 && c.sym.startsWith(Q)) score = 50;
    if (!score) continue;
    score += (c.funded ? 5 : 0) - c.name.length / 1000;
    if (score > bestScore) [best, bestScore] = [c, score];
  }
  return best;
}

function resolveLine(line: string): Candidate | null {
  const paren = line.match(/\(([^)]+)\)/)?.[1];
  const base = line.replace(/\([^)]*\)/g, ' ').trim();
  return matchOne(base) ?? (paren ? matchOne(paren) : null);
}

// Accepts symbols or names, one per line or comma-separated. Bullets, headings and prose lines are skipped,
// so a whole watchlist note can be pasted as is.
function parsePaste(text: string): Resolved[] {
  const seen = new Set<string>();
  const out: Resolved[] = [];
  for (const raw of text.split(/[\n,;]+/)) {
    const line = raw.replace(/^\s*(?:[*\-•·>]+|\d+[.)])\s*/, '').trim();
    if (line.length <= 1 || line.startsWith('#') || line.split(/\s+/).length > 6) continue;
    const c = resolveLine(line);
    const key = c?.sym ?? `?${line.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ input: line, sym: c?.sym ?? null, name: c?.name ?? '' });
  }
  return out;
}

function renderPending() {
  const box = document.getElementById('pending');
  if (!box) return;
  const found = pending.filter((p) => p.sym);
  const fresh = found.filter((p) => !state.pins.includes(p.sym!));
  box.innerHTML = pending.length
    ? `<div class="p-list">${pending
        .map((p) => {
          const badge = !p.sym ? '<span class="badge miss">No match</span>' : state.pins.includes(p.sym) ? '<span class="badge">Pinned</span>' : '<span class="badge new">New</span>';
          const what = p.sym ? `<b>${esc(p.sym)}</b> <span class="muted">${esc(p.name)}</span>` : '<span class="muted">Try the NSE symbol instead</span>';
          return `<div class="p-row"><div class="p-main"><div class="p-in">${esc(p.input)}</div><div class="p-to">${what}</div></div>${badge}</div>`;
        })
        .join('')}</div>`
    : '';
  const add = $<HTMLButtonElement>('#add-go');
  const rep = $<HTMLButtonElement>('#replace-go');
  add.disabled = !fresh.length;
  add.textContent = fresh.length ? `Add ${fresh.length} to pins` : 'Add to pins';
  rep.disabled = !found.length;
  rep.textContent = found.length ? `Replace pins with these ${found.length}` : 'Replace pins';
}

function renderCurrentPins() {
  const box = document.getElementById('current-pins');
  if (!box) return;
  $('#current-count').textContent = String(state.pins.length);
  box.innerHTML = state.pins.length
    ? [...state.pins]
        .sort()
        .map((p) => `<span class="pin-chip">${esc(p)}<button data-unpin="${esc(p)}" aria-label="Remove ${esc(p)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg></button></span>`)
        .join('')
    : '<p class="muted small">No pins yet.</p>';
}

async function openAddSheet() {
  const sheet = $<HTMLDialogElement>('#sheet');
  sheet.innerHTML = `
    <div class="sheet-inner">
      <div class="sheet-head">
        <div><div class="sym big">Pinned stocks</div><div class="name">Paste names or NSE symbols, one per line or separated by commas.</div></div>
        <div class="sheet-actions"><button class="icon-btn" data-close aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
      </div>
      <textarea id="paste" rows="4" placeholder="Cummins, Tube Investments, Saregama&#10;PTCIL&#10;Crisil" spellcheck="false"></textarea>
      <div id="pending"></div>
      <div class="sheet-buttons">
        <button class="btn btn-primary" id="add-go" disabled>Add to pins</button>
        <button class="btn btn-ghost" id="replace-go" disabled>Replace pins</button>
      </div>
      <h3>Current pins <span class="count" id="current-count"></span></h3>
      <div class="pin-chips" id="current-pins"></div>
      <div class="sheet-buttons">
        <button class="btn btn-ghost danger" id="clear-pins">Remove all</button>
      </div>
    </div>`;
  pending = [];
  renderCurrentPins();
  if (!sheet.open) sheet.showModal();
  const symbols = await loadSymbols();
  universe = buildUniverse(symbols);
  const ta = $<HTMLTextAreaElement>('#paste');
  ta.addEventListener('input', () => {
    pending = parsePaste(ta.value);
    renderPending();
  });
  if (!matchMedia('(pointer: coarse)').matches) ta.focus();
}

function applyPending(replace: boolean) {
  const syms = pending.filter((p) => p.sym).map((p) => p.sym!);
  if (replace && !confirm(`Replace your ${state.pins.length} pins with these ${syms.length}?`)) return;
  const before = state.pins.length;
  state.pins = replace ? syms : [...new Set([...state.pins, ...syms])];
  savePins();
  render();
  $<HTMLDialogElement>('#sheet').close();
  toast(replace ? `Pinned ${state.pins.length} stocks` : `Added ${state.pins.length - before} stocks`);
}

/* ---------- popover for broker dots ---------- */

// Small floating card next to what was tapped; inside the stock sheet it lives in the dialog's layer.
function showPanel(anchor: HTMLElement, html: string, wide = false) {
  const pop = $('#popover');
  const host = anchor.closest('dialog') ?? document.body;
  if (pop.parentElement !== host) host.appendChild(pop);
  pop.innerHTML = html;
  pop.dataset.y = String(anchor.closest('dialog') ? anchor.closest('dialog')!.scrollTop + 100000 : window.scrollY);
  pop.classList.toggle('is-wide', wide);
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  pop.style.left = `${Math.min(Math.max(12, r.left), window.innerWidth - w - 12)}px`;
  const below = r.bottom + 8;
  pop.style.top = `${below + h > window.innerHeight - 12 && r.top - h - 8 > 12 ? r.top - h - 8 : below}px`;
}

function showPopover(btn: HTMLElement, b: BrokerKey) {
  const info = state.meta!.brokers[b];
  const label = { ok: 'Up to date', stale: 'Stale, showing last good data', failed: 'Failed' }[info.status];
  showPanel(btn, `<div class="pop-title"><span class="dot ${info.status}"></span>${BROKER_NAME[b]}</div>
    <p class="pop-sec">MTF list</p>
    <dl><dt>Status</dt><dd>${label}</dd><dt>Stocks</dt><dd>${fmtNum(info.count)}</dd><dt>Last fetch</dt><dd>${fmtTime(info.fetchedAt)}</dd></dl>
    ${info.error ? `<p class="pop-err">${esc(info.error)}</p>` : ''}
    ${accountPopHTML(b)}`);
}

// Account sync for one broker: 'off' (no passphrase or not set up), 'ok', or 'attention'.
function accountSyncState(b: BrokerKey): 'off' | 'ok' | 'attention' {
  if (!SYNC_ON || !store<string>(POS_PASS_KEY)) return 'off';
  const x = brokerSnap?.brokers[b];
  if (!x) return b === 'rupeezy' && brokerSnap ? 'attention' : 'off';
  return x.ok ? 'ok' : 'attention';
}

function accountPopHTML(b: BrokerKey): string {
  if (!SYNC_ON || !store<string>(POS_PASS_KEY)) return '';
  const x = brokerSnap?.brokers[b];
  const rows = !x
    ? `<dt>Status</dt><dd>Not connected</dd>`
    : x.ok
      ? `<dt>Status</dt><dd>Synced</dd><dt>Last sync</dt><dd>${fmtTime(x.at)}</dd>${(x.raw as { _errors?: Record<string, string> } | undefined)?._errors ? `<dt>Partial</dt><dd>${Object.keys((x.raw as { _errors: Record<string, string> })._errors).join(', ')} unavailable</dd>` : ''}`
      : `<dt>Status</dt><dd>Latest sync failed</dd><dt>Last good</dt><dd>${x.at ? fmtTime(x.at) : 'never'}</dd>`;
  const err = x && !x.ok && x.error ? `<p class="pop-err">${esc(x.error)}</p>` : '';
  const connect = b === 'rupeezy' && (!x || !x.ok) ? '<button class="btn btn-primary btn-sm pop-btn" data-connect-rupeezy>Connect Rupeezy</button>' : '';
  return `<p class="pop-sec">Your account</p><dl>${rows}</dl>${err}${connect}`;
}

// Everything flagged on a stock, in plain words: what a tapped pill opens.
function flagDetails(sym: string): { level: string; title: string; detail: string; link: string | null }[] {
  const out: { level: string; title: string; detail: string; link: string | null }[] = attentionItems(sym);
  for (const e of stockEvents(sym)) {
    if (e.kind === 'meeting' || e.kind === 'action' || e.kind === 'result') {
      const when = e.date === localISO() ? 'today' : shortDate(e.date);
      out.push({ level: 'info', title: `${e.title}${e.kind === 'action' ? ' (ex-date)' : ''}, ${when}`, detail: e.detail, link: e.link });
    }
    if (e.kind === 'broker' && e.level === 'info') out.push({ level: 'good', title: e.title, detail: e.detail, link: null });
  }
  const px = state.market?.prices[sym];
  const band = state.bands[sym]?.band;
  if (px?.chg != null && px.chg >= 5) out.push({ level: 'good', title: `Up ${px.chg.toFixed(1)}% today`, detail: `At ${rupee(px.p)}.`, link: null });
  if (px?.prev && band && px.p >= px.prev * (1 + band / 100) * 0.99) out.push({ level: 'good', title: 'At the upper circuit', detail: 'Buy orders may not fill until sellers return.', link: null });
  if (px?.hi52 && px.p >= px.hi52 * 0.995) out.push({ level: 'good', title: 'At a 52-week high', detail: `At ${rupee(px.p)}.`, link: null });
  if (px?.vol && px.avgVol && px.vol >= 3 * px.avgVol) {
    out.push({ level: 'info', title: `Volume ${(px.vol / px.avgVol).toFixed(1)}× the usual`, detail: `${compact(px.vol)} shares traded against a 20-day average of ${compact(px.avgVol)}. Big volume often comes with news or a big move.`, link: null });
  }
  return out;
}

function showFlags(anchor: HTMLElement, sym: string) {
  const items = flagDetails(sym);
  const list = items
    .map((a) => `<li class="att-item"><span class="a-dot ${a.level === 'good' ? 'good' : a.level}" aria-hidden="true"></span><div><div class="att-title">${esc(a.title)}</div>${a.detail ? `<p class="tl-detail">${esc(a.detail)}</p>` : ''}${a.link ? `<a class="tl-link" href="${esc(safeUrl(a.link))}" target="_blank" rel="noopener">Read the filing</a>` : ''}</div></li>`)
    .join('');
  showPanel(anchor, `<div class="pop-title">${esc(sym)}<span class="pop-sub">${items.length} flag${items.length === 1 ? '' : 's'}</span></div>
    <ul class="att pop-list">${list || '<li class="muted small">Nothing flagged right now.</li>'}</ul>
    <button class="btn btn-ghost btn-sm pop-open" data-open="${esc(sym)}">Open ${esc(sym)}</button>`, true);
}

// What the cushion line means, with this position's own numbers.
function showCushionHelp(track: HTMLElement) {
  const now = Number(track.dataset.now), be = Number(track.dataset.be), call = Number(track.dataset.call);
  const gap = ((now - call) / now) * 100;
  showPanel(track, `<div class="pop-title">Reading this line</div>
    <ul class="legend">
      <li><span class="lg-dot"></span><div><b>Today's price</b> ${rupeeShort(now)}</div></li>
      <li><span class="lg-tick is-call"></span><div><b>Top-up level</b> ${rupeeShort(call)}. Below it your margin is short and the broker asks for more money.</div></li>
      <li><span class="lg-zone"></span><div><b>Red stretch</b> is everything below the top-up level.</div></li>
      <li><span class="lg-tick"></span><div><b>Break-even</b> ${rupeeShort(be)}. Selling above it makes money after every charge and interest so far.</div></li>
    </ul>
    <p class="pop-note">${gap >= 0 ? `The dot is ${gap.toFixed(1)}% above the top-up level: that is your cushion.` : `The dot is ${Math.abs(gap).toFixed(1)}% inside the red stretch: add margin or reduce the position.`} The line is zoomed to these three prices, so short distances look long.</p>`, true);
}

/* ---------- toast ---------- */

let toastTimer = 0;
function toast(msg: string) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 3200);
}

/* ---------- pins import/export ---------- */

function exportPins() {
  const blob = new Blob([JSON.stringify({ pins: state.pins, exportedAt: new Date().toISOString() }, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mtf-pins.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importPins(file: File) {
  try {
    const data = JSON.parse(await file.text());
    const list: unknown = Array.isArray(data) ? data : data.pins;
    if (!Array.isArray(list)) throw new Error('bad file');
    const pins = list.map((p) => String(p).trim().toUpperCase()).filter(Boolean);
    state.pins = [...new Set([...state.pins, ...pins])];
    savePins();
    render();
    toast(`Imported ${pins.length} pins`);
  } catch {
    toast('That file is not a pin export');
  }
}

async function copyPinLink() {
  const url = `${location.origin}${location.pathname}?pins=${state.pins.map(encodeURIComponent).join(',')}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Pin link copied');
  } catch {
    prompt('Copy this link', url);
  }
}

/* ---------- refresh ---------- */

function cooldownLeft(): number {
  const last = store<number>(REFRESH_KEY) ?? 0;
  return Math.max(0, last + COOLDOWN_MS - Date.now());
}

function setRefreshButton(label: string, opts: { busy?: boolean; disabled?: boolean; title?: string } = {}) {
  const btn = $<HTMLButtonElement>('#refresh');
  btn.querySelector('span')!.textContent = label;
  btn.classList.toggle('busy', !!opts.busy);
  btn.disabled = !!opts.disabled;
  btn.title = opts.title ?? '';
}

function updateRefreshCooldown() {
  if (state.refreshing) return;
  if (run.status === 'running') return setRefreshButton('Refreshing…', { busy: true, disabled: true, title: 'A refresh is already running' });
  const left = cooldownLeft();
  if (left > 0) setRefreshButton('Refresh', { disabled: true, title: `Available again in ${Math.ceil(left / 60000)} min` });
  else setRefreshButton('Refresh');
}

type TriggerResult = { status: number; body: { error?: string; runStatus?: string } };

// Vercel mode: the serverless function holds the GitHub token and checks a passcode.
async function triggerViaApi(pass: string): Promise<TriggerResult> {
  const r = await fetch('/api/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode: pass }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// GitHub Pages mode: same checks as api/refresh.js, run in the browser with a token saved on this device.
// The button runs the quick sync (accounts + prices, under a minute); the full refresh runs hourly.
const QUICK_WORKFLOW = 'brokers.yml';

async function triggerViaGitHub(token: string): Promise<TriggerResult> {
  const base = `https://api.github.com/repos/${GH_REPO}/actions/workflows/${QUICK_WORKFLOW}`;
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  const runs = await fetch(`${base}/runs?per_page=1`, { headers, cache: 'no-store' });
  if (runs.status === 401 || runs.status === 403 || runs.status === 404) return { status: 401, body: {} };
  if (!runs.ok) return { status: 502, body: { error: `GitHub: ${runs.status}` } };
  const last = (await runs.json()).workflow_runs?.[0];
  if (last) {
    const age = Date.now() - new Date(last.created_at).getTime();
    if (last.status !== 'completed') return { status: 429, body: { runStatus: last.status } };
    if (age < COOLDOWN_MS) {
      const mins = Math.max(1, Math.ceil((COOLDOWN_MS - age) / 60000));
      return { status: 429, body: { runStatus: 'completed', error: `Refreshed recently. Try again in ${mins} min` } };
    }
  }
  const d = await fetch(`${base}/dispatches`, { method: 'POST', headers, body: JSON.stringify({ ref: GH_REF }) });
  if (d.status === 401 || d.status === 403) return { status: 401, body: {} };
  return d.status === 204 ? { status: 202, body: {} } : { status: 502, body: { error: `GitHub dispatch failed: ${d.status}` } };
}

async function refresh() {
  if (state.refreshing || cooldownLeft() > 0) return;
  const github = REFRESH_MODE === 'github';
  const key = github ? GH_TOKEN_KEY : PASS_KEY;
  let pass = store<string>(key);
  if (!pass) {
    pass =
      prompt(
        github
          ? 'GitHub token (fine-grained, this repo only, with Actions and Contents: Read and write). It is saved only in this browser.'
          : 'Refresh passcode',
      )?.trim() || null;
    if (!pass) return;
  }
  state.refreshing = true;
  setRefreshButton('Refreshing…', { busy: true, disabled: true });
  try {
    const { status, body } = github ? await triggerViaGitHub(pass) : await triggerViaApi(pass);
    const r = { status, ok: status >= 200 && status < 300 };
    if (r.status === 401) {
      store(key, '');
      throw new Error(github ? 'GitHub rejected that token' : 'Wrong passcode');
    }
    if (!r.ok && r.status !== 429) throw new Error(body.error || `Refresh failed (${r.status})`);
    store(key, pass);
    store(REFRESH_KEY, Date.now());
    if (r.status === 429 && body.runStatus === 'completed') {
      state.refreshing = false;
      toast(body.error || 'Refreshed recently');
      updateRefreshCooldown();
      return;
    }
    if (r.status === 429) toast('A refresh is already running. Watching for its result.');
    if (github) await pollQuickSync();
    else {
      window.setTimeout(checkRun, 5000); // show "Refreshing now" as soon as GitHub reports the run
      await pollForUpdate();
    }
  } catch (e) {
    toast((e as Error).message);
    state.refreshing = false;
    updateRefreshCooldown();
  }
}

// Wait for the quick sync to finish, then read the fresh files straight from GitHub's API (live, no
// waiting for the site to be rebuilt): your broker accounts and prices.
async function pollQuickSync() {
  const started = Date.now();
  const runs = `https://api.github.com/repos/${GH_REPO}/actions/workflows/${QUICK_WORKFLOW}/runs?per_page=1`;
  while (Date.now() - started < 4 * 60_000) {
    await new Promise((res) => setTimeout(res, 6000));
    setRefreshButton(`Syncing… ${Math.round((Date.now() - started) / 1000)}s`, { busy: true, disabled: true });
    try {
      const last = (await (await fetch(runs, { headers: ghHeaders(), cache: 'no-store' })).json()).workflow_runs?.[0];
      if (!last || new Date(last.created_at).getTime() < started - 60_000 || RUN_ACTIVE.has(last.status)) continue;
      await Promise.all([loadBrokerSnapshot(), reloadMarketLive()]);
      state.refreshing = false;
      setRefreshButton('Updated', { disabled: true });
      toast(last.conclusion === 'success' ? `Synced in ${Math.round((Date.now() - started) / 1000)}s` : 'Sync finished with errors: see the broker status in the header');
      setTimeout(updateRefreshCooldown, 3000);
      return;
    } catch {
      /* keep polling */
    }
  }
  state.refreshing = false;
  setRefreshButton('Still running, check back shortly', { disabled: true });
  setTimeout(updateRefreshCooldown, 8000);
}

async function reloadMarketLive() {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/public/data/market.json?ref=${encodeURIComponent(GH_REF)}`, {
    headers: { ...ghHeaders(), Accept: 'application/vnd.github.raw+json' }, cache: 'no-store',
  });
  if (!r.ok) return;
  state.market = await r.json();
  render();
}

async function pollForUpdate() {
  const before = state.meta?.generatedAt;
  const start = Date.now();
  while (Date.now() - start < POLL_MAX_MS) {
    await new Promise((res) => setTimeout(res, POLL_MS));
    try {
      const meta = await getJSON<Meta>('/data/meta.json');
      if (meta.generatedAt !== before) {
        const stocks = await getJSON<Stock[]>('/data/mtf.json');
        setData(stocks, meta);
        renderAll();
        loadExtras();
        state.refreshing = false;
        setRefreshButton('Updated', { disabled: true });
        toast(`Updated ${fmtTime(meta.generatedAt, false)}`);
        setTimeout(updateRefreshCooldown, 4000);
        return;
      }
    } catch {
      /* keep polling */
    }
  }
  state.refreshing = false;
  setRefreshButton('Still running, check back shortly', { disabled: true });
  setTimeout(updateRefreshCooldown, 8000);
}

/* ---------- events ---------- */

function bind() {
  const q = $<HTMLInputElement>('#q');
  $('.search').addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('button')) q.focus();
  });
  q.addEventListener('input', () => {
    state.query = q.value;
    renderList();
  });

  document.addEventListener('keydown', (e) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
    if (e.key === '/' && !typing) {
      e.preventDefault();
      q.focus();
      q.select();
    } else if (e.key === 'Escape' && document.activeElement === q) {
      q.value = '';
      state.query = '';
      renderList();
      q.blur();
    } else if (e.key === 'Enter' && e.target instanceof HTMLElement && e.target.classList.contains('row')) {
      openSheet(e.target.dataset.sym!, 'overview');
    }
  });

  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const pop = $('#popover');
    const dot = t.closest<HTMLElement>('.dot-btn');
    if (dot) {
      const b = dot.dataset.broker as BrokerKey;
      if (!pop.hidden && pop.dataset.for === b) pop.hidden = true;
      else {
        pop.dataset.for = b;
        showPopover(dot, b);
      }
      return;
    }
    if (!t.closest('#popover')) pop.hidden = true;

    // A tapped flag explains itself (on the watchlist and in Positions), without opening the stock.
    const flag = t.closest<HTMLElement>('.flag');
    const flagSym = flag?.closest<HTMLElement>('[data-sym]')?.dataset.sym;
    if (flag && flagSym) {
      e.stopPropagation();
      return showFlags(flag, flagSym);
    }
    const track = t.closest<HTMLElement>('.pr-track');
    if (track) return showCushionHelp(track);

    const pin = t.closest<HTMLElement>('[data-pin]');
    if (pin) {
      togglePin(pin.dataset.pin!);
      if ($<HTMLDialogElement>('#sheet').open) openSheet(pin.dataset.pin!);
      return;
    }
    if (t.closest('[data-close]')) {
      $<HTMLDialogElement>('#sheet').close();
      return;
    }
    if (t.closest('[data-add]')) return void openAddSheet();
    const st = t.closest<HTMLElement>('[data-sheet-tab]');
    if (st && state.sheetSym) {
      openSheet(state.sheetSym, st.dataset.sheetTab as SheetTab);
      $('#sheet').scrollTop = 0;
      return;
    }
    if (t.closest('#bell')) return openAlerts();
    const al = t.closest<HTMLElement>('[data-alert-level]');
    if (al) {
      store(ALERT_LEVEL_KEY, al.dataset.alertLevel || null);
      return openAlerts(true);
    }
    const af = t.closest<HTMLElement>('[data-alert-filter]');
    if (af) {
      store(ALERT_FILTER_KEY, af.dataset.alertFilter);
      return openAlerts(true);
    }
    const posSave = t.closest<HTMLElement>('[data-pos-save]');
    if (posSave) return savePositionFromForm(posSave.dataset.posSave!);
    const posDel = t.closest<HTMLElement>('[data-pos-del]');
    if (posDel) {
      if (!confirm('Remove this position from this device?')) return;
      savePositions(loadPositions().filter((p) => p.id !== posDel.dataset.posDel));
      if ($<HTMLDialogElement>('#sheet').open && state.sheetSym) openSheet(state.sheetSym);
      render();
      return;
    }
    if (t.closest('#pos-export')) return exportPositions();
    if (t.closest('#pos-clear')) return openClearSheet();
    const acct = t.closest('[data-connect-rupeezy]') ? null : t.closest<HTMLElement>('[data-acct]');
    if (acct) {
      const b = acct.dataset.acct as BrokerKey;
      if (!pop.hidden && pop.dataset.for === `acct-${b}`) return void (pop.hidden = true);
      pop.dataset.for = `acct-${b}`;
      return showPanel(acct, `<div class="pop-title">${BROKER_NAME[b]} account</div>${accountPopHTML(b) || '<p class="muted small">Turn on private sync in Manage positions to connect your broker accounts.</p>'}<p class="pop-sec">How margin is counted</p><p class="muted small">Needs: each holding's value × the broker's margin % for it today. Equity: your cash + unrealised P&amp;L − interest. A buy paid from spare margin adds no cash, so it lowers the spare.</p>`);
    }
    const ce = t.closest<HTMLElement>('[data-cash-edit]');
    if (ce) return editLotCash(ce.dataset.cashEdit!);
    if (t.closest('[data-connect-rupeezy]')) return connectRupeezy();
    const clr = t.closest<HTMLElement>('[data-clear]');
    if (clr) return clearPositions(clr.dataset.clear === 'export');
    if (t.closest('[data-pnl-start]')) return setStartPnl();
    const ps = t.closest<HTMLElement>('[data-possync]');
    if (ps) return void setPositionsPassphrase(ps.dataset.possync === 'on');
    const sell = t.closest<HTMLElement>('[data-sell]');
    if (sell) return openSellSheet(sell.dataset.sell!);
    if (t.closest('#sell-save')) return saveSale();
    const cdel = t.closest<HTMLElement>('[data-closed-del]');
    if (cdel) {
      if (!confirm('Delete this closed trade record?')) return;
      saveClosed(loadClosed().filter((x) => x.id !== cdel.dataset.closedDel));
      return renderList();
    }
    const pm = t.closest<HTMLElement>('[data-posmode]');
    if (pm) {
      store(POS_VIEW_KEY, { ...posView(), mode: pm.dataset.posmode });
      return renderList();
    }
    const pf = t.closest<HTMLElement>('[data-posf]');
    if (pf) {
      const [key, value] = pf.dataset.posf!.split(':');
      const v = posView() as unknown as Record<string, unknown>;
      if (key === 'results') v.results = !v.results;
      else v[key] = v[key] === value ? 'all' : value; // tap again to clear
      store(POS_VIEW_KEY, v);
      return renderList();
    }
    if (t.closest('[data-import-holdings]')) return void openHoldingsImport();
    if (t.closest('#h-add')) return applyHoldings(false);
    if (t.closest('#h-replace')) return applyHoldings(true);
    const openPos = t.closest<HTMLElement>('[data-open-pos]');
    if (openPos) return void openSheet(openPos.dataset.openPos!, 'position');
    const openSym = t.closest<HTMLElement>('[data-open]');
    if (openSym) {
      pop.hidden = true;
      return void openSheet(openSym.dataset.open!, 'overview');
    }
    if (t.closest('[data-reset-rates]')) {
      store(RATES_KEY, {});
      positionsChanged();
      if (state.sheetSym) openSheet(state.sheetSym);
      return;
    }
    if (t.closest('#add-go')) return applyPending(false);
    if (t.closest('#replace-go')) return applyPending(true);
    const unpin = t.closest<HTMLElement>('[data-unpin]');
    if (unpin) {
      togglePin(unpin.dataset.unpin!);
      renderCurrentPins();
      renderPending();
      return;
    }
    if (t.closest('[data-connect]')) return connectGitHub();
    if (t.closest('#clear-pins')) {
      if (!confirm(`Remove all ${state.pins.length} pins?`)) return;
      state.pins = [];
      savePins();
      render();
      renderCurrentPins();
      return;
    }
    const view = t.closest<HTMLElement>('[data-view]');
    if (view) {
      state.view = view.dataset.view as 'pinned' | 'all' | 'positions';
      state.limit = PAGE;
      // Positions is its own page, without search.
      if (state.view === 'positions' && state.query) {
        state.query = '';
        $<HTMLInputElement>('#q').value = '';
      }
      render();
      return;
    }
    const typeBtn = t.closest<HTMLElement>('[data-type]');
    if (typeBtn) {
      setType(typeBtn.dataset.type as 'equity' | 'etf');
      return;
    }
    if (t.closest('[data-results]')) {
      state.results = !state.results;
      state.limit = PAGE;
      render();
      return;
    }
    if (t.closest('[data-solo]')) {
      state.solo = !state.solo;
      state.limit = PAGE;
      render();
      return;
    }
    const chip = t.closest<HTMLElement>('[data-filter]');
    if (chip) {
      const b = chip.dataset.filter as BrokerKey;
      state.filter = state.filter === b ? null : b;
      state.limit = PAGE;
      render();
      return;
    }
    if (t.closest('#more')) {
      state.limit += PAGE * 3;
      renderList();
      return;
    }
    if (t.closest('#copy-link')) return void copyPinLink();
    if (t.closest('#export')) return void exportPins();
    const row = t.closest<HTMLElement>('.row');
    if (row) openSheet(row.dataset.sym!, 'overview');
  });

  $<HTMLDialogElement>('#sheet').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) (e.currentTarget as HTMLDialogElement).close();
  });

  document.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'sell-qty' || t.id === 'sell-price' || t.id === 'sell-date') {
      renderSellPreview();
      return;
    }
    if (t.dataset.calc) {
      const v = calcInputs();
      const n = Number(t.value);
      if (t.value === '' || !Number.isFinite(n)) return;
      store(CALC_KEY, { ...v, [t.dataset.calc]: n });
      renderCalc();
    } else if (t.dataset.rate) {
      const [b, k] = t.dataset.rate.split('.') as [BrokerKey, keyof BrokerRates];
      const n = Number(t.value);
      if (t.value === '' || !Number.isFinite(n) || n < 0) return;
      const saved = store<Partial<Record<BrokerKey, Partial<BrokerRates>>>>(RATES_KEY) ?? {};
      store(RATES_KEY, { ...saved, [b]: { ...saved[b], [k]: n } });
      positionsChanged();
      renderCalc();
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target as HTMLElement;
    if (t.id === 'pos-sort') {
      store(POS_VIEW_KEY, { ...posView(), sort: (t as HTMLSelectElement).value as PosSort });
      renderList();
    } else if (t.id === 'sort') {
      state.sort = (t as HTMLSelectElement).value as typeof state.sort;
      renderList();
    } else if (t.id === 'pos-broker') {
      // Default the leverage field to the chosen broker's current multiplier.
      const opt = (t as HTMLSelectElement).selectedOptions[0];
      const lev = document.getElementById('pos-lev') as HTMLInputElement | null;
      if (opt && lev) lev.value = opt.dataset.lev ?? lev.value;
    } else if (t.id === 'pos-import') {
      const f = (t as HTMLInputElement).files?.[0];
      if (f) importPositions(f);
    } else if (t.id === 'import') {
      const f = (t as HTMLInputElement).files?.[0];
      if (f) importPins(f);
    }
  });

  document.addEventListener(
    'toggle',
    async (e) => {
      const d = e.target as HTMLDetailsElement;
      if (d.classList?.contains('calc-horizon')) horizonOpen = d.open;
      if (d.id !== 'unmatched' || !d.open) return;
      try {
        state.unmatched ??= await getJSON<Unmatched[]>('/data/unmatched.json');
        const rows = state.unmatched
          .slice(0, 300)
          .map((u) => `<tr><td>${BROKER_SHORT[u.broker]}</td><td>${esc(titleCase(u.name || ''))}</td><td class="mono">${esc(u.symbol || u.isin || '')}</td><td class="num">${fmtLev(u.lev)}</td></tr>`)
          .join('');
        d.querySelector('.unmatched-body')!.innerHTML = `<p class="muted small">These rows could not be tied to an NSE symbol (often BSE-only or recently renamed). Add a line to <code>data/overrides.csv</code> to fix one.</p><div class="table-scroll"><table>${rows}</table></div>`;
      } catch {
        d.querySelector('.unmatched-body')!.innerHTML = '<p class="muted small">Could not load the list.</p>';
      }
    },
    true,
  );

  $('#refresh').addEventListener('click', refresh);
  window.addEventListener('resize', () => ($('#popover').hidden = true));
  // Close a floating card once the page has really moved, not on the tail of the scroll that led to the tap.
  const closeOnScroll = (y: number) => {
    const pop = $('#popover');
    if (!pop.hidden && Math.abs(y - Number(pop.dataset.y ?? y)) > 40) pop.hidden = true;
  };
  window.addEventListener('scroll', () => closeOnScroll(window.scrollY), { passive: true });
  $('#sheet').addEventListener('scroll', () => closeOnScroll($('#sheet').scrollTop + 100000), { passive: true });
  $('#sheet').addEventListener('close', () => {
    const pop = $('#popover');
    pop.hidden = true;
    if (pop.parentElement !== document.body) document.body.appendChild(pop);
  });
}

/* ---------- boot ---------- */

async function boot() {
  const fromUrl = new URLSearchParams(location.search).get('pins');
  const saved = store<string[]>(PIN_KEY);
  if (fromUrl !== null) {
    state.pins = [...new Set(fromUrl.split(',').map((p) => p.trim().toUpperCase()).filter(Boolean))];
    savePins();
    history.replaceState(null, '', location.pathname);
  } else {
    state.pins = saved ?? DEFAULT_PINS.slice();
    // First run with sync on a device that already had pins: nothing it added may be lost,
    // so treat its list as additions on top of the shared one.
    if (SYNC_ON && saved && store(BASE_KEY) === null && saved.join() !== DEFAULT_PINS.join()) {
      store(BASE_KEY, []);
      store(DIRTY_KEY, true);
    }
  }

  // With sync, held stocks are added on top of the shared list after it loads (see pullPins).
  if (!SYNC_ON) ensureHeldPinned();

  // Remember whether the summary's margin section is open.
  document.addEventListener('toggle', (e) => {
    const d = e.target as HTMLElement;
    if (d.classList?.contains('ps-more')) store(PS_MORE_KEY, (d as HTMLDetailsElement).open);
    if (d.classList?.contains('ps-overall')) store(OV_OPEN_KEY, (d as HTMLDetailsElement).open);
  }, true);

  // Pick up edits made on other devices when this tab comes back into view.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!sync.busy) pullPins();
    pullPositions();
    loadBrokerSnapshot();
    checkRun();
  });
  pullPins();
  pullPositions();
  loadBrokerSnapshot();
  const rzAuth = new URLSearchParams(location.search).get('auth');
  if (rzAuth) finishRupeezyLogin(rzAuth);

  bind();
  updateRefreshCooldown();
  setInterval(updateRefreshCooldown, 30000);
  $('#list').innerHTML = '<div class="skeleton"></div>'.repeat(6);
  try {
    await loadData();
    renderAll();
    checkRun();
    if (fromUrl !== null) toast(`Loaded ${state.pins.length} pins from link`);
  } catch (e) {
    $('#list').innerHTML = `<div class="empty"><p class="empty-title">Could not load data</p><p>${esc((e as Error).message)}</p></div>`;
  }
}

boot();
