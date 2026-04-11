const { request } = require("./exchange");
const { EMA } = require("./indicators");
const { buildEntryPlan, buildPositionMeta } = require("./execution");
const {
  computeEquity,
  detectOpenPositionFromBalance,
  getCoinBalance,
  getPriceFromBreakdown
} = require("./portfolio");

// Cache untuk size scale per symbol (dari /api/v2/spot/market/symbols)
const symbolScales = {};
const { scanMarket, pickStopPct, evaluateExit } = require("./strategy");
const { logEvent } = require("./logger");
const { loadState, saveState, loadHealth, saveHealth, saveJsonFile } = require("./state");
const { logTrade, JOURNAL_PATH } = require("./tradeLogger");
const reporting = require("./reporting");
const { runScheduledReports } = require("./runtime/reports");
const { handleExitFlow } = require("./runtime/exitFlow");
const { handleEntryFlow } = require("./runtime/entryFlow");
const { validateConfig, validateEngineFiles } = require("./configValidation");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");
const readline = require("readline");

// Safe toFixed helper â€“ prevents crashes on undefined/null
function safeToFixed(value, decimals = 2) {
  if (typeof value === 'number' && isFinite(value)) {
    return value.toFixed(decimals);
  }
  return 'N/A';
}

const ROOT_ENV_PATH = path.resolve(__dirname, "..", ".env");
const EXTERNAL_ENV_PATH = path.resolve(__dirname, "..", "..", ".env");
dotenv.config({ path: fs.existsSync(ROOT_ENV_PATH) ? ROOT_ENV_PATH : EXTERNAL_ENV_PATH });

const CONFIG_PATH = "config.json";
const DATA_DIR = "data";
const STATE_PATH = path.join(DATA_DIR, "state.json");
const HEALTH_PATH = path.join(DATA_DIR, "health.json");
const MARKET_SNAPSHOT_PATH = path.join(DATA_DIR, "market_snapshot.json");
const LOG_FILE = path.join("logs", "bot.log");

// Track last candle timestamps per symbol (for heartbeat data freshness)
let lastCandleData = {}; // { symbol: { closeTime, close } }

// Simple semaphore to limit concurrent API requests (max 2 at a time)
const MAX_CONCURRENT_REQUESTS = 2;
let activeRequests = 0;
const requestQueue = [];

function waitForSlot() {
  return new Promise(resolve => {
    const check = () => {
      if (activeRequests < MAX_CONCURRENT_REQUESTS) {
        activeRequests++;
        resolve();
      } else {
        requestQueue.push(check);
      }
    };
    check();
  });
}

function releaseSlot() {
  activeRequests = Math.max(0, activeRequests - 1);
  if (requestQueue.length > 0) {
    const next = requestQueue.shift();
    next();
  }
}

// Wrapper logger for internal modules
function botLog(level, message, meta = {}) {
  logEvent(LOG_FILE, level, message, meta);
}

// Wrapper logging
function log(level, message, meta = {}) {
  logEvent(LOG_FILE, level, message, meta);
}

function cliOnly(level, message, meta = {}) {
  logEvent(null, level, message, meta);
}

// Get latest candle timestamp among all pairs for a given timeframe
function getLatestCandleTs(timeframe) {
  let maxTs = 0;
  for (const sym of config.pairs) {
    const key = `${sym}:${timeframe}`;
    const rec = lastCandleData[key];
    if (rec && rec.closeTime > maxTs) maxTs = rec.closeTime;
  }
  return maxTs;
}

function isCandleTimestampFresh(closeTime, timeframe, now = Date.now()) {
  if (!Number.isFinite(closeTime) || closeTime <= 0) return false;
  const timeframeMs = timeframeToMs(timeframe);
  if (!timeframeMs) return false;
  const maxAgeMs = Math.max(timeframeMs * 3, 2 * 60 * 1000);
  return (now - closeTime) <= maxAgeMs;
}

async function primeSignalCandlesForAllPairs(timeframe, limit = 2) {
  const pairs = Array.isArray(config.pairs) ? config.pairs : [];
  for (const symbol of pairs) {
    try {
      await getCandles(symbol, timeframe, limit);
    } catch (err) {
      logEvent(LOG_FILE, "DEBUG", `Signal freshness skipped for ${symbol} (${timeframe}): ${err.message}`);
    }
  }
}

let config = normalizePairConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
config.apiKey = process.env.BITGET_API_KEY;
config.secretKey = process.env.BITGET_SECRET_KEY;
config.passphrase = process.env.BITGET_PASSPHRASE;
if (config.telegram) {
  config.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
  config.telegram.chatId = process.env.TELEGRAM_CHAT_ID;
}
if (!config.apiKey || !config.secretKey || !config.passphrase) {
  console.error("Missing Bitget API credentials");
  process.exit(1);
}
if (config.telegram?.enabled && (!config.telegram.botToken || !config.telegram.chatId)) {
  console.error("Missing Telegram credentials");
  process.exit(1);
}

// ================= EXECUTION SAFETY LOCKS =================
let executing = false;
let globalExecutionFailures = 0;
const MAX_EXECUTION_FAILURES = 3;
let executionKillSwitch = false;
const inFlightClientOrders = new Set();

function normalizeOrderStatus(status) {
  const raw = String(status || "").toUpperCase();
  if (!raw) return "UNKNOWN";
  if (["FILLED", "FULLY_FILLED", "SUCCESS"].includes(raw)) return "FILLED";
  if (["PARTIAL", "PARTIALLY_FILLED", "PARTIAL_FILL"].includes(raw)) return "PARTIAL";
  if (["CANCELED", "CANCELLED", "CANCELING"].includes(raw)) return "CANCELED";
  if (["REJECTED", "FAILED", "FAIL"].includes(raw)) return "REJECTED";
  if (["NEW", "INIT", "LIVE", "OPEN"].includes(raw)) return "OPEN";
  return raw;
}

function isTerminalOrderStatus(status) {
  return ["FILLED", "PARTIAL", "CANCELED", "REJECTED"].includes(normalizeOrderStatus(status));
}

async function getOrder(symbol, { orderId = null, clientOrderId = null } = {}) {
  const params = new URLSearchParams({ symbol });
  if (orderId) params.set("orderId", orderId);
  else if (clientOrderId) params.set("clientOid", clientOrderId);
  else throw new Error("getOrder requires orderId or clientOrderId");

  const res = await request(
    config.baseUrl,
    config.apiKey,
    config.secretKey,
    config.passphrase,
    "GET",
    `/api/v2/spot/trade/orderInfo?${params.toString()}`,
    null,
    1
  );

  const row = Array.isArray(res) ? res[0] : (Array.isArray(res?.list) ? res.list[0] : res);
  if (!row || typeof row !== "object") return null;

  return {
    orderId: row.orderId || row.order_id || orderId || null,
    clientOrderId: row.clientOid || row.clientOrderId || clientOrderId || null,
    symbol: row.symbol || symbol,
    side: String(row.side || "").toLowerCase(),
    requestedSize: Number(row.size || row.quantity || 0),
    filledSize: Number(row.baseVolume || row.filledQty || row.filledQuantity || row.dealSize || 0),
    avgPrice: Number(row.priceAvg || row.avgPrice || row.fillPrice || row.price || 0),
    status: normalizeOrderStatus(row.state || row.status),
    raw: row,
    timestamp: Date.now()
  };
}

async function reconcileOrder(symbol, side, requestedSize, orderMeta) {
  const startedAt = Date.now();
  let latest = orderMeta;
  for (let attempt = 0; attempt < 4; attempt++) {
    const status = normalizeOrderStatus(latest?.status);
    if (isTerminalOrderStatus(status)) break;
    await sleep(1200);
    const fetched = await getOrder(symbol, {
      orderId: latest?.orderId,
      clientOrderId: latest?.clientOrderId
    });
    if (fetched) latest = { ...latest, ...fetched };
  }

  const status = normalizeOrderStatus(latest?.status);
  const filledSize = Number(latest?.filledSize || 0);
  const avgPrice = Number(latest?.avgPrice || 0);

  if (status === "REJECTED" || status === "CANCELED") {
    throw new Error(`Order ${status.toLowerCase()}: ${symbol} ${side}`);
  }
  if (status === "OPEN" || status === "UNKNOWN") {
    throw new Error(`Order not finalized: ${symbol} ${side} status=${status}`);
  }
  if (!Number.isFinite(filledSize) || filledSize <= 0) {
    throw new Error(`Order returned no filled size: ${symbol} ${side} status=${status}`);
  }

  return {
    ...latest,
    status,
    requestedSize,
    filledSize,
    avgPrice,
    partialFill: filledSize > 0 && filledSize + 1e-12 < requestedSize,
    reconcileLatencyMs: Date.now() - startedAt
  };
}

