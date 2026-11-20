// Indian intraday equity (MIS) statutory charges + discount-broker brokerage.
export const RATES = {
  brokeragePct: 0.03,       // % per executed order, capped
  brokerageCap: 20,         // ₹ per executed order
  sttSellPct: 0.025,        // STT on sell side (intraday)
  exchangePct: 0.00297,     // NSE transaction charge on turnover
  sebiPerCrore: 10,         // ₹10 per crore of turnover
  stampBuyPct: 0.003,       // stamp duty on buy side
  gstPct: 18,               // on brokerage + exchange + SEBI
};

const r2 = n => Math.round(n * 100) / 100;

export function intradayCharges(buyPrice, sellPrice, qty) {
  const buy = buyPrice * qty, sell = sellPrice * qty, turnover = buy + sell;
  const brokerage = Math.min(RATES.brokerageCap, buy * RATES.brokeragePct / 100) + Math.min(RATES.brokerageCap, sell * RATES.brokeragePct / 100);
  const stt = Math.round(sell * RATES.sttSellPct / 100);
  const exchange = turnover * RATES.exchangePct / 100;
  const sebi = turnover * RATES.sebiPerCrore / 1e7;
  const stamp = Math.round(buy * RATES.stampBuyPct / 100);
  const gst = (brokerage + exchange + sebi) * RATES.gstPct / 100;
  const total = brokerage + stt + exchange + sebi + stamp + gst;
  const gross = sell - buy;
  return {
    turnover: r2(turnover), brokerage: r2(brokerage), stt: r2(stt), exchange: r2(exchange), sebi: r2(sebi),
    stamp: r2(stamp), gst: r2(gst), total: r2(total), gross: r2(gross), net: r2(gross - total),
    breakevenMove: qty ? r2(total / qty) : 0,
  };
}
