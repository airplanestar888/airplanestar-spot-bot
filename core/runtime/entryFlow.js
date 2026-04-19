async function handleEntryFlow({
  config,
  state,
  scanConfig,
  marketMode,
  volatilityState,
  bestEligible,
  usdtFree,
  currentEquity,
  now,
  globalExecutionFailures,
  buildEntryPlan,
  buildPositionMeta,
  pickStopPct,
  safeExecute,
  placeOrder,
  normalizeOrderStatus,
  getPortfolioValue,
  getCoinBalance,
  getPriceFromBreakdown,
  getCandles,
  extractLastClosedPrice,
  saveState,
  STATE_PATH,
  logTrade,
  report,
  reporting,
  logEvent,
  LOG_FILE,
  safeToFixed,
  cachedPrices
}) {
  const calcBuySlippagePct = (intendedPrice, fillPrice) => {
    if (!Number.isFinite(intendedPrice) || intendedPrice <= 0 || !Number.isFinite(fillPrice) || fillPrice <= 0) return null;
    return Math.max(0, (fillPrice - intendedPrice) / intendedPrice);
  };

  const positions = Array.isArray(state.positions)
    ? state.positions.filter(Boolean)
    : (state.position ? [state.position] : []);
  state.positions = positions;
  state.position = positions[0] || null;
  const enableMultiTrade = config.enableMultiTrade === true;
  const maxOpenPositions = enableMultiTrade ? Math.max(1, Number(config.maxOpenPositions || 1)) : 1;
  const heldSymbols = new Set(positions.map(pos => pos?.symbol).filter(Boolean));
  const openExposureUsdt = positions.reduce((sum, pos) => sum + (Number(pos?.sizeUSDT || 0) || 0), 0);
  const exposureCapUsdt = Math.max(0, (Number(currentEquity || 0) || 0) * (Number(config.exposureCapPct || 0.5) || 0.5));

  if (state.haltedForDay) return { handled: true };
  if (globalExecutionFailures >= 3) {
    logEvent(LOG_FILE, "ERROR", "Bot halted due to repeated execution failures. Manual intervention required.");
    state.haltedForDay = true;
    saveState(STATE_PATH, state);
    return { handled: true };
  }
  if (!bestEligible) return { handled: true };
  const activeEntryBlock = state.entryBlockBySymbol?.[bestEligible.symbol];
  if (activeEntryBlock && Number(activeEntryBlock.until || 0) > now) {
    const minsLeft = Math.max(1, Math.ceil((Number(activeEntryBlock.until) - now) / 60000));
    logEvent(
      LOG_FILE,
      "INFO",
      `Skipping entry ${bestEligible.symbol}: reentry blocked ${minsLeft}m after ${activeEntryBlock.reason || "loss"} (${safeToFixed(activeEntryBlock.pnlPct, 2)}%)`
    );
    return { handled: true };
  }
  if (heldSymbols.has(bestEligible.symbol)) {
    logEvent(LOG_FILE, "DEBUG", `Skipping entry ${bestEligible.symbol}: already open`);
    return { handled: true };
  }
  if (positions.length >= maxOpenPositions) {
    logEvent(LOG_FILE, "DEBUG", `Skipping entry ${bestEligible.symbol}: max open positions reached (${positions.length}/${maxOpenPositions})`);
    return { handled: true };
  }
  const remainingExposureUsdt = exposureCapUsdt > 0 ? Math.max(0, exposureCapUsdt - openExposureUsdt) : 0;
  if (remainingExposureUsdt < config.minBuyUSDT) {
    logEvent(LOG_FILE, "DEBUG", `Skipping entry ${bestEligible.symbol}: exposure cap reached (${safeToFixed(openExposureUsdt, 2)}/${safeToFixed(exposureCapUsdt, 2)} USDT)`);
    return { handled: true };
  }
  if (typeof bestEligible.price !== "number" || !isFinite(bestEligible.price) || bestEligible.price <= 0) {
    logEvent(LOG_FILE, "WARN", "Skipping entry: invalid price from signal");
    return { handled: true };
  }
  const coinKey = String(bestEligible.symbol || "").replace(/USDT$/i, "").toLowerCase();
  const livePrice = Number(cachedPrices?.[coinKey] ?? cachedPrices?.[bestEligible.symbol] ?? 0);
  const maxEntryPriceDriftPct = Number(config.maxEntryPriceDriftPct ?? 0.006);
  if (
    Number.isFinite(livePrice) &&
    livePrice > 0 &&
    Number.isFinite(maxEntryPriceDriftPct) &&
    maxEntryPriceDriftPct > 0
  ) {
    const liveDriftPct = (livePrice - bestEligible.price) / bestEligible.price;
    if (Math.abs(liveDriftPct) > maxEntryPriceDriftPct) {
      logEvent(
        LOG_FILE,
        "INFO",
        `Skipping entry ${bestEligible.symbol}: live price drift ${(liveDriftPct * 100).toFixed(2)}% exceeds max ${(maxEntryPriceDriftPct * 100).toFixed(2)}% (signal=${safeToFixed(bestEligible.price, 6)} live=${safeToFixed(livePrice, 6)})`
      );
      return { handled: true };
    }
  }

  const entryPlan = buildEntryPlan({ usdtFree, bestEligible, config, maxAllowedSizeUSDT: remainingExposureUsdt });
  if (!entryPlan) return { handled: true };
  const { reserveUSDT, plannedSize, estimatedQty, clientOrderId } = entryPlan;
  const sizeCapped = safeToFixed(plannedSize, 2);
  const dynamicTakeProfitEnabled = config.useDynamicTakeProfit === true;
  const baseTakeProfitPct = config._effectiveTakeProfitPct ?? config.takeProfitPct ?? 0.012;
  const dynamicTakeProfitPct = bestEligible.dynamicTakeProfitPct ?? bestEligible.scalpTargetPct ?? baseTakeProfitPct;
  const positionTakeProfitPct = dynamicTakeProfitEnabled
    ? Math.max(baseTakeProfitPct, dynamicTakeProfitPct)
    : baseTakeProfitPct;
  const profitActivationPct = dynamicTakeProfitEnabled
    ? Math.min(baseTakeProfitPct, dynamicTakeProfitPct)
    : baseTakeProfitPct;
  const profitActivationFloorPct = Math.max(config.trailingProtectionPct ?? 0.0025, profitActivationPct * 0.35);
  const stopPct = pickStopPct(bestEligible.atr, bestEligible.price, config);

  const signalNotes = ["15m trend aligned", `RSI ${Number(bestEligible.rsi).toFixed(1)}`];
  if (config.requireBreakout !== false && bestEligible.breakoutOk) {
    signalNotes.push(config.activeBotType === "swing_trade" ? "higher timeframe breakout confirmed" : "micro breakout confirmed");
  }
  if (config.requireFastTrend !== false && bestEligible.fastTrendOk) {
    signalNotes.push("fast trend aligned");
  }
  if (config.requireEma21Rising !== false && bestEligible.ema21Rising) {
    signalNotes.push("EMA21 rising");
  }
  if (config.requirePriceAboveEma9 !== false && bestEligible.priceAboveEma9) {
    signalNotes.push("price above EMA9");
  }

  const qualityNotes = [];
  if (config.enableAtrFilter !== false) {
    qualityNotes.push(`ATR ${(Number(bestEligible.atrPct) * 100).toFixed(2)}%`);
  }
  if (config.enableVolumeFilter !== false) {
    qualityNotes.push(`volume ${Number(bestEligible.volumeRatio || 0).toFixed(2)}x`);
  }
  if (config.enablePriceExtensionFilter !== false) {
    qualityNotes.push(`EMA gap ${(Number((bestEligible.emaGapPct || 0) * 100)).toFixed(2)}%`);
  }
  if (config.enableCandleStrengthFilter !== false) {
    qualityNotes.push("candle strength ok");
  }

  const buyReasons = [
    `Highest eligible score (${Number(bestEligible.score).toFixed(2)})`,
    signalNotes.join(", "),
    qualityNotes.length ? `3m quality: ${qualityNotes.join(", ")}` : "3m quality filters relaxed",
    dynamicTakeProfitEnabled
      ? `TP ${(positionTakeProfitPct * 100).toFixed(2)}% | DTP ${(profitActivationPct * 100).toFixed(2)}%`
      : `Take profit ${(positionTakeProfitPct * 100).toFixed(2)}%`,
    `Path: E ${safeToFixed(bestEligible.price, 4)} | D +${safeToFixed(profitActivationPct * 100, 2)}% | T +${safeToFixed(positionTakeProfitPct * 100, 2)}%`,
    `Reserve kept: ${safeToFixed(reserveUSDT)} USDT`
  ];

  const positionMeta = buildPositionMeta({
    bestEligible,
    marketMode,
    stopPct,
    plannedSize,
    estimatedQty,
    now,
    intendedEntryPrice: bestEligible.price,
    takeProfitPct: positionTakeProfitPct,
    profitActivationPct,
    profitActivationFloorPct,
    useDynamicTakeProfit: dynamicTakeProfitEnabled
  });

  if (config.dryRun) {
    const entryResult = await safeExecute(async () => placeOrder(
      bestEligible.symbol,
      "buy",
      sizeCapped,
      clientOrderId,
      bestEligible.price
    ));
    if (!entryResult.success) {
      return { handled: true };
    }

    const orderResult = entryResult.result;
    if (!["FILLED", "PARTIAL"].includes(normalizeOrderStatus(orderResult.status))) {
      throw new Error(`Dry-run entry not executable: ${orderResult.status}`);
    }
    logEvent(LOG_FILE, "INFO", `Dry-run order placed: ${orderResult.orderId} filled=${orderResult.filledSize} avg=${safeToFixed(orderResult.avgPrice, 6)} status=${orderResult.status}`);

    const dryRunEntryPrice = Number.isFinite(orderResult.avgPrice) && orderResult.avgPrice > 0
      ? Number(orderResult.avgPrice)
      : bestEligible.price;
    const dryRunEntrySlippagePct = calcBuySlippagePct(bestEligible.price, dryRunEntryPrice);
    const dryRunPositionMeta = buildPositionMeta({
      bestEligible,
      marketMode,
      stopPct,
      plannedSize,
      estimatedQty,
      now,
      entryPrice: dryRunEntryPrice,
      actualQty: estimatedQty,
      actualSizeUSDT: plannedSize,
      intendedEntryPrice: bestEligible.price,
      entryFillPrice: dryRunEntryPrice,
      entrySlippagePct: dryRunEntrySlippagePct,
      takeProfitPct: positionTakeProfitPct,
      profitActivationPct,
      profitActivationFloorPct,
      useDynamicTakeProfit: dynamicTakeProfitEnabled
    });

    state.positions = [...positions, dryRunPositionMeta];
    state.position = state.positions[0] || null;
    state.recentEntriesBySymbol = state.recentEntriesBySymbol || {};
    state.recentEntriesBySymbol[bestEligible.symbol] = {
      at: now,
      entry: dryRunPositionMeta.entry,
      qty: dryRunPositionMeta.qty,
      sizeUSDT: dryRunPositionMeta.sizeUSDT
    };
    state.lastTradeTime = now + (config._effectiveCooldown ?? config.cooldownMs ?? 300000);
    saveState(STATE_PATH, state);
    await report(reporting.buildBuyReport(
      bestEligible.symbol,
      dryRunPositionMeta.entry,
      dryRunPositionMeta.sizeUSDT,
      dryRunPositionMeta.qty,
      stopPct,
      config.emergencyStopLossPct,
      config.trailingActivationPct,
      usdtFree - plannedSize,
      buyReasons,
      positionTakeProfitPct,
      profitActivationPct
    ));
    logTrade({
      type: "entry",
      source: "signal",
      botType: config.activeBotType || config.selectedBotType || "",
      mode: config.activeMode || config.selectedMode || "",
      marketProfile: scanConfig.activeMarketProfile || config.selectedMarketProfile || "",
      marketProfileMode: config.marketProfileMode || "",
      pair: bestEligible.symbol,
      side: "buy",
      price: dryRunEntryPrice,
      intendedPrice: bestEligible.price,
      fillPrice: dryRunEntryPrice,
      slippagePct: dryRunEntrySlippagePct != null ? dryRunEntrySlippagePct * 100 : null,
      qty: estimatedQty,
      sizeUSDT: plannedSize,
      reason: (dryRunPositionMeta.entryReason?.notes || "entry signal") + (stopPct ? `; stop: ${safeToFixed(stopPct * 100)}%` : ""),
      entry_rsi: bestEligible.rsi,
      entry_atrPct: bestEligible.atrPct,
      entry_score: bestEligible.score,
      entry_marketMode: marketMode,
      entry_volatility: volatilityState
    });
    return {
      handled: true,
      currentPositionPrice: dryRunPositionMeta.entry
    };
  }

  const entryResult = await safeExecute(async () => placeOrder(
    bestEligible.symbol,
    "buy",
    sizeCapped,
    clientOrderId,
    bestEligible.price
  ));
  if (!entryResult.success) {
    return { handled: true };
  }

  const orderResult = entryResult.result;
  if (!["FILLED", "PARTIAL"].includes(normalizeOrderStatus(orderResult.status))) {
    throw new Error(`Entry order not executable: ${orderResult.status}`);
  }
  logEvent(LOG_FILE, "INFO", `Order placed: ${orderResult.orderId} filled=${orderResult.filledSize} avg=${safeToFixed(orderResult.avgPrice, 6)} status=${orderResult.status}`);

  const portfolio = await getPortfolioValue();
  const usdtFreeAfterBuy = portfolio.usdtFree;
  const balances = portfolio.balances;

  const actualQty = getCoinBalance(bestEligible.symbol, balances);
  const orderAvgEntryPrice = Number.isFinite(orderResult.avgPrice) && orderResult.avgPrice > 0
    ? Number(orderResult.avgPrice)
    : 0;
  let actualEntryPrice = orderAvgEntryPrice || getPriceFromBreakdown(bestEligible.symbol, balances, portfolio.breakdown);
  let entryPriceSource = "portfolio";
  if (orderAvgEntryPrice > 0) {
    entryPriceSource = "fill-avg";
  }
  if ((!actualEntryPrice || actualEntryPrice <= 0) && actualQty > 0) {
    const pCandles = await getCandles(bestEligible.symbol, config.signalTimeframe);
    if (pCandles?.length) {
      actualEntryPrice = extractLastClosedPrice(pCandles);
      entryPriceSource = "candle-fallback";
    }
  }
  const reconciledQty = Number.isFinite(actualQty) && actualQty > 0
    ? Number(actualQty)
    : (Number.isFinite(orderResult.filledSize) && orderResult.filledSize > 0 ? Number(orderResult.filledSize) : actualQty);
  const entryFillPrice = orderAvgEntryPrice || actualEntryPrice;
  const entrySlippagePct = calcBuySlippagePct(bestEligible.price, entryFillPrice);
  const entryFeeAmount = Number.isFinite(orderResult.feeAmount) ? Number(orderResult.feeAmount) : null;
  const entryFeeCoin = orderResult.feeCoin || null;
  const entryFeeUSDT = Number.isFinite(orderResult.feeUSDT) ? Number(orderResult.feeUSDT) : null;
  const actualSizeUSDT = reconciledQty > 0 && actualEntryPrice > 0
    ? Number((reconciledQty * actualEntryPrice).toFixed(8))
    : actualQty > 0 && actualEntryPrice > 0
    ? Number((actualQty * actualEntryPrice).toFixed(8))
    : plannedSize;

  const reconciledPositionMeta = buildPositionMeta({
    bestEligible,
    marketMode,
    stopPct,
    plannedSize,
    estimatedQty,
    now,
    entryPrice: actualEntryPrice,
    actualQty: reconciledQty,
    actualSizeUSDT,
    intendedEntryPrice: bestEligible.price,
    entryFillPrice,
    entrySlippagePct,
    entryFeeAmount,
    entryFeeCoin,
    entryFeeUSDT,
    takeProfitPct: positionTakeProfitPct,
    profitActivationPct,
    profitActivationFloorPct,
    useDynamicTakeProfit: dynamicTakeProfitEnabled
  });

  state.positions = [...positions, reconciledPositionMeta];
  state.position = state.positions[0] || null;
  state.recentEntriesBySymbol = state.recentEntriesBySymbol || {};
  state.recentEntriesBySymbol[bestEligible.symbol] = {
    at: now,
    entry: reconciledPositionMeta.entry,
    qty: reconciledPositionMeta.qty,
    sizeUSDT: reconciledPositionMeta.sizeUSDT
  };
  state.lastTradeTime = now + (config._effectiveCooldown ?? config.cooldownMs ?? 300000);
  saveState(STATE_PATH, state);

  await report(reporting.buildBuyReport(
    bestEligible.symbol,
    reconciledPositionMeta.entry,
    reconciledPositionMeta.sizeUSDT,
    reconciledPositionMeta.qty,
    stopPct,
    config.emergencyStopLossPct,
    config.trailingActivationPct,
    usdtFreeAfterBuy,
    buyReasons,
    positionTakeProfitPct,
    profitActivationPct
  ));
  logEvent(LOG_FILE, "INFO", `Reconciled entry for ${bestEligible.symbol}: entry=${safeToFixed(reconciledPositionMeta.entry, 6)} qty=${safeToFixed(reconciledPositionMeta.qty, 6)} source=${entryPriceSource}`);

  logTrade({
    type: "entry",
    source: "signal",
    botType: config.activeBotType || config.selectedBotType || "",
    mode: config.activeMode || config.selectedMode || "",
    marketProfile: scanConfig.activeMarketProfile || config.selectedMarketProfile || "",
    marketProfileMode: config.marketProfileMode || "",
    pair: bestEligible.symbol,
    side: "buy",
    price: reconciledPositionMeta.entry,
    intendedPrice: bestEligible.price,
    fillPrice: entryFillPrice,
    slippagePct: entrySlippagePct != null ? entrySlippagePct * 100 : null,
    feeAmount: entryFeeAmount,
    feeCoin: entryFeeCoin,
    feeUSDT: entryFeeUSDT,
    qty: reconciledPositionMeta.qty,
    sizeUSDT: reconciledPositionMeta.sizeUSDT,
    reason: (reconciledPositionMeta.entryReason?.notes || "entry signal") + (stopPct ? `; stop: ${safeToFixed(stopPct * 100)}%` : ""),
    entry_rsi: bestEligible.rsi,
    entry_atrPct: bestEligible.atrPct,
    entry_score: bestEligible.score,
    entry_marketMode: marketMode,
    entry_volatility: volatilityState,
    fillsUsed: orderResult.fillsUsed === true,
    reconcileLatencyMs: orderResult.reconcileLatencyMs ?? null
  });

  return {
    handled: true,
    currentPositionPrice: actualEntryPrice > 0 ? actualEntryPrice : 0
  };
}

module.exports = {
  handleEntryFlow
};
