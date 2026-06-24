const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { scanMarket, evaluateExit } = require("../core/strategy");
const { composeActiveConfig } = require("../core/configProfiles");
const { runScheduledReports } = require("../core/runtime/reports");
const { validateConfig } = require("../core/configValidation");
const { validateDecision, applyDecision } = require("../core/aiAgent");

function loadConfig() {
  const configPath = path.resolve(__dirname, "..", "config.json");
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function makeCandlesFromCloses(closes, { volume = 100, drift = 0.12 } = {}) {
  const start = Date.now() - closes.length * 60_000;
  const rows = closes.map((close, index) => {
    const prev = index === 0 ? close - drift : closes[index - 1];
    const open = prev;
    const high = Math.max(open, close) + 0.08;
    const low = Math.min(open, close) - 0.08;
    const vol = Array.isArray(volume) ? volume[index] : volume;
    return [start + index * 60_000, open, high, low, close, vol];
  });
  return rows.reverse();
}

function makeChronologicalCandles(closes, opts = {}) {
  return makeCandlesFromCloses(closes, opts).reverse();
}

async function run(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    return true;
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message || error);
    return false;
  }
}

async function testConfigMerge() {
  const baseConfig = loadConfig();
  baseConfig.marketProfileMode = "auto";
  const config = composeActiveConfig(baseConfig, {
    botTypeKey: "custom",
    modeKey: "aggressive",
    marketMode: "Bearish"
  });

  assert.equal(config.activeBotType, "custom");
  assert.equal(config.activeMode, "aggressive");
  assert.equal(config.requireFastTrend, baseConfig.botTypeProfiles.custom.overrides.requireFastTrend);
  assert.equal(config.requireBreakout, baseConfig.marketProfiles.bearish.entryOverrides.requireBreakout);
  assert.equal(config.enableVolumeFilter, true);
  assert.equal(config.riskPercent, baseConfig.modeProfiles.aggressive.overrides.riskPercent);
  assert.equal(config.takeProfitPct, baseConfig.modeProfiles.aggressive.overrides.takeProfitPct);
  assert.equal(config.marketEntriesEnabled, false);
}

async function testBreakoutToggle() {
  const bullish15 = makeCandlesFromCloses(
    Array.from({ length: 50 }, (_, i) => 100 + i * 0.25),
    { volume: 140 }
  );

  const closes3 = [
    ...Array.from({ length: 44 }, (_, i) => 108 + i * 0.03),
    109.2, 109.35, 109.48, 109.55, 109.6, 109.62
  ];
  const signal3 = makeCandlesFromCloses(closes3, {
    volume: [...Array(49).fill(130), 150]
  });

  const getCandles = async (_symbol, timeframe) => timeframe === "15min" ? bullish15 : signal3;

  const baseConfig = {
    pairs: ["TESTUSDT"],
    activeBotType: "scalp_trend",
    selectedBotType: "scalp_trend",
    trendTimeframe: "15min",
    signalTimeframe: "3min",
    minTrendRsi: 42,
    minVolumeRatio: 1.05,
    maxEmaGapPct: 0.03,
    minAtrPct: 0.001,
    maxAtrPct: 0.03,
    roundTripFeePct: 0.004,
    slippageBufferPct: 0.001,
    minExpectedNetPct: 0.001,
    minScalpTargetPct: 0.004,
    maxScalpTargetPct: 0.02,
    dynamicTakeProfitAtrMultiplier: 1.35,
    rsiBandLower: 35,
    rsiBandUpper: 80,
    minCandleStrength: 0.1,
    minConfirmation: 1,
    breakoutPct: 1.002,
    optimalRsiLow: 40,
    optimalRsiHigh: 75,
    optimalAtrLow: 0.001,
    optimalAtrHigh: 0.02,
    minEmaGapNeg: 0.01,
    requireEma21Rising: true,
    requireFastTrend: false,
    requirePriceAboveEma9: true,
    requireEdge: false,
    requireRsiMomentum: false,
    enableRsiBandFilter: false,
    enableAtrFilter: false,
    enableVolumeFilter: true,
    enableCandleStrengthFilter: true,
    enablePriceExtensionFilter: false,
    enableRangeRecoveryFilter: false
  };

  const withBreakout = await scanMarket({ ...baseConfig, requireBreakout: true }, getCandles, () => {});
  const withoutBreakout = await scanMarket({ ...baseConfig, requireBreakout: false }, getCandles, () => {});

  assert.match(withBreakout.entryCandidates[0].failed.join(", "), /micro breakout/);
  assert.doesNotMatch(withoutBreakout.entryCandidates[0].failed.join(", "), /micro breakout/);
}

