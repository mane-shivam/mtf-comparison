import './style.css';

type BrokerKey = 'kotak' | 'paytm' | 'rupeezy';

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
  paytm: Cell | null;
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

interface Meta {
  generatedAt: string;
  brokers: Record<BrokerKey, BrokerMeta>;
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

const BROKERS: BrokerKey[] = ['kotak', 'paytm', 'rupeezy'];
const BROKER_NAME: Record<BrokerKey, string> = { kotak: 'Kotak Neo', paytm: 'Paytm Money', rupeezy: 'Rupeezy' };
const BROKER_SHORT: Record<BrokerKey, string> = { kotak: 'Kotak', paytm: 'Paytm', rupeezy: 'Rupeezy' };
const SOURCES: Record<BrokerKey, string> = {
  kotak: 'https://www.kotakneo.com/margin-requirement/margin-trading/1/',
  paytm: 'https://www.paytmmoney.com/mtf/list',
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
  type: 'equity' as 'equity' | 'etf', // search and the All list show one kind at a time; stocks by default
  query: '',
  limit: PAGE,
  refreshing: false,
  symbols: null as Map<string, string> | null, // every NSE symbol → name, loaded on demand
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
    symbol: sym, name: state.symbols?.get(sym) ?? '', type: 'equity', kotak: null, paytm: null, rupeezy: null,
    best: [], bestLev: null, change: { kotak: 0, paytm: 0, rupeezy: 0 }, stub: true,
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
}

function setData(stocks: Stock[], meta: Meta) {
  for (const s of stocks) {
    s.name = titleCase(s.name);
    // Re-derive the winner at display precision, so 4.27 vs 4.25 (both 4.3×) is a tie, not a win.
    const levs = BROKERS.filter((b) => isFunded(s[b])).map((b) => round1(s[b]!.lev));
    s.bestLev = levs.length ? Math.max(...levs) : null;
    s.best = BROKERS.filter((b) => isFunded(s[b]) && round1(s[b]!.lev) === s.bestLev);
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
  const out = state.filter ? list.filter((s) => s.best.includes(state.filter!)) : list.slice();
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
  const who = !contested(s) ? (s.best.length > 1 ? 'Same everywhere' : `Only ${BROKER_SHORT[s.best[0]]}`) : s.best.map((b) => BROKER_SHORT[b]).join(' · ');
  const best = s.best.length
    ? `<span class="best-lev">${fmtLev(s.bestLev!)}</span><span class="best-who">${who}</span>`
    : `<span class="none">${s.stub ? 'Not on MTF lists' : 'No funding'}</span>`;
  return `<div class="row${s.stub ? ' is-stub' : ''}" role="listitem" data-sym="${esc(s.symbol)}" tabindex="0">
    <div class="stock">
      <div class="sym">${esc(s.symbol)}${s.type === 'etf' ? '<span class="pill">ETF</span>' : ''}</div>
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
  $('#chips').innerHTML = '<span class="chips-label">Best on</span>' + BROKERS.map(
    (b) =>
      `<button class="chip${state.filter === b ? ' on' : ''}" data-filter="${b}" aria-pressed="${state.filter === b}" aria-label="Best on ${BROKER_SHORT[b]}"><span class="chip-pre">Best on </span>${BROKER_SHORT[b]}</button>`,
  ).join('');
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
      <div class="chips"><button class="chip" data-add>+ Add stocks</button><button class="chip" data-restore>Restore defaults</button></div></div>`;
  }
  return `<div class="empty"><p class="empty-title">No stocks here</p><p>No ${state.view === 'pinned' ? 'pinned ' : ''}stock has its best multiplier on ${BROKER_NAME[state.filter!]}.</p></div>`;
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
    foot.push('<button class="btn btn-ghost" data-add>+ Add or edit pinned stocks</button>');
  }
  if (!searching && state.view === 'all' && list.length > shown.length) {
    foot.push(`<button class="btn btn-ghost" id="more">Show more <span class="muted">${fmtNum(shown.length)} of ${fmtNum(list.length)}</span></button>`);
  }
  $('#list-foot').innerHTML = foot.join('');
  $('#pin-count').textContent = state.pins.length ? String(state.pins.length) : '';
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
        <ul class="sources">${fetches}</ul>
      </div>
      <div>
        <h2>Pins</h2>
        <div class="pin-actions">
          <button class="btn btn-ghost" id="copy-link">Copy pin link</button>
          <button class="btn btn-ghost" id="export">Export</button>
          <label class="btn btn-ghost">Import<input type="file" id="import" accept="application/json,.json" hidden /></label>
        </div>
        <p class="muted small">Pins are saved in this browser. Open the pin link on your phone to carry them over.</p>
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

/* ---------- detail sheet ---------- */

async function openSheet(sym: string) {
  const s = state.bySymbol.get(sym);
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
          <div class="sym big">${esc(s.symbol)}${s.type === 'etf' ? '<span class="pill">ETF</span>' : ''}</div>
          <div class="name">${esc(s.name)}</div>
        </div>
        <div class="sheet-actions">
          <button class="star${pinned ? ' on' : ''}" data-pin="${esc(sym)}" aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(sym)}">${ICON.star}</button>
          <button class="icon-btn" data-close aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        </div>
      </div>
      <div class="d-list">${rows}</div>
      <h3>Last 7 days</h3>
      <div class="history" id="history"><p class="muted small">Loading…</p></div>
      <p class="muted small">Kotak's own-funds share is 1 ÷ leverage. Kotak does not publish it separately.</p>
    </div>`;
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
        <button class="btn btn-ghost" data-restore>Restore defaults</button>
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
          ? 'GitHub token for refresh (fine-grained, Actions: read and write on this repo). It is saved only in this browser.'
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
    if (t.closest('#add-go')) return applyPending(false);
    if (t.closest('#replace-go')) return applyPending(true);
    const unpin = t.closest<HTMLElement>('[data-unpin]');
    if (unpin) {
      togglePin(unpin.dataset.unpin!);
      renderCurrentPins();
      renderPending();
      return;
    }
    if (t.closest('[data-restore]')) {
      if (state.pins.length && !confirm('Replace your pins with the default list?')) return;
      state.pins = DEFAULT_PINS.slice();
      savePins();
      render();
      renderCurrentPins();
      toast(`Restored ${state.pins.length} pins`);
      return;
    }
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
  }

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
