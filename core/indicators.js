function EMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

function RSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  const gains = [], losses = [];
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i-1];
    if (diff >= 0) gains.push(diff); else losses.push(Math.abs(diff));
  }
  const avgGain = gains.reduce((a,b)=>a+b,0)/period;
  const avgLoss = losses.reduce((a,b)=>a+b,0)/period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function ATR(prices, highs, lows, period = 14) {
  if (prices.length < period + 1) return 0;
  const tr = [];
  for (let i = 1; i <= period; i++) {
    const h = highs[i], l = lows[i], p = prices[i-1];
    tr.push(Math.max(h-l, Math.abs(h-p), Math.abs(l-p)));
  }
  return tr.reduce((a,b)=>a+b,0)/period;
}

module.exports = { EMA, RSI, ATR };