async function safeExecute(fn, context) {
  if (executionKillSwitch) {
    logEvent(LOG_FILE, "ERROR", "Execution blocked: kill switch active");
    return { success: false, error: "Kill switch active", skip: true };
  }
  if (executing) {
    logEvent(LOG_FILE, "WARN", "Execution blocked: already in progress");
    return { success: false, error: "Already executing", skip: true };
  }
  try {
    executing = true;
    const result = await fn.call(context);
    globalExecutionFailures = 0; // reset on success
    return { success: true, result, skip: false };
  } catch (err) {
    globalExecutionFailures++;
    logEvent(LOG_FILE, "ERROR", `Execution failed: ${err.message} (consecutive failures: ${globalExecutionFailures})`);
    if (globalExecutionFailures >= MAX_EXECUTION_FAILURES) {
      executionKillSwitch = true;
      logEvent(LOG_FILE, "ERROR", "Execution kill switch activated");
    }
    return { success: false, error: err, skip: false };
  } finally {
    executing = false;
  }
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mergeConfig(base, override) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      merged[key] = mergeConfig(base[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function normalizeConfig() {
  const clampNum = (value, min, max, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };

  const rawRisk = clampNum(config.riskPercent, 0.01, 0.2, 0.15);
  const rawFee = clampNum(config.roundTripFeePct, 0, 0.01, 0.004);
  const rawSlippage = clampNum(config.slippageBufferPct, 0, 0.005, 0.001);
  const baseCooldown = clampNum(config.cooldownMs, 60000, 3600000, 300000);
  const rawMinExpectedNet = clampNum(config.minExpectedNetPct, 0, 0.03, 0.003);
  const rawTakeProfit = clampNum(config.takeProfitPct, 0.001, 0.2, 0.012);
  const rawTrailingActivation = clampNum(config.trailingActivationPct, 0.001, 0.2, 0.008);
  const rawBreakEvenArmed = clampNum(config.breakEvenArmedPct, 0.0005, 0.2, 0.006);
  const totalCostPct = rawFee + rawSlippage;
  const minNetBufferPct = Math.max(rawMinExpectedNet, 0.001);

  let effectiveCooldown = baseCooldown;
  if (rawRisk >= 0.15) effectiveCooldown = Math.max(baseCooldown, 600000);
  else if (rawRisk >= 0.1) effectiveCooldown = Math.max(baseCooldown, 300000);
  else effectiveCooldown = Math.max(baseCooldown, 180000);

  const effectiveTakeProfit = Math.max(rawTakeProfit, totalCostPct + minNetBufferPct);
  let effectiveBreakEvenArmed = Math.max(rawBreakEvenArmed, totalCostPct + 0.0005);
  let effectiveTrailingActivation = Math.max(rawTrailingActivation, effectiveBreakEvenArmed + 0.0005);
  if (effectiveTrailingActivation >= effectiveTakeProfit) {
    effectiveTrailingActivation = Math.max(effectiveBreakEvenArmed + 0.0003, effectiveTakeProfit * 0.8);
  }
  if (effectiveBreakEvenArmed >= effectiveTrailingActivation) {
    effectiveBreakEvenArmed = Math.max(totalCostPct + 0.0005, effectiveTrailingActivation - 0.0005);
  }

  // Derived internal values only; config schema stays unchanged
  config._effectiveRisk = rawRisk;
  config._effectiveCooldown = effectiveCooldown;
  config._effectiveSlippageBufferPct = rawSlippage;
  config._effectiveRoundTripFeePct = rawFee;
  config._effectiveMinExpectedNetPct = rawMinExpectedNet;
  config._effectiveTakeProfitPct = effectiveTakeProfit;
  config._effectiveTrailingActivationPct = effectiveTrailingActivation;
  config._effectiveBreakEvenArmedPct = effectiveBreakEvenArmed;
  config._effectiveCostPct = totalCostPct;
  const maxRoundsPerDay = Number.isFinite(config.maxRoundsPerDay) ? config.maxRoundsPerDay : config.maxTradesPerDay;
  config._effectiveMaxTrades = Number.isFinite(maxRoundsPerDay) ? maxRoundsPerDay : 20;
  config.maxRoundsPerDay = config._effectiveMaxTrades;
  config.maxTradesPerDay = config._effectiveMaxTrades;
  config.enableMultiTrade = config.enableMultiTrade === true;
  config.maxOpenPositions = Math.max(1, Math.min(10, Math.floor(Number(config.maxOpenPositions) || 1)));
  config.exposureCapPct = clampNum(config.exposureCapPct, 0.05, 1, 0.5);
  config.enableMultiTrade = config.enableMultiTrade === true;
  config.maxOpenPositions = Math.max(1, Math.min(10, Math.floor(Number(config.maxOpenPositions) || 1)));
  config.exposureCapPct = clampNum(config.exposureCapPct, 0.05, 1, 0.5);

  // 5. Mode profile semantics enforcement
  const mode = config.activeMode || config.selectedMode || 'normal';
  if (mode === 'aggressive' || mode === 'hyper') {
    config._effectiveRisk = Math.min(config._effectiveRisk, 0.2);
    config._effectiveMaxTrades = Math.min(config._effectiveMaxTrades, 999);
  }

  // 6. Market profile allowEntries: respect dashboard but guard bearish/choppy
  config._effectiveAllowEntries = true; // default
  const profileKey = config.selectedMarketProfile || 'auto';
  if (profileKey !== 'auto') {
    const mp = config.marketProfiles?.[profileKey];
    if (mp) {
      const bearishProfiles = ['bearish', 'choppy'];
      if (bearishProfiles.includes(profileKey)) {
        config._effectiveAllowEntries = false;
      } else {
        config._effectiveAllowEntries = mp.allowEntries !== false;
      }
    }
  } else {
    // auto mode: look at activeMarketProfile after market detection
    const activeProfile = config.activeMarketProfile || 'neutral';
    if (['bearish', 'choppy'].includes(activeProfile)) {
      config._effectiveAllowEntries = false;
    } else {
      const mp = config.marketProfiles?.[activeProfile];
      config._effectiveAllowEntries = mp ? mp.allowEntries !== false : true;
    }
  }

  // 7. Sanity check numeric fields (NaN/Infinity guard)
  const numericFields = [
    'minBuyUSDT', 'maxBuyUSDT', 'reserveUSDT',
    'minManagedPositionUSDT', 'minRecoverUSDT',
    'takeProfitPct', 'trailingActivationPct', 'trailingDrawdownPct',
    'trailingProtectionPct', 'exitRSIThreshold',
    'minExpectedNetPct', 'minScalpTargetPct', 'maxScalpTargetPct',
    'minAtrPct', 'maxAtrPct', 'minTrendRsi', 'minVolumeRatio', 'maxEmaGapPct',
    'minCandleStrength', 'breakoutPct', 'maxOpenPositions', 'exposureCapPct'
  ];
  for (const field of numericFields) {
    if (config[field] !== undefined) {
      const val = Number(config[field]);
      if (!isFinite(val) || isNaN(val)) {
        console.warn(`[SAFETY] Invalid ${field}=${config[field]}, using fallback`);
        if (field.includes('Pct')) config[field] = 0.01;
        else if (field.includes('USDT')) config[field] = 5;
        else config[field] = 1;
      }
    }
  }
}

const BOT_TYPE_OVERRIDE_KEYS = new Set([
  "signalTimeframe",
  "trendTimeframe",
  "minScalpTargetPct",
  "maxScalpTargetPct",
  "timeStopMinutes",
  "maxHoldMinutes",
  "breakEvenMinutes",
  "minConfirmation",
  "breakoutPct",
  "requireEma21Rising",
  "requireFastTrend",
  "requirePriceAboveEma9",
  "requireEdge",
  "rsiBandLower",
  "rsiBandUpper",
  "minCandleStrength",
  "optimalRsiLow",
  "optimalRsiHigh",
  "optimalAtrLow",
  "optimalAtrHigh",
  "minEmaGapNeg",
  "requireRsiMomentum",
  "requireBreakout",
  "enableRsiBandFilter",
  "enableAtrFilter",
  "enableVolumeFilter",
  "enableCandleStrengthFilter",
  "enablePriceExtensionFilter",
  "enableRangeRecoveryFilter"
]);

function filterOverrides(override, allowedKeys = null, blockedKeys = null) {
  const next = {};
  for (const [key, value] of Object.entries(override || {})) {
    if (allowedKeys && !allowedKeys.has(key)) continue;
    if (blockedKeys && blockedKeys.has(key)) continue;
    next[key] = value;
  }
  return next;
}

function normalizePairConfig(currentConfig) {
  const pairSettings = isPlainObject(currentConfig.pairSettings) ? currentConfig.pairSettings : {};
  const enabledPairs = Object.entries(pairSettings)
    .filter(([, value]) => value === true || (isPlainObject(value) && value.enabled !== false))
    .map(([symbol]) => symbol.toUpperCase());

  const nextConfig = { ...currentConfig };
  nextConfig.pairs = enabledPairs;
  nextConfig.baseCoins = nextConfig.pairs.map(symbol => symbol.replace(/USDT$/i, "").toUpperCase());
  return nextConfig;
}

function getModeChoices() {
  const modeProfiles = config.modeProfiles || {};
  return Object.entries(modeProfiles).map(([key, value], index) => ({
    key,
    number: String(index + 1),
    label: value.label || key,
    description: value.description || "",
    config: value
  }));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jakartaDateKey(input = Date.now()) {
  const date = input instanceof Date ? input : new Date(input);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function countClosedRoundsForDate(dateKey) {
  try {
    if (!fs.existsSync(JOURNAL_PATH)) return 0;
    const raw = fs.readFileSync(JOURNAL_PATH, "utf8").trim();
    if (!raw) return 0;
    const journal = JSON.parse(raw);
    if (!Array.isArray(journal)) return 0;
    return journal.filter((trade) => {
      if (trade?.status !== "closed") return false;
      const closedAt = trade.closedAt || trade.exitTime || trade.openedAt || trade.entryTime;
      if (!closedAt) return false;
      const parsed = new Date(closedAt);
      if (Number.isNaN(parsed.getTime())) return false;
      return jakartaDateKey(parsed) === dateKey;
    }).length;
  } catch {
    return 0;
  }
}

function syncStatePositions(nextState) {
  if (!nextState || typeof nextState !== "object") return [];
  let positions = Array.isArray(nextState.positions) ? nextState.positions.filter(Boolean) : [];
  if (!positions.length && nextState.position) {
    positions = [nextState.position];
  }
  nextState.positions = positions;
  nextState.position = positions[0] || null;
  if (!nextState.lastReportedPnlBySymbol || typeof nextState.lastReportedPnlBySymbol !== "object") {
    nextState.lastReportedPnlBySymbol = {};
  }
  return positions;
}

function getOpenPositions(nextState) {
  return syncStatePositions(nextState);
}

function getOpenExposureUsdt(nextState) {
  return getOpenPositions(nextState).reduce((sum, pos) => {
    const size = Number(pos?.sizeUSDT || 0);
    return sum + (Number.isFinite(size) ? size : 0);
  }, 0);
}

function summarizeOpenPositions(nextState, maxItems = 3) {
  const positions = getOpenPositions(nextState);
  if (!positions.length) return "None";
  const symbols = positions.map(pos => pos.symbol).filter(Boolean);
  const shown = symbols.slice(0, maxItems).join(", ");
  return symbols.length > maxItems ? `${shown} (+${symbols.length - maxItems} more)` : shown;
}

function printBanner(defaultBotType, defaultMode, defaultMarketProfile, marketProfileMode) {
  const colors = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    brightGreen: "\x1b[92m",
    cyan: "\x1b[36m",
    white: "\x1b[97m",
    dim: "\x1b[90m",
    dark: "\x1b[32m"
  };
  const divider = `${colors.green}=================================================================================================${colors.reset}`;
  const banner = [
    divider,
    `${colors.brightGreen}   █████╗ ██╗██████╗ ██████╗ ██╗      █████╗ ███╗   ██╗███████╗███████╗████████╗ █████╗ ██████╗ ${colors.reset}`,
    `${colors.brightGreen}  ██╔══██╗██║██╔══██╗██╔══██╗██║     ██╔══██╗████╗  ██║██╔════╝██╔════╝╚══██╔══╝██╔══██╗██╔══██╗${colors.reset}`,
    `${colors.green}  ███████║██║██████╔╝██████╔╝██║     ███████║██╔██╗ ██║█████╗  ███████╗   ██║   ███████║██████╔╝${colors.reset}`,
    `${colors.green}  ██╔══██║██║██╔══██╗██╔═══╝ ██║     ██╔══██║██║╚██╗██║██╔══╝  ╚════██║   ██║   ██╔══██║██╔══██╗${colors.reset}`,
    `${colors.dark}  ██║  ██║██║██║  ██║██║     ███████╗██║  ██║██║ ╚████║███████╗███████║   ██║   ██║  ██║██║  ██║${colors.reset}`,
    `${colors.dark}  ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝${colors.reset}`,
    `${colors.cyan}                              		SPOT SCALPER CLI${colors.reset}`,
    divider
  ];

  console.log(banner.join("\n"));
  console.log("");
}

function renderStartupValidationLine(progress, label, done = false) {
  const colors = {
    reset: "\x1b[0m",
    darkGreen: "\x1b[32m",
    lightGreen: "\x1b[92m",
    white: "\x1b[97m",
    dim: "\x1b[90m"
  };
  const width = 24;
  const safeProgress = Math.max(0, Math.min(1, progress));
  const filled = Math.round(width * safeProgress);
  const filledDark = Math.max(0, Math.min(filled, Math.max(0, filled - 4)));
  const filledLight = Math.max(0, filled - filledDark);
  const empty = width - filled;
  const bar = `${colors.darkGreen}${"█".repeat(filledDark)}${colors.lightGreen}${"█".repeat(filledLight)}${colors.dim}${"░".repeat(empty)}${colors.reset}`;
  const pct = `${Math.round(safeProgress * 100)}%`.padStart(4, " ");
  const status = done ? `${colors.lightGreen}OK${colors.reset}` : `${colors.white}..${colors.reset}`;
  return `${colors.white}[VALIDATION]${colors.reset} [${bar}] ${pct} ${status} ${label}`;
}

async function animateValidationStage(fromProgress, toProgress, label, durationMs = 1250) {
  await sleep(durationMs);
}

function printValidationPassed() {
  const colors = {
    reset: "\x1b[0m",
    darkGreen: "\x1b[32m",
    lightGreen: "\x1b[92m",
    white: "\x1b[97m"
  };
  const bar = `${colors.darkGreen}${"█".repeat(20)}${colors.lightGreen}${"█".repeat(4)}${colors.reset}`;
  const line = `${colors.white}[VALIDATION]${colors.reset} [${bar}] 100% ${colors.lightGreen}PASS${colors.reset} startup validation complete`;
  console.log("");
  console.log(line);
  console.log("");
}

function applySelectedBotType(botTypeKey) {
  const profiles = config.botTypeProfiles || {};
  const selectedProfile = profiles[botTypeKey];
  if (!selectedProfile) {
    config.activeBotType = config.selectedBotType || "scalp_trend";
    return;
  }

  config = normalizePairConfig(
    mergeConfig(config, filterOverrides(selectedProfile.overrides || {}, BOT_TYPE_OVERRIDE_KEYS))
  );
  config.selectedBotType = botTypeKey;
  config.activeBotType = botTypeKey;
  config.activeBotTypeLabel = selectedProfile.label || botTypeKey;
  config.activeBotTypeDescription = selectedProfile.description || "";
}

function applySelectedMode(modeKey) {
  const profiles = config.modeProfiles || {};
  const selectedProfile = profiles[modeKey];
  if (!selectedProfile) {
    config.activeMode = config.selectedMode || "normal";
    return;
  }

  config = normalizePairConfig(
    mergeConfig(config, filterOverrides(selectedProfile.overrides || {}, null, BOT_TYPE_OVERRIDE_KEYS))
  );
  config.selectedMode = modeKey;
  config.activeMode = modeKey;
  config.activeModeLabel = selectedProfile.label || modeKey;
  config.activeModeDescription = selectedProfile.description || "";

  console.log("");
  if (config.activeBotTypeLabel) {
    console.log(`Bot type   : ${config.activeBotTypeLabel}`);
  }
  console.log(`Mode aktif : ${config.activeModeLabel}`);
  if (config.activeModeDescription) {
    console.log(`Deskripsi  : ${config.activeModeDescription}`);
  }
  console.log(`Risk       : ${(config.riskPercent * 100).toFixed(1)}% | TP ${(config.takeProfitPct * 100).toFixed(2)}% | Reserve ${safeToFixed(config.reserveUSDT ?? 0)} USDT`);
  console.log(`Multi trade: ${config.enableMultiTrade ? `on | slots ${config.maxOpenPositions} | cap ${(config.exposureCapPct * 100).toFixed(0)}%` : "off"}`);
  console.log(`Safe exit  : press Ctrl+C to stop gracefully`);
  console.log(`Dashboard  : http://localhost:3841`);
  console.log("");
}

function resolveMarketProfileKey(marketMode) {
  if (config.marketProfileMode === "manual") {
    return config.selectedMarketProfile || null;
  }

  const mapping = {
    "Bullish": "bullish",
    "Bullish but slow": "bullish_slow",
    "Neutral": "neutral",
    "Bearish": "bearish",
    "Choppy": "choppy"
  };

  return mapping[marketMode] || null;
}

function applyMarketProfile(baseConfig, marketProfileKey) {
  if (!marketProfileKey) {
    return normalizePairConfig({
      ...baseConfig,
      activeMarketProfile: null,
      activeMarketProfileLabel: "Auto",
      activeMarketProfileDescription: "",
      marketEntriesEnabled: true,
      _effectiveAllowEntries: baseConfig._effectiveAllowEntries // inherit from base
    });
  }

  const profile = baseConfig.marketProfiles?.[marketProfileKey];
  if (!profile) {
    return normalizePairConfig({
      ...baseConfig,
      activeMarketProfile: marketProfileKey,
      activeMarketProfileLabel: marketProfileKey,
      activeMarketProfileDescription: "",
      marketEntriesEnabled: true,
      _effectiveAllowEntries: baseConfig._effectiveAllowEntries
    });
  }

  const merged = normalizePairConfig(mergeConfig(baseConfig, profile.entryOverrides || {}));
  merged.activeMarketProfile = marketProfileKey;
  merged.activeMarketProfileLabel = profile.label || marketProfileKey;
  merged.activeMarketProfileDescription = profile.description || "";
  merged.marketEntriesEnabled = profile.allowEntries !== false;
  
  // Set _effectiveAllowEntries: guard bullish/choppy
  const bearishProfiles = ['bearish', 'choppy'];
  if (bearishProfiles.includes(marketProfileKey)) {
    merged._effectiveAllowEntries = false;
  } else {
    merged._effectiveAllowEntries = profile.allowEntries !== false;
  }
  
  return merged;
}

// Ensure logs dir
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

async function loadSymbolScales(symbol = null) {
  const suffix = symbol ? `?symbol=${encodeURIComponent(symbol)}` : "";
  const data = await request(config.baseUrl, null, null, null, "GET", `/api/v2/spot/public/symbols${suffix}`, null, 3);
  const items = Array.isArray(data) ? data : [];

  for (const item of items) {
    if (!item.symbol) continue;
    const scale = Number(item.quantityPrecision ?? item.baseAssetPrecision);
    if (Number.isInteger(scale) && scale >= 0) {
      symbolScales[item.symbol] = scale;
    }
  }

  return items;
}

async function initScales() {
  try {
    await loadSymbolScales();
    logEvent(LOG_FILE, "INFO", `Loaded symbol scales for ${Object.keys(symbolScales).length} symbols`);
  } catch (err) {
    logEvent(LOG_FILE, "ERROR", `Failed to load symbol scales: ${err.message}`);
  }
}

// Load state & health
let state = loadState(STATE_PATH);
syncStatePositions(state);
let health = loadHealth(HEALTH_PATH);
if (!health.startedAt) {
  health.startedAt = new Date().toISOString();
  health.status = "running";
  saveHealth(HEALTH_PATH, health, {});
} else {
  health = saveHealth(HEALTH_PATH, health, {
    status: "running",
    resumedAt: new Date().toISOString()
  });
}
// Ensure new fields exist for older state files
if (state.realizedPnlToday === undefined) state.realizedPnlToday = 0;
if (state.lastReportedPnlBySymbol === undefined) state.lastReportedPnlBySymbol = {};

// Globals
let lastHeartbeatTime = 0, lastMarketReportTime = 0, lastBalanceReportTime = 0, lastHoldReportTime = 0, lastNoSignalReportTime = 0;
let lastBalanceFetchTime = 0;
let cachedBalances = null;
let lastPriceFetchTime = 0;
let cachedPrices = null;
let position = state.position;
let loopTimer = null;
let loopInProgress = false;
let shutdownRequested = false;
let shutdownInProgress = false;
const alertTimestamps = {};

async function reportCritical(key, message, cooldownMs = 15 * 60 * 1000) {
  const now = Date.now();
  if ((alertTimestamps[key] || 0) + cooldownMs > now) return false;
  alertTimestamps[key] = now;
  return report(message);
}

function cleanupKeyboardHooks() {
  if (!process.stdin.isTTY) return;
  try {
    process.stdin.setRawMode(false);
  } catch (_) {}
  process.stdin.pause();
  process.stdin.removeAllListeners("data");
}

async function performSafeShutdown(source = "manual") {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }

  logEvent(LOG_FILE, "INFO", `Safe exit requested via ${source}`);
  cliOnly("INFO", `Safe exit requested via ${source}. Shutting down gracefully...`);

  try {
    health = saveHealth(HEALTH_PATH, health, {
      status: "stopped",
      stoppedAt: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - new Date(health.startedAt).getTime()) / 1000)
    });
  } catch (err) {
    logEvent(LOG_FILE, "ERROR", `Failed to save shutdown health: ${err.message}`);
  }

  cleanupKeyboardHooks();
  process.exit(0);
}

function requestSafeExit(source = "manual") {
  if (shutdownRequested) return;
  shutdownRequested = true;

  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }

  if (!loopInProgress) {
    performSafeShutdown(source).catch(err => {
      logEvent(LOG_FILE, "ERROR", `Safe shutdown failed: ${err.message}`);
      process.exit(1);
    });
  } else {
    logEvent(LOG_FILE, "INFO", `Safe exit queued via ${source}`);
    cliOnly("INFO", `Safe exit queued via ${source}. Waiting for current cycle to finish...`);
  }
}