async function testDynamicTakeProfitExit() {
  const candles = makeChronologicalCandles(
    Array.from({ length: 49 }, (_, i) => 100 + i * 0.02).concat([101.35]),
    { volume: 120 }
  );
  const getCandles = async () => candles;

  const result = await evaluateExit(
    {
      symbol: "BTCUSDT",
      entry: 100,
      peak: 100,
      trailingActive: false,
      stopPct: -0.006,
      entryTime: Date.now() - 12 * 60_000,
      takeProfitPct: 0.008,
      profitActivationPct: 0.013,
      profitActivationFloorPct: 0.0045,
      useDynamicTakeProfit: true
    },
    { btc: 1 },
    {
      signalTimeframe: "3min",
      roundTripFeePct: 0.004,
      slippageBufferPct: 0.001,
      emergencyStopLossPct: -0.02,
      breakEvenArmedPct: 0.008,
      breakEvenFloorPct: 0.0015,
      timeStopMinutes: 18,
      maxHoldMinutes: 45,
      minHoldPnlPct: 0.0035,
      enableTimeStop: false,
      enableStaleTrade: true,
      minMomentumExitPct: 0.004,
      exitRSIThreshold: 70,
      trailingActivationPct: 0.008,
      trailingDrawdownPct: 0.004,
      trailingProtectionPct: 0.0025,
      useDynamicTakeProfit: true,
      enableCostGuard: true,
      costGuardArmPct: 0.0055,
      costGuardFloorPct: 0.003,
      selectedBotType: "custom",
      activeBotType: "custom"
    },
    getCandles
  );

  assert.equal(result.exit, true);
  assert.equal(result.reason, "Take Profit");
}

async function testDynamicTakeProfitFallbackExit() {
  const closes = Array.from({ length: 46 }, (_, i) => 100 + i * 0.01).concat([100.95, 100.87, 100.79, 100.78]);
  const candles = makeChronologicalCandles(closes, { volume: 120 });
  const getCandles = async () => candles;

  const result = await evaluateExit(
    {
      symbol: "BTCUSDT",
      entry: 100,
      peak: 100.95,
      trailingActive: false,
      stopPct: -0.006,
      entryTime: Date.now() - 12 * 60_000,
      takeProfitPct: 0.013,
      profitActivationPct: 0.008,
      profitActivationFloorPct: 0.0045,
      useDynamicTakeProfit: true
    },
    { btc: 1 },
    {
      signalTimeframe: "3min",
      roundTripFeePct: 0.004,
      slippageBufferPct: 0.001,
      emergencyStopLossPct: -0.02,
      breakEvenArmedPct: 0.008,
      breakEvenFloorPct: 0.0015,
      timeStopMinutes: 18,
      maxHoldMinutes: 45,
      minHoldPnlPct: 0.0035,
      enableTimeStop: false,
      enableStaleTrade: true,
      minMomentumExitPct: 0.004,
      exitRSIThreshold: 70,
      trailingActivationPct: 0.02,
      trailingDrawdownPct: 0.004,
      trailingProtectionPct: 0.0025,
      useDynamicTakeProfit: true,
      enableCostGuard: false,
      selectedBotType: "custom",
      activeBotType: "custom"
    },
    getCandles
  );

  assert.equal(result.exit, true);
  assert.equal(result.reason, "DTP Fallback");
}

