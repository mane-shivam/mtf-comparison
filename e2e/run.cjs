/* End-to-end tests: the built site against a fake GitHub (contents API, Actions runs, quick sync) with
   encrypted broker snapshots in the real format. Run with `npm run e2e`. Screenshots land in e2e/.shots.

   Each scenario starts from a clean browser profile, so localStorage, the fake repo and the fake runs
   are its own. Prices come from a fixture market.json, so every number on screen is predictable. */

const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execSync } = require('node:child_process');
const { webcrypto } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(__dirname, '.site');
const SHOTS = path.join(__dirname, '.shots');
const BASE = '/mtf/';
const PASS = 'correct horse battery staple';
const REPO = 'test/mtf';
const TODAY = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

/* ---------- build and serve ---------- */

function build() {
  fs.rmSync(SITE, { recursive: true, force: true });
  execSync(`npx vite build --base ${BASE} --outDir ${path.join(SITE, 'mtf')} --emptyOutDir`, {
    cwd: ROOT, stdio: 'pipe',
    env: { ...process.env, VITE_GITHUB_REPO: REPO, VITE_REFRESH_MODE: 'github', VITE_GITHUB_REF: 'main' },
  });
}

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(SITE, p);
    if (!file.startsWith(SITE) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, () => r(server)));
}

/* ---------- the encrypted file format the site and scripts use ---------- */

async function encrypt(payload) {
  const enc = new TextEncoder();
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const base = await webcrypto.subtle.importKey('raw', enc.encode(PASS), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 200000 }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const data = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload))));
  const b = (x) => Buffer.from(x).toString('base64');
  return JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', iter: 200000, salt: b(salt), iv: b(iv), data: b(data) });
}

/* ---------- fixtures ---------- */

const MTF = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/mtf.json'), 'utf8'));
const lev = (sym, b) => MTF.find((s) => s.symbol === sym)?.[b]?.lev;
for (const [s, b] of [['CDSL', 'kotak'], ['NUVAMA', 'kotak'], ['ENTERO', 'rupeezy'], ['ANANDRATHI', 'rupeezy']]) {
  assert.ok(lev(s, b) > 1, `fixture needs ${s} funded at ${b}`);
}

const PRICES = { CDSL: 1500, NUVAMA: 1900, ENTERO: 2100, ANANDRATHI: 3000, AARTIPHARM: 950 };
function marketFile(prices = PRICES) {
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/market.json'), 'utf8'));
  const p = {};
  for (const [sym, px] of Object.entries(prices)) {
    p[sym] = { p: px, prev: px * 0.99, chg: 1, dayHi: px, dayLo: px, hi52: px * 1.5, lo52: px * 0.5, vol: 1, avgVol: 1, date: TODAY, t: 0, closes: [] };
  }
  return JSON.stringify({ ...real, prices: p });
}

// Broker snapshot as scripts/brokers.py writes it (raw responses, encrypted).
function snapshot({ kotak = [], rupeezy = [], kotakTrades = null, at = new Date().toISOString(), rupeezyOk = true } = {}) {
  const trades = kotakTrades
    ? { trades: { stat: 'Ok', stCode: 200, data: kotakTrades.map(([sym, side, qty, px]) => ({ trdSym: `${sym}-EQ`, sym, trnsTp: side, fldQty: qty, avgPrc: String(px), exSeg: 'nse_cm', prod: 'MTF', flDt: TODAY })) } }
    : { _errors: { limits: 'bridge API error out', trades: 'no trades' } };
  return {
    at,
    brokers: {
      kotak: { ok: true, at, raw: { holdings: { data: kotak.map(([symbol, quantity, averagePrice]) => ({ symbol, displaySymbol: `${symbol}-EQ`, quantity, averagePrice, exchangeSegment: 'nse_cm', closingPrice: PRICES[symbol] })) }, ...trades } },
      rupeezy: rupeezyOk
        ? { ok: true, at, raw: { positions: { status: 'success', data: { net: rupeezy.map(([symbol, quantity, average_price]) => ({ symbol, product: 'MTF', quantity, average_price, overnight_average_price: average_price })), day: [] } }, funds: { nse: { net_available: 12345.6 } } } }
        : { ok: false, at: null, error: 'Rupeezy: not signed in. Tap Connect Rupeezy on the site' },
    },
  };
}

