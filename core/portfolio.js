function formatNumber(value, decimals = 2) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(decimals) : "N/A";
}

function computeEquity({
  balances,
  priceMap,
  dustThreshold = 0.01,
  qtyDustThreshold = 1e-8,
  logger = () => {}
}) {
  let total = balances.usdt || 0;
  const breakdown = {};
  const summary = [];

  for (const [coin, bal] of Object.entries(balances)) {
    if (coin === "usdt") continue;
    const qty = bal || 0;
    if (qty <= 0) continue;

    const lowerCoin = coin.toLowerCase();
    const price = priceMap[lowerCoin];
    if (!price || price <= 0) {
      logger(`Missing/zero price for ${lowerCoin} (balance=${qty})`);
      continue;
    }

    const value = qty * price;

    // Always add to total equity, even if it's dust
    total += value;

    if (qty < qtyDustThreshold || value < dustThreshold) {
      continue;
    }

    breakdown[lowerCoin] = value;
    summary.push(`${lowerCoin}: qty=${qty}, price=${price}, value=${formatNumber(value)}`);
  }

  if (summary.length > 0) {
    logger(`COMPUTE EQUITY ASSETS - ${summary.join(" | ")}`);
  }
  logger(`COMPUTE EQUITY END - totalEquity: ${total} | assets=${Object.keys(breakdown).join(",") || "none"}`);

  return {
    totalEquity: total,
    usdtFree: balances.usdt,
    balances,
    breakdown
  };
}

function getCoinBalance(symbol, balances) {
  const coin = symbol.replace("USDT", "").toLowerCase();
  const actual = Object.keys(balances).find(key => key.toLowerCase() === coin);
  return actual ? balances[actual] : 0;
}

function detectOpenPositionFromBalance({
  balances,
  priceMap,
  config,
  now = Date.now(),
  logger = () => {}
}) {
  const minRecover = config.minRecoverUSDT || config.minManagedPositionUSDT || config.minHoldUSDT || 5;
  logger(`SCANNING BALANCES FOR POSITION RECOVERY (threshold: ${minRecover} USDT)...`);

  for (const [coin, qty] of Object.entries(balances)) {
    if (coin.toLowerCase() === "usdt") continue;
    if (!qty || qty <= 0) continue;

    const coinLower = coin.toLowerCase();
    const price = priceMap[coinLower];
    if (!price) {
      logger(`Missing price for ${coinLower} (balance=${qty})`);
      continue;
    }

    const value = qty * price;
    const coinUpper = coinLower.toUpperCase();
    logger(`${coinUpper}: qty=${qty}, price=${price}, value=${formatNumber(value)}`);

    if (value >= minRecover) {
      const symbol = coinUpper + "USDT";
      logger(`RECOVERED POSITION: ${symbol} value=${formatNumber(value)}`);
      return {
        symbol,
        entry: price,
        currentPrice: price,
        qty,
        sizeUSDT: value,
        peak: price,
        trailingActive: false,
        stopPct: -0.02,
        entryTime: now,
        entryReason: {
          score: null,
          marketMode: null,
          rsi: null,
          atrPct: null,
          notes: "Recovered from balance - entry price estimated"
        },
        source: "recovery"
      };
    }
  }

  return null;
}

function getPriceFromBreakdown(symbol, balances, breakdown) {
  const coin = symbol.replace("USDT", "").toLowerCase();
  const coinBal = balances[coin] || 0;
  if (!breakdown || !breakdown[coin] || coinBal <= 0) return 0;
  return breakdown[coin] / coinBal;
}

function calculatePlannedSize(usdtFree, config) {
  const reserveUSDT = config.reserveUSDT ?? 2;
  if (usdtFree < config.minBuyUSDT + reserveUSDT) return null;

  const tradableUsdt = Math.max(0, usdtFree - reserveUSDT);
  const sizeRaw = tradableUsdt * config.riskPercent;
  const sizeCappedNum = Math.min(
    Math.max(sizeRaw, config.minBuyUSDT),
    Math.min(config.maxBuyUSDT, tradableUsdt)
  );

  if (sizeCappedNum < config.minBuyUSDT) return null;

  return {
    reserveUSDT,
    tradableUsdt,
    plannedSize: Number(sizeCappedNum.toFixed(2))
  };
}

module.exports = {
  calculatePlannedSize,
  computeEquity,
  detectOpenPositionFromBalance,
  getCoinBalance,
  getPriceFromBreakdown
};
