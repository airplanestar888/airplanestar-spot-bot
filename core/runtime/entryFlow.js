async function handleEntryFlow({
  config,
  state,
  scanConfig,
  marketMode,
  volatilityState,
  bestEligible,
  bestShortEligible,
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
  cachedPrices,
  request,
  futures
}) {
  const calcBuySlippagePct = (intendedPrice, fillPrice) => {
    if (!Number.isFinite(intendedPrice) || intendedPrice <= 0 || !Number.isFinite(fillPrice) || fillPrice <= 0) return null;
    return Math.max(0, (fillPrice - intendedPrice) / intendedPrice);
  };

  // ===== SHARED: finalize entry after order fill =====
  async function finalizeEntry({
    orderResult,
    entryPrice,
    entryQty,
    entrySizeUSDT,
    entryPriceSource,
    intendedPrice,
    plannedSize,
    positionMeta,
    buyReasons,
    positionTakeProfitPct,
    profitActivationPct,
    stopPct,
    usdtFreeAfterBuy
  }) {
    const entrySlippagePct = calcBuySlippagePct(intendedPrice, entryPrice);
    const entryFeeAmount = Number.isFinite(orderResult.feeAmount) ? Number(orderResult.feeAmount) : null;
    const entryFeeCoin = orderResult.feeCoin || null;
    const entryFeeUSDT = Number.isFinite(orderResult.feeUSDT) ? Number(orderResult.feeUSDT) : null;

    state.positions = [...(state.positions || []).filter(Boolean), positionMeta];
    state.position = state.positions[0] || null;
    state.recentEntriesBySymbol = state.recentEntriesBySymbol || {};
    state.recentEntriesBySymbol[candidate.symbol] = {
      at: now,
      entry: positionMeta.entry,
      qty: positionMeta.qty,
      sizeUSDT: positionMeta.sizeUSDT
    };
    state.lastTradeTime = now + (config._effectiveCooldown ?? config.cooldownMs ?? 300000);
    saveState(STATE_PATH, state);

    await report(reporting.buildBuyReport(
      candidate.symbol,
      positionMeta.entry,
      positionMeta.sizeUSDT,
      positionMeta.qty,
      stopPct,
      config.emergencyStopLossPct,
      config.trailingActivationPct,
      usdtFreeAfterBuy,
      buyReasons,
      positionTakeProfitPct,
      profitActivationPct
    ));

    logEvent(LOG_FILE, "INFO", `Reconciled entry for ${candidate.symbol}: entry=${safeToFixed(positionMeta.entry, 6)} qty=${safeToFixed(positionMeta.qty, 6)} source=${entryPriceSource}`);

    logTrade({
      type: "entry",
      source: "signal",
      botType: config.activeBotType || config.selectedBotType || "",
      mode: config.activeMode || config.selectedMode || "",
      marketProfile: scanConfig.activeMarketProfile || config.selectedMarketProfile || "",
      marketProfileMode: config.marketProfileMode || "",
      pair: candidate.symbol,
      side: entrySide,
      price: positionMeta.entry,
      intendedPrice,
      fillPrice: entryPrice,
      slippagePct: entrySlippagePct != null ? entrySlippagePct * 100 : null,
      feeAmount: entryFeeAmount,
      feeCoin: entryFeeCoin,
      feeUSDT: entryFeeUSDT,
      qty: positionMeta.qty,
      sizeUSDT: positionMeta.sizeUSDT,
      reason: (positionMeta.entryReason?.notes || "entry signal") + (stopPct ? `; stop: ${safeToFixed(stopPct * 100)}%` : ""),
      entry_rsi: candidate.rsi,
      entry_atrPct: candidate.atrPct,
      entry_score: candidate.score,
      entry_marketMode: marketMode,
      entry_volatility: volatilityState,
      fillsUsed: orderResult.fillsUsed === true,
      reconcileLatencyMs: orderResult.reconcileLatencyMs ?? null
    });

    return {
      handled: true,
      currentPositionPrice: entryPrice > 0 ? entryPrice : 0
    };
  }

  // ===== ENTRY GATE CHECKS =====
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

  // ===== SHORT ENTRY DECISION (futures only) =====
  const isFutures = config.tradingMode === "futures";
  const shortsEnabled = isFutures && config.futures?.enableShorts !== false;
  const bearishMarket = ["Bearish", "Choppy"].includes(marketMode);
  const useShort = shortsEnabled && bearishMarket && bestShortEligible && !bestEligible;

  // Select candidate: short or long
  const candidate = useShort ? bestShortEligible : bestEligible;
  if (!candidate) return { handled: true };

  // Set direction fields for futures
  if (useShort) {
    candidate.side = "short";
    candidate.isFutures = true;
    logEvent(LOG_FILE, "INFO", `SHORT entry candidate: ${candidate.symbol} (shortScore=${candidate.shortScore}, marketMode=${marketMode})`);
  } else if (isFutures) {
    candidate.side = "long";
    candidate.isFutures = true;
  }

  const activeEntryBlock = state.entryBlockBySymbol?.[candidate.symbol];
  if (activeEntryBlock && Number(activeEntryBlock.until || 0) > now) {
    const minsLeft = Math.max(1, Math.ceil((Number(activeEntryBlock.until) - now) / 60000));
    logEvent(
      LOG_FILE,
      "INFO",
      `Skipping entry ${candidate.symbol}: reentry blocked ${minsLeft}m after ${activeEntryBlock.reason || "loss"} (${safeToFixed(activeEntryBlock.pnlPct, 2)}%)`
    );
    return { handled: true };
  }
  if (heldSymbols.has(candidate.symbol)) {
    logEvent(LOG_FILE, "DEBUG", `Skipping entry ${candidate.symbol}: already open`);
    return { handled: true };
  }
  if (positions.length >= maxOpenPositions) {
    logEvent(LOG_FILE, "DEBUG", `Skipping entry ${candidate.symbol}: max open positions reached (${positions.length}/${maxOpenPositions})`);
    return { handled: true };
  }
  const remainingExposureUsdt = exposureCapUsdt > 0 ? Math.max(0, exposureCapUsdt - openExposureUsdt) : 0;
  if (remainingExposureUsdt < config.minBuyUSDT) {
    logEvent(LOG_FILE, "DEBUG", `Skipping entry ${candidate.symbol}: exposure cap reached (${safeToFixed(openExposureUsdt, 2)}/${safeToFixed(exposureCapUsdt, 2)} USDT)`);
    return { handled: true };
  }
  if (typeof candidate.price !== "number" || !isFinite(candidate.price) || candidate.price <= 0) {
    logEvent(LOG_FILE, "WARN", "Skipping entry: invalid price from signal");
    return { handled: true };
  }
  const coinKey = String(candidate.symbol || "").replace(/USDT$/i, "").toLowerCase();
  const livePrice = Number(cachedPrices?.[coinKey] ?? cachedPrices?.[candidate.symbol] ?? 0);
  const maxEntryPriceDriftPct = Number(config.maxEntryPriceDriftPct ?? 0.006);
  if (
    Number.isFinite(livePrice) &&
    livePrice > 0 &&
    Number.isFinite(maxEntryPriceDriftPct) &&
    maxEntryPriceDriftPct > 0
  ) {
    const liveDriftPct = (livePrice - candidate.price) / candidate.price;
    if (Math.abs(liveDriftPct) > maxEntryPriceDriftPct) {
      logEvent(
        LOG_FILE,
        "INFO",
        `Skipping entry ${candidate.symbol}: live price drift ${(liveDriftPct * 100).toFixed(2)}% exceeds max ${(maxEntryPriceDriftPct * 100).toFixed(2)}% (signal=${safeToFixed(candidate.price, 6)} live=${safeToFixed(livePrice, 6)})`
      );
      return { handled: true };
    }
  }

  // ===== FUTURES FUNDING RATE GUARD =====
  // Skip entry when funding cost is too expensive for the intended direction.
  // Longs pay when rate > 0; shorts pay when rate < 0. Cached 5min per symbol in futures module.
  if (config.tradingMode === "futures" && futures && Number(config.futures?.fundingRateThreshold) > 0) {
    const fundingRate = await futures.getLiveFundingRate(request, config, candidate.symbol);
    const threshold = Number(config.futures.fundingRateThreshold);
    if (Number.isFinite(fundingRate) && Number.isFinite(threshold)) {
      const expensiveForDirection = useShort
        ? fundingRate < -threshold
        : fundingRate > threshold;
      if (expensiveForDirection) {
        logEvent(LOG_FILE, "INFO",
          `Skipping entry ${candidate.symbol}: funding rate ${(fundingRate * 100).toFixed(4)}% exceeds ±${(threshold * 100).toFixed(4)}% for ${useShort ? "short" : "long"}`
        );
        return { handled: true };
      }
    }
  }

  // ===== BUILD ENTRY PLAN =====
  const entryPlan = buildEntryPlan({ usdtFree, candidate, config, maxAllowedSizeUSDT: remainingExposureUsdt });
  if (!entryPlan) return { handled: true };
  const { reserveUSDT, plannedSize, estimatedQty, clientOrderId } = entryPlan;
  const sizeCapped = safeToFixed(plannedSize, 2);
  const dynamicTakeProfitEnabled = config.useDynamicTakeProfit === true;
  const baseTakeProfitPct = config._effectiveTakeProfitPct ?? config.takeProfitPct ?? 0.012;
  const dynamicTakeProfitPct = candidate.dynamicTakeProfitPct ?? candidate.scalpTargetPct ?? baseTakeProfitPct;
  const positionTakeProfitPct = dynamicTakeProfitEnabled
    ? Math.max(baseTakeProfitPct, dynamicTakeProfitPct)
    : baseTakeProfitPct;
  const profitActivationPct = dynamicTakeProfitEnabled
    ? Math.min(baseTakeProfitPct, dynamicTakeProfitPct)
    : baseTakeProfitPct;
  const profitActivationFloorPct = Math.max(config.trailingProtectionPct ?? 0.0025, profitActivationPct * 0.35);
  const stopPct = pickStopPct(candidate.atr, candidate.price, config);

  const signalNotes = ["15m trend aligned", `RSI ${Number(candidate.rsi).toFixed(1)}`];
  if (config.requireBreakout !== false && candidate.breakoutOk) {
    signalNotes.push(config.activeBotType === "swing_trade" ? "higher timeframe breakout confirmed" : "micro breakout confirmed");
  }
  if (config.requireFastTrend !== false && candidate.fastTrendOk) {
    signalNotes.push("fast trend aligned");
  }
  if (config.requireEma21Rising !== false && candidate.ema21Rising) {
    signalNotes.push("EMA21 rising");
  }
  if (config.requirePriceAboveEma9 !== false && candidate.priceAboveEma9) {
    signalNotes.push("price above EMA9");
  }

  const qualityNotes = [];
  if (config.enableAtrFilter !== false) {
    qualityNotes.push(`ATR ${(Number(candidate.atrPct) * 100).toFixed(2)}%`);
  }
  if (config.enableVolumeFilter !== false) {
    qualityNotes.push(`volume ${Number(candidate.volumeRatio || 0).toFixed(2)}x`);
  }
  if (config.enablePriceExtensionFilter !== false) {
    qualityNotes.push(`EMA gap ${(Number((candidate.emaGapPct || 0) * 100)).toFixed(2)}%`);
  }
  if (config.enableCandleStrengthFilter !== false) {
    qualityNotes.push("candle strength ok");
  }

  const buyReasons = [
    `Highest eligible score (${Number(candidate.score).toFixed(2)})`,
    signalNotes.join(", "),
    qualityNotes.length ? `3m quality: ${qualityNotes.join(", ")}` : "3m quality filters relaxed",
    dynamicTakeProfitEnabled
      ? `TP ${(positionTakeProfitPct * 100).toFixed(2)}% | DTP ${(profitActivationPct * 100).toFixed(2)}%`
      : `Take profit ${(positionTakeProfitPct * 100).toFixed(2)}%`,
    `Path: E ${safeToFixed(candidate.price, 4)} | D +${safeToFixed(profitActivationPct * 100, 2)}% | T +${safeToFixed(positionTakeProfitPct * 100, 2)}%`,
    `Reserve kept: ${safeToFixed(reserveUSDT)} USDT`
  ];

  // ===== EXECUTE ORDER =====
  const entrySide = useShort ? "sell" : "buy";
  const entryResult = await safeExecute(async () => placeOrder(
    candidate.symbol,
    entrySide,
    sizeCapped,
    clientOrderId,
    candidate.price
  ));
  if (!entryResult.success) {
    return { handled: true };
  }

  const orderResult = entryResult.result;
  if (!["FILLED", "PARTIAL"].includes(normalizeOrderStatus(orderResult.status))) {
    throw new Error(`Entry order not executable: ${orderResult.status}`);
  }
  logEvent(LOG_FILE, "INFO", `Order placed: ${orderResult.orderId} filled=${orderResult.filledSize} avg=${safeToFixed(orderResult.avgPrice, 6)} status=${orderResult.status}`);

  // ===== RECONCILE FILL =====
  const orderAvgPrice = Number.isFinite(orderResult.avgPrice) && orderResult.avgPrice > 0
    ? Number(orderResult.avgPrice)
    : 0;
  const actualQtyFromOrder = Number.isFinite(Number(orderResult.filledSize)) && Number(orderResult.filledSize) > 0
    ? Number(orderResult.filledSize)
    : null;
  const spendUSDT = Number.isFinite(Number(orderResult.requestedSize)) && Number(orderResult.requestedSize) > 0
    ? Number(orderResult.requestedSize)
    : Number(plannedSize || sizeCapped || 0);

  if (config.dryRun) {
    // Dry-run: use simulated values directly, no portfolio fetch needed
    const dryRunEntryPrice = orderAvgPrice || candidate.price;
    const dryRunActualQty = actualQtyFromOrder || estimatedQty;
    const dryRunActualSizeUSDT = dryRunActualQty > 0 && dryRunEntryPrice > 0
      ? Number((dryRunActualQty * dryRunEntryPrice).toFixed(8))
      : plannedSize;

    if (state.dryRunPaperBalance) {
      state.dryRunPaperBalance.usdt = Math.max(0, Number(state.dryRunPaperBalance.usdt || 0) - spendUSDT);
      state.dryRunPaperBalance.balances = state.dryRunPaperBalance.balances || {};
      const coin = String(candidate.symbol || '').replace(/USDT$/i, '').toLowerCase();
      state.dryRunPaperBalance.balances.usdt = state.dryRunPaperBalance.usdt;
      state.dryRunPaperBalance.balances[coin] = Number(state.dryRunPaperBalance.balances[coin] || 0) + dryRunActualQty;
    }

    const dryRunPositionMeta = buildPositionMeta({
      candidate,
      marketMode,
      stopPct,
      plannedSize,
      estimatedQty,
      now,
      entryPrice: dryRunEntryPrice,
      actualQty: dryRunActualQty,
      actualSizeUSDT: dryRunActualSizeUSDT,
      intendedEntryPrice: candidate.price,
      entryFillPrice: dryRunEntryPrice,
      entrySlippagePct: calcBuySlippagePct(candidate.price, dryRunEntryPrice),
      entryFeeAmount: Number.isFinite(orderResult.feeAmount) ? Number(orderResult.feeAmount) : null,
      entryFeeCoin: orderResult.feeCoin || null,
      entryFeeUSDT: Number.isFinite(orderResult.feeUSDT) ? Number(orderResult.feeUSDT) : null,
      takeProfitPct: positionTakeProfitPct,
      profitActivationPct,
      profitActivationFloorPct,
      useDynamicTakeProfit: dynamicTakeProfitEnabled
    });

    return finalizeEntry({
      orderResult,
      entryPrice: dryRunEntryPrice,
      entryQty: dryRunActualQty,
      entrySizeUSDT: dryRunActualSizeUSDT,
      entryPriceSource: "dry-run",
      intendedPrice: candidate.price,
      plannedSize,
      positionMeta: dryRunPositionMeta,
      buyReasons,
      positionTakeProfitPct,
      profitActivationPct,
      stopPct,
      usdtFreeAfterBuy: state.dryRunPaperBalance?.usdt ?? (usdtFree - plannedSize)
    });
  }

  // Live: fetch fresh portfolio after buy
  const portfolio = await getPortfolioValue();
  const usdtFreeAfterBuy = portfolio.usdtFree;
  const balances = portfolio.balances;

  const actualQty = getCoinBalance(candidate.symbol, balances);
  let actualEntryPrice = orderAvgPrice || getPriceFromBreakdown(candidate.symbol, balances, portfolio.breakdown);
  let entryPriceSource = orderAvgPrice > 0 ? "fill-avg" : "portfolio";
  if ((!actualEntryPrice || actualEntryPrice <= 0) && actualQty > 0) {
    const pCandles = await getCandles(candidate.symbol, config.signalTimeframe);
    if (pCandles?.length) {
      actualEntryPrice = extractLastClosedPrice(pCandles);
      entryPriceSource = "candle-fallback";
    }
  }
  const reconciledQty = Number.isFinite(actualQty) && actualQty > 0
    ? Number(actualQty)
    : (actualQtyFromOrder || actualQty);
  const entryFillPrice = orderAvgPrice || actualEntryPrice;
  const actualSizeUSDT = reconciledQty > 0 && actualEntryPrice > 0
    ? Number((reconciledQty * actualEntryPrice).toFixed(8))
    : actualQty > 0 && actualEntryPrice > 0
    ? Number((actualQty * actualEntryPrice).toFixed(8))
    : plannedSize;

  const reconciledPositionMeta = buildPositionMeta({
    candidate,
    marketMode,
    stopPct,
    plannedSize,
    estimatedQty,
    now,
    entryPrice: actualEntryPrice,
    actualQty: reconciledQty,
    actualSizeUSDT,
    intendedEntryPrice: candidate.price,
    entryFillPrice,
    entrySlippagePct: calcBuySlippagePct(candidate.price, entryFillPrice),
    entryFeeAmount: Number.isFinite(orderResult.feeAmount) ? Number(orderResult.feeAmount) : null,
    entryFeeCoin: orderResult.feeCoin || null,
    entryFeeUSDT: Number.isFinite(orderResult.feeUSDT) ? Number(orderResult.feeUSDT) : null,
    takeProfitPct: positionTakeProfitPct,
    profitActivationPct,
    profitActivationFloorPct,
    useDynamicTakeProfit: dynamicTakeProfitEnabled
  });

  return finalizeEntry({
    orderResult,
    entryPrice: actualEntryPrice,
    entryQty: reconciledQty,
    entrySizeUSDT: actualSizeUSDT,
    entryPriceSource,
    intendedPrice: candidate.price,
    plannedSize,
    positionMeta: reconciledPositionMeta,
    buyReasons,
    positionTakeProfitPct,
    profitActivationPct,
    stopPct,
    usdtFreeAfterBuy
  });
}

module.exports = {
  handleEntryFlow
};
