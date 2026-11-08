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
  kind: 'meeting' | 'action' | 'news' | 'broker';
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
const COOLDOWN_MS = 10 * 60 * 1000;
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
  view: 'pinned' as 'pinned' | 'all',
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
  const base = new Set(store<string[]>(BASE_KEY) ?? remote);
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
    render();
    return void pushPins();
  }
  state.pins = remote.pins;
  store(PIN_KEY, state.pins);
  store(BASE_KEY, remote.pins);
  sync.at = Date.now();
  setSync('synced');
  render();
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
  if (i >= 0) state.pins.splice(i, 1);
  else state.pins.push(sym);
  savePins();
  render();
}

/* ---------- formatting ---------- */

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
  const evs = all.filter((e) => e.kind === 'meeting' || e.kind === 'action');
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

function flagsHTML(sym: string): string {
  return eventFlagsHTML(sym) + (state.surv[sym] ?? [])
    .map((f) => {
      const title = `${f.ex.join(' + ')} · ${survName(f)} · Stage ${f.stage} · ${survSince(f)}`;
      return `<span class="flag${survSevere(f) ? ' severe' : ''}" title="${esc(title)}">${esc(survLabel(f))}</span>`;
    })
    .join('');
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
      <div class="sym">${esc(s.symbol)}${s.type === 'etf' ? '<span class="pill">ETF</span>' : ''}${flagsHTML(s.symbol)}</div>
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
    return `<button class="dot-btn" data-broker="${b}" aria-label="${BROKER_NAME[b]}: ${info.status}"><span class="dot ${info.status}"></span>${BROKER_SHORT[b]}${age}</button>`;
  }).join('');
  $('#status').innerHTML = `<span class="updated">Updated ${fmtTime(m.generatedAt)}</span><span class="dots">${dots}</span>`;
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
        <ul class="sources">${fetches}${survSourcesHTML(m)}${eventSourcesHTML(m)}</ul>
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
    row('Charges as % of your funds', (r) => `${((r.total / funds) * 100).toFixed(2)}%`),
    row('Break-even price rise', (r) => `≈ ${r.breakEvenPct.toFixed(2)}%`),
    row(`Net P&L if price moves ${move}%`, (r) => `<span class="${r.pnl >= 0 ? 'pos' : 'neg'}">${inr2(r.pnl)} <span class="muted">(${r.roiPct.toFixed(1)}%)</span></span>`, 'strong'),
  ].join('');

  const missing = BROKERS.filter((_, i) => !res[i]).map((b) => BROKER_NAME[b]);
  const horizon = live.length ? horizonHTML(s, rates, funds, move) : '';
  out.innerHTML = live.length
    ? `<div class="table-scroll"><table class="calc-table">${head}${body}</table></div>
       ${horizon}
       ${missing.length ? `<p class="muted small">${missing.join(' and ')} does not fund this stock for MTF.</p>` : ''}
       <p class="muted small">One buy order and one sell order on NSE, pledged in one request and sold in one go. Interest is charged on the broker's funds for each calendar day held.</p>`
    : '<p class="muted small">Neither broker funds this stock for MTF.</p>';
}

/* ---------- detail sheet ---------- */