function setupKeyboardShortcuts() {
  if (!process.stdin.isTTY) return;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", chunk => {
    const key = String(chunk);
    if (key === "q" || key === "Q") {
      requestSafeExit("keyboard:q");
      return;
    }
    if (chunk.length === 1 && chunk[0] === 3) {
      requestSafeExit("keyboard:ctrl-c");
    }
  });
}

// ================= HELPERS =================
async function report(msg) {
  logEvent(LOG_FILE, "REPORT", msg);
  const botToken = config.telegram?.botToken;
  const chatId = config.telegram?.chatId;
  if (!botToken || !chatId) return false;

  const escapedMsg = String(msg)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `<pre>${escapedMsg}</pre>`,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(JSON.stringify(data));

    return true;
  } catch (err) {
    logEvent(LOG_FILE, "ERROR", "Telegram send failed: " + err.message);
    return false;
  }
}

function shouldReport(intervalMs, lastTime) {
  return Date.now() - lastTime >= intervalMs;
}

function estimateNetPnlPct(grossPnlFraction) {
  const grossPct = Number(grossPnlFraction) * 100;
  const feePct = Number(config.roundTripFeePct || 0) * 100;
  const slippagePct = Number(config.slippageBufferPct || 0) * 100;
  if (!Number.isFinite(grossPct)) return null;
  return grossPct - feePct - slippagePct;
}