async function testTrailingIgnoresPreEntryCandleHigh() {
  const now = Date.now();
  const entryTime = now - 15_000;
  const lastCloseTime = now - 30_000;
  const start = lastCloseTime - 50 * 60_000;
  const closes = Array.from({ length: 49 }, (_, i) => 100 + i * 0.01).concat([101.4]);
  const candles = closes.map((close, index) => {
    const open = index === 0 ? close : closes[index - 1];
    const high = index === closes.length - 1 ? 103 : Math.max(open, close) + 0.05;
    const low = Math.min(open, close) - 0.05;
    return [start + index * 60_000, open, high, low, close, 120];
  });
  const getCandles = async () => candles;

  const result = await evaluateExit(
    {
      symbol: "BTCUSDT",
      entry: 100,
      peak: 100,
      trailingActive: false,
      stopPct: -0.006,
      entryTime
    },
    { btc: 1 },
    {
      exitTimeframe: "1min",
      roundTripFeePct: 0,
      slippageBufferPct: 0,
      emergencyStopLossPct: -0.02,
      takeProfitPct: 0.02,
      trailingActivationPct: 0.008,
      trailingDrawdownPct: 0.004,
      trailingProtectionPct: 0.0025,
      minTrailingAgeMs: 60000,
      useDynamicTakeProfit: false,
      enableCostGuard: false,
      enableTimeStop: false,
      enableStaleTrade: false,
      minMomentumExitPct: 0.02,
      exitRSIThreshold: 99,
      selectedBotType: "custom",
      activeBotType: "custom"
    },
    getCandles
  );

  assert.equal(result.exit, false);
  assert.equal(result.diagnostics.trailingAgeReady, false);
  assert.equal(result.diagnostics.candleClosedAfterEntry, false);
  assert.equal(result.diagnostics.trailingExit, false);
}

async function testReportGating() {
  const sent = [];
  const report = async (msg) => {
    sent.push(msg);
    return true;
  };

  const reporting = {
    buildHeartbeatReport: () => "HB",
    buildMarketReport: () => "MR",
    buildBalanceReport: () => "BR"
  };

  const commonArgs = {
    config: {
      report: {
        heartbeatIntervalMs: 300000,
        marketReportIntervalMs: 3600000,
        balanceReportIntervalMs: 1800000
      },
      pairs: ["BTCUSDT"],
      loopIntervalMs: 60000,
      signalTimeframe: "3min",
      trendTimeframe: "15min",
      reserveUSDT: 2
    },
    state: {
      position: null,
      startOfDayEquity: 100,
      realizedPnlToday: 0
    },
    health: { startedAt: new Date(Date.now() - 60_000).toISOString() },
    now: Date.now(),
    dataFresh: true,
    last3mCandleTs: Date.now(),
    last15mCandleTs: Date.now(),
    scanConfig: { activeMarketProfileLabel: "Neutral", marketEntriesEnabled: true },
    marketMode: "Neutral",
    volatilityState: "Moderate",
    topScoring: null,
    bestEligible: null,
    watchlist: [],
    marketData: [],
    currentPositionPrice: 0,
    currentEquity: 100,
    usdtFree: 100,
    realizedPnlPct: 0,
    cachedPrices: {},
    shouldReport: (intervalMs, lastTime) => Date.now() - lastTime >= intervalMs,
    report,
    reporting,
    logEvent: () => {},
    LOG_FILE: "logs/bot.log",
    saveHealth: (_p, health, patch) => ({ ...health, ...patch }),
    HEALTH_PATH: "data/health.json",
    getPortfolioValue: async () => ({ usdtFree: 100, totalEquity: 100, balances: {} }),
    safeToFixed: (n, d = 2) => Number(n).toFixed(d)
  };

  await runScheduledReports({
    ...commonArgs,
    lastHeartbeatTime: Date.now(),
    lastMarketReportTime: Date.now(),
    lastBalanceReportTime: Date.now()
  });
  assert.equal(sent.length, 0);

  await runScheduledReports({
    ...commonArgs,
    lastHeartbeatTime: 0,
    lastMarketReportTime: Date.now(),
    lastBalanceReportTime: Date.now()
  });
  assert.deepEqual(sent, ["HB"]);
}

async function testConfigValidation() {
  const config = loadConfig();
  const valid = validateConfig(config, {
    botTypeKey: config.selectedBotType,
    modeKey: config.selectedMode,
    marketProfileKey: config.selectedMarketProfile
  });
  assert.equal(valid.ok, true);

  const invalid = validateConfig(
    {
      ...config,
      minScalpTargetPct: 0.02,
      maxScalpTargetPct: 0.01,
      report: {
        ...config.report,
        heartbeatIntervalMs: 0
      }
    },
    {
      botTypeKey: "missing-type",
      modeKey: config.selectedMode,
      marketProfileKey: config.selectedMarketProfile
    }
  );

  assert.equal(invalid.ok, false);
  assert.match(invalid.issues.join(" | "), /selectedBotType|minScalpTargetPct|heartbeatIntervalMs/);
}

