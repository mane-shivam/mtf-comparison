// MTF trade cost calculator. All rates are percentages unless named *Flat / *Min (rupees).
// Sources (checked Nov 2026):
//   Kotak Neo Trade Free Pro: kotakneo.com/pricing/trade-free-pro (MTF 9.69% p.a., delivery brokerage 0.10%,
//     DP sell 0.04% min ₹20, pledge/unpledge for margin incl. MTF ₹20 per ISIN, NSE txn 0.0030699%).
//   Rupeezy: rupeezy.in/pricing and support articles (pledge ₹25 on MTF buy, ₹25 on unpledge at sale,
//     DP ₹25 per scrip on sale). Interest 10.99% p.a. with ₹20 flat brokerage is the owner's custom plan.
//   Statutory (equity delivery, NSE): STT 0.1% both sides, stamp 0.015% on buy, SEBI ₹10/crore,
//     GST 18% on brokerage + transaction + SEBI charges and on depository charges.
//   GST is not added to MTF interest (owner's choice; Kotak does not list it).

export interface BrokerRates {
  interest: number; // % per year on the funded amount, calendar days / 365
  brokPct: number; // % of order value, per executed order
  brokFlat: number; // ₹ per executed order
  dpPct: number; // % of sell value
  dpMin: number; // ₹ minimum (or flat) DP charge on sale, per scrip
  pledge: number; // ₹ per ISIN when the MTF buy is pledged
  unpledge: number; // ₹ per ISIN when the pledge is released at sale
}

export const STATUTORY = {
  stt: 0.1, // % on buy and on sell (delivery)
  txn: 0.0030699, // % NSE transaction charge each side, IPFT included (as Kotak lists it)
  sebi: 0.0001, // % = ₹10 per crore, each side
  stamp: 0.015, // % on buy only
  gst: 18, // %
};

export interface CostBreakdown {
  lev: number;
  buyValue: number;
  funded: number;
  sellValue: number;
  brokBuy: number;
  brokSell: number;
  interest: number;
  pledge: number;
  unpledge: number;
  dp: number;
  gstDepository: number;
  stt: number;
  txn: number;
  sebi: number;
  stamp: number;
  gstTrade: number;
  brokerTotal: number; // brokerage + interest
  depositoryTotal: number; // pledge + unpledge + DP + their GST
  govTotal: number; // STT + txn + SEBI + stamp + GST on trade
  total: number;
  fixed: number; // every charge except interest
  buySide: number; // part of `fixed` paid when buying
  sellSide: number; // part of `fixed` paid when selling
  breakEvenPct: number; // price rise needed to cover all costs
  pnl: number; // after all costs, at the chosen exit move
  roiPct: number; // pnl as % of own funds
}

const pct = (value: number, rate: number) => (value * rate) / 100;

export function computeCosts(r: BrokerRates, funds: number, lev: number, days: number, movePct: number): CostBreakdown {
  const buyValue = funds * lev;
  const funded = Math.max(0, buyValue - funds);
  const sellValue = buyValue * (1 + movePct / 100);
  const turnover = buyValue + sellValue;

  const brokBuy = pct(buyValue, r.brokPct) + r.brokFlat;
  const brokSell = pct(sellValue, r.brokPct) + r.brokFlat;
  const interest = (funded * r.interest * days) / (100 * 365);

  const pledge = r.pledge;
  const unpledge = r.unpledge;
  const dp = Math.max(r.dpMin, pct(sellValue, r.dpPct));
  const gstDepository = pct(pledge + unpledge + dp, STATUTORY.gst);

  const stt = pct(turnover, STATUTORY.stt);
  const txn = pct(turnover, STATUTORY.txn);
  const sebi = pct(turnover, STATUTORY.sebi);
  const stamp = pct(buyValue, STATUTORY.stamp);
  const gstTrade = pct(brokBuy + brokSell + txn + sebi, STATUTORY.gst);

  const brokerTotal = brokBuy + brokSell + interest;
  const depositoryTotal = pledge + unpledge + dp + gstDepository;
  const govTotal = stt + txn + sebi + stamp + gstTrade;
  const total = brokerTotal + depositoryTotal + govTotal;
  // Split the fixed charges into what the buy leg and the sell leg each cost.
  const gstRate = STATUTORY.gst;
  const legStat = (v: number) => pct(v, STATUTORY.stt) + pct(v, STATUTORY.txn) + pct(v, STATUTORY.sebi);
  const legGst = (brok: number, v: number) => pct(brok + pct(v, STATUTORY.txn) + pct(v, STATUTORY.sebi), gstRate);
  const buySide = brokBuy + pledge + stamp + legStat(buyValue) + legGst(brokBuy, buyValue) + pct(pledge, gstRate);
  const fixed = total - interest;
  const pnl = sellValue - buyValue - total;

  return {
    lev, buyValue, funded, sellValue, brokBuy, brokSell, interest, pledge, unpledge, dp, gstDepository,
    stt, txn, sebi, stamp, gstTrade, brokerTotal, depositoryTotal, govTotal, total,
    fixed, buySide, sellSide: fixed - buySide,
    breakEvenPct: buyValue ? (total / buyValue) * 100 : 0,
    pnl,
    roiPct: funds ? (pnl / funds) * 100 : 0,
  };
}