function timeframeToMs(timeframe) {
  const raw = String(timeframe || "").toLowerCase().trim();
  const match = raw.match(/^(\d+)\s*(min|m|minute|minutes|hour|hours|h)$/);
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (unit === "h" || unit === "hour" || unit === "hours") return value * 60 * 60 * 1000;
  return value * 60 * 1000;
}

function normalizeCandleRows(rows, timeframe) {
  const timeframeMs = timeframeToMs(timeframe);
  const now = Date.now();
  const normalized = (Array.isArray(rows) ? rows : [])
    .filter(row => Array.isArray(row) && row.length >= 6)
    .map(row => row.map(value => Number(value)))
    .filter(row =>
      row.every((value, idx) => idx === 5 || Number.isFinite(value)) &&
      Number.isFinite(row[0]) &&
      Number.isFinite(row[1]) &&
      Number.isFinite(row[2]) &&
      Number.isFinite(row[3]) &&
      Number.isFinite(row[4]) &&
      row[0] > 0
    )
    .sort((a, b) => a[0] - b[0]);

  if (!timeframeMs) return normalized;

  return normalized.filter(row => row[0] + timeframeMs <= now);
}

function extractTickerRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.tickers)) return data.tickers;
  return [];
}

function extractTickerSymbol(ticker) {
  return String(
    ticker?.symbol ||
    ticker?.instId ||
    ticker?.symbolName ||
    ticker?.productId ||
    ""
  ).toUpperCase();
}

function extractTickerPrice(ticker) {
  const candidates = [
    ticker?.last,
    ticker?.lastPr,
    ticker?.close,
    ticker?.closePrice,
    ticker?.lastPrice,
    ticker?.price
  ];
  for (const candidate of candidates) {
    const price = Number(candidate);
    if (Number.isFinite(price) && price > 0) return price;
  }
  return 0;
}