async function testAiAgentFullMarketProfileFields() {
  const rawDecision = {
    marketProfile: "neutral",
    allowEntries: true,
    entryOverrides: {
      minExpectedNetPct: 0.0027,
      minVolumeRatio: 1.11,
      minTrendRsi: 41,
      minAtrPct: 0.003,
      maxAtrPct: 0.021,
      maxEmaGapPct: 0.017,
      rsiBandLower: 44,
      rsiBandUpper: 67,
      minCandleStrength: 0.37,
      minEmaGapNeg: 0.0017,
      optimalRsiLow: 48,
      optimalRsiHigh: 59,
      optimalAtrLow: 0.0048,
      optimalAtrHigh: 0.013,
      requireRsiMomentum: true,
      requireBreakout: false,
      enableRsiBandFilter: true,
      enableAtrFilter: true,
      enableVolumeFilter: true,
      enableCandleStrengthFilter: true,
      enablePriceExtensionFilter: false,
      enableRangeRecoveryFilter: true
    },
    reason: "full market profile test"
  };
  const settings = {
    allowMarketProfile: true,
    allowEntriesToggle: true,
    allowMarketFilters: true,
    allowQualityFilters: true
  };

  const decision = validateDecision(rawDecision, settings);
  assert.deepEqual(Object.keys(decision.entryOverrides).sort(), Object.keys(rawDecision.entryOverrides).sort());

  const config = loadConfig();
  applyDecision(config, decision, Date.UTC(2026, 3, 19));

  assert.equal(config.selectedMarketProfile, "ai_agent");
  assert.equal(config.marketProfiles.ai_agent.allowEntries, true);
  for (const [key, value] of Object.entries(rawDecision.entryOverrides)) {
    assert.equal(config.marketProfiles.ai_agent.entryOverrides[key], value);
  }
}

async function testFuturesConfigClamps() {
  const futures = require("../core/futures");
  // High values clamp down to MAX
  const high = futures.getFuturesConfig({ futures: { leverage: 999, maxLeverage: 999 } });
  assert.equal(high.leverage, futures.MAX_FUTURES_LEVERAGE);
  assert.equal(high.maxLeverage, futures.MAX_FUTURES_LEVERAGE);
  assert.equal(futures.MAX_FUTURES_LEVERAGE, 20);
  assert.equal(futures.MIN_FUTURES_LEVERAGE, 1);
  // Negative values clamp up to MIN (note: 0 falls through to default due to `|| 10`)
  const low = futures.getFuturesConfig({ futures: { leverage: -5, maxLeverage: -5 } });
  assert.equal(low.leverage, futures.MIN_FUTURES_LEVERAGE);
  assert.equal(low.maxLeverage, futures.MIN_FUTURES_LEVERAGE);
  // Effective leverage must not exceed maxLeverage
  const capped = futures.getFuturesConfig({ futures: { leverage: 20, maxLeverage: 10 } });
  assert.equal(capped.leverage, 10);
  assert.equal(capped.maxLeverage, 10);
  // Zero falls through to default (10 / 20)
  const zero = futures.getFuturesConfig({ futures: { leverage: 0, maxLeverage: 0 } });
  assert.equal(zero.leverage, 10);
  assert.equal(zero.maxLeverage, 20);
  // Missing values use defaults (10 / 20)
  const def = futures.getFuturesConfig({});
  assert.equal(def.leverage, 10);
  assert.equal(def.maxLeverage, 20);
  assert.equal(def.marginMode, "crossed");
  assert.equal(def.fundingRateThreshold, 0.001);
}

async function testEnsureFuturesSetupDryRun() {
  const futures = require("../core/futures");
  let called = 0;
  const mockRequest = async () => {
    called += 1;
    throw new Error("request must not be called in dry-run");
  };
  const cfg = { futures: { leverage: 10, marginMode: "crossed" }, dryRun: true };
  const events = [];
  const logEvent = (_file, level, msg) => events.push({ level, msg });
  await futures.ensureFuturesSetup(mockRequest, cfg, "BTCUSDT", logEvent, "fake.log");
  assert.equal(called, 0, "no API call expected in dry-run mode");
  const dryEvent = events.find(e => e.level === "DEBUG" && e.msg.includes("dry-run"));
  assert.ok(dryEvent, "expected DEBUG log mentioning dry-run");
}