function eventsSectionHTML(sym: string): string {
  const today = localISO();
  const levelBadge = (e: CoEvent) =>
    e.level === 'alert' ? '<span class="flag severe">Serious</span> ' : e.level === 'watch' ? '<span class="flag">Check</span> ' : '';
  const kindNote = (e: CoEvent) =>
    e.kind === 'action' ? ' <span class="muted small">· ex-date</span>' : e.kind === 'news' ? ' <span class="muted small">· announcement</span>' : '';
  const rows = stockEvents(sym).map((e) => {
    const when = e.date < today ? 'past' : e.date === today ? 'today' : '';
    return `<div class="e-row">
      <div class="e-date${when ? ` ${when}` : ''}"><span>${shortDate(e.date)}</span>${when === 'today' ? '<span class="tag">Today</span>' : ''}</div>
      <div class="e-main"><div class="e-title">${levelBadge(e)}${esc(e.title)}${kindNote(e)}</div>
        ${e.detail ? `<div class="muted small">${esc(e.detail)}</div>` : ''}
        <a class="e-link" href="${esc(e.link)}" target="_blank" rel="noopener">Read more ↗</a></div>
    </div>`;
  });
  const band = state.bands[sym];
  if (band && (band.series === 'BE' || band.series === 'BZ' || (band.band && band.band <= 10))) {
    const notes: string[] = [];
    if (band.band) notes.push(`Price band ${band.band}%: the stock can move at most ${band.band}% in a day, so a leveraged position can get stuck at the circuit.`);
    if (band.series === 'BE' || band.series === 'BZ') notes.push(`Trade-to-trade (${band.series}): every trade settles by delivery and no intraday netting is allowed${band.series === 'BZ' ? '; BZ also marks companies that have not met listing requirements' : ''}.`);
    rows.unshift(`<div class="e-row">
      <div class="e-date"><span>Now</span></div>
      <div class="e-main"><div class="e-title">${band.series === 'BE' || band.series === 'BZ' ? `<span class="flag${band.series === 'BZ' ? ' severe' : ''}">T2T</span> ` : ''}${band.band ? `<span class="flag${band.band <= 2 ? ' severe' : ''}">${band.band}% band</span>` : ''}</div>
        <div class="muted small">${notes.join(' ')}</div>
        <a class="e-link" href="https://nsearchives.nseindia.com/content/equities/sec_list.csv" target="_blank" rel="noopener">Read more ↗</a></div>
    </div>`);
  }
  if (inBan(sym)) {
    rows.unshift(`<div class="e-row">
      <div class="e-date"><span>${shortDate(state.ban!.date)}</span></div>
      <div class="e-main"><div class="e-title"><span class="flag severe">F&amp;O ban</span></div>
        <div class="muted small">In NSE's F&amp;O ban period: open interest is above 95% of the market-wide limit, so no new F&amp;O positions can be opened.</div>
        <a class="e-link" href="${BAN_LINK}" target="_blank" rel="noopener">Read more ↗</a></div>
    </div>`);
  }
  return rows.length ? `<h3>Alerts and events</h3><div class="s-list">${rows.join('')}</div>` : '';
}

function survSectionHTML(sym: string): string {
  const flags = state.surv[sym];
  if (!flags?.length) return '';
  const rows = flags
    .map(
      (f) => `<div class="s-row">
        <span class="flag${survSevere(f) ? ' severe' : ''}">${esc(survLabel(f))}</span>
        <div class="s-main"><div>${survName(f)} · Stage ${esc(f.stage)} <span class="muted">· ${f.ex.join(' + ')}</span></div>
        <div class="muted small">${survSince(f)}${f.desc && f.list === 'GSM' ? ` · ${esc(f.desc)}` : ''}</div></div>
      </div>`,
    )
    .join('');
  return `<h3>Surveillance</h3><div class="s-list">${rows}</div>`;
}