async function getCandles(symbol, timeframe = "3min", limit = 50) {
  await waitForSlot();
  try {
    // Throttle: delay between requests to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 100));

    const timeframeMs = timeframeToMs(timeframe);
    const isFreshEnough = (rows, now = Date.now()) => {
      if (!Array.isArray(rows) || rows.length === 0 || !timeframeMs) return false;
      const last = rows[rows.length - 1];
      const closeTime = Number(last[0]) + timeframeMs;
      return isCandleTimestampFresh(closeTime, timeframe, now);
    };

    const describeRows = (rows, source) => {
      if (!Array.isArray(rows) || rows.length === 0 || !timeframeMs) {
        return `${source}:empty`;
      }
      const last = rows[rows.length - 1];
      const closeTime = Number(last[0]) + timeframeMs;
      const ageMin = ((Date.now() - closeTime) / 60000).toFixed(1);
      return `${source}:close=${new Date(closeTime).toISOString()} ageMin=${ageMin}`;
    };

    const fetchCandles = async (path, source) => {
      const data = await request(config.baseUrl, config.apiKey, config.secretKey, config.passphrase, "GET", path);
      const rows = normalizeCandleRows(Array.isArray(data) ? data : [], timeframe);
      logEvent(LOG_FILE, "DEBUG", `Candle fetch ${symbol} (${timeframe}) ${describeRows(rows, source)}`);
      return rows;
    };

    const primaryPath = `/api/v2/spot/market/candles?symbol=${symbol}&granularity=${timeframe}&limit=${limit + 2}`;
    const historyPath = `/api/v2/spot/market/history-candles?symbol=${symbol}&granularity=${timeframe}&endTime=${Date.now()}&limit=${limit + 2}`;

    let candles = await fetchCandles(primaryPath, "primary");
    let sourceUsed = "primary";

    if (candles.length === 0 || !isFreshEnough(candles)) {
      if (candles.length > 0) {
        logEvent(LOG_FILE, "WARN", `Stale primary candles for ${symbol} (${timeframe}), retrying before fallback`);
        await new Promise(resolve => setTimeout(resolve, 500));
        const retryCandles = await fetchCandles(primaryPath, "primary-retry");
        if (retryCandles.length > 0) {
          candles = retryCandles;
          sourceUsed = "primary-retry";
        }
      }

      if (candles.length === 0 || !isFreshEnough(candles)) {
        const historyCandles = await fetchCandles(historyPath, "history-fallback");
        if (historyCandles.length > 0) {
          candles = historyCandles;
          sourceUsed = "history-fallback";
        }
      }
    }

    if (candles.length > limit) {
      candles = candles.slice(-limit);
    }

    if (Array.isArray(candles) && candles.length > 0) {
      const last = candles[candles.length - 1];
      const key = `${symbol}:${timeframe}`;
      lastCandleData[key] = {
        closeTime: Number(last[0]) + timeframeMs,
        close: parseFloat(last[4])
      };
      if (!isFreshEnough(candles)) {
        logEvent(LOG_FILE, "WARN", `Using stale candles for ${symbol} (${timeframe}) after fallback chain, source=${sourceUsed}`);
      }
    } else {
      logEvent(LOG_FILE, "WARN", `Empty/invalid closed candles for ${symbol} (${timeframe}) after fallback chain`);
    }
    return candles;
  } catch (err) {
    logEvent(LOG_FILE, "ERROR", `getCandles failed for ${symbol} (${timeframe}): ${err.message}`);
    throw err; // re-throw so caller knows
  } finally {
    releaseSlot();
  }
}

async function getBalances() {
  await waitForSlot();
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    const data = await request(config.baseUrl, config.apiKey, config.secretKey, config.passphrase, "GET", "/api/v2/spot/account/assets");
    const byCoin = Object.fromEntries(
      data.map(item => [String(item.coin || "").toUpperCase(), Number(item.available || 0)])
    );
    const balances = { usdt: byCoin.USDT || 0 };
    for (const coin of config.baseCoins || []) {
      balances[coin.toLowerCase()] = byCoin[coin] || 0;
    }
    return balances;
  } finally {
    releaseSlot();
  }
}

async function getPortfolioValue() {
  const now = Date.now();
  // Always fetch fresh data
  const [balances, tickers] = await Promise.all([
    getBalances(),
    getTickers()
  ]);
  cachedBalances = balances;
  lastBalanceFetchTime = now;

  // Build price map from tickers: { btc: 60000, eth: 3000, ... }
  const priceMap = {};
  for (const t of tickers) {
    const coin = t.symbol.replace('USDT', '').toLowerCase();
    priceMap[coin] = t.last;
  }

  // Fallback: for any coin with balance but missing/zero price, fetch last candle close
  const missingCoins = [];
  for (const [coin, bal] of Object.entries(balances)) {
    if (coin === 'usdt') continue;
    const lower = coin.toLowerCase();
    if (bal > 0 && (!priceMap[lower] || priceMap[lower] <= 0)) {
      missingCoins.push(lower);
    }
  }
  if (missingCoins.length > 0) {
    logEvent(LOG_FILE, 'DEBUG', `Missing prices for: ${missingCoins.join(',')}, fetching candles...`);
    for (const coin of missingCoins) {
      const symbol = coin.toUpperCase() + 'USDT';
      try {
        const candles = await getCandles(symbol, config.signalTimeframe, 1);
        if (candles && candles.length > 0) {
          const close = extractLastClosedPrice(candles);
          if (close > 0) {
            priceMap[coin] = close;
            logEvent(LOG_FILE, 'DEBUG', `Fallback price for ${coin}: ${close} (from candles)`);
          }
        }
      } catch (e) {
        // ignore, will remain 0
      }
    }
  }

  // Debug: log final price map used for equity
  logEvent(LOG_FILE, 'DEBUG', `PRICE MAP FINAL: ${JSON.stringify(priceMap)}`);

  cachedPrices = priceMap;
  lastPriceFetchTime = now;
  return computeEquity({
    balances,
    priceMap,
    dustThreshold: config.logDustThreshold ?? 0.01,
    qtyDustThreshold: config.logQtyDustThreshold ?? 1e-8,
    logger: message => logEvent(LOG_FILE, "DEBUG", message)
  });
}

function computeEquityLegacy(balances, priceMap) {
  let total = balances.usdt || 0;
  const breakdown = {};
  const dustThreshold = config.logDustThreshold ?? 0.01;
  const qtyDustThreshold = config.logQtyDustThreshold ?? 1e-8;
  const summary = [];

  for (const [coin, bal] of Object.entries(balances)) {
    if (coin === 'usdt') continue;
    const qty = bal || 0;
    if (qty <= 0) continue;
    const lowerCoin = coin.toLowerCase();
    const price = priceMap[lowerCoin];
    if (!price || price <= 0) {
      logEvent(LOG_FILE, "WARN", `Missing/zero price for ${lowerCoin} (balance=${qty})`);
      continue;
    }
    const value = qty * price;
    if (qty < qtyDustThreshold || value < dustThreshold) {
      continue;
    }
    breakdown[lowerCoin] = value;
    total += value;
    summary.push(`${lowerCoin}: qty=${qty}, price=${price}, value=${safeToFixed(value)}`);
  }
  if (summary.length > 0) {
    logEvent(LOG_FILE, "DEBUG", `Equity assets | ${summary.join(" | ")}`);
  }
  logEvent(LOG_FILE, "DEBUG", `Equity computed | total=${safeToFixed(total, 2)} | assets=${Object.keys(breakdown).join(",") || "none"}`);
  return {
    totalEquity: total,
    usdtFree: balances.usdt,
    balances: balances,
    breakdown: breakdown
  };
}

async function getTickers() {
  const data = await request(config.baseUrl, config.apiKey, config.secretKey, config.passphrase, "GET", "/api/v2/spot/market/tickers");
  const tickers = extractTickerRows(data);
  const result = [];
  for (const t of tickers) {
    const sym = extractTickerSymbol(t);
    const price = extractTickerPrice(t);
    if (config.pairs.includes(sym) && price > 0) {
      result.push({ symbol: sym, last: price });
    }
  }

  if (result.length === 0) {
    const sample = tickers.slice(0, 3).map(t => ({
      symbol: extractTickerSymbol(t),
      last: t?.last,
      lastPr: t?.lastPr,
      close: t?.close,
      closePrice: t?.closePrice
    }));
    logEvent(LOG_FILE, "WARN", `getTickers returned 0 matched prices from ${tickers.length} rows; sample=${JSON.stringify(sample)}`);
  } else {
    logEvent(LOG_FILE, "DEBUG", `getTickers fetched ${result.length} prices: ${JSON.stringify(result.map(x=>({coin:x.symbol.replace('USDT','').toLowerCase(),price:x.last})))}`);
  }

  const deduped = [];
  const seen = new Set();
  for (const ticker of result) {
    if (seen.has(ticker.symbol)) continue;
    seen.add(ticker.symbol);
    deduped.push(ticker);
  }
  return deduped;
}

function isValidLatestCandle(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return false;
  const last = candles[candles.length - 1];
  if (!Array.isArray(last) || last.length < 6) return false;
  const openTime = Number(last[0]);
  const open = Number(last[1]);
  const high = Number(last[2]);
  const low = Number(last[3]);
  const close = Number(last[4]);
  return (
    Number.isFinite(openTime) &&
    Number.isFinite(open) &&
    Number.isFinite(high) &&
    Number.isFinite(low) &&
    Number.isFinite(close) &&
    openTime > 0 &&
    close > 0 &&
    high >= low
  );
}

function extractLastClosedPrice(candles) {
  if (!isValidLatestCandle(candles)) return 0;
  const last = candles[candles.length - 1];
  const close = Number(last[4]);
  return Number.isFinite(close) && close > 0 ? close : 0;
}

let cachedTickers = null;
let lastTickerFetchTime = 0;
async function getTickersCached() {
  const now = Date.now();
  if (cachedTickers && (now - lastTickerFetchTime < 5 * 60 * 1000)) {
    return cachedTickers;
  }
  try {
    cachedTickers = await getTickers();
    lastTickerFetchTime = now;
    return cachedTickers;
  } catch (err) {
    logEvent(LOG_FILE, "ERROR", "getTickers failed: " + err.message);
    if (cachedTickers) return cachedTickers;
    throw err;
  }
}

