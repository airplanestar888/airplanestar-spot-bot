const { EMA, RSI, ATR } = require("./indicators");

function average(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function assessMarketMode({
  bullishCount,
  totalPairs,
  avgAtrPct,
  topScore,
  topWeight,
  topTrendOk,
  topEligible
}) {
  const ratio = totalPairs > 0 ? bullishCount / totalPairs : 0;
  const strongLeader =
    topTrendOk &&
    (
      topEligible ||
      (Number.isFinite(topScore) && topScore >= 14 && Number.isFinite(topWeight) && topWeight >= 1.15)
    );

  if (ratio >= 0.7) return avgAtrPct >= 0.01 ? "Bullish" : "Bullish but slow";
  if (ratio >= 0.4) return "Neutral";

  if (ratio >= 0.2) {
    if (avgAtrPct < 0.006) return strongLeader ? "Neutral" : "Choppy";
    return strongLeader ? "Neutral" : "Bearish";
  }

  if (strongLeader) {
    return avgAtrPct < 0.006 ? "Neutral" : "Bullish but slow";
  }

  if (avgAtrPct < 0.006) return "Choppy";
  return "Bearish";
}

function calculateVolatilityState(atrPcts) {
  if (!atrPcts.length) return "Unknown";
  const avg = atrPcts.reduce((a,b)=>a+b,0) / atrPcts.length;
  if (avg > 0.02) return "High";
  if (avg > 0.01) return "Moderate";
  return "Low";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function computeTrendLiveWeight({
  marketTrendOk,
  trendOk15,
  rsi15,
  atrPct,
  minTrendRsi,
  minAtrPct,
  maxAtrPct
}) {
  let multiplier = 1;
  if (marketTrendOk) multiplier += 0.08;
  if (trendOk15) multiplier += 0.06;
  if (rsi15 >= minTrendRsi + 4 && rsi15 <= 62) multiplier += 0.05;
  else if (rsi15 < Math.max(32, minTrendRsi - 6)) multiplier -= 0.06;
  if (atrPct >= minAtrPct && atrPct <= maxAtrPct) multiplier += 0.05;
  else if (atrPct < minAtrPct * 0.85 || atrPct > maxAtrPct * 1.15) multiplier -= 0.08;
  return clamp(multiplier, 0.7, 1.45);
}

function computeSignalLiveWeight({
  trendWeight,
  isRangeScalp,
  isSwingTrade,
  breakoutOk,
  requireBreakout,
  volumeRatio,
  minVolumeRatio,
  enableVolumeFilter,
  atrPct3,
  minAtrPct,
  maxAtrPct,
  enableAtrFilter,
  rsi,
  optRsiLow,
  optRsiHigh,
  rsiMomentumOk,
  requireRsiMomentum,
  enableRsiBandFilter,
  candleStrong,
  enableCandleStrengthFilter,
  priceNotExtended,
  enablePriceExtensionFilter,
  edgeOk,
  rangeRecoveryOk,
  enableRangeRecoveryFilter
}) {
  let multiplier = 1;
  if (!isRangeScalp && requireBreakout && breakoutOk) multiplier += isSwingTrade ? 0.12 : 0.1;
  if (isRangeScalp && enableRangeRecoveryFilter && rangeRecoveryOk) multiplier += 0.12;
  if (enableVolumeFilter) {
    if (volumeRatio >= minVolumeRatio) multiplier += 0.08;
    else if (volumeRatio < minVolumeRatio * 0.7) multiplier -= 0.12;
  }
  if (enableAtrFilter) {
    if (atrPct3 >= minAtrPct && atrPct3 <= maxAtrPct) multiplier += 0.06;
    else if (atrPct3 < minAtrPct * 0.8 || atrPct3 > maxAtrPct * 1.15) multiplier -= 0.08;
  }
  if (enableRsiBandFilter) {
    if (rsi >= optRsiLow && rsi <= optRsiHigh) multiplier += 0.08;
    else if (rsi < optRsiLow - 4 || rsi > optRsiHigh + 6) multiplier -= 0.05;
  }
  if (requireRsiMomentum && rsiMomentumOk) multiplier += 0.04;
  if (enableCandleStrengthFilter && candleStrong) multiplier += 0.03;
  if (enablePriceExtensionFilter && priceNotExtended) multiplier += 0.03;
  if (edgeOk) multiplier += 0.05;
  return clamp(trendWeight * multiplier, 0.65, 1.7);
}

async function scanMarket(config, getCandles, logEvent) {
  const marketData = [];
  const entryCandidates = [];
  const botType = config.activeBotType || config.selectedBotType || "scalp_trend";
  const isRangeScalp = botType === "range_scalp";
  const isSwingTrade = botType === "swing_trade";
  const trendTf = config.trendTimeframe || "15min";
  const signalTf = config.signalTimeframe || "3min";
  const bullishFlags15 = [], atrPcts15 = [], rsiVals15 = [];
  const minTrendRsi = config.minTrendRsi ?? 42;
  const minVolumeRatio = config.minVolumeRatio ?? 1.15;
  const maxEmaGapPct = config.maxEmaGapPct ?? 0.008;
  const minAtrPct = config.minAtrPct ?? 0.0035;
  const maxAtrPct = config.maxAtrPct ?? 0.018;
  const roundTripFeePct = config._effectiveRoundTripFeePct ?? config.roundTripFeePct ?? 0.004;
  const slippageBufferPct = config._effectiveSlippageBufferPct ?? config.slippageBufferPct ?? 0.001;
  const minExpectedNetPct = config._effectiveMinExpectedNetPct ?? config.minExpectedNetPct ?? 0.003;
  const minScalpTargetPct = config.minScalpTargetPct ?? 0.008;
  const maxScalpTargetPct = config.maxScalpTargetPct ?? config._effectiveTakeProfitPct ?? config.takeProfitPct ?? 0.012;
  const dynamicTakeProfitAtrMultiplier = config.dynamicTakeProfitAtrMultiplier ?? 1.35;

  // Entry thresholds from config (no more hardcoded values)
  const rsiBandLower  = config.rsiBandLower  ?? 46;
  const rsiBandUpper  = config.rsiBandUpper  ?? 64;
  const minCandleStr  = config.minCandleStrength ?? 0.35;
  const minConf       = config.minConfirmation ?? 3;
  const breakoutPct   = config.breakoutPct ?? 0.9985;
  const optRsiLow     = config.optimalRsiLow ?? 49;
  const optRsiHigh    = config.optimalRsiHigh ?? 58;
  const optAtrLow     = config.optimalAtrLow ?? 0.005;
  const optAtrHigh    = config.optimalAtrHigh ?? 0.012;
  const minEmaGapNeg  = config.minEmaGapNeg ?? 0.0015;

  // On/off toggles for entry requirements
  const requireEma21Rising    = config.requireEma21Rising !== false;
  const requireFastTrend      = config.requireFastTrend !== false;
  const requirePriceAboveEma9 = config.requirePriceAboveEma9 !== false;
  const requireEdge           = config.requireEdge !== false;
  const requireRsiMomentum    = config.requireRsiMomentum !== false;
  const requireBreakout       = config.requireBreakout !== false;
  const enableRsiBandFilter   = config.enableRsiBandFilter !== false;
  const enableAtrFilter       = config.enableAtrFilter !== false;
  const enableVolumeFilter    = config.enableVolumeFilter !== false;
  const enableCandleStrengthFilter = config.enableCandleStrengthFilter !== false;
  const enablePriceExtensionFilter = config.enablePriceExtensionFilter !== false;
  const enableRangeRecoveryFilter = config.enableRangeRecoveryFilter !== false;
  const rangeBiasMaxPct       = config.rangeBiasMaxPct ?? 0.01;
  const rangeRsiLower         = config.rangeRsiLower ?? 42;
  const rangeRsiUpper         = config.rangeRsiUpper ?? 60;

  for (const symbol of config.pairs) {
    // 15m trend
    let candles15;
    try {
      candles15 = await getCandles(symbol, config.trendTimeframe, 50);
    } catch (err) {
      logEvent("WARN", `getCandles error (${trendTf}) for ${symbol}: ${err.message}`);
      continue;
    }
    if (!Array.isArray(candles15) || candles15.length < 30) {
      logEvent("WARN", `Invalid ${trendTf} candles for ${symbol}: ${JSON.stringify(candles15)}`);
      continue;
    }
    const closes15 = candles15.map(c=>Number(c[4])).reverse();
    const highs15 = candles15.map(c=>Number(c[2])).reverse();
    const lows15 = candles15.map(c=>Number(c[3])).reverse();
    const price15 = closes15[closes15.length-1];
    const rsi15 = RSI(closes15);
    const ema21_15 = EMA(closes15, 21);
    const ema21prev_15 = EMA(closes15.slice(0,-1), 21);
    const atr15 = ATR(closes15, highs15, lows15, 14);
    const atrPct = atr15 / price15;

    const rangeBiasPct = ema21_15 > 0 ? Math.abs(price15 - ema21_15) / ema21_15 : Infinity;
    const marketTrendOk = ema21_15 > ema21prev_15 && price15 > ema21_15 && rsi15 >= minTrendRsi;
    const trendOk15 = isRangeScalp
      ? rangeBiasPct <= rangeBiasMaxPct && rsi15 >= rangeRsiLower && rsi15 <= rangeRsiUpper
      : marketTrendOk;
    bullishFlags15.push(marketTrendOk);
    atrPcts15.push(atrPct);
    rsiVals15.push(rsi15);

    const trendLiveWeight = computeTrendLiveWeight({
      marketTrendOk,
      trendOk15,
      rsi15,
      atrPct,
      minTrendRsi,
      minAtrPct,
      maxAtrPct
    });

    let score15 = 0;
    if (rsi15 >= 30 && rsi15 < 40) score15 += 2;
    else if (rsi15 >= 40 && rsi15 < 45) score15 += 1;
    if (price15 > ema21_15) score15 += 1;
    if (rsi15 >= minTrendRsi && rsi15 <= 62) score15 += 1;
    if (atrPct >= minAtrPct && atrPct <= maxAtrPct) score15 += 1;
    score15 = score15 * trendLiveWeight;

    // Ensure price is finite number
    const safePrice15 = (typeof price15 === 'number' && isFinite(price15)) ? price15 : 0;

    // Simpan ke marketData, inisialisasi price dengan price15 (fallback)
    const mdIdx = marketData.length;
    marketData.push({
      symbol,
      trendOk15,
      rsi: rsi15,
      atrPct: typeof atrPct === 'number' ? Number((atrPct * 100).toFixed(2)) : 0,
      trendRsi: rsi15,
      trendAtrPct: typeof atrPct === 'number' ? Number((atrPct * 100).toFixed(2)) : 0,
      score: typeof score15 === 'number' ? score15.toFixed(2) : '0.00',
      price: safePrice15,   // temporarily 15m price
      liveWeight: Number(trendLiveWeight.toFixed(2))
    });

    if (!trendOk15) continue;

    // 3m entry scan
    let candles3;
    try {
      candles3 = await getCandles(symbol, config.signalTimeframe, 50);
    } catch (err) {
      logEvent("WARN", `getCandles error (${signalTf}) for ${symbol}: ${err.message}`);
      continue;
    }
    if (!Array.isArray(candles3) || candles3.length < 30) {
      logEvent("WARN", `Invalid ${signalTf} candles for ${symbol}: ${JSON.stringify(candles3)}`);
      continue;
    }
    const closes3 = candles3.map(c=>Number(c[4])).reverse();
    const highs3 = candles3.map(c=>Number(c[2])).reverse();
    const lows3 = candles3.map(c=>Number(c[3])).reverse();
    const volumes3 = candles3.map(c=>Number(c[5])).reverse();
    const price = closes3[closes3.length-1];
    const rsi = RSI(closes3);
    const ema9 = EMA(closes3, 9);
    const ema21_3 = EMA(closes3, 21);
    const ema9prev = EMA(closes3.slice(0,-1), 9);
    const ema21prev_3 = EMA(closes3.slice(0,-1), 21);
    const prevRsi = RSI(closes3.slice(0,-1));
    const atr = ATR(closes3, highs3, lows3, 14);
    const atrPct3 = atr / price;

    const currentVol = volumes3[volumes3.length-1];
    const recentVolumes = volumes3.slice(-11, -1);
    const avgVol10 = average(recentVolumes);
    const volumeRatio = avgVol10 > 0 ? currentVol / avgVol10 : 0;
    const volumeOk = !enableVolumeFilter || volumeRatio >= minVolumeRatio;

    const lastCandle = candles3[candles3.length-1];
    const open = Number(lastCandle[1]), high = Number(lastCandle[2]), low = Number(lastCandle[3]), close = Number(lastCandle[4]);
    const body = Math.abs(close - open);
    const range = high - low;
    const bodyRatio = range > 0 ? body / range : 0;
    const recentHigh = Math.max(...highs3.slice(-6, -1));
    const swingBreakoutHigh = Math.max(...highs3.slice(-11, -1));
    const breakoutOk = isRangeScalp
      ? Number.isFinite(recentHigh) ? price >= recentHigh * Math.min(breakoutPct, 0.9975) : false
      : isSwingTrade
        ? Number.isFinite(swingBreakoutHigh) ? price >= swingBreakoutHigh * breakoutPct : false
        : Number.isFinite(recentHigh) ? price >= recentHigh * breakoutPct : false;
    const emaGapPct = ema9 > 0 ? (price - ema9) / ema9 : 0;
    const scalpTargetPct = Math.min(maxScalpTargetPct, Math.max(minScalpTargetPct, atrPct3 * dynamicTakeProfitAtrMultiplier));
    const expectedNetPct = scalpTargetPct - roundTripFeePct - slippageBufferPct;

    const fastTrendOk = ema9 > ema21_3;
    const ema21Rising = ema21_3 > ema21prev_3;
    const priceAboveEma9 = price > ema9;
    const rsiMomentumOk = !requireRsiMomentum || rsi > prevRsi;
    const rsiBandOk = !enableRsiBandFilter || (rsi >= rsiBandLower && rsi <= rsiBandUpper);
    const atrOk = !enableAtrFilter || (atrPct3 >= minAtrPct && atrPct3 <= maxAtrPct);
    const candleStrong = bodyRatio >= minCandleStr;
    const priceNotExtended = emaGapPct >= -minEmaGapNeg && emaGapPct <= maxEmaGapPct;
    const edgeOk = expectedNetPct >= minExpectedNetPct;
    const rangeRecoveryOk = !enableRangeRecoveryFilter || (price >= ema9 * 0.998 && rsiMomentumOk && emaGapPct <= Math.max(maxEmaGapPct * 0.5, 0.004));
    const candleStrengthOk = !enableCandleStrengthFilter || candleStrong;
    const priceExtensionOk = !enablePriceExtensionFilter || priceNotExtended;
    const breakoutSignalOk = !requireBreakout || breakoutOk;
    const rangeEntrySignal = atrOk && candleStrengthOk && rangeRecoveryOk && rsi >= rangeRsiLower && rsi <= Math.min(rangeRsiUpper, rsiBandUpper);
    const swingRsiBandOk = rsi >= Math.max(rsiBandLower, 50) && rsi <= Math.min(rsiBandUpper + 2, 68);
    const swingEntrySignal = (!requirePriceAboveEma9 || priceAboveEma9) && atrOk && (!enableRsiBandFilter || swingRsiBandOk);

    const baseTrend = isRangeScalp
      ? trendOk15 && (!requireFastTrend || fastTrendOk || price >= ema9)
      : isSwingTrade
        ? marketTrendOk && ema21Rising && priceAboveEma9
      : trendOk15 && (!requireFastTrend || fastTrendOk) && (!requireEma21Rising || ema21Rising);
    const entrySignal = isRangeScalp
      ? rangeEntrySignal
      : isSwingTrade
        ? swingEntrySignal
        : ((!requirePriceAboveEma9 || priceAboveEma9) && rsiBandOk && atrOk);
    const confirmation = isRangeScalp
      ? (rsiMomentumOk ? 1 : 0) +
        (candleStrengthOk ? 1 : 0) +
        (priceExtensionOk ? 1 : 0) +
        (volumeOk ? 1 : 0) +
        ((!requirePriceAboveEma9 || price >= ema9) ? 1 : 0)
      : isSwingTrade
        ? (rsiMomentumOk ? 1 : 0) +
          (candleStrengthOk ? 1 : 0) +
          (priceExtensionOk ? 1 : 0) +
          (volumeOk ? 1 : 0) +
          (breakoutSignalOk ? 1 : 0)
        : (rsiMomentumOk ? 1 : 0) +
          (candleStrengthOk ? 1 : 0) +
          (priceExtensionOk ? 1 : 0) +
          (volumeOk ? 1 : 0) +
          (breakoutSignalOk ? 1 : 0);
    const eligible = baseTrend && entrySignal && (!requireEdge || edgeOk) && confirmation >= minConf;

    const signalLiveWeight = computeSignalLiveWeight({
      trendWeight: trendLiveWeight,
      isRangeScalp,
      isSwingTrade,
      breakoutOk,
      requireBreakout,
      volumeRatio,
      minVolumeRatio,
      enableVolumeFilter,
      atrPct3,
      minAtrPct,
      maxAtrPct,
      enableAtrFilter,
      rsi,
      optRsiLow,
      optRsiHigh,
      rsiMomentumOk,
      requireRsiMomentum,
      enableRsiBandFilter,
      candleStrong,
      enableCandleStrengthFilter,
      priceNotExtended,
      enablePriceExtensionFilter,
      edgeOk,
      rangeRecoveryOk,
      enableRangeRecoveryFilter
    });

    let score = 0;
    if (trendOk15) score += 2;
    if (!requireFastTrend || fastTrendOk) score += 1;
    if (!requireEma21Rising || ema21Rising) score += 1;
    if (!requireBreakout || breakoutOk) score += isSwingTrade ? 3 : 2;
    if (!enableRsiBandFilter || (rsi >= optRsiLow && rsi <= optRsiHigh)) score += 2;
    else if (rsi > optRsiHigh && rsi <= rsiBandUpper) score += 1;
    if (!enableAtrFilter || (atrPct3 >= optAtrLow && atrPct3 <= optAtrHigh)) score += 1;
    if (!enableCandleStrengthFilter || candleStrengthOk) score += 1;
    if (!enableVolumeFilter || volumeOk) score += 1;
    if (!requireEdge || edgeOk) score += 1;
    if (isRangeScalp && (!enableRangeRecoveryFilter || rangeRecoveryOk)) score += 2;
    let failed = [];
    if (!trendOk15) failed.push("15m trend");
    if (requireFastTrend && !fastTrendOk) failed.push("fast trend");
    if (requireEma21Rising && !ema21Rising) failed.push("EMA21 slope");
    if (requireBreakout && !breakoutOk && !isRangeScalp) failed.push(isSwingTrade ? "higher timeframe breakout" : "micro breakout");
    if (requirePriceAboveEma9 && !priceAboveEma9) failed.push("price above EMA9");
    if (requireRsiMomentum && !rsiMomentumOk) failed.push("RSI momentum");
    if (enableRsiBandFilter && !(isSwingTrade ? swingRsiBandOk : rsiBandOk) && !isRangeScalp) failed.push(`RSI band (${typeof rsi === 'number' ? rsi.toFixed(1) : 'N/A'})`);
    if (isRangeScalp && enableRangeRecoveryFilter && !rangeRecoveryOk) failed.push("range recovery");
    if (enableAtrFilter && !atrOk) failed.push(`ATR (${typeof atrPct3 === 'number' ? (atrPct3*100).toFixed(2) : 'N/A'}%)`);
    if (enableCandleStrengthFilter && !candleStrong) failed.push("candle strength");
    if (enablePriceExtensionFilter && !priceNotExtended) failed.push("price extended");
    if (enableVolumeFilter && !volumeOk) failed.push(`volume ratio (${volumeRatio.toFixed(2)}x)`);
    if (requireEdge && !edgeOk) failed.push(`net edge (${(expectedNetPct*100).toFixed(2)}%)`);

    const rawScore = score * signalLiveWeight;
    let displayScore = rawScore;
    if (!eligible) {
      const confirmationRatio = clamp(confirmation / Math.max(1, minConf), 0.35, 1);
      const baseTrendFactor = baseTrend ? 1 : 0.7;
      const entrySignalFactor = entrySignal ? 1 : 0.8;
      const failedPenalty = Math.max(0.45, 1 - failed.length * 0.08);
      displayScore = rawScore * confirmationRatio * baseTrendFactor * entrySignalFactor * failedPenalty;
    }
    score = Number(displayScore.toFixed(2));

    entryCandidates.push({
      symbol,
      score,
      rawScore: Number(rawScore.toFixed(2)),
      eligible,
      rsi,
      atr,          // BUG2: store atr (raw)
      atrPct: atrPct3,
      price,
      trendOk15,
      fastTrendOk,
      ema21Rising,
      priceAboveEma9,
      rsiMomentumOk,
      rsiBandOk,
      atrOk,
      candleStrong,
      priceNotExtended,
      volumeOk,
      breakoutOk,
      volumeRatio,
      emaGapPct,
      expectedNetPct,
      scalpTargetPct,
      dynamicTakeProfitPct: scalpTargetPct,
      liveWeight: signalLiveWeight,
      failed
    });

    // Optional debug only (disabled by default)
    // if (!eligible && config.debugFailedFilters) {
    //   logEvent("DEBUG", `${symbol} failed filters`, { failed });
    // }

    // Update harga di marketData menjadi price 3m (lebih fresh) jika valid
    const md = marketData.find(m => m.symbol === symbol);
    if (md && typeof price === 'number' && isFinite(price)) {
      md.price = price;
      md.rsi = Number.isFinite(rsi) ? rsi : md.rsi;
      md.atrPct = Number.isFinite(atrPct3) ? Number((atrPct3 * 100).toFixed(2)) : md.atrPct;
      md.liveWeight = Number(signalLiveWeight.toFixed(2));
      md.score = typeof score === "number" ? score.toFixed(2) : md.score;
      md.rawScore = Number.isFinite(rawScore) ? rawScore.toFixed(2) : md.rawScore;
    }
  }

  const bullishCount = bullishFlags15.filter(Boolean).length;
  const avgAtrPct = atrPcts15.length ? atrPcts15.reduce((a,b)=>a+b,0)/atrPcts15.length : 0;
  const bestEligible = entryCandidates.filter(s => s.eligible).sort((a,b) => b.score - a.score)[0] || null; // BUG1: highest score
  const topEntryCandidate = entryCandidates.reduce((a, b) => {
    if (!a) return b;
    return Number(a.score) > Number(b.score) ? a : b;
  }, null);
  const marketMode = assessMarketMode({
    bullishCount,
    totalPairs: marketData.length,
    avgAtrPct,
    topScore: Number(topEntryCandidate?.score || 0),
    topWeight: Number(topEntryCandidate?.liveWeight || 1),
    topTrendOk: Boolean(topEntryCandidate?.trendOk15),
    topEligible: Boolean(topEntryCandidate?.eligible)
  });
  const volatilityState = calculateVolatilityState(atrPcts15);
  const topScoring = topEntryCandidate
    ? {
        symbol: topEntryCandidate.symbol,
        score: Number(topEntryCandidate.score).toFixed(2),
        liveWeight: Number(topEntryCandidate.liveWeight || 1).toFixed(2),
        eligible: topEntryCandidate.eligible
      }
    : marketData.reduce((a,b) => parseFloat(a.score) > parseFloat(b.score) ? a : b, marketData[0] || {symbol:'none',score:'0'});
  const watchlist = entryCandidates.filter(s => s.eligible).map(s => ({ symbol: s.symbol }));

  // Attach entryCandidate to marketData for reporting
  for (const md of marketData) {
    md.entryCandidate = entryCandidates.find(e => e.symbol === md.symbol);
  }

  return {
    marketData,
    bestEligible,
    topScoring,
    watchlist,
    marketMode,
    volatilityState,
    entryCandidates   // tambahkan
  };
}

function pickStopPct(atr, price, config) {
  const raw = -(config.atrStopMultiplier * atr / price);
  // widest = most negative (e.g. -0.025), tightest = least negative (e.g. -0.006)
  const widest = Math.min(config.minStopPct, config.maxStopPct);
  const tightest = Math.max(config.minStopPct, config.maxStopPct);
  const atrStop = Math.max(widest, Math.min(tightest, raw));
  const emergencyStop = Number(config.emergencyStopLossPct);

  // Normal ATR stop should never be looser than emergency stop.
  if (Number.isFinite(emergencyStop)) {
    return Math.max(atrStop, emergencyStop);
  }

  return atrStop;
}

async function evaluateExit(position, balances, config, getCandles) {
  const { symbol, entry, trailingActive, stopPct, entryTime } = position;
  const botType = config.activeBotType || config.selectedBotType || "scalp_trend";
  const isRangeScalp = botType === "range_scalp";
  const isSwingTrade = botType === "swing_trade";
  if (!Number.isFinite(entry) || entry <= 0) {
    return { exit: false, reason: "Invalid entry reference" };
  }
  const candles = await getCandles(symbol, config.signalTimeframe, 50);
  if (!candles || candles.length < 2) return null;
  const closes = candles.map(c => parseFloat(c[4]));
  const highs = candles.map(c => parseFloat(c[2]));
  const price = closes[closes.length-1];
  const prevClose = closes[closes.length-2];
  const rsi = RSI(closes);
  const prevRsi = RSI(closes.slice(0,-1));
  const pnl = (price - entry) / entry;
  const roundTripFeePct = config._effectiveRoundTripFeePct ?? config.roundTripFeePct ?? 0.004;
  const slippageBufferPct = config._effectiveSlippageBufferPct ?? config.slippageBufferPct ?? 0.001;
  const estimatedNetPnl = pnl - roundTripFeePct - slippageBufferPct;
  const ageMin = Math.floor((Date.now() - entryTime) / 60000);
  const priorPeak = Number.isFinite(position.peak) && position.peak > 0 ? position.peak : entry;
  const effectivePeak = Math.max(priorPeak, price);
  const peakPnl = (effectivePeak - entry) / entry;
  const peakEstimatedNetPnl = peakPnl - roundTripFeePct - slippageBufferPct;
  // Case-insensitive balance lookup
  const coinKey = symbol.replace("USDT","").toLowerCase();
  const coinBal = balances[coinKey] || 0;
  // If balance 0 but we think we have position, try find actual key
  let actualBal = coinBal;
  if (coinBal === 0) {
    for (const [k, v] of Object.entries(balances)) {
      if (k.toLowerCase() === coinKey) {
        actualBal = v;
        break;
      }
    }
  }
  const coinValue = actualBal * price;
  const exitQty = actualBal > 0 ? actualBal : coinBal;

  // trailing activation
  let useTrailing = trailingActive;
  const trailingActivationPct = config._effectiveTrailingActivationPct ?? config.trailingActivationPct ?? 0.008;
  const dynamicTakeProfitEnabled = position.useDynamicTakeProfit === true || config.useDynamicTakeProfit === true;
  const configuredTakeProfitPct = config._effectiveTakeProfitPct ?? config.takeProfitPct ?? 0.012;
  const rawPositionTakeProfitPct = position.takeProfitPct;
  const rawPositionActivationPct = position.profitActivationPct;
  const resolvedTakeProfitPct = Number.isFinite(rawPositionTakeProfitPct) ? rawPositionTakeProfitPct : configuredTakeProfitPct;
  const resolvedActivationPct = Number.isFinite(rawPositionActivationPct) ? rawPositionActivationPct : configuredTakeProfitPct;
  const takeProfitPct = dynamicTakeProfitEnabled
    ? Math.max(resolvedTakeProfitPct, resolvedActivationPct)
    : resolvedTakeProfitPct;
  const activationPct = dynamicTakeProfitEnabled
    ? Math.min(resolvedTakeProfitPct, resolvedActivationPct)
    : resolvedActivationPct;
  const profitActivationFloorPct = activationPct;
  const breakEvenArmedPct = config._effectiveBreakEvenArmedPct ?? config.breakEvenArmedPct ?? 0.006;
  if (!useTrailing && pnl >= trailingActivationPct) {
    useTrailing = true;
  }

  // compute ema9 for momentum check (local)
  const ema9 = EMA(closes, 9);
  const ema21 = EMA(closes, 21);
  const ema21Prev = EMA(closes.slice(0, -1), 21);
  const timeStopEnabled = config.enableTimeStop !== false;
  const staleTradeEnabled = config.enableStaleTrade !== false;
  const costGuardEnabled = config.enableCostGuard !== false;
  const costGuardArmPct = config.costGuardArmPct ?? (roundTripFeePct + slippageBufferPct);
  const costGuardFloorPct = config.costGuardFloorPct ?? 0;
  const costCovered = estimatedNetPnl >= 0;
  const costGuardArmed = costGuardEnabled && peakPnl >= costGuardArmPct;
  const costGuardBlocksSoftExit = costGuardArmed && pnl > costGuardFloorPct && !costCovered;
  const costGuardExit = costGuardArmed && pnl <= costGuardFloorPct;

  // exit conditions
  const takeProfitHit = pnl >= takeProfitPct;
  const profitActivationArmed = dynamicTakeProfitEnabled && peakPnl >= activationPct;
  const emergencySL = pnl <= config.emergencyStopLossPct;
  const normalSL = pnl <= stopPct && !useTrailing;
  const momentumFailure =
    !costGuardBlocksSoftExit &&
    !costGuardArmed &&
    !isSwingTrade &&
    pnl >= (config.minMomentumExitPct ?? 0.004) &&
    rsi < prevRsi &&
    price < ema9 &&
    price < prevClose;
  const rsiBlowoffExit =
    !costGuardBlocksSoftExit &&
    !costGuardArmed &&
    !isSwingTrade &&
    rsi > config.exitRSIThreshold &&
    rsi < prevRsi &&
    price < prevClose;
  const drawdownFromPeak = effectivePeak > 0 ? (price - effectivePeak) / effectivePeak : 0;
  const trailingExit = !costGuardBlocksSoftExit && useTrailing && drawdownFromPeak <= -config.trailingDrawdownPct;
  const trailingProtection = !costGuardBlocksSoftExit && useTrailing && pnl < config.trailingProtectionPct;
  const profitActivationExit =
    !costGuardBlocksSoftExit &&
    profitActivationArmed &&
    pnl <= profitActivationFloorPct &&
    drawdownFromPeak < 0;
  const timeStopMinutes = config.timeStopMinutes ?? 18;
  const timeStopProfitPct = config.timeStopProfitPct ?? 0.003;
  const staleTradeMinutes = config.maxHoldMinutes ?? 45;
  const staleTradeProfitPct = config.minHoldPnlPct ?? 0.0035;
  const recentBreakoutHigh = Math.max(...highs.slice(-6, -1));
  const recentSwingLow = Math.min(...closes.slice(-8, -1));
  const breakoutFailed = Number.isFinite(recentBreakoutHigh) ? price < recentBreakoutHigh * 0.997 : price < entry;
  const fastTrendLost = price < ema9 && ema9 <= ema21;
  const trendSlopeLost = ema21 <= ema21Prev;
  const momentumLost = rsi < prevRsi;
  const belowEntry = price < entry;
  const rangeInvalidation =
    (price < ema9 * 0.996 && momentumLost) ||
    (trendSlopeLost && belowEntry);
  const swingInvalidation =
    (trendSlopeLost && belowEntry) ||
    (price < ema21 && belowEntry) ||
    (Number.isFinite(recentSwingLow) && price < recentSwingLow * 0.996);
  const staleInvalidation = isRangeScalp
    ? rangeInvalidation
    : isSwingTrade
      ? swingInvalidation
      : fastTrendLost || (trendSlopeLost && belowEntry) || (breakoutFailed && momentumLost);
  const breakEvenFailure =
    !costGuardBlocksSoftExit &&
    !costGuardArmed &&
    ageMin >= (config.breakEvenMinutes ?? 9) &&
    pnl >= breakEvenArmedPct &&
    pnl <= (config.breakEvenFloorPct ?? 0.0015) &&
    (isSwingTrade ? price < ema21 : price < ema9);
  const timeStop = timeStopEnabled && !costGuardArmed && !isSwingTrade && ageMin >= timeStopMinutes && pnl < timeStopProfitPct && price < ema9;
  const staleTrade =
    staleTradeEnabled &&
    !costGuardArmed &&
    ageMin >= staleTradeMinutes &&
    pnl < staleTradeProfitPct &&
    staleInvalidation;

  if (price > priorPeak) {
    position.peak = price;
  }
  if (!trailingActive && useTrailing) {
    position.trailingActive = true;
  }

  const diagnostics = {
    pnlPct: pnl * 100,
    estimatedNetPnlPct: estimatedNetPnl * 100,
    peakPnlPct: peakPnl * 100,
    peakEstimatedNetPnlPct: peakEstimatedNetPnl * 100,
    drawdownFromPeakPct: drawdownFromPeak * 100,
    ageMin,
    trailingActive: position.trailingActive,
    costCovered,
    timeStopEnabled,
    staleTradeEnabled,
    staleInvalidation,
    breakoutFailed,
    fastTrendLost,
    trendSlopeLost,
    momentumLost,
    rangeInvalidation,
    swingInvalidation,
    costGuardEnabled,
    costGuardArmed,
    costGuardArmPct: costGuardArmPct * 100,
    costGuardFloorPct: costGuardFloorPct * 100,
    costGuardBlocksSoftExit,
    costGuardExit,
    dynamicTakeProfitEnabled,
    takeProfitPct: takeProfitPct * 100,
    profitActivationPct: activationPct * 100,
    profitActivationFloorPct: profitActivationFloorPct * 100,
    profitActivationArmed,
    profitActivationExit,
    takeProfitHit,
    emergencySL,
    normalSL,
    breakEvenFailure,
    timeStop,
    staleTrade,
    momentumFailure,
    rsiBlowoffExit,
    trailingExit,
    trailingProtection
  };

  if (takeProfitHit) return { exit: true, reason: "Take Profit", pnl, qty: exitQty, currentPrice: price, drawdownFromPeak, peakPnlPct: peakPnl * 100, diagnostics };
  if (emergencySL) return { exit: true, reason: "Emergency SL", pnl, qty: exitQty, currentPrice: price, drawdownFromPeak, peakPnlPct: peakPnl * 100, diagnostics };
  if (normalSL) return { exit: true, reason: "ATR Stop Loss", pnl, qty: exitQty, currentPrice: price, drawdownFromPeak, peakPnlPct: peakPnl * 100, diagnostics };
  if (profitActivationExit) return { exit: true, reason: "DTP Fallback", pnl, qty: exitQty, currentPrice: price, drawdownFromPeak, peakPnlPct: peakPnl * 100, diagnostics };
  if (costGuardExit) return { exit: true, reason: "Cost Guard", pnl, qty: exitQty, currentPrice: price, drawdownFromPeak, peakPnlPct: peakPnl * 100, diagnostics };
  if (breakEvenFailure) return { exit: true, reason: "Break-even Fade", pnl, qty: exitQty, currentPrice: price, drawdownFromPeak, peakPnlPct: peakPnl * 100, diagnostics };
  if (timeStop) return { exit: true, reason: "Time Stop", pnl, qty: exitQty, currentPrice: price, drawdownFromPeak, peakPnlPct: peakPnl * 100, diagnostics };
  if (staleTrade) return { exit: true, reason: "Stale Trade", pnl, qty: exitQty, currentPrice: price, drawdownFromPeak, peakPnlPct: peakPnl * 100, diagnostics };
  if (momentumFailure) return { exit: true, reason: "Momentum Failure", pnl, qty: exitQty, currentPrice: price, drawdownFromPeak, peakPnlPct: peakPnl * 100, diagnostics };
  if (rsiBlowoffExit) return { exit: true, reason: "RSI Reversal", pnl, qty: exitQty, currentPrice: price, drawdownFromPeak, peakPnlPct: peakPnl * 100, diagnostics };
  if (trailingExit) return { exit: true, reason: "Trailing Hit", pnl, qty: exitQty, currentPrice: price, drawdownFromPeak, peakPnlPct: peakPnl * 100, diagnostics };
  if (trailingProtection) return { exit: true, reason: "Profit Protection", pnl, qty: exitQty, currentPrice: price, drawdownFromPeak, peakPnlPct: peakPnl * 100, diagnostics };

  return { exit: false, useTrailing, drawdownFromPeak, coinValue, ema9, currentPrice: price, peakPnlPct: peakPnl * 100, diagnostics };
}

module.exports = {
  scanMarket,
  pickStopPct,
  evaluateExit
};