async function testEnsureFuturesSetupLiveCallsApi() {
  const futures = require("../core/futures");
  let calls = [];
  const mockRequest = async (_url, _k, _s, _p, method, path) => {
    calls.push({ method, path });
    return { ok: true };
  };
  const cfg = { futures: { leverage: 7, marginMode: "isolated" }, dryRun: false };
  const events = [];
  const logEvent = (_file, level, msg) => events.push({ level, msg });
  await futures.ensureFuturesSetup(mockRequest, cfg, "ETHUSDT", logEvent, "fake.log");
  // Should call set-margin-mode then set-leverage (order may vary by try blocks)
  assert.ok(calls.some(c => c.path.includes("set-margin-mode")), "expected set-margin-mode call");
  assert.ok(calls.some(c => c.path.includes("set-leverage")), "expected set-leverage call");
  // Second call should be a no-op (cached)
  calls = [];
  await futures.ensureFuturesSetup(mockRequest, cfg, "ETHUSDT", logEvent, "fake.log");
  assert.equal(calls.length, 0, "second call should hit cache");
}

async function testEnsureFuturesSetupBlocksOnLeverageFailure() {
  const futures = require("../core/futures");
  let calls = [];
  const mockRequest = async (_url, _k, _s, _p, method, path) => {
    calls.push({ method, path });
    if (path.includes("set-leverage")) throw new Error("leverage rejected");
    return { ok: true };
  };
  const cfg = { futures: { leverage: 7, marginMode: "crossed" }, dryRun: false };
  const events = [];
  const logEvent = (_file, level, msg) => events.push({ level, msg });

  await assert.rejects(
    () => futures.ensureFuturesSetup(mockRequest, cfg, "XRPUSDT", logEvent, "fake.log"),
    /leverage rejected/
  );
  assert.ok(events.some(e => e.level === "WARN" && e.msg.includes("Failed to set leverage")), "expected leverage failure warning");

  calls = [];
  await assert.rejects(
    () => futures.ensureFuturesSetup(mockRequest, cfg, "XRPUSDT", logEvent, "fake.log"),
    /leverage rejected/
  );
  assert.ok(calls.some(c => c.path.includes("set-leverage")), "failed setup must not be cached");
}

async function testGetLiveFundingRateCacheAndParse() {
  const futures = require("../core/futures");
  let calls = 0;
  const mockRequest = async (_url, _k, _s, _p, _method, path) => {
    calls += 1;
    // Return Bitget v2 wrapped format
    return { data: [{ symbol: "BTCUSDT", fundingRate: "0.00012" }] };
  };
  const cfg = { futures: {}, baseUrl: "x", apiKey: "a", secretKey: "b", passphrase: "c" };
  const r1 = await futures.getLiveFundingRate(mockRequest, cfg, "BTCUSDT");
  assert.equal(r1, 0.00012);
  assert.equal(calls, 1);
  // Second call within TTL is cached
  const r2 = await futures.getLiveFundingRate(mockRequest, cfg, "BTCUSDT");
  assert.equal(r2, 0.00012);
  assert.equal(calls, 1, "second call should be served from cache");
  // API error → returns null
  const failing = async () => { throw new Error("rate limit"); };
  assert.equal(await futures.getLiveFundingRate(failing, cfg, "XRPUSDT"), null);
}

async function testGetFuturesPositionsLeverageValidation() {
  const futures = require("../core/futures");
  const mockRequest = async () => [
    { symbol: "BTCUSDT", holdSide: "long", total: "0.1", leverage: "5",  markPrice: "30000", margin: "600" },
    { symbol: "ETHUSDT", holdSide: "short", total: "1",   leverage: "10", markPrice: "2000",  margin: "200" }
  ];
  const cfg = { futures: { leverage: 10, marginMode: "crossed" }, baseUrl: "x", apiKey: "a", secretKey: "b", passphrase: "c" };
  const events = [];
  const logEvent = (_file, level, msg) => events.push({ level, msg });
  const positions = await futures.getFuturesPositions(mockRequest, cfg, logEvent, "fake.log");
  assert.equal(positions.length, 2);
  // BTC has 5x, config is 10x → should WARN
  const mismatchWarn = events.find(e => e.level === "WARN" && e.msg.includes("BTCUSDT") && e.msg.includes("5x"));
  assert.ok(mismatchWarn, "expected WARN for BTCUSDT leverage drift");
  // ETH matches config 10x → no warn for ETH
  const ethWarn = events.find(e => e.level === "WARN" && e.msg.includes("ETHUSDT"));
  assert.equal(ethWarn, undefined, "no warn expected for matching leverage");
}

