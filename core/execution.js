const crypto = require("crypto");

function generateClientOrderId(symbol, side) {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `BOT_${symbol}_${side}_${ts}_${rand}`.toUpperCase().slice(0, 32);
}

function buildPositionMeta({
  bestEligible,
  marketMode,
  stopPct,
  plannedSize,
  estimatedQty,
  now,
  entryPrice,
  actualQty,
  actualSizeUSDT,
  intendedEntryPrice,
  entryFillPrice,
  entrySlippagePct,
  entryFeeAmount,
  entryFeeCoin,
  entryFeeUSDT,
  takeProfitPct,
  profitActivationPct,
  profitActivationFloorPct,
  useDynamicTakeProfit
}) {
  const expectedNetPct = typeof bestEligible.expectedNetPct === "number" ? bestEligible.expectedNetPct : 0;
  const resolvedEntry = Number.isFinite(entryPrice) && entryPrice > 0 ? entryPrice : bestEligible.price;
  const resolvedQty = Number.isFinite(actualQty) && actualQty > 0 ? actualQty : estimatedQty;
  const resolvedSize = Number.isFinite(actualSizeUSDT) && actualSizeUSDT > 0 ? actualSizeUSDT : plannedSize;

  return {
    symbol: bestEligible.symbol,
    entry: resolvedEntry,
    qty: resolvedQty,
    sizeUSDT: resolvedSize,
    peak: resolvedEntry,
    trailingActive: false,
    stopPct,
    intendedEntryPrice: Number.isFinite(intendedEntryPrice) ? intendedEntryPrice : bestEligible.price,
    entryFillPrice: Number.isFinite(entryFillPrice) ? entryFillPrice : resolvedEntry,
    entrySlippagePct: Number.isFinite(entrySlippagePct) ? entrySlippagePct : null,
    entryFeeAmount: Number.isFinite(entryFeeAmount) ? entryFeeAmount : null,
    entryFeeCoin: entryFeeCoin || null,
    entryFeeUSDT: Number.isFinite(entryFeeUSDT) ? entryFeeUSDT : null,
    takeProfitPct: Number.isFinite(takeProfitPct) ? takeProfitPct : null,
    profitActivationPct: Number.isFinite(profitActivationPct) ? profitActivationPct : null,
    profitActivationFloorPct: Number.isFinite(profitActivationFloorPct) ? profitActivationFloorPct : null,
    useDynamicTakeProfit: useDynamicTakeProfit === true,
    entryTime: now,
    entryReason: {
      score: bestEligible.score,
      marketMode,
      rsi: bestEligible.rsi,
      atrPct: bestEligible.atrPct,
      notes: bestEligible.notes || "best eligible setup",
      expectedNetPct,
      takeProfitPct: Number.isFinite(takeProfitPct) ? takeProfitPct : null
    },
    source: "bot"
  };
}

function buildEntryPlan({ usdtFree, bestEligible, config, maxAllowedSizeUSDT = null }) {
  const reserveUSDT = config.reserveUSDT ?? 2;
  if (usdtFree < config.minBuyUSDT + reserveUSDT) return null;

  const tradableUsdt = Math.max(0, usdtFree - reserveUSDT);
  const effectiveRisk = Number.isFinite(config._effectiveRisk) ? config._effectiveRisk : config.riskPercent;
  const sizeRaw = tradableUsdt * effectiveRisk;
  let hardCap = Math.min(config.maxBuyUSDT, tradableUsdt);
  if (Number.isFinite(maxAllowedSizeUSDT)) {
    hardCap = Math.min(hardCap, maxAllowedSizeUSDT);
  }
  if (hardCap < config.minBuyUSDT) return null;
  const sizeCappedNum = Math.min(
    Math.max(sizeRaw, config.minBuyUSDT),
    hardCap
  );

  if (sizeCappedNum < config.minBuyUSDT) return null;

  const plannedSize = Number(sizeCappedNum.toFixed(2));
  const estimatedQty = plannedSize / bestEligible.price;
  const expectedNetPct = typeof bestEligible.expectedNetPct === "number" ? bestEligible.expectedNetPct : 0;

  return {
    reserveUSDT,
    plannedSize,
    estimatedQty,
    expectedNetPct,
    clientOrderId: generateClientOrderId(bestEligible.symbol, "buy")
  };
}

module.exports = {
  buildEntryPlan,
  buildPositionMeta,
  generateClientOrderId
};