async function openSheet(sym: string) {
  // Pinned stocks no broker funds still open, mainly to show their ASM/GSM status.
  const s = state.bySymbol.get(sym) ?? (state.pins.includes(sym) ? stubStock(sym) : null);
  if (!s) return;
  const sheet = $<HTMLDialogElement>('#sheet');
  const pinned = state.pins.includes(sym);
  const rows = BROKERS.map((b) => {
    const c = s[b];
    const own = c ? (b === 'kotak' ? (isFunded(c) ? `${Number((100 / c.lev).toFixed(1))}%` : '100%') : c.ownPct != null ? `${Number(c.ownPct.toFixed(2))}%` : '—') : '—';
    const lev = !c ? '<span class="none">Not listed</span>' : isFunded(c) ? fmtLev(c.lev) : '<span class="nf">Not funded</span>';
    const extra = b === 'kotak' && c?.maxExposureCr != null ? `Max exposure ₹${c.maxExposureCr} Cr` : b === 'kotak' ? '' : c ? 'Own funds as published' : '';
    return `<div class="d-row${s.best.includes(b) ? ' is-best' : ''}">
      <div><div class="d-broker">${BROKER_NAME[b]}</div><div class="muted small">${extra}</div></div>
      <div class="d-own"><span class="muted small">Your funds</span>${own}</div>
      <div class="d-lev">${lev}${s.best.includes(b) && contested(s) ? '<span class="tag">Best</span>' : ''}</div>
    </div>`;
  }).join('');
  sheet.innerHTML = `
    <div class="sheet-inner">
      <div class="sheet-head">
        <div>
          <div class="sym big">${esc(s.symbol)}${s.type === 'etf' ? '<span class="pill">ETF</span>' : ''}${flagsHTML(s.symbol)}</div>
          <div class="name">${esc(s.name)}</div>
        </div>
        <div class="sheet-actions">
          <button class="star${pinned ? ' on' : ''}" data-pin="${esc(sym)}" aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(sym)}">${ICON.star}</button>
          <button class="icon-btn" data-close aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        </div>
      </div>
      <div class="d-list">${rows}</div>
      ${eventsSectionHTML(sym)}
      ${survSectionHTML(sym)}
      ${s.stub ? '' : calcSectionHTML()}
      <h3>Last 7 days</h3>
      <div class="history" id="history"><p class="muted small">Loading…</p></div>
      <p class="muted small">Kotak's own-funds share is 1 ÷ leverage. Kotak does not publish it separately.</p>
    </div>`;
  state.sheetSym = sym;
  renderCalc();
  if (!sheet.open) sheet.showModal();
  try {
    state.history ??= await getJSON<History>('/data/history.json');
    renderHistory(sym);
  } catch {
    $('#history').innerHTML = '<p class="muted small">No history yet.</p>';
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

function showPopover(btn: HTMLElement, b: BrokerKey) {
  const info = state.meta!.brokers[b];
  const pop = $('#popover');
  const label = { ok: 'Up to date', stale: 'Stale, showing last good data', failed: 'Failed' }[info.status];
  pop.innerHTML = `<div class="pop-title"><span class="dot ${info.status}"></span>${BROKER_NAME[b]}</div>
    <dl><dt>Status</dt><dd>${label}</dd><dt>Stocks</dt><dd>${fmtNum(info.count)}</dd><dt>Last fetch</dt><dd>${fmtTime(info.fetchedAt)}</dd></dl>
    ${info.error ? `<p class="pop-err">${esc(info.error)}</p>` : ''}`;
  pop.hidden = false;
  const r = btn.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.left = `${Math.min(Math.max(12, r.left), window.innerWidth - w - 12)}px`;
  pop.style.top = `${r.bottom + 8 + window.scrollY}px`;
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
async function triggerViaGitHub(token: string): Promise<TriggerResult> {
  const base = `https://api.github.com/repos/${GH_REPO}/actions/workflows/refresh.yml`;
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
    await pollForUpdate();
  } catch (e) {
    toast((e as Error).message);
    state.refreshing = false;
    updateRefreshCooldown();
  }
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
      openSheet(e.target.dataset.sym!);
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
    if (t.closest('[data-reset-rates]')) {
      store(RATES_KEY, {});
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
      state.view = view.dataset.view as 'pinned' | 'all';
      state.limit = PAGE;
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
    if (row) openSheet(row.dataset.sym!);
  });

  $<HTMLDialogElement>('#sheet').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) (e.currentTarget as HTMLDialogElement).close();
  });

  document.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
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
      renderCalc();
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target as HTMLElement;
    if (t.id === 'sort') {
      state.sort = (t as HTMLSelectElement).value as typeof state.sort;
      renderList();
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

  // Pick up edits made on other devices when this tab comes back into view.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !sync.busy) pullPins();
  });
  pullPins();

  bind();
  updateRefreshCooldown();
  setInterval(updateRefreshCooldown, 30000);
  $('#list').innerHTML = '<div class="skeleton"></div>'.repeat(6);
  try {
    await loadData();
    renderAll();
    if (fromUrl !== null) toast(`Loaded ${state.pins.length} pins from link`);
  } catch (e) {
    $('#list').innerHTML = `<div class="empty"><p class="empty-title">Could not load data</p><p>${esc((e as Error).message)}</p></div>`;
  }
}

boot();