/* ---------- fake GitHub ---------- */

class FakeGitHub {
  constructor() { this.files = {}; this.sha = 0; this.runs = { 'brokers.yml': [], 'refresh.yml': [] }; this.dispatches = []; this.onQuickSync = null; this.syncMs = 2500; }
  put(p, text) { this.files[p] = { text, sha: `s${++this.sha}` }; }
  async attach(ctx) {
    const H = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,PUT,POST,DELETE' };
    const json = (r, status, body) => r.fulfill({ status, headers: H, contentType: 'application/json', body: JSON.stringify(body) });
    await ctx.route('https://raw.githubusercontent.com/**', (r) => {
      const p = new URL(r.request().url()).pathname.split('/').slice(4).join('/');
      const f = this.files[p];
      return f ? r.fulfill({ status: 200, headers: H, contentType: 'application/json', body: f.text }) : r.fulfill({ status: 404, headers: H, body: '' });
    });
    await ctx.route('https://api.github.com/**', async (r) => {
      const q = r.request(); const u = new URL(q.url()); const m = q.method();
      if (m === 'OPTIONS') return r.fulfill({ status: 204, headers: H });
      const contents = u.pathname.match(/\/contents\/(.+)$/);
      if (contents) {
        const p = decodeURIComponent(contents[1]);
        if (m === 'GET') {
          const f = this.files[p];
          if (!f) return json(r, 404, {});
          if ((q.headers().accept || '').includes('raw')) return r.fulfill({ status: 200, headers: H, contentType: 'application/json', body: f.text });
          return json(r, 200, { sha: f.sha, content: Buffer.from(f.text).toString('base64') });
        }
        if (m === 'PUT') {
          const body = JSON.parse(q.postData());
          const f = this.files[p];
          if (f && body.sha !== f.sha) return json(r, 409, {});
          this.put(p, Buffer.from(body.content, 'base64').toString());
          return json(r, 200, { content: { sha: this.files[p].sha } });
        }
      }
      const runs = u.pathname.match(/workflows\/([\w.]+)\/(runs|dispatches)$/);
      if (runs) {
        const wf = runs[1];
        if (runs[2] === 'runs') return json(r, 200, { workflow_runs: [...(this.runs[wf] || [])].reverse() });
        this.dispatches.push(wf);
        const run = { status: 'in_progress', conclusion: null, created_at: new Date().toISOString(), run_started_at: new Date().toISOString(), html_url: 'https://x' };
        (this.runs[wf] ||= []).push(run);
        setTimeout(async () => { if (wf === 'brokers.yml' && this.onQuickSync) await this.onQuickSync(this); Object.assign(run, { status: 'completed', conclusion: 'success' }); }, this.syncMs);
        return r.fulfill({ status: 204, headers: H });
      }
      return json(r, 404, {});
    });
  }
}

/* ---------- harness ---------- */

let browser, origin;
const results = [];
const errorsOf = new WeakMap();

async function page({ width = 390, height = 860, storage = {}, gh, market = marketFile() } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, acceptDownloads: true });
  await gh.attach(ctx);
  await ctx.route(`**${BASE}data/market.json`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: market }));
  await ctx.addInitScript((s) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v));
  }, { 'mtf.ghToken': 'tok', 'mtf.posPass': PASS, 'mtf.view': 'positions', ...storage });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  p.on('dialog', (d) => d.accept(p.nextPrompt ?? undefined));
  errorsOf.set(p, errs);
  return p;
}

const positions = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('mtf.positions') || '[]'));
const closed = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('mtf.closed') || '[]'));
const text = (p, sel) => p.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim());
async function settle(p, ms = 1500) { await p.waitForTimeout(ms); }
async function noOverflow(p) {
  const [sw, w] = await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  assert.ok(sw <= w + 1, `page scrolls sideways: ${sw}px content in ${w}px window`);
}
async function shot(p, name) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); }

