/**
 * patch_runbot.js
 * Replaces the runBot() function in core/index.js with a clean 11-step linear flow.
 * Run: node scripts/patch_runbot.js
 */
const fs = require("fs");
const path = require("path");

const TARGET = path.resolve(__dirname, "../core/index.js");
const src = fs.readFileSync(TARGET, "utf8");
const lines = src.split("\n");

// Find start: the "// ================= CORE LOOP =================" line (0-indexed)
const startIdx = lines.findIndex(l => l.trim() === "// ================= CORE LOOP =================");
if (startIdx === -1) throw new Error("Could not find CORE LOOP marker");

// Find end: closing brace of runBot() — search from line ~2370
let endIdx = -1;
for (let i = 2370; i < lines.length; i++) {
  if (
    lines[i].trim() === "}" &&
    lines[i - 1].trim() === "}" &&
    lines[i - 2].trim() === "}"
  ) {
    endIdx = i;
    break;
  }
}
if (endIdx === -1) throw new Error("Could not find end of runBot()");

console.log(`Replacing lines ${startIdx + 1}–${endIdx + 1} (0-indexed: ${startIdx}–${endIdx})`);

const before = lines.slice(0, startIdx).join("\n");
const after  = lines.slice(endIdx + 1).join("\n");

const newRunBot = `// ================= CORE LOOP =================
async function runBot() {

  // ===== STEP 1: LOOP GUARD =====
  if (shutdownRequested) return;
  if (executionKillSwitch) {
    await reportCritical("kill-switch", "🚨 EXECUTION KILL SWITCH ACTIVE\\nBot stopped opening new trades due to repeated execution failures.");
    return;
  }
  if (loopInProgress) {
    logEvent(LOG_FILE, "WARN", "Skipping loop: previous cycle still running");
    return;
  }
  loopInProgress = true;
  try {
    const loopStartedAt = Date.now();
    const now = Date.now();
    const today = jakartaDateKey(now);

    // ===== STEP 2: PORTFOLIO VALUATION =====
    let portfolio = await getPortfolioValue();
    let usdtFree = portfolio.usdtFree;
    let balances = portfolio.balances;
    let currentEquity = portfolio.totalEquity;
    let currentPositionPrice = 0;

    // ===== STEP 3: DAILY RESET =====
    if (state.date !== today) {
      state.date = today;
      state.tradesToday = 0;
      state.lossStreak = 0;
      state.haltedForDay = false;
      state.haltReason = null;
      state.startOfDayEquity = currentEquity;
      state.realizedPnlToday = 0;
      state.realizedNetPnlToday = 0;
      state.lastReportedPnl = null;
      state.lastReportedPnlBySymbol = {};
      saveState(STATE_PATH, state);
    } else if (!state.startOfDayEquity || state.startOfDayEquity <= 0) {
      state.startOfDayEquity = currentEquity;
      saveState(STATE_PATH, state);
    }
    const journalRoundsToday = countClosedRoundsForDate(today);
    if (state.tradesToday !== journalRoundsToday) {
      state.tradesToday = journalRoundsToday;
      saveState(STATE_PATH, state);
    }
    const realizedPnlPct = state.startOfDayEquity > 0 ? state.realizedPnlToday / state.startOfDayEquity : 0;
    if (realizedPnlPct >= config.dailyProfitTargetPct) {
      state.haltedForDay = true;
      state.haltReason = \`Daily profit target reached (+\${safeToFixed(realizedPnlPct * 100)}%)\`;
      saveState(STATE_PATH, state);
      logEvent(LOG_FILE, "INFO", "Halted: " + state.haltReason);
    }
    if (realizedPnlPct <= config.dailyLossLimitPct) {
      state.haltedForDay = true;
      state.haltReason = \`Daily loss limit hit (\${safeToFixed(realizedPnlPct * 100)}%)\`;
      saveState(STATE_PATH, state);
      logEvent(LOG_FILE, "INFO", "Halted: " + state.haltReason);
    }

    // ===== STEP 4: POSITION RECOVERY =====
    // Scan all non-USDT balances in portfolio:
    //   < $3 (dust threshold): unmanage if currently tracked, then skip silently
    //   >= $3 and not yet tracked: recover into state.positions
    const DUST_THRESHOLD_USDT = 3;
    const managedSymbolsSet = new Set(getOpenPositions(state).map(pos => pos.symbol));

    for (const [coin, qty] of Object.entries(balances)) {
      if (coin === "usdt") continue;
      if (!qty || qty <= 0) continue;

      const symbol = coin.toUpperCase() + "USDT";
      const price = cachedPrices?.[coin] || 0;
      if (!price || price <= 0) continue;

      const value = qty * price;

      if (value < DUST_THRESHOLD_USDT) {
        // Dust: unmanage if previously tracked, then skip
        if (managedSymbolsSet.has(symbol)) {
          logEvent(LOG_FILE, "INFO", \`Position \${symbol} dropped below dust threshold ($\${DUST_THRESHOLD_USDT}), unmanaging\`);
          state.positions = (state.positions || []).filter(p => p.symbol !== symbol);
          state.position = state.positions[0] || null;
          position = state.position;
          delete state.lastReportedPnlBySymbol[symbol];
          managedSymbolsSet.delete(symbol);
          saveState(STATE_PATH, state);
        }
        continue; // skip dust regardless
      }

      // value >= DUST_THRESHOLD_USDT and not yet managed: recover into state
      if (!managedSymbolsSet.has(symbol)) {
        logEvent(LOG_FILE, "INFO", \`Position recovered | \${symbol} est=\${safeToFixed(value)} USDT\`);
        const recoveredPosition = {
          symbol,
          entry: price,
          currentPrice: price,
          qty,
          sizeUSDT: value,
          peak: price,
          trailingActive: false,
          stopPct: -0.02,
          entryTime: Date.now(),
          entryReason: {
            score: null,
            marketMode: null,
            rsi: null,
            atrPct: null,
            notes: "Recovered from balance — entry price estimated"
          },
          source: "recovery"
        };

        if (!Array.isArray(state.positions)) state.positions = [];
        state.positions.push(recoveredPosition);
        state.position = state.positions[0] || null;
        position = state.position;
        managedSymbolsSet.add(symbol);
        saveState(STATE_PATH, state);

        logTrade({
          type: "entry",
          source: "recovery",
          botType: config.activeBotType || config.selectedBotType || "",
          mode: config.activeMode || config.selectedMode || "",
          marketProfile: config.selectedMarketProfile || "auto",
          marketProfileMode: config.marketProfileMode || "",
          pair: symbol,
          side: "buy",
          price,
          qty,
          sizeUSDT: value,
          reason: "balance detection"
        });

        const lastRecoveryTime = state.lastRecoveryTime || 0;
        const lastRecoverySymbol = state.lastRecoverySymbol;
        if (!lastRecoverySymbol || lastRecoverySymbol !== symbol || Date.now() - lastRecoveryTime > 5 * 60 * 1000) {
          await report(\`⚠️ POSITION RECOVERED\\nPair: \${symbol}\\nEstimated Entry: \${safeToFixed(price)}\\nValue: \${safeToFixed(value)} USDT\\n\\nBot detected an existing position from balance.\`);
          state.lastRecoveryTime = Date.now();
          state.lastRecoverySymbol = symbol;
          saveState(STATE_PATH, state);
        } else {
          logEvent(LOG_FILE, "DEBUG", \`Recovery message suppressed | last=\${lastRecoverySymbol}\`);
        }
      }
    }

    // ===== STEP 5: POSITION VALIDATION =====
    // Validate all currently tracked positions: update qty/price, drop vanished or dust positions
    const trackedPositions = getOpenPositions(state);
    if (trackedPositions.length) {
      const portfolioNow = await getPortfolioValue();
      const tickersForValidation = await getTickersCached();
      let positionsChanged = false;
      const nextPositions = [];

      for (const openPosition of trackedPositions) {
        const symbol = openPosition?.symbol;
        if (!symbol) continue;
        const coin = symbol.replace("USDT", "").toLowerCase();
        const coinBal = portfolioNow.balances[coin] || 0;

        if (coinBal <= 0) {
          logEvent(LOG_FILE, "INFO", \`Position vanished for \${symbol}, removing from managed positions\`);
          positionsChanged = true;
          delete state.lastReportedPnlBySymbol[symbol];
          continue;
        }

        let price = getPriceFromBreakdown(symbol, portfolioNow.balances, portfolioNow.breakdown);
        if (!price || price <= 0) {
          const ticker = (tickersForValidation || []).find(item => item.symbol === symbol);
          price = ticker?.last || 0;
        }
        if (!price || price <= 0) {
          logEvent(LOG_FILE, "WARN", \`No price for \${coin} (balance=\${coinBal}), fetching candles\`);
          const pCandles = await getCandles(symbol, config.signalTimeframe);
          if (pCandles?.length) price = extractLastClosedPrice(pCandles);
        }

        const value = coinBal * price;
        if (value < DUST_THRESHOLD_USDT) {
          logEvent(LOG_FILE, "INFO", \`Position \${symbol} value below dust threshold ($\${DUST_THRESHOLD_USDT}), removing from managed positions\`);
          positionsChanged = true;
          delete state.lastReportedPnlBySymbol[symbol];
          continue;
        }

        nextPositions.push({
          ...openPosition,
          qty: coinBal,
          sizeUSDT: value > 0 ? value : openPosition.sizeUSDT,
          currentPrice: price > 0 ? price : openPosition.currentPrice
        });
      }

      if (positionsChanged) {
        state.positions = nextPositions;
        state.position = nextPositions[0] || null;
        position = state.position;
        saveState(STATE_PATH, state);
      }

      // Update currentPositionPrice from validated state
      if (state.position) {
        currentPositionPrice = getPriceFromBreakdown(state.position.symbol, portfolioNow.balances, portfolioNow.breakdown);
        if (!currentPositionPrice || currentPositionPrice <= 0) {
          const pCandles = await getCandles(state.position.symbol, config.signalTimeframe);
          if (pCandles?.length) currentPositionPrice = extractLastClosedPrice(pCandles);
        }
      }
    } else if (state.position) {
      // No tracked positions but state.position still set — resolve price for exit/reports
      currentPositionPrice = getPriceFromBreakdown(state.position.symbol, balances, portfolio.breakdown);
      if (!currentPositionPrice || currentPositionPrice <= 0) {
        const pCandles = await getCandles(state.position.symbol, config.signalTimeframe);
        if (pCandles?.length) currentPositionPrice = extractLastClosedPrice(pCandles);
      }
    }

    // ===== STEP 6: ENTRY GATE CHECKS =====
    const openPositionsBeforeEntry = getOpenPositions(state);
    const maxOpenPositions = config.enableMultiTrade === true ? config.maxOpenPositions : 1;
    const currentExposureUsdt = getOpenExposureUsdt(state);
    const exposureCapUsdt = currentEquity * (config.exposureCapPct || 0.5);
    const lossStreakHaltThreshold = config.lossStreakHaltThreshold ?? 3;
    const entryBlockedByLossStreak =
      config.stopAfterThreeConsecutiveLosses &&
      state.lossStreak >= lossStreakHaltThreshold &&
      !openPositionsBeforeEntry.length;
    const entryBlockedByCooldown = now < state.lastTradeTime;
    const entryBlockedByDailyTradeLimit = state.tradesToday >= config.maxRoundsPerDay;
    const entryBlockedByPositionSlots = openPositionsBeforeEntry.length >= maxOpenPositions;
    const entryBlockedByExposureCap = (exposureCapUsdt - currentExposureUsdt) < config.minBuyUSDT;
    let entryGateStatus = "open";
    if (entryBlockedByLossStreak) {
      entryGateStatus = \`loss streak halt (\${state.lossStreak})\`;
    } else if (entryBlockedByDailyTradeLimit) {
      entryGateStatus = \`daily round limit reached (\${state.tradesToday}/\${config.maxRoundsPerDay})\`;
    } else if (entryBlockedByCooldown) {
      entryGateStatus = \`cooldown active (\${Math.max(1, Math.ceil((state.lastTradeTime - now) / 60000))}m left)\`;
    } else if (entryBlockedByPositionSlots) {
      entryGateStatus = \`position slots full (\${openPositionsBeforeEntry.length}/\${maxOpenPositions})\`;
    } else if (entryBlockedByExposureCap) {
      entryGateStatus = \`exposure cap reached (\${safeToFixed(currentExposureUsdt, 2)}/\${safeToFixed(exposureCapUsdt, 2)} USDT)\`;
    }

    // ===== STEP 7: MARKET SCANNING =====
    const baseScan = await scanMarket(config, getCandles, botLog);
    const marketProfileKey = resolveMarketProfileKey(baseScan.marketMode);
    const scanConfig = applyMarketProfile(config, marketProfileKey);
    const scanResult = marketProfileKey ? await scanMarket(scanConfig, getCandles, botLog) : baseScan;
    const { marketData, topScoring, watchlist, marketMode, volatilityState, entryCandidates } = scanResult;
    const heldSymbols = new Set(getOpenPositions(state).map(pos => pos.symbol));
    const bestEligible = scanConfig.marketEntriesEnabled === false
      ? null
      : (entryCandidates || [])
          .filter(candidate => candidate.eligible && !heldSymbols.has(candidate.symbol))
          .sort((a, b) => b.score - a.score)[0] || null;

    saveJsonFile(MARKET_SNAPSHOT_PATH, {
      generatedAt: new Date().toISOString(),
      botType: config.activeBotType || config.selectedBotType || "scalp_trend",
      botTypeLabel: config.activeBotTypeLabel || config.activeBotType || config.selectedBotType || "scalp_trend",
      mode: config.activeMode || config.selectedMode || "normal",
      modeLabel: config.activeModeLabel || config.activeMode || config.selectedMode || "normal",
      marketProfile: scanConfig.activeMarketProfile || config.selectedMarketProfile || "auto",
      marketProfileLabel: scanConfig.activeMarketProfileLabel || config.selectedMarketProfile || "auto",
      marketProfileMode: config.marketProfileMode || "auto",
      marketMode,
      volatilityState,
      topScoring,
      bestEligible: bestEligible
        ? {
            symbol: bestEligible.symbol,
            score: bestEligible.score,
            liveWeight: bestEligible.liveWeight,
            eligible: bestEligible.eligible
          }
        : null,
      autoPairRotation: { enabled: false },
      pairs: marketData.map(md => ({
        symbol: md.symbol,
        price: md.price,
        trendOk15: md.trendOk15,
        score: md.score,
        liveWeight: md.liveWeight,
        rsi: md.rsi,
        atrPct: md.atrPct,
        eligible: Boolean(md.entryCandidate?.eligible),
        failed: Array.isArray(md.entryCandidate?.failed) ? md.entryCandidate.failed : []
      }))
    });

    // ===== STEP 8: DATA FRESHNESS =====
    const latestSignalCandleTs = getLatestCandleTs(config.signalTimeframe);
    if (
      state.position ||
      !latestSignalCandleTs ||
      !isCandleTimestampFresh(latestSignalCandleTs, config.signalTimeframe, now)
    ) {
      await primeSignalCandlesForAllPairs(config.signalTimeframe, 2);
    }
    const last3mCandleTs = getLatestCandleTs(config.signalTimeframe);
    const last15mCandleTs = getLatestCandleTs(config.trendTimeframe);
    const dataFresh =
      isCandleTimestampFresh(last3mCandleTs, config.signalTimeframe, now) &&
      isCandleTimestampFresh(last15mCandleTs, config.trendTimeframe, now);
    health = saveHealth(HEALTH_PATH, health, {
      status: executionKillSwitch ? "kill_switch" : "running",
      lastLoopAt: new Date(now).toISOString(),
      lastLoopDurationMs: Date.now() - loopStartedAt,
      dataFresh,
      pairsScanned: Array.isArray(marketData) ? marketData.length : 0,
      eligibleCount: Array.isArray(entryCandidates) ? entryCandidates.filter(item => item.eligible).length : 0,
      marketMode,
      signalTimeframe: config.signalTimeframe || "3min",
      trendTimeframe: config.trendTimeframe || "15min",
      lastSignalCandle: last3mCandleTs || null,
      lastTrendCandle: last15mCandleTs || null,
      executionKillSwitch
    });
    if (!dataFresh) {
      const sigTs = last3mCandleTs
        ? new Date(last3mCandleTs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" })
        : "n/a";
      const trendTs = last15mCandleTs
        ? new Date(last15mCandleTs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" })
        : "n/a";
      await reportCritical(
        "stale-data",
        \`⚠️ DATA STALE\\nSignal \${config.signalTimeframe || "3min"}: \${sigTs}\\nTrend \${config.trendTimeframe || "15min"}: \${trendTs}\\nMarket mode: \${marketMode || "unknown"}\`,
        20 * 60 * 1000
      );
    }

    // ===== STEP 9: REPORTS =====
    ({
      health,
      lastHeartbeatTime,
      lastMarketReportTime,
      lastBalanceReportTime
    } = await runScheduledReports({
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
      safeToFixed
    }));

    // ===== STEP 10: EXIT FLOW =====
    if (state.position) {
      const exitFlowResult = await handleExitFlow({
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
      });
      lastHoldReportTime = exitFlowResult.lastHoldReportTime;
      position = state.position;
      if (exitFlowResult.handledExit) {
        return;
      }
    }

    // ===== STEP 11: ENTRY FLOW =====
    if (entryBlockedByLossStreak || entryBlockedByCooldown || entryBlockedByDailyTradeLimit || entryBlockedByPositionSlots || entryBlockedByExposureCap) {
      return;
    }

    const entryFlowResult = await handleEntryFlow({
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
      safeToFixed
    });
    if (Number.isFinite(entryFlowResult.currentPositionPrice)) {
      currentPositionPrice = entryFlowResult.currentPositionPrice;
    }
    position = state.position;

  } catch (err) {
    logEvent(LOG_FILE, "ERROR", "runBot: " + err.message);
    logEvent(LOG_FILE, "ERROR", err.message);
  } finally {
    loopInProgress = false;
    if (shutdownRequested) {
      await performSafeShutdown("queued-request");
    }
  }
}`;

const result = before + "\n" + newRunBot + "\n" + after;
fs.writeFileSync(TARGET, result, "utf8");
console.log("✅ Done. New total lines:", result.split("\n").length);
