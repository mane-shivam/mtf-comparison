/* Broker ledger (account statement) import: Kotak Neo and Rupeezy CSV downloads.

   What the ledgers show (checked against real statements, Nov 2026):
   Kotak  - "MTF cash margin blocked" moves your cash into MTF margin when you buy; "MTF Cash Margin released"
            gives it back after a sale and when unrealised gains free up margin. Profit or loss reaches cash only
            when a position closes ("Final MTF settlement profit/loss"), and MTF interest is taken then too
            ("MTF interest adjusted against cash balance"). Demat charges: ₹23.60 per stock sold.
   Rupeezy - "Margin and MTM obligation debited to/credited from MTF ledger" settles margin and mark-to-market
            daily; "MTF EXCESS CASH COLL REV JV FOR T+1 DAY" returns excess margin (including gains) to cash the
            next day. MTF interest stays in the separate MTF ledger, not this one. DP/pledge: ₹29.50 an item.
   The summary counts these per broker; nothing else from the statement is kept. */

export type LedgerBroker = 'kotak' | 'rupeezy';

export interface LedgerSummary {
  broker: LedgerBroker;
  from: string; // first entry date, YYYY-MM-DD
  to: string; // last entry date
  opening: number; // cash balance before the first entry
  closing: number; // cash balance after the last entry: your free cash at the broker
  deposits: number;
  withdrawals: number;
  interest: number; // MTF interest (and interest on a negative balance) debited to cash
  charges: number; // demat, DP, pledge, subscription and other account charges
  booked: number | null; // profit minus loss booked to cash on closing positions (Kotak states it; Rupeezy doesn't)
  marginBlocked: number; // cash moved into MTF margin
  marginReleased: number; // margin returned to cash (after sales, or freed by gains)
  mtmNet: number; // Rupeezy daily margin and MTM settlement, net (credits minus debits)
  entries: number;
  importedAt: string;
}

// Minimal CSV: commas, quoted fields with "" escapes, CRLF or LF.
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = '';
    } else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x));
}

const amt = (v: string | undefined) => {
  const n = Number(String(v ?? '').replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const dmy = (v: string) => {
  const m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
};
const r2 = (n: number) => Math.round(n * 100) / 100;

function base(broker: LedgerBroker): LedgerSummary {
  return { broker, from: '', to: '', opening: 0, closing: 0, deposits: 0, withdrawals: 0, interest: 0, charges: 0, booked: null,
    marginBlocked: 0, marginReleased: 0, mtmNet: 0, entries: 0, importedAt: new Date().toISOString() };
}

function finish(s: LedgerSummary, dated: { date: string; net: number; balance: number }[]): LedgerSummary {
  // Statements list newest first or oldest first; order by date, keeping file order within a day.
  const asc = dated[0].date > dated[dated.length - 1].date ? [...dated].reverse() : dated;
  const first = asc[0];
  const last = asc[asc.length - 1];
  s.from = first.date;
  s.to = last.date;
  s.opening = r2(first.balance - first.net);
  s.closing = r2(last.balance);
  s.entries = dated.length;
  for (const k of ['deposits', 'withdrawals', 'interest', 'charges', 'marginBlocked', 'marginReleased', 'mtmNet'] as const) s[k] = r2(s[k]);
  if (s.booked != null) s.booked = r2(s.booked);
  return s;
}

function kotak(rows: string[][]): LedgerSummary | null {
  const h = rows.findIndex((r) => r.includes('Transaction Type') && r.some((x) => /Net Balance/i.test(x)));
  if (h < 0) return null;
  const col = (name: string) => rows[h].findIndex((x) => x.toLowerCase() === name.toLowerCase());
  const [cDate, cType, cDesc, cDr, cCr, cBal] = ['Transaction Date', 'Transaction Type', 'Description', 'Debit', 'Credit', 'Net Balance'].map(col);
  const s = base('kotak');
  s.booked = 0;
  const dated: { date: string; net: number; balance: number }[] = [];
  for (const r of rows.slice(h + 1)) {
    const date = dmy(r[cDate] ?? '');
    if (!date) continue;
    const type = (r[cType] ?? '').toLowerCase();
    const desc = (r[cDesc] ?? '').toLowerCase();
    const dr = amt(r[cDr]);
    const cr = amt(r[cCr]);
    if (type === 'deposit') s.deposits += cr - dr;
    else if (type === 'withdrawal') s.withdrawals += dr - cr;
    else if (desc.includes('mtf interest') || type === 'interest') s.interest += dr - cr;
    else if (type === 'demat' || type === 'charges') s.charges += dr - cr;
    else if (desc.includes('final mtf settlement')) s.booked! += cr - dr;
    else if (desc.includes('cash margin blocked')) s.marginBlocked += dr - cr;
    else if (desc.includes('cash margin released')) s.marginReleased += cr - dr;
    dated.push({ date, net: cr - dr, balance: amt(r[cBal]) });
  }
  return dated.length ? finish(s, dated) : null;
}

function rupeezy(rows: string[][]): LedgerSummary | null {
  const h = rows.findIndex((r) => r[0] === 'Date' && r.includes('Particulars'));
  if (h < 0) return null;
  const col = (name: string) => rows[h].findIndex((x) => x.toLowerCase() === name.toLowerCase());
  const [cDate, cPart, cDr, cCr, cBal] = ['Date', 'Particulars', 'Debit', 'Credit', 'Balance'].map(col);
  const s = base('rupeezy');
  const dated: { date: string; net: number; balance: number }[] = [];
  for (const r of rows.slice(h + 1)) {
    const date = (r[cDate] ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const p = (r[cPart] ?? '').toLowerCase();
    const dr = amt(r[cDr]);
    const cr = amt(r[cCr]);
    if (/online transaction|funds? (received|added)|receipt/.test(p) && cr) s.deposits += cr - dr;
    else if (/payout|withdraw/.test(p)) s.withdrawals += dr - cr;
    else if (p.includes('interest')) s.interest += dr - cr;
    else if (/dp charges|amc|charges/.test(p) && !p.includes('settlement')) s.charges += dr - cr;
    else if (p.includes('mtm obligation')) s.mtmNet += cr - dr;
    else if (p.includes('excess cash coll')) s.marginReleased += cr - dr;
    dated.push({ date, net: cr - dr, balance: amt(r[cBal]) });
  }
  return dated.length ? finish(s, dated) : null;
}

/** A ledger CSV from either broker, or null when the file isn't one. */
export function parseLedger(text: string): LedgerSummary | null {
  const rows = parseCSV(text);
  return kotak(rows) ?? rupeezy(rows);
}
