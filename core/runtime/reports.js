async function runScheduledReports({
  config,
  state,
  health,
  now,
  dataFresh,
  last3mCandleTs,
  last15mCandleTs,
  scanConfig,
  marketMode,
  volatilityState,
  topScoring,
  bestEligible,
  watchlist,
  marketData,
  currentPositionPrice,
  currentEquity,
  usdtFree,
  realizedPnlPct,
  lastHeartbeatTime,
  lastMarketReportTime,
  lastBalanceReportTime,
  cachedPrices,
  shouldReport,
  entryGateStatus,
  report,
  reporting,
  logEvent,
  LOG_FILE,
  saveHealth,
  HEALTH_PATH,
  getPortfolioValue,
  safeToFixed,
  runtimeJobs
}) {
  const openPositions = Array.isArray(state.positions)
    ? state.positions.filter(Boolean)
    : (state.position ? [state.position] : []);
  const activeBotTypeLabel = config.activeBotTypeLabel || config.activeBotType || config.selectedBotType || "scalp_trend";
  const activeModeLabel = config.activeModeLabel || config.activeMode || config.selectedMode || "normal";
  const marketProfileLabel = scanConfig.activeMarketProfileLabel || "Auto";

  const heartbeatDue = shouldReport(config.report.heartbeatIntervalMs, lastHeartbeatTime);
  logEvent(LOG_FILE, "DEBUG", `Heartbeat check | due=${heartbeatDue} dataFresh=${dataFresh}`);
  if (heartbeatDue) {
    logEvent(LOG_FILE, "DEBUG", "Heartbeat send | start");
    const timeStr = new Date().toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });
    const sent = await report(reporting.buildHeartbeatReport(
      usdtFree,
      openPositions,
      currentEquity,
      realizedPnlPct,
      state,
      timeStr,
      dataFresh,
      last3mCandleTs,
      last15mCandleTs,
      {
        activeBotTypeLabel,
        activeModeLabel,
        marketProfileLabel,
        marketProfileMode: config.marketProfileMode || "auto",
        activePairs: Array.isArray(config.pairs) ? config.pairs.length : 0,
        loopMinutes: Math.round((config.loopIntervalMs || 60000) / 60000),
        signalTimeframe: config.signalTimeframe || "3min",
        trendTimeframe: config.trendTimeframe || "15min",
        entryGateStatus,
        runtimeJobs,
        dryRun: config.dryRun === true
      }
    ));
    logEvent(LOG_FILE, "DEBUG", `Heartbeat send | sent=${sent}`);
    lastHeartbeatTime = now;
    health = saveHealth(HEALTH_PATH, health, {
      lastHeartbeat: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - new Date(health.startedAt).getTime()) / 1000)
    });
  }

  if (shouldReport(config.report.marketReportIntervalMs, lastMarketReportTime)) {
    await report(reporting.buildMarketReport({
      marketMode,
      volatilityState,
      topScoring,
      bestEligible,
      watchlist,
      marketData,
      position: openPositions.map((pos) => ({
        ...pos,
        currentPrice: pos.symbol === state.position?.symbol ? currentPositionPrice : pos.currentPrice
      })),
      now: new Date(),
      activeBotTypeLabel,
      activeModeLabel,
      marketProfileLabel,
      marketProfileMode: config.marketProfileMode || "auto",
      marketEntriesEnabled: scanConfig.marketEntriesEnabled !== false,
      entryGateStatus,
      dynamicTakeProfitEnabled: config.useDynamicTakeProfit === true,
      baseTakeProfitPct: config._effectiveTakeProfitPct ?? config.takeProfitPct ?? null
    }));
    lastMarketReportTime = now;
  }

  if (shouldReport(config.report.balanceReportIntervalMs, lastBalanceReportTime)) {
    const freshPortfolio = await getPortfolioValue();
    const freshUsdtFree = freshPortfolio.usdtFree;
    const freshEquity = freshPortfolio.totalEquity;

    let plannedSize = 0;
    if (freshUsdtFree >= config.minBuyUSDT) {
      plannedSize = freshUsdtFree * config.riskPercent;
      if (plannedSize < config.minBuyUSDT) {
        plannedSize = config.minBuyUSDT;
      } else {
        plannedSize = Math.min(plannedSize, config.maxBuyUSDT);
      }
      plannedSize = Math.min(plannedSize, freshUsdtFree);
    }

    let posValue = 0;
    for (const openPosition of openPositions) {
      const coin = openPosition.symbol.replace("USDT", "").toLowerCase();
      const qty = freshPortfolio.balances[coin] || 0;
      const price = cachedPrices?.[coin] || 0;
      if (qty > 0 && price > 0) {
        posValue += qty * price;
      } else if (qty > 0) {
        logEvent(LOG_FILE, "ERROR", `Value zero anomaly | ${coin} qty=${qty} price=${price}`);
      }
    }

    const otherAssets = freshEquity - freshUsdtFree - posValue;
    const realizedNetToday = Number(state.realizedNetPnlToday ?? state.realizedPnlToday ?? 0);
    const freshRealizedPnlPct = state.startOfDayEquity > 0 ? realizedNetToday / state.startOfDayEquity : 0;
    logEvent(
      LOG_FILE,
      "DEBUG",
      `Balance snapshot | usdt=${safeToFixed(freshUsdtFree, 2)} posValue=${safeToFixed(posValue, 2)} otherAssets=${safeToFixed(otherAssets, 2)}`
    );

    await report(reporting.buildBalanceReport(
      freshUsdtFree,
      freshEquity,
      posValue,
      plannedSize,
      state,
      freshRealizedPnlPct,
      otherAssets,
      openPositions.reduce((sum, pos) => sum + (Number(pos?.sizeUSDT || 0) || 0), 0) || null,
      state.startOfDayEquity,
      {
        activeBotTypeLabel,
        activeModeLabel,
        reserveUSDT: config.reserveUSDT,
        roundTripFeePct: config._effectiveRoundTripFeePct ?? config.roundTripFeePct ?? 0.004
      }
    ));
    lastBalanceReportTime = now;
  }

  return {
    health,
    lastHeartbeatTime,
    lastMarketReportTime,
    lastBalanceReportTime
  };
}

module.exports = {
  runScheduledReports
};
