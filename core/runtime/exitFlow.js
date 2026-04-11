async function handleExitFlow({
  config,
  state,
  balances,
  currentPositionPrice,
  marketData,
  scanConfig,
  now,
  lastHoldReportTime,
  evaluateExit,
  getCandles,
  getCoinBalance,
  safeExecute,
  placeOrder,
  normalizeOrderStatus,
  getPortfolioValue,
  estimateNetPnlPct,
  shouldReport,
  saveState,
  STATE_PATH,
  logTrade,
  report,
  reporting,
  logEvent,
  LOG_FILE,
  safeToFixed
}) {
  const positions = Array.isArray(state.positions)
    ? state.positions.filter(Boolean)
    : (state.position ? [state.position] : []);
  state.positions = positions;
  state.position = positions[0] || null;
  if (!positions.length) {
    return { handledExit: false, lastHoldReportTime };
  }
  state.lastReportedPnlBySymbol = state.lastReportedPnlBySymbol || {};

  const openPositionsText = positions.map(pos => pos.symbol).filter(Boolean).join(", ");
  const holdItems = [];
  let shouldSendHoldSummary = false;
  const holdReportDue = shouldReport(config.report.holdReportIntervalMs, lastHoldReportTime);

  for (let idx = 0; idx < positions.length; idx++) {
    const openPosition = positions[idx];
    const marketRow = Array.isArray(marketData) ? marketData.find(m => m.symbol === openPosition.symbol) : null;
    const resolvedCurrentPrice = Number.isFinite(marketRow?.price) && marketRow.price > 0
      ? marketRow.price
      : (openPosition.symbol === state.position?.symbol && Number.isFinite(currentPositionPrice) ? currentPositionPrice : 0);

    if (!Number.isFinite(resolvedCurrentPrice) || resolvedCurrentPrice <= 0) {
      logEvent(LOG_FILE, "WARN", `Skipping exit check for ${openPosition.symbol}: no validated position price`);
      continue;
    }

    const exitEval = await evaluateExit(openPosition, balances, config, getCandles);
    if (exitEval?.diagnostics) {
      const d = exitEval.diagnostics;
      logEvent(
        LOG_FILE,
        "DEBUG",
        `EXIT CHECK ${openPosition.symbol} pnl=${safeToFixed(d.pnlPct, 2)}% peak=${safeToFixed(d.peakPnlPct, 2)}% dd=${safeToFixed(d.drawdownFromPeakPct, 2)}% age=${d.ageMin}m trailing=${d.trailingActive} tp=${d.takeProfitHit} esl=${d.emergencySL} asl=${d.normalSL} be=${d.breakEvenFailure} ts=${d.timeStop} stale=${d.staleTrade} mom=${d.momentumFailure} rsi=${d.rsiBlowoffExit} trailHit=${d.trailingExit} protect=${d.trailingProtection}`
      );
    }

    if (exitEval?.exit) {
      const symbol = openPosition.symbol;
      const coinBal = getCoinBalance(symbol, balances);
      if (!coinBal || coinBal <= 0) {
        logEvent(LOG_FILE, "WARN", `Exit skipped: zero balance for ${symbol}`);
        continue;
      }

      const exitPrice = Number.isFinite(exitEval.currentPrice) && exitEval.currentPrice > 0
        ? exitEval.currentPrice
        : resolvedCurrentPrice;

      const exitResult = await safeExecute(async () => placeOrder(symbol, "sell", coinBal));
      if (!exitResult.success) {
        if (exitResult.skip) return { handledExit: true, lastHoldReportTime };
        logEvent(LOG_FILE, "ERROR", `Exit failed: ${exitResult.error?.message || "unknown"}`);
        return { handledExit: true, lastHoldReportTime };
      }

      const orderResult = exitResult.result;
      if (!["FILLED", "PARTIAL"].includes(normalizeOrderStatus(orderResult.status))) {
        throw new Error(`Exit order not executable: ${orderResult.status}`);
      }
      logEvent(
        LOG_FILE,
        "INFO",
        `Exit order placed: ${orderResult.orderId} filled=${orderResult.filledSize} avg=${safeToFixed(orderResult.avgPrice, 6)} status=${orderResult.status}`
      );

      const freshPortfolio = await getPortfolioValue();
      const freshUsdtFree = freshPortfolio.usdtFree;
      const pnlFraction = exitEval.pnl;
      const pnlAbsolute = openPosition.sizeUSDT * pnlFraction;
      logEvent(LOG_FILE, "INFO", `SELL ${symbol} pnl=${safeToFixed(pnlFraction, 4)} reason=${exitEval.reason}`);

      const exitRsi = marketRow ? marketRow.rsi : null;
      const peakPnlPct = Number.isFinite(exitEval.peakPnlPct) ? exitEval.peakPnlPct : null;

      logTrade({
        type: "exit",
        source: exitEval.reason,
        botType: config.activeBotType || config.selectedBotType || "",
        mode: config.activeMode || config.selectedMode || "",
        marketProfile: scanConfig.activeMarketProfile || config.selectedMarketProfile || "",
        marketProfileMode: config.marketProfileMode || "",
        pair: symbol,
        side: "sell",
        price: exitPrice,
        qty: Number(orderResult.filledSize || coinBal),
        sizeUSDT: Number(orderResult.filledSize || coinBal) * exitPrice,
        PnL: pnlAbsolute,
        PnL_pct: pnlFraction * 100,
        reason: exitEval.reason,
        exit_rsi: exitRsi,
        netPnlEstPct: estimateNetPnlPct(pnlFraction),
        peakPnlPct,
        drawdownFromPeak: Number.isFinite(exitEval.drawdownFromPeak) ? exitEval.drawdownFromPeak * 100 : null
      });

      const estimatedNetPnlPct = estimateNetPnlPct(pnlFraction);
      const tpMainPct = Number.isFinite(openPosition?.takeProfitPct) ? openPosition.takeProfitPct * 100 : null;
      const activationPct = Number.isFinite(openPosition?.profitActivationPct) ? openPosition.profitActivationPct * 100 : null;
      await report(reporting.buildSellReport(
        symbol,
        exitPrice,
        pnlFraction,
        exitEval.reason,
        openPosition.entry,
        peakPnlPct,
        freshUsdtFree,
        state.lossStreak,
        state.tradesToday + 1,
        [
          `Exit PnL ${safeToFixed(pnlFraction * 100, 2)}% with peak ${safeToFixed(peakPnlPct, 2)}%`,
          `Drawdown from peak ${safeToFixed((Number.isFinite(exitEval.drawdownFromPeak) ? exitEval.drawdownFromPeak : 0) * 100, 2)}%`,
          `Est. net after fee/slippage ${safeToFixed(estimatedNetPnlPct, 2)}%`,
          `TP ${tpMainPct == null ? "N/A" : `${safeToFixed(tpMainPct, 2)}%`} | DTP ${activationPct == null ? "N/A" : `${safeToFixed(activationPct, 2)}%`}`,
          `Trailing ${openPosition.trailingActive ? "active" : "inactive"} | Stop ${safeToFixed((openPosition.stopPct || 0) * 100, 2)}%`
        ],
        estimatedNetPnlPct,
        openPosition?.takeProfitPct ?? null,
        openPosition?.profitActivationPct ?? null
      ));

      const remainingQty = getCoinBalance(symbol, freshPortfolio.balances);
      const isExitPartial = Number(orderResult.filledSize || 0) + 1e-12 < Number(coinBal || 0);
      state.tradesToday++;
      state.lastTradeTime = now + (config._effectiveCooldown ?? config.cooldownMs ?? 300000);
      state.lastTradePnl = pnlFraction;
      state.realizedPnlToday += pnlAbsolute;
      state.lastReportedPnl = null;
      delete state.lastReportedPnlBySymbol[symbol];

      if (pnlFraction < 0) {
        state.lossStreak++;
        state.lastTradeTime = now + config.lossCooldownMs;
      } else {
        state.lossStreak = 0;
      }

      if (isExitPartial && remainingQty > 0) {
        const remainingValue = remainingQty * exitPrice;
        positions[idx] = {
          ...openPosition,
          qty: remainingQty,
          sizeUSDT: remainingValue,
          entry: openPosition.entry || exitPrice,
          peak: Math.max(openPosition.peak || openPosition.entry || exitPrice, exitPrice)
        };
      } else {
        positions.splice(idx, 1);
      }

      state.positions = positions;
      state.position = positions[0] || null;
      saveState(STATE_PATH, state);
      return { handledExit: true, lastHoldReportTime };
    }

    if (exitEval?.useTrailing && !openPosition.trailingActive) {
      openPosition.trailingActive = true;
      state.positions = positions;
      state.position = positions[0] || null;
      saveState(STATE_PATH, state);
      await report(reporting.buildTrailingActivatedReport(
        openPosition.symbol,
        openPosition.entry,
        resolvedCurrentPrice,
        ((resolvedCurrentPrice - openPosition.entry) / openPosition.entry * 100),
        config.trailingActivationPct
      ));
    }

    const holdPrice = Number.isFinite(exitEval?.currentPrice) && exitEval.currentPrice > 0
      ? exitEval.currentPrice
      : resolvedCurrentPrice;
    const pnlPct = Number.isFinite(exitEval?.diagnostics?.pnlPct)
      ? exitEval.diagnostics.pnlPct
      : ((holdPrice - openPosition.entry) / openPosition.entry * 100);
    const lastReported = state.lastReportedPnlBySymbol[openPosition.symbol] ?? null;
    const pnlChanged = lastReported === null || Math.abs(pnlPct - lastReported) > 0.3;
    if (pnlChanged) {
      shouldSendHoldSummary = true;
    }
    const peakPnLPct = Number.isFinite(exitEval?.diagnostics?.peakPnlPct)
      ? exitEval.diagnostics.peakPnlPct
      : ((Math.max(
          Number.isFinite(openPosition.peak) ? openPosition.peak : openPosition.entry,
          holdPrice
        ) - openPosition.entry) / openPosition.entry * 100);
    const peakPriceFromPct = openPosition.entry * (1 + (peakPnLPct / 100));
    holdItems.push({
      position: openPosition,
      currentPrice: holdPrice,
      pnlPct,
      peakPnLPct,
      livePeakPrice: peakPriceFromPct,
      useTrailing: openPosition.trailingActive,
      ageMin: Math.floor((now - openPosition.entryTime) / 60000),
      drawdownFromPeak: peakPriceFromPct > 0
        ? (holdPrice - peakPriceFromPct) / peakPriceFromPct
        : 0
    });
  }

  if (holdItems.length && (holdReportDue || shouldSendHoldSummary)) {
    const totalExposureUsdt = positions.reduce((sum, pos) => sum + (Number(pos?.sizeUSDT) || 0), 0);
    await report(reporting.buildHoldSummaryReport(
      holdItems,
      now,
      {
        openPositionsText,
        totalExposureUsdt,
        exposureCapPct: Number(config.exposureCapPct)
      }
    ));
    state.lastReportedPnl = holdItems.length === 1 ? holdItems[0].pnlPct : null;
    for (const item of holdItems) {
      state.lastReportedPnlBySymbol[item.position.symbol] = item.pnlPct;
    }
    lastHoldReportTime = now;
    state.positions = positions;
    state.position = positions[0] || null;
    saveState(STATE_PATH, state);
  }

  return { handledExit: false, lastHoldReportTime };
}

module.exports = {
  handleExitFlow
};