function calculateTotalEquity(balances, tickers) {
  let total = balances.usdt;
  for (const [coin, qty] of Object.entries(balances)) {
    if (coin === 'usdt') continue;
    const symbol = coin.toUpperCase() + 'USDT';
    const price = tickers[symbol];
    if (price && qty > 0) {
      total += qty * price;
    }
  }
  return total;
}

async function getBalancesCached() {
  const now = Date.now();
  if (cachedBalances && (now - lastBalanceFetchTime < 5 * 60 * 1000)) {
    return cachedBalances;
  }
  try {
    cachedBalances = await getBalances();
    lastBalanceFetchTime = now;
    return cachedBalances;
  } catch (err) {
    logEvent(LOG_FILE, "ERROR", "getBalances failed: " + err.message);
    if (cachedBalances) return cachedBalances;
    throw err;
  }
}

function getCoinBalanceLegacy(symbol, balances) {
  const coin = symbol.replace("USDT", "").toLowerCase();
  // Case-insensitive lookup
  const actual = Object.keys(balances).find(k => k.toLowerCase() === coin);
  return actual ? balances[actual] : 0;
}

// Detect open position from balance (recovery if state.position missing)
function detectOpenPositionFromBalanceLegacy(balances, priceMap, config) {
  const minRecover = config.minRecoverUSDT || config.minManagedPositionUSDT || config.minHoldUSDT || 5;
  logEvent(LOG_FILE, "DEBUG", `Recovery scan | threshold=${safeToFixed(minRecover, 2)} USDT`);
  for (const [coin, qty] of Object.entries(balances)) {
    if (coin.toLowerCase() === 'usdt') continue;
    if (!qty || qty <= 0) continue;
    const coinLower = coin.toLowerCase();
    const price = priceMap[coinLower];
    if (!price) {
      logEvent(LOG_FILE, "WARN", `Missing price for ${coinLower} (balance=${qty})`);
      continue;
    }
    const value = qty * price;
    const coinUpper = coinLower.toUpperCase();
    logEvent(LOG_FILE, "DEBUG", `Recovery asset | ${coinUpper} qty=${qty} price=${price} value=${safeToFixed(value)}`);
    if (value >= minRecover) {
      const symbol = coinUpper + 'USDT';
      logEvent(LOG_FILE, "INFO", `Recovered position | ${symbol} value=${safeToFixed(value)}`);
      return {
        symbol,
        entry: price,
        currentPrice: price,
        qty: qty,
        sizeUSDT: value,
        peak: price,
        trailingActive: false,
        stopPct: -0.02, // default 2% stop until next evaluation
        entryTime: Date.now(),
        entryReason: {
          score: null,
          marketMode: null,
          rsi: null,
          atrPct: null,
          notes: "Recovered from balance â€“ entry price estimated"
        },
        source: "recovery"
      };
    }
  }
  logEvent(LOG_FILE, "INFO", "Position recovery scan complete: no valid position found");
  return null;
}

async function placeOrder(symbol, side, size, clientOrderId = null) {
  if (executionKillSwitch) {
    throw new Error("Execution kill switch active");
  }
  if (clientOrderId && inFlightClientOrders.has(clientOrderId)) {
    throw new Error(`Duplicate in-flight clientOrderId: ${clientOrderId}`);
  }

  let scale = symbolScales[symbol];
  if (!Number.isInteger(scale)) {
    try {
      await loadSymbolScales(symbol);
      scale = symbolScales[symbol];
    } catch (err) {
      logEvent(LOG_FILE, "WARN", `Could not refresh symbol scale for ${symbol}: ${err.message}`);
    }
  }

  let sizeNum = Number(size);
  if (!Number.isFinite(sizeNum) || sizeNum <= 0) {
    throw new Error(`Invalid order size for ${symbol}: ${size}`);
  }

  if (Number.isInteger(scale) && scale >= 0) {
    const factor = Math.pow(10, scale);
    sizeNum = Math.floor(sizeNum * factor) / factor;
  }

  if (sizeNum <= 0) {
    throw new Error(`Rounded order size became zero for ${symbol}: original=${size} scale=${scale}`);
  }

  const sizeStr = Number.isInteger(scale) && scale >= 0
    ? sizeNum.toFixed(scale)
    : sizeNum.toString();

  const body = { 
    symbol, 
    side, 
    orderType: "market", 
    force: "gtc", 
    size: sizeStr 
  };
  
  if (clientOrderId) {
    body.clientOid = clientOrderId;
  }

  if (config.dryRun) {
    logEvent(LOG_FILE, "SIMULATE", `ORDER ${side} ${symbol} size=${sizeStr}${clientOrderId ? ` cid=${clientOrderId}` : ""}`);
    return { 
      orderId: `SIM_${Date.now()}`, 
      clientOrderId: clientOrderId || `SIM_${Date.now()}`,
      symbol, 
      side, 
      requestedSize: sizeNum,
      filledSize: sizeNum,
      avgPrice: 0,
      status: "filled",
      dryRun: true 
    };
  }
  
  logEvent(LOG_FILE, "INFO", `Submitting ${side.toUpperCase()} ${symbol} size=${sizeStr}${clientOrderId ? ` cid=${clientOrderId}` : ""}`);
  const startedAt = Date.now();
  if (clientOrderId) inFlightClientOrders.add(clientOrderId);

  try {
    const res = await request(config.baseUrl, config.apiKey, config.secretKey, config.passphrase, "POST", "/api/v2/spot/trade/place-order", body, 1);
    
    // Verify order response structure
    if (!res || typeof res !== 'object') {
      throw new Error(`Invalid order response: ${JSON.stringify(res)}`);
    }
    
    const orderId = res.orderId || res.order_id;
    if (!orderId) {
      throw new Error(`Order response missing orderId: ${JSON.stringify(res)}`);
    }

    // Parse fill info (Bitget v2 returns: filledQty, priceAvg, state)
    const apiLatencyMs = Date.now() - startedAt;
    const initialStatus = normalizeOrderStatus(res.state || res.status || "UNKNOWN");
    const initialOrder = {
      orderId,
      clientOrderId: res.clientOid || clientOrderId,
      symbol,
      side,
      requestedSize: sizeNum,
      filledSize: Number(res.filledQty || res.filled || res.baseVolume || 0),
      avgPrice: Number(res.priceAvg || res.avgPrice || res.price || 0),
      status: initialStatus,
      raw: res,
      timestamp: Date.now(),
      apiLatencyMs
    };
    const reconciled = await reconcileOrder(symbol, side, sizeNum, initialOrder);
    if (apiLatencyMs > 10000 && reconciled.status !== "FILLED") {
      throw new Error(`Execution latency too high: ${apiLatencyMs}ms`);
    }

    // Invalidate caches so next fetch gets fresh balances/prices
    cachedBalances = null;
    cachedTickers = null;
    cachedPrices = null;

    return reconciled;
  } catch (err) {
    if (clientOrderId) {
      try {
        const recoveredOrder = await getOrder(symbol, { clientOrderId });
        if (recoveredOrder) {
          return await reconcileOrder(symbol, side, sizeNum, recoveredOrder);
        }
      } catch (_) {}
    }
    cachedBalances = null;
    cachedTickers = null;
    cachedPrices = null;
    throw err;
  } finally {
    if (clientOrderId) inFlightClientOrders.delete(clientOrderId);
  }
}