async function testExpectedNetEdgeGate() {
  // Build a clean uptrend that would normally be eligible.
  const bullish15 = makeCandlesFromCloses(
    Array.from({ length: 50 }, (_, i) => 100 + i * 0.25),
    { volume: 140 }
  );
  const closes3 = [
    ...Array.from({ length: 44 }, (_, i) => 108 + i * 0.03),
    109.2, 109.35, 109.48, 109.55, 109.6, 109.62
  ];
  const signal3 = makeCandlesFromCloses(closes3, {
    volume: [...Array(49).fill(130), 150]
  });
  const getCandles = async (_symbol, timeframe) => timeframe === "15min" ? bullish15 : signal3;

  const baseConfig = {
    pairs: ["TESTUSDT"],
    activeBotType: "scalp_trend",
    selectedBotType: "scalp_trend",
    trendTimeframe: "15min",
    signalTimeframe: "3min",
    minTrendRsi: 42,
    minVolumeRatio: 1.05,
    maxEmaGapPct: 0.03,
    minAtrPct: 0.001,
    maxAtrPct: 0.03,
    roundTripFeePct: 0.004,
    slippageBufferPct: 0.001,
    minScalpTargetPct: 0.004,
    maxScalpTargetPct: 0.02,
    dynamicTakeProfitAtrMultiplier: 1.35,
    rsiBandLower: 35,
    rsiBandUpper: 80,
    minCandleStrength: 0.1,
    minConfirmation: 1,
    breakoutPct: 1.002,
    optimalRsiLow: 40,
    optimalRsiHigh: 75,
    optimalAtrLow: 0.001,
    optimalAtrHigh: 0.02,
    minEmaGapNeg: 0.01,
    requireEma21Rising: true,
    requireFastTrend: false,
    requirePriceAboveEma9: true,
    requireRsiMomentum: false,
    enableRsiBandFilter: false,
    enableAtrFilter: false,
    enableVolumeFilter: true,
    enableCandleStrengthFilter: true,
    enablePriceExtensionFilter: false,
    enableRangeRecoveryFilter: false,
    requireBreakout: false
  };

  // 1. With gate disabled (minExpectedNetPct <= 0), candidate should be eligible.
  const disabled = await scanMarket({ ...baseConfig, minExpectedNetPct: 0 }, getCandles, () => {});
  const candDisabled = disabled.entryCandidates[0];
  assert.equal(candDisabled.edgeOk, true, "edgeOk should be true when gate disabled");
  assert.doesNotMatch(candDisabled.failed.join(", "), /expected net/);

  // 2. With an impossibly high threshold, candidate should be rejected on edge.
  const tooHigh = await scanMarket({ ...baseConfig, minExpectedNetPct: 0.5 }, getCandles, () => {});
  const candTooHigh = tooHigh.entryCandidates[0];
  assert.equal(candTooHigh.edgeOk, false, "edgeOk should be false when threshold > expectedNet");
  assert.match(candTooHigh.failed.join(", "), /expected net too thin/);
  assert.equal(candTooHigh.eligible, false, "candidate with thin edge should not be eligible");
}

async function main() {
  const results = [];
  results.push(await run("config merge", testConfigMerge));
  results.push(await run("breakout toggle", testBreakoutToggle));
  results.push(await run("dynamic take profit exit", testDynamicTakeProfitExit));
  results.push(await run("dynamic take profit fallback exit", testDynamicTakeProfitFallbackExit));
  results.push(await run("trailing ignores pre-entry candle high", testTrailingIgnoresPreEntryCandleHigh));
  results.push(await run("report gating", testReportGating));
  results.push(await run("config validation", testConfigValidation));
  results.push(await run("AI agent full market profile fields", testAiAgentFullMarketProfileFields));
  results.push(await run("futures config clamps", testFuturesConfigClamps));
  results.push(await run("ensureFuturesSetup dry-run skips API", testEnsureFuturesSetupDryRun));
  results.push(await run("ensureFuturesSetup live calls API + cache", testEnsureFuturesSetupLiveCallsApi));
  results.push(await run("ensureFuturesSetup blocks on leverage failure", testEnsureFuturesSetupBlocksOnLeverageFailure));
  results.push(await run("getLiveFundingRate cache + parse", testGetLiveFundingRateCacheAndParse));
  results.push(await run("getFuturesPositions leverage validation", testGetFuturesPositionsLeverageValidation));
  results.push(await run("expected net edge gate", testExpectedNetEdgeGate));

  if (results.every(Boolean)) {
    console.log("ALL TESTS PASSED");
    process.exit(0);
  }

  console.error("TESTS FAILED");
  process.exit(1);
}

main();