async function scenario(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push([name, 'ok', Date.now() - t]);
    console.log(`  ✓ ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    results.push([name, 'FAIL', Date.now() - t, e]);
    console.log(`  ✗ ${name}\n    ${String(e.stack || e).split('\n').slice(0, 4).join('\n    ')}`);
  }
}

/* ---------- scenarios ---------- */

const MANUAL = [
  { id: 'c', sym: 'CDSL', broker: 'kotak', qty: 300, price: 1300, date: daysAgo(20), lev: 4 },
  { id: 'e', sym: 'ENTERO', broker: 'rupeezy', qty: 100, price: 2000, date: daysAgo(10), lev: 2.89 },
];

async function seededSync() {
  const gh = new FakeGitHub();
  gh.put('data/pins.json', JSON.stringify({ pins: ['CDSL', 'ENTERO'] }));
  gh.put('data/broker.enc.json', await encrypt(snapshot({
    kotak: [['CDSL', 300, 1302], ['NUVAMA', 50, 1900]], // NUVAMA: bought today from spare margin
    rupeezy: [['ENTERO', 100, 2000], ['ANANDRATHI', 20, 3000]],
  })));
  return gh;
}

async function run() {
  console.log('Building…');
  build();
  const server = await serve();
  origin = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
  const url = `${origin}${BASE}`;
  console.log('Running scenarios');

  await scenario('broker sync adds new buys, paid from spare margin first', async () => {
    const gh = await seededSync();
    const p = await page({ gh, storage: { 'mtf.positions': MANUAL } });
    await p.goto(url);
    await p.waitForSelector('.hero');
    await settle(p, 4000);
    const list = await positions(p);
    const nuv = list.find((x) => x.sym === 'NUVAMA');
    const ana = list.find((x) => x.sym === 'ANANDRATHI');
    assert.ok(nuv && ana, `new buys added: ${list.map((x) => x.sym)}`);
    assert.equal(nuv.src, 'broker');
    const margin = (x) => (x.qty * x.price) / x.lev;
    // CDSL is up ₹60,000 at 4x: its spare covers NUVAMA's whole margin, so no new money.
    assert.equal(nuv.cash, 0, `NUVAMA cash ${nuv.cash}`);
    // ENTERO's gain covers only part of ANANDRATHI's margin: the rest is new money.
    assert.ok(ana.cash > 0 && ana.cash < margin(ana), `ANANDRATHI cash ${ana.cash} of ${margin(ana)}`);
    // Unchanged lots keep your date, price and leverage.
    assert.deepEqual(list.find((x) => x.sym === 'CDSL'), MANUAL[0]);
    const row = await text(p, '.hr[data-open-pos="NUVAMA"]');
    assert.match(row, /^NUVAMA/);
    assert.match(row, /Kotak 3×, 50 at ₹1,900/);
    const cash = margin(MANUAL[0]) + margin(MANUAL[1]) + ana.cash;
    const lakh = (x) => `₹${(x / 1e5).toFixed(2)}L`;
    const hero = await text(p, '.hero-sub');
    assert.ok(hero.includes(`${lakh(cash)} your cash`), `hero shows your cash ${lakh(cash)}: "${hero}"`);
    assert.match(hero, /from spare margin/);
    await shot(p, 'positions-phone');
    // Tapping a holding opens its detail card, which explains how it was paid for.
    await p.click('.hr[data-open-pos="NUVAMA"]');
    await p.waitForSelector('.sheet .pr');
    const card = await text(p, '.sheet .pr');
    assert.match(card, /bought with spare margin/);
    assert.match(card, /from spare margin/);
    await p.keyboard.press('Escape');
    await noOverflow(p);
    assert.deepEqual(errorsOf.get(p), []);
    await p.context().close();
  });

  await scenario('spare margin drops by the new lot margin, never rises', async () => {
    const gh = await seededSync();
    const p = await page({ gh, storage: { 'mtf.positions': MANUAL, 'mtf.psMore': true } });
    await p.goto(url);
    await p.waitForSelector('.accts');
    await settle(p, 4000);
    const acct = await text(p, '.acct[data-acct="kotak"]');
    assert.match(acct, /^Kotak Neo Synced .* ₹[\d,]+ spare/);
    // Spare before NUVAMA: CDSL equity (cash 97,500 + gain 60,000 - interest) - its margin on 4,50,000.
    // NUVAMA was bought with spare (no cash), so the spare falls by exactly its margin on 95,000.
    const spare = Number(acct.match(/₹([\d,]+) spare/)[1].replace(/,/g, ''));
    const nuvMargin = 50 * 1900 / lev('NUVAMA', 'kotak');
    const interest = (390000 - 97500) * 9.69 * 20 / 36500; // on the broker's loan at purchase
    const before = 97500 + 60000 - interest - 450000 / lev('CDSL', 'kotak');
    assert.ok(Math.abs(spare - (before - nuvMargin)) < 50, `spare ₹${spare}, expected ${Math.round(before - nuvMargin)} (${Math.round(before)} before, minus ${Math.round(nuvMargin)})`);
    assert.match(await text(p, '.acct[data-acct="rupeezy"]'), /Rupeezy reports ₹12,346 available/);
    await p.click('.acct[data-acct="kotak"]');
    assert.match(await text(p, '#popover'), /Kotak Neo account.*Synced.*How margin is counted/);
    await p.context().close();
  });

  await scenario('Refresh runs the quick sync and applies a sale only after two syncs agree', async () => {
    const gh = await seededSync();
    let n = 0;
    gh.onQuickSync = async (g) => {
      n += 1;
      g.put('data/broker.enc.json', await encrypt(snapshot({
        kotak: [['CDSL', 180, 1302], ['NUVAMA', 50, 1900]], // 120 CDSL sold
        rupeezy: [['ENTERO', 100, 2000], ['ANANDRATHI', 20, 3000]],
        at: new Date(Date.now() + n * 1000).toISOString(),
      })));
      g.put('public/data/market.json', marketFile({ ...PRICES, CDSL: 1520 }));
    };
    const p = await page({ gh, storage: { 'mtf.positions': MANUAL } });
    await p.goto(url);
    await p.waitForSelector('.hero');
    await settle(p, 3500);
    await p.click('#refresh');
    await p.waitForFunction(() => /Updated/.test(document.querySelector('#refresh').textContent), null, { timeout: 30000 });
    assert.equal(gh.dispatches.filter((w) => w === 'brokers.yml').length, 1, 'Refresh starts the quick sync, not the full refresh');
    assert.equal((await positions(p)).find((x) => x.sym === 'CDSL').qty, 300, 'first sync: sale held back');
    assert.equal((await closed(p)).length, 0);
    // The button allows a new sync a minute after the last one: move the clock instead of waiting.
    for (const r of gh.runs['brokers.yml']) r.created_at = new Date(Date.parse(r.created_at) - 70000).toISOString();
    await p.evaluate(() => localStorage.setItem('mtf.lastRefresh', String(Date.now() - 70000)));
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await p.waitForTimeout(1500);
    await p.click('#refresh');
    await p.waitForFunction(() => /Updated/.test(document.querySelector('#refresh').textContent), null, { timeout: 30000 });
    assert.equal((await positions(p)).find((x) => x.sym === 'CDSL').qty, 180, 'second sync agrees: sale booked');
    const c = await closed(p);
    assert.equal(c.length, 1);
    assert.equal(c[0].qty, 120);
    assert.equal(c[0].sell, 1520, 'sold at the fresh price from the quick sync');
    assert.ok(c[0].est);
    assert.deepEqual(errorsOf.get(p), []);
    await p.context().close();
  });

  await scenario("Kotak: today's trades count before settlement, with exact fill prices", async () => {
    const gh = new FakeGitHub();
    // Settled holdings still show 300 CDSL and no NUVAMA; today's trade book has a NUVAMA buy and a CDSL sell.
    gh.put('data/broker.enc.json', await encrypt(snapshot({
      kotak: [['CDSL', 300, 1302]],
      kotakTrades: [['NUVAMA', 'B', 50, 1887.25], ['CDSL', 'S', 100, 1512.4]],
      rupeezy: [['ENTERO', 100, 2000]],
    })));
    const p = await page({ gh, storage: { 'mtf.positions': MANUAL } });
    await p.goto(url);
    await p.waitForSelector('.hero');
    await settle(p, 4000);
    const list = await positions(p);
    const nuv = list.find((x) => x.sym === 'NUVAMA');
    assert.ok(nuv, 'NUVAMA bought today shows up before settlement');
    assert.equal(nuv.qty, 50);
    assert.equal(nuv.price, 1887.25, 'exact fill price, not a derived average');
    assert.equal(nuv.lev, lev('NUVAMA', 'kotak'), 'Kotak funds it: MTF at the broker rate');
    assert.equal(list.find((x) => x.sym === 'CDSL').qty, 200, 'the sell in the trade book books at once');
    const c = await closed(p);
    assert.equal(c.length, 1);
    assert.equal(c[0].sell, 1512.4, 'exact sell price');
    assert.ok(!c[0].est, 'not marked as estimated');
    assert.deepEqual(errorsOf.get(p), []);
    await p.context().close();
  });

  await scenario('Details tab: net if sold now, interest per day and so far, by broker and position', async () => {
    const gh = await seededSync();
    const p = await page({ gh, storage: { 'mtf.positions': MANUAL, 'mtf.posView': { mode: 'details', sort: 'risk' } } });
    await p.goto(url);
    await p.waitForSelector('.dt');
    await settle(p, 4000);
    const list = await positions(p);
    // Interest = broker's money (value at purchase - initial margin) x rate / 365, per calendar day since buying.
    const rate = { kotak: 9.69, rupeezy: 10.99 };
    const funded = (x) => x.qty * x.price - (x.qty * x.price) / x.lev;
    const perDay = list.reduce((t, x) => t + (funded(x) * rate[x.broker]) / 36500, 0);
    const hero = await text(p, '.hero');
    assert.match(hero, /^Net P&L if you sold everything now [+−]₹[\d,]+/);
    const shown = Number(hero.match(/Interest per day ₹([\d,.]+)/)[1].replace(/,/g, ''));
    assert.ok(Math.abs(shown - perDay) < 1, `per day ₹${shown} vs ₹${perDay.toFixed(2)}`);
    const cdsl = await text(p, '.dt-row[data-open-pos="CDSL"]');
    const cdslSoFar = Math.round((funded(MANUAL[0]) * 9.69 * 20) / 36500);
    assert.match(cdsl, /CDSL 20 days, Kotak 9.69%/);
    assert.ok(cdsl.endsWith(`₹${cdslSoFar.toLocaleString('en-IN')}`), `CDSL so far ₹${cdslSoFar}: "${cdsl}"`);
    assert.match(await text(p, '.dt-row[data-open-pos="NUVAMA"]'), /Starts tomorrow/);
    assert.match(await text(p, '.dt'), /Interest by broker Kotak Neo 9.69% a year/);
    await noOverflow(p);
    await shot(p, 'details-phone');
    assert.deepEqual(errorsOf.get(p), []);
    await p.context().close();
  });

  await scenario('Connect Rupeezy saves the sign-in code encrypted and starts the quick sync', async () => {
    const gh = new FakeGitHub();
    gh.put('data/broker.enc.json', await encrypt(snapshot({ kotak: [['CDSL', 100, 1302]], rupeezyOk: false })));
    const p = await page({ gh, storage: { 'mtf.positions': [MANUAL[0]], 'mtf.rupeezyApp': 'APP1' } });
    await p.route('https://flow.rupeezy.in/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: 'rupeezy' }));
    await p.goto(url);
    await p.waitForSelector('.acct[data-acct="rupeezy"]');
    await settle(p, 2500);
    // No Rupeezy holdings and a failed sync: Portfolio still shows the account, with Connect on it.
    assert.match(await text(p, '.acct[data-acct="rupeezy"]'), /Rupeezy Sync failed .*not signed in.*Connect Rupeezy/);
    await Promise.all([p.waitForURL(/flow\.rupeezy\.in/), p.click('.acct[data-acct="rupeezy"] [data-connect-rupeezy]')]);
    assert.match(p.url(), /applicationId=APP1/);
    await p.goto(`${url}?auth=CODE9`);
    await p.waitForTimeout(2500);
    assert.ok(gh.files['data/rupeezy_auth.enc.json'], 'sign-in code saved');
    assert.ok(!gh.files['data/rupeezy_auth.enc.json'].text.includes('CODE9'), 'saved encrypted');
    assert.ok(gh.dispatches.includes('brokers.yml'), 'quick sync started');
    assert.equal(new URL(p.url()).search, '', 'code removed from the address bar');
    await p.context().close();
  });

  await scenario('manual position with "spare margin first", edit cash, record a sale', async () => {
    const gh = new FakeGitHub();
    const p = await page({ gh, storage: { 'mtf.positions': [MANUAL[0]], 'mtf.view': 'pinned' } });
    await p.goto(url);
    await p.waitForSelector('.row');
    await p.fill('#q', 'NUVAMA');
    await p.click('.row[data-sym="NUVAMA"]');
    await p.click('[data-sheet-tab="position"]');
    await p.waitForSelector('#pos-qty');
    await p.selectOption('#pos-broker', 'kotak');
    await p.fill('#pos-qty', '50');
    await p.fill('#pos-price', '1900');
    await p.selectOption('#pos-paid', 'spare');
    await p.click('[data-pos-save]');
    await settle(p, 600);
    let nuv = (await positions(p)).find((x) => x.sym === 'NUVAMA');
    assert.equal(nuv.cash, 0, 'spare margin first: CDSL gain covers it');
    p.nextPrompt = '10000';
    await p.click('.pr[data-sym="NUVAMA"] .pr-more summary, .sheet .pr .pr-more summary');
    await p.click('.sheet .pr [data-cash-edit]');
    await settle(p, 300);
    nuv = (await positions(p)).find((x) => x.sym === 'NUVAMA');
    assert.equal(nuv.cash, 10000);
    await p.context().close();
  });

  await scenario('Remove all positions saves a backup first', async () => {
    const gh = new FakeGitHub();
    const p = await page({ gh, storage: { 'mtf.positions': MANUAL } });
    await p.goto(url);
    await p.waitForSelector('.manage');
    await p.click('.manage > summary');
    await p.click('#pos-clear');
    await p.waitForSelector('.clear-sheet');
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-clear="export"]')]);
    const saved = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    assert.equal(saved.positions.length, 2);
    assert.equal((await positions(p)).length, 0);
    await p.context().close();
  });

  await scenario('alerts sheet: level filter and Today grouping', async () => {
    const gh = new FakeGitHub();
    const p = await page({ gh, storage: { 'mtf.view': 'pinned' } });
    const now = new Date().toISOString();
    await p.route(`**${BASE}data/alerts.json`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { symbol: 'CDSL', name: 'CDSL', level: 'alert', text: 'Entered ST-ASM II', link: null, at: now },
      { symbol: 'ENTERO', name: 'Entero', level: 'good', text: 'At a 52-week high', link: null, at: now },
    ]) }));
    await p.goto(url);
    await p.waitForSelector('#bell');
    await settle(p, 800);
    await p.click('#bell');
    await p.waitForSelector('.al');
    assert.match(await text(p, '.al-day'), /^Today/);
    await p.click('[data-alert-level="alert"]');
    await p.waitForTimeout(200);
    assert.equal((await p.$$('.al-line')).length, 1);
    await p.context().close();
  });

  for (const [w, h, tag] of [[360, 780, 'small-phone'], [430, 932, 'large-phone'], [1280, 900, 'desktop']]) {
    await scenario(`layout at ${w}px: no sideways scroll, no errors`, async () => {
      const gh = await seededSync();
      for (const view of ['positions', 'details', 'closed', 'pinned', 'all']) {
        const mode = ['details', 'closed'].includes(view) ? view : 'open';
        const p = await page({ gh, width: w, height: h, storage: { 'mtf.positions': MANUAL, 'mtf.view': ['details', 'closed'].includes(view) ? 'positions' : view, 'mtf.posView': { mode, sort: 'risk' } } });
        await p.goto(url);
        await p.waitForSelector(view === 'positions' || view === 'details' ? '.hero' : view === 'closed' ? '.pr-modes' : '.row');
        await settle(p, 2500);
        await noOverflow(p);
        await shot(p, `${view}-${tag}`);
        assert.deepEqual(errorsOf.get(p), []);
        await p.context().close();
      }
    });
  }

  await browser.close();
  server.close();
  const failed = results.filter((r) => r[1] !== 'ok');
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Screenshots: ${path.relative(ROOT, SHOTS)}/`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
