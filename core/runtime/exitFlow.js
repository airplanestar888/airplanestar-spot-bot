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
  const calcSellSlippagePct = (intendedPrice, fillPrice) => {
    if (!Number.isFinite(intendedPrice) || intendedPrice <= 0 || !Number.isFinite(fillPrice) || fillPrice <= 0) return null;
    return Math.max(0, (intendedPrice - fillPrice) / intendedPrice);
  };

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
  let exitOccurred = false;

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
      const exitRsi = marketRow ? marketRow.rsi : null;
      const peakPnlPct = Number.isFinite(exitEval.peakPnlPct) ? exitEval.peakPnlPct : null;
      const exitFillPrice = Number.isFinite(orderResult.avgPrice) && orderResult.avgPrice > 0
        ? Number(orderResult.avgPrice)
        : exitPrice;
      const exitQty = Number(orderResult.filledSize || coinBal || 0);
      const entryFillPrice = Number.isFinite(openPosition?.entryFillPrice) && openPosition.entryFillPrice > 0
        ? Number(openPosition.entryFillPrice)
        : Number(openPosition.entry || 0);
      const entryCostUSDT = Number.isFinite(entryFillPrice) && entryFillPrice > 0 && exitQty > 0
        ? entryFillPrice * exitQty
        : Number(openPosition.sizeUSDT || 0);
      const exitValueUSDT = Number.isFinite(exitFillPrice) && exitFillPrice > 0 && exitQty > 0
        ? exitFillPrice * exitQty
        : 0;
      const actualGrossPnlUSDT = exitValueUSDT - entryCostUSDT;
      const actualGrossPnlFraction = entryCostUSDT > 0
        ? actualGrossPnlUSDT / entryCostUSDT
        : exitEval.pnl;
      const exitSlippagePct = calcSellSlippagePct(exitPrice, exitFillPrice);
      const entrySlippagePct = Number.isFinite(openPosition?.entrySlippagePct) ? Number(openPosition.entrySlippagePct) : null;
      const totalActualSlippagePct = (entrySlippagePct ?? 0) + (exitSlippagePct ?? 0);
      const entryFeeUSDT = Number.isFinite(openPosition?.entryFeeUSDT) ? Number(openPosition.entryFeeUSDT) : null;
      const exitFeeAmount = Number.isFinite(orderResult.feeAmount) ? Number(orderResult.feeAmount) : null;
      const exitFeeCoin = orderResult.feeCoin || null;
      const exitFeeUSDT = Number.isFinite(orderResult.feeUSDT) ? Number(orderResult.feeUSDT) : null;
      const actualFeeUSDT = Number.isFinite(entryFeeUSDT) && Number.isFinite(exitFeeUSDT)
        ? entryFeeUSDT + exitFeeUSDT
        : null;
      const fallbackNetPnlPct = estimateNetPnlPct(actualGrossPnlFraction, {
        actualSlippagePct: 0
      });
      const netPnlPct = Number.isFinite(actualFeeUSDT) && entryCostUSDT > 0
        ? ((actualGrossPnlUSDT - actualFeeUSDT) / entryCostUSDT) * 100
        : fallbackNetPnlPct;
      const netPnlAbsolute = Number.isFinite(actualFeeUSDT)
        ? actualGrossPnlUSDT - actualFeeUSDT
        : entryCostUSDT * (netPnlPct / 100);
      const pnlFraction = actualGrossPnlFraction;
      const pnlAbsolute = actualGrossPnlUSDT;
      logEvent(LOG_FILE, "INFO", `SELL ${symbol} pnl=${safeToFixed(pnlFraction, 4)} reason=${exitEval.reason}`);

      logTrade({
        type: "exit",
        source: exitEval.reason,
        botType: config.activeBotType || config.selectedBotType || "",
        mode: config.activeMode || config.selectedMode || "",
        marketProfile: scanConfig.activeMarketProfile || config.selectedMarketProfile || "",
        marketProfileMode: config.marketProfileMode || "",
        pair: symbol,
        side: "sell",
        price: exitFillPrice,
        intendedPrice: exitPrice,
        fillPrice: exitFillPrice,
        slippagePct: exitSlippagePct != null ? exitSlippagePct * 100 : null,
        totalSlippagePct: totalActualSlippagePct * 100,
        feeAmount: exitFeeAmount,
        feeCoin: exitFeeCoin,
        feeUSDT: exitFeeUSDT,
        totalFeeUSDT: actualFeeUSDT,
        qty: exitQty,
        sizeUSDT: exitValueUSDT,
        PnL: pnlAbsolute,
        PnL_pct: pnlFraction * 100,
        reason: exitEval.reason,
        exit_rsi: exitRsi,
        netPnlEstPct: netPnlPct,
        peakPnlPct,
        drawdownFromPeak: Number.isFinite(exitEval.drawdownFromPeak) ? exitEval.drawdownFromPeak * 100 : null
      });

      const tpMainPct = Number.isFinite(openPosition?.takeProfitPct) ? openPosition.takeProfitPct * 100 : null;
      const activationPct = Number.isFinite(openPosition?.profitActivationPct) ? openPosition.profitActivationPct * 100 : null;
      await report(reporting.buildSellReport(
        symbol,
        exitFillPrice,
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
          Number.isFinite(actualFeeUSDT)
            ? `Net actual after fee ${safeToFixed(netPnlPct, 2)}% | fee ${safeToFixed(actualFeeUSDT, 4)} USDT`
            : `Net after fallback fee ${safeToFixed(netPnlPct, 2)}%`,
          `Actual slippage entry ${safeToFixed((entrySlippagePct ?? 0) * 100, 2)}% | exit ${safeToFixed((exitSlippagePct ?? 0) * 100, 2)}%`,
          `TP ${tpMainPct == null ? "N/A" : `${safeToFixed(tpMainPct, 2)}%`} | DTP ${activationPct == null ? "N/A" : `${safeToFixed(activationPct, 2)}%`}`,
          `Trailing ${openPosition.trailingActive ? "active" : "inactive"} | Stop ${safeToFixed((openPosition.stopPct || 0) * 100, 2)}%`
        ],
        netPnlPct,
        openPosition?.takeProfitPct ?? null,
        openPosition?.profitActivationPct ?? null
      ));

      const remainingQty = getCoinBalance(symbol, freshPortfolio.balances);
      const isExitPartial = Number(orderResult.filledSize || 0) + 1e-12 < Number(coinBal || 0);
      state.tradesToday++;
      state.lastTradeTime = now + (config._effectiveCooldown ?? config.cooldownMs ?? 300000);
      state.lastTradePnl = pnlFraction;
      state.realizedPnlToday += pnlAbsolute;
      state.realizedNetPnlToday = Number(state.realizedNetPnlToday || 0) + netPnlAbsolute;
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
        idx--; // Adjust index after removal to maintain correct iteration
      }

      state.positions = positions;
      state.position = positions[0] || null;
      saveState(STATE_PATH, state);
      exitOccurred = true;
      // Continue to check remaining positions instead of returning early
      continue;
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

  // Send hold summary if due, if PnL changed significantly, or if an exit occurred (to show updated state)
  if (holdItems.length && (holdReportDue || shouldSendHoldSummary || exitOccurred)) {
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

  return { handledExit: exitOccurred, lastHoldReportTime };
}

module.exports = {
  handleExitFlow
};