// ================= CORE LOOP =================
async function runBot() {
  if (shutdownRequested) return;
  if (executionKillSwitch) {
    await reportCritical("kill-switch", "🚨 EXECUTION KILL SWITCH ACTIVE\nBot stopped opening new trades due to repeated execution failures.");
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

    // Track data freshness for heartbeat
    let lastDataUpdate = 0;
    let last3mCandleTs = 0;
    let last15mCandleTs = 0;
    let dataFresh = false;

    // Portfolio valuation (total all assets)
    let portfolio = await getPortfolioValue();
    let usdtFree = portfolio.usdtFree;
    let balances = portfolio.balances; // for getCoinBalance etc.
    let currentEquity = portfolio.totalEquity;
    let currentPositionPrice = 0;
    if (state.position) {
      // Get current price for the position coin using portfolio prices or fallback to candles
      currentPositionPrice = getPriceFromBreakdown(state.position.symbol, balances, portfolio.breakdown);
      if (!currentPositionPrice || currentPositionPrice <= 0) {
        const pCandles = await getCandles(state.position.symbol, config.signalTimeframe);
        if (pCandles?.length) {
          currentPositionPrice = extractLastClosedPrice(pCandles);
        }
      }
    }

    // Daily reset
    if (state.date !== today) {
      state.date = today;
      state.tradesToday = 0;
      state.lossStreak = 0;
      state.haltedForDay = false;
      state.haltReason = null;
      state.startOfDayEquity = currentEquity;
      state.realizedPnlToday = 0;
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

    // Realized daily PnL (only from closed trades)
    const realizedPnlPct = state.startOfDayEquity > 0 ? state.realizedPnlToday / state.startOfDayEquity : 0;

    // Daily halt checks â€“ based on realized PnL only
    if (realizedPnlPct >= config.dailyProfitTargetPct) {
      state.haltedForDay = true;
      state.haltReason = `Daily profit target reached (+${safeToFixed(realizedPnlPct*100)}%)`;
      saveState(STATE_PATH, state);
      logEvent(LOG_FILE, "INFO", "Halted: " + state.haltReason);
    }
    if (realizedPnlPct <= config.dailyLossLimitPct) {
      state.haltedForDay = true;
      state.haltReason = `Daily loss limit hit (${safeToFixed(realizedPnlPct*100)}%)`;
      saveState(STATE_PATH, state);
      logEvent(LOG_FILE, "INFO", "Halted: " + state.haltReason);
    }

    // ===== POSITION RECOVERY (if state.position missing but balance has coin) =====
    if (!state.position && cachedPrices) {
      const recovered = detectOpenPositionFromBalance({
        balances,
        priceMap: cachedPrices,
        config,
        now,
        logger: message => logEvent(LOG_FILE, "DEBUG", message)
      });
      if (recovered) {
        logEvent(LOG_FILE, "INFO", `Position recovered | ${recovered.symbol} est=${safeToFixed(recovered.sizeUSDT)} USDT`);
        state.positions = [recovered];
        state.position = recovered;
        // Update global position variable too (used in current loop)
        position = recovered;
        // Recompute currentPositionPrice from fresh data
        currentPositionPrice = getPriceFromBreakdown(recovered.symbol, balances, portfolio.breakdown);
        if (!currentPositionPrice || currentPositionPrice <= 0) {
          const pCandles = await getCandles(recovered.symbol, config.signalTimeframe);
          if (pCandles?.length) {
            currentPositionPrice = extractLastClosedPrice(pCandles);
          }
        }
        // Attach currentPrice to recovered position for reporting
        recovered.currentPrice = currentPositionPrice;
        state.positions = [recovered];
        state.position = recovered;
        position = recovered;
        saveState(STATE_PATH, state);
        
        // Log recovery entry
        logTrade({
          type: 'entry',
          source: 'recovery',
          botType: config.activeBotType || config.selectedBotType || "",
          mode: config.activeMode || config.selectedMode || "",
          marketProfile: scanConfig.activeMarketProfile || config.selectedMarketProfile || "",
          marketProfileMode: config.marketProfileMode || "",
          pair: recovered.symbol,
          side: 'buy',
          price: recovered.entry,
          qty: recovered.qty,
          sizeUSDT: recovered.sizeUSDT,
          reason: 'balance detection'
          // entry_rsi etc not available, left blank
        });
        
        // Throttle recovery Telegram messages (max every 5 min or different symbol)
        const now = Date.now();
        const lastRecoveryTime = state.lastRecoveryTime || 0;
        const lastRecoverySymbol = state.lastRecoverySymbol;
        const shouldReportRecovery = !lastRecoverySymbol || 
                                    lastRecoverySymbol !== recovered.symbol ||
                                    now - lastRecoveryTime > 5 * 60 * 1000; // 5 minutes
        if (shouldReportRecovery) {
          await report(`âš ï¸ POSITION RECOVERED\nPair: ${recovered.symbol}\nEstimated Entry: ${safeToFixed(recovered.entry)}\nValue: ${safeToFixed(recovered.sizeUSDT)} USDT\n\nBot detected an existing position from balance.`);
          state.lastRecoveryTime = now;
          state.lastRecoverySymbol = recovered.symbol;
          saveState(STATE_PATH, state);
        } else {
          logEvent(LOG_FILE, "DEBUG", `Recovery message suppressed | last=${lastRecoverySymbol}`);
        }
      }
    }



    // Validate positions (dust/zero) per symbol, not as a single global position.
    const trackedPositions = getOpenPositions(state);
    if (trackedPositions.length) {
      const portfolioNow = await getPortfolioValue();
      const minManagedPositionUSDT = config.minManagedPositionUSDT ?? config.minHoldUSDT;
      const tickersForValidation = await getTickersCached();
      let positionsChanged = false;
      const nextPositions = [];

      for (const openPosition of trackedPositions) {
        const symbol = openPosition?.symbol;
        if (!symbol) continue;
        const coin = symbol.replace("USDT", "").toLowerCase();
        const coinBal = portfolioNow.balances[coin] || 0;

        if (coinBal <= 0) {
          logEvent(LOG_FILE, "INFO", `Position vanished for ${symbol}, removing from managed positions`);
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
          logEvent(LOG_FILE, "WARN", `No price for ${coin} (balance=${coinBal}), fetching candles`);
          const pCandles = await getCandles(symbol, config.signalTimeframe);
          if (pCandles?.length) price = extractLastClosedPrice(pCandles);
        }

        const value = coinBal * price;
        if (value < minManagedPositionUSDT) {
          logEvent(LOG_FILE, "INFO", `Position ${symbol} value < ${minManagedPositionUSDT}, removing from managed positions`);
          positionsChanged = true;
          delete state.lastReportedPnlBySymbol[symbol];
          continue;
        }

        nextPositions.push({
          ...openPosition,
          qty: coinBal,
          sizeUSDT: value > 0 ? value : openPosition.sizeUSDT
        });
      }

      if (positionsChanged) {
        state.positions = nextPositions;
        state.position = nextPositions[0] || null;
        position = state.position;
        saveState(STATE_PATH, state);
      }
    }

    // Entry throttles should not suppress monitoring/reporting.
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
      entryGateStatus = `loss streak halt (${state.lossStreak})`;
    } else if (entryBlockedByDailyTradeLimit) {
      entryGateStatus = `daily round limit reached (${state.tradesToday}/${config.maxRoundsPerDay})`;
    } else if (entryBlockedByCooldown) {
      entryGateStatus = `cooldown active (${Math.max(1, Math.ceil((state.lastTradeTime - now) / 60000))}m left)`;
    } else if (entryBlockedByPositionSlots) {
      entryGateStatus = `position slots full (${openPositionsBeforeEntry.length}/${maxOpenPositions})`;
    } else if (entryBlockedByExposureCap) {
      entryGateStatus = `exposure cap reached (${safeToFixed(currentExposureUsdt, 2)}/${safeToFixed(exposureCapUsdt, 2)} USDT)`;
    }

    // ===== SCANNING =====
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

    if (state.position || !getLatestCandleTs(config.signalTimeframe)) {
      await primeSignalCandlesForAllPairs(config.signalTimeframe, 2);
    }

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

    // Update data freshness timestamps after scanning (uses getCandles)
    lastDataUpdate = Date.now();
    last3mCandleTs = getLatestCandleTs(config.signalTimeframe);
    last15mCandleTs = getLatestCandleTs(config.trendTimeframe);
    dataFresh =
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
      await reportCritical(
        "stale-data",
        `⚠️ DATA STALE\nSignal ${config.signalTimeframe || "3min"}: ${last3mCandleTs ? new Date(last3mCandleTs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" }) : "n/a"}\nTrend ${config.trendTimeframe || "15min"}: ${last15mCandleTs ? new Date(last15mCandleTs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" }) : "n/a"}\nMarket mode: ${marketMode || "unknown"}`,
        20 * 60 * 1000
      );
    }

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

    // ===== FORCE EXIT SAFETY: auto-sell unmanaged coins =====
    const managedSymbols = new Set(getOpenPositions(state).map(pos => pos.symbol));
    for (const [coin, qty] of Object.entries(balances)) {
        if (coin === 'usdt') continue;
        if (qty && qty > 0) {
          const symbol = coin.toUpperCase() + 'USDT';
          if (managedSymbols.has(symbol)) continue;
          const price = cachedPrices?.[coin] || 0;
          if (price > 0) {
            const value = qty * price;
            const minManagedPositionUSDT = config.minManagedPositionUSDT ?? config.minHoldUSDT;
            if (value >= minManagedPositionUSDT) {
              // This coin should have been managed; auto-sell as safety
              const autoSellResult = await safeExecute(async () => {
                return await placeOrder(symbol, 'sell', qty);
              });
              
              if (autoSellResult.success) {
                const filledQty = Number(autoSellResult.result?.filledSize || qty || 0);
                const avgPrice = Number(autoSellResult.result?.avgPrice || price || 0);
                const exitSizeUSDT = filledQty > 0 && avgPrice > 0 ? filledQty * avgPrice : value;
                logTrade({
                  timestamp: new Date().toISOString(),
                  type: "exit",
                  source: "auto-sell-unmanaged",
                  pair: symbol,
                  symbol,
                  side: "sell",
                  price: avgPrice || price,
                  qty: filledQty || qty,
                  sizeUSDT: exitSizeUSDT,
                  reason: "Auto-sell unmanaged asset",
                  exit_reason: "Auto-sell unmanaged asset",
                  exit_rsi: null,
                  PnL: null,
                  PnL_pct: null,
                  netPnlEstPct: null,
                  peakPnlPct: null,
                  drawdownFromPeak: null
                });
                await report(`ðŸš¨ AUTO-SELL UNMANAGED\nPair: ${symbol}\nQty: ${qty}\nValue: ${safeToFixed(value)} USDT\n\nBot detected unmanaged asset and auto-liquidated.`);
                return; // exit loop to let portfolio refresh
              } else {
                logEvent(LOG_FILE, "ERROR", `Auto-sell failed for ${symbol}: ${autoSellResult.error?.message || 'blocked'}`);
                // Continue to let portfolio refresh anyway
              }
            }
          }
        }
      }

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

    // ===== ENTRY SCAN =====
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
}

