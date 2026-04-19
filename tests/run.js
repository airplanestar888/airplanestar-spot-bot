const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { scanMarket, evaluateExit } = require("../core/strategy");
const { composeActiveConfig } = require("../core/configProfiles");
const { runScheduledReports } = require("../core/runtime/reports");
const { validateConfig } = require("../core/configValidation");

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

async function main() {
  const results = [];
  results.push(await run("config merge", testConfigMerge));
  results.push(await run("breakout toggle", testBreakoutToggle));
  results.push(await run("dynamic take profit exit", testDynamicTakeProfitExit));
  results.push(await run("dynamic take profit fallback exit", testDynamicTakeProfitFallbackExit));
  results.push(await run("trailing ignores pre-entry candle high", testTrailingIgnoresPreEntryCandleHigh));
  results.push(await run("report gating", testReportGating));
  results.push(await run("config validation", testConfigValidation));

  if (results.every(Boolean)) {
    console.log("ALL TESTS PASSED");
    process.exit(0);
  }

  console.error("TESTS FAILED");
  process.exit(1);
}

main();