// ================= CONFIG NORMALIZATION =================
function normalizeConfig() {
  const clampNum = (value, min, max, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };

  const rawRisk = clampNum(config.riskPercent, 0.01, 0.2, 0.15);
  const rawFee = clampNum(config.roundTripFeePct, 0, 0.01, 0.004);
  const rawSlippage = clampNum(config.slippageBufferPct, 0, 0.005, 0.001);
  const baseCooldown = clampNum(config.cooldownMs, 60000, 3600000, 300000);
  const rawMinExpectedNet = clampNum(config.minExpectedNetPct, 0, 0.03, 0.003);
  const rawTakeProfit = clampNum(config.takeProfitPct, 0.001, 0.2, 0.012);
  const rawTrailingActivation = clampNum(config.trailingActivationPct, 0.001, 0.2, 0.008);
  const rawBreakEvenArmed = clampNum(config.breakEvenArmedPct, 0.0005, 0.2, 0.006);
  const totalCostPct = rawFee + rawSlippage;
  const minNetBufferPct = Math.max(rawMinExpectedNet, 0.001);

  let effectiveCooldown = baseCooldown;
  if (rawRisk >= 0.15) effectiveCooldown = Math.max(baseCooldown, 600000);
  else if (rawRisk >= 0.1) effectiveCooldown = Math.max(baseCooldown, 300000);
  else effectiveCooldown = Math.max(baseCooldown, 180000);

  const effectiveTakeProfit = Math.max(rawTakeProfit, totalCostPct + minNetBufferPct);
  let effectiveBreakEvenArmed = Math.max(rawBreakEvenArmed, totalCostPct + 0.0005);
  let effectiveTrailingActivation = Math.max(rawTrailingActivation, effectiveBreakEvenArmed + 0.0005);
  if (effectiveTrailingActivation >= effectiveTakeProfit) {
    effectiveTrailingActivation = Math.max(effectiveBreakEvenArmed + 0.0003, effectiveTakeProfit * 0.8);
  }
  if (effectiveBreakEvenArmed >= effectiveTrailingActivation) {
    effectiveBreakEvenArmed = Math.max(totalCostPct + 0.0005, effectiveTrailingActivation - 0.0005);
  }

  config._effectiveRisk = rawRisk;
  config._effectiveCooldown = effectiveCooldown;
  config._effectiveSlippageBufferPct = rawSlippage;
  config._effectiveRoundTripFeePct = rawFee;
  config._effectiveMinExpectedNetPct = rawMinExpectedNet;
  config._effectiveTakeProfitPct = effectiveTakeProfit;
  config._effectiveTrailingActivationPct = effectiveTrailingActivation;
  config._effectiveBreakEvenArmedPct = effectiveBreakEvenArmed;
  config._effectiveCostPct = totalCostPct;
  const maxRoundsPerDay = Number.isFinite(config.maxRoundsPerDay) ? config.maxRoundsPerDay : config.maxTradesPerDay;
  config._effectiveMaxTrades = Number.isFinite(maxRoundsPerDay) ? maxRoundsPerDay : 20;
  config.maxRoundsPerDay = config._effectiveMaxTrades;
  config.maxTradesPerDay = config._effectiveMaxTrades;

  const mode = config.activeMode || config.selectedMode || 'normal';
  if (mode === 'conservative') {
    if (config.requireEdge === undefined) config.requireEdge = true;
    if (config.minConfirmation === undefined) config.minConfirmation = 4;
  } else if (mode === 'aggressive' || mode === 'hyper') {
    if (config.requireEdge === undefined) config.requireEdge = false;
    if (config.minConfirmation === undefined) config.minConfirmation = 3;
    config._effectiveRisk = Math.min(config._effectiveRisk, 0.2);
    config._effectiveMaxTrades = Math.min(config._effectiveMaxTrades, 999);
  }
  // 'normal' and 'range_scalp' keep their current overrides

  // 6. Market profile allowEntries: respect dashboard but guard bearish/choppy
  config._effectiveAllowEntries = true; // default
  const profileKey = config.selectedMarketProfile || 'auto';
  if (profileKey !== 'auto') {
    const mp = config.marketProfiles?.[profileKey];
    if (mp) {
      const bearishProfiles = ['bearish', 'choppy'];
      if (bearishProfiles.includes(profileKey)) {
        config._effectiveAllowEntries = false;
      } else {
        config._effectiveAllowEntries = mp.allowEntries !== false;
      }
    }
  } else {
    // auto mode: will be determined after market detection (in applyMarketProfile)
    // Default to true; actual value set later based on activeMarketProfile
    config._effectiveAllowEntries = true;
  }

  // 7. Sanity check numeric fields (NaN/Infinity guard)
  const numericFields = [
    'minBuyUSDT', 'maxBuyUSDT', 'reserveUSDT',
    'minManagedPositionUSDT', 'minRecoverUSDT',
    'takeProfitPct', 'trailingActivationPct', 'trailingDrawdownPct',
    'trailingProtectionPct', 'exitRSIThreshold',
    'minExpectedNetPct', 'minScalpTargetPct', 'maxScalpTargetPct',
    'minAtrPct', 'maxAtrPct', 'minTrendRsi', 'minVolumeRatio', 'maxEmaGapPct',
    'minCandleStrength', 'breakoutPct', 'maxOpenPositions', 'exposureCapPct'
  ];
  for (const field of numericFields) {
    if (config[field] !== undefined) {
      const val = Number(config[field]);
      if (!isFinite(val) || isNaN(val)) {
        console.warn(`[SAFETY] Invalid ${field}=${config[field]}, using fallback`);
        // Fallbacks
        if (field.includes('Pct')) config[field] = 0.01;
        else if (field.includes('USDT')) config[field] = 5;
        else config[field] = 1;
      }
    }
  }
}

// ================= LOOP =================
async function startBot() {
  const choices = getModeChoices();
  const botTypeChoices = Object.keys(config.botTypeProfiles || {});
  const selectedBotType = config.selectedBotType || botTypeChoices[0] || "scalp_trend";
  const selectedMode = config.selectedMode || choices[1]?.key || choices[0]?.key || "normal";
  const selectedMarketProfile = config.selectedMarketProfile || "auto";
  printBanner(selectedBotType, selectedMode, selectedMarketProfile, config.marketProfileMode || "auto");
  setupKeyboardShortcuts();
  process.on("SIGINT", () => requestSafeExit("signal:SIGINT"));
  process.on("SIGTERM", () => requestSafeExit("signal:SIGTERM"));
  const selectionValidation = validateConfig(config, {
    botTypeKey: selectedBotType,
    modeKey: selectedMode,
    marketProfileKey: selectedMarketProfile
  });
  if (!selectionValidation.ok) {
    for (const issue of selectionValidation.issues) {
      console.error(`[CONFIG ERROR] ${issue}`);
    }
    process.exit(1);
  }
  const engineValidation = validateEngineFiles(path.resolve(__dirname, ".."));
  if (!engineValidation.ok) {
    for (const issue of engineValidation.issues) {
      console.error(`[ENGINE ERROR] ${issue}`);
    }
    process.exit(1);
  }
  applySelectedBotType(selectedBotType);
  applySelectedMode(selectedMode);
  normalizeConfig(); // Apply safety and derived values
  await animateValidationStage(0, 0.2, "checking selected bot type, mode, and market profile", 1000);
  await animateValidationStage(0.2, 0.4, "checking engine files and runtime directories", 1000);
  await animateValidationStage(0.4, 0.6, "applying entry style overrides", 1000);
  await animateValidationStage(0.6, 0.8, "applying risk and exit style overrides", 1000);

  const startupValidation = validateConfig(config, {
    botTypeKey: config.activeBotType || selectedBotType,
    modeKey: config.activeMode || selectedMode,
    marketProfileKey: selectedMarketProfile
  });
  if (startupValidation.warnings.length) {
    for (const warning of startupValidation.warnings) {
      console.warn(`[CONFIG WARN] ${warning}`);
    }
  }
  if (!startupValidation.ok) {
    for (const issue of startupValidation.issues) {
      console.error(`[CONFIG ERROR] ${issue}`);
    }
    process.exit(1);
  }
  await animateValidationStage(0.8, 1, "checking ranges, intervals, and config conflicts", 1000);
  printValidationPassed();
  await initScales();
  await runBot();
  loopTimer = setInterval(runBot, config.loopIntervalMs);
}

startBot().catch(err => {
  logEvent(LOG_FILE, "ERROR", `Failed to start bot: ${err.message}`);
  process.exit(1);
});
