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
const { getAiAgentSettings, runAiAgentAfterRotation } = require("./aiAgent");
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

function buildPersistedConfigSnapshot(currentConfig) {
  const snapshot = JSON.parse(JSON.stringify(currentConfig || {}));
  delete snapshot.apiKey;
  delete snapshot.secretKey;
  delete snapshot.passphrase;
  delete snapshot.pairs;
  delete snapshot.baseCoins;
  delete snapshot.runtimePairSource;
  if (snapshot.telegram) {
    delete snapshot.telegram.botToken;
    delete snapshot.telegram.chatId;
  }
  return snapshot;
}

function persistConfigSnapshot() {
  saveJsonFile(CONFIG_PATH, buildPersistedConfigSnapshot(config));
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

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeFeeCoin(value) {
  if (!value) return null;
  return String(value).replace(/[^a-z0-9]/gi, "").toUpperCase() || null;
}

function splitSpotSymbol(symbol) {
  const normalized = String(symbol || "").toUpperCase();
  if (normalized.endsWith("USDT")) {
    return {
      baseCoin: normalized.replace(/USDT$/i, ""),
      quoteCoin: "USDT"
    };
  }
  return {
    baseCoin: normalized,
    quoteCoin: null
  };
}

function inferFeeCoinFromSide(symbol, side) {
  const { baseCoin, quoteCoin } = splitSpotSymbol(symbol);
  const normalizedSide = String(side || "").toLowerCase();
  if (normalizedSide === "buy") return baseCoin || null;
  if (normalizedSide === "sell") return quoteCoin || baseCoin || null;
  return quoteCoin || baseCoin || null;
}

function convertFeeToUsdt(symbol, feeAmount, feeCoin, avgPrice) {
  const amount = toFiniteNumber(feeAmount);
  const coin = normalizeFeeCoin(feeCoin);
  if (!Number.isFinite(amount) || amount < 0) return null;
  if (!coin) return null;
  const baseCoin = String(symbol || "").replace(/USDT$/i, "").toUpperCase();
  if (coin === "USDT") return amount;
  if (coin === baseCoin && Number.isFinite(avgPrice) && avgPrice > 0) {
    return amount * avgPrice;
  }
  return null;
}

function parseOrderFee(raw, symbol, avgPrice = 0) {
  if (!raw || typeof raw !== "object") {
    return { feeAmount: null, feeCoin: null, feeUSDT: null };
  }
  const inferredFeeCoin = inferFeeCoinFromSide(symbol, raw.side);

  let feeAmount = toFiniteNumber(
    raw.fillFee ??
    raw.fee ??
    raw.fillFeeAmount ??
    raw.totalFee ??
    raw.baseFee
  );
  let feeCoin = normalizeFeeCoin(
    raw.fillFeeCoin ||
    raw.feeCoin ||
    raw.feeCcy ||
    raw.feeCurrency ||
    raw.fillFeeCoinCode ||
    raw.chargeFeeCoin
  );

  if ((!Number.isFinite(feeAmount) || !feeCoin) && raw.feeDetail) {
    let feeDetail = raw.feeDetail;
    if (typeof feeDetail === "string") {
      try {
        feeDetail = JSON.parse(feeDetail);
      } catch (_) {
        feeDetail = null;
      }
    }

    if (feeDetail && typeof feeDetail === "object") {
      const directAmount = toFiniteNumber(
        feeDetail.totalFee ??
        feeDetail.fee ??
        feeDetail.fillFee
      );
      const directCoin = normalizeFeeCoin(
        feeDetail.feeCoin ||
        feeDetail.coin ||
        feeDetail.currency ||
        feeDetail.feeCcy
      );

      if (Number.isFinite(directAmount) && directCoin) {
        feeAmount = directAmount;
        feeCoin = directCoin;
      } else if (feeDetail.newFees && typeof feeDetail.newFees === "object") {
        const nf = feeDetail.newFees;
        const parsedAmount = toFiniteNumber(nf.t ?? nf.totalFee ?? nf.r ?? nf.c);
        if (Number.isFinite(parsedAmount)) {
          feeAmount = parsedAmount;
          feeCoin = inferredFeeCoin;
        }
      } else {
        const pools = [
          feeDetail.fees,
          feeDetail.data
        ];
        for (const pool of pools) {
          if (!pool || typeof pool !== "object") continue;
          const entries = Object.entries(pool);
          if (!entries.length) continue;
          const [coinKey, amountVal] = entries[0];
          const parsedAmount = toFiniteNumber(amountVal);
          const parsedCoin = normalizeFeeCoin(coinKey);
          if (Number.isFinite(parsedAmount) && parsedCoin) {
            feeAmount = parsedAmount;
            feeCoin = parsedCoin;
            break;
          }
        }
      }
    }
  }

  if (Number.isFinite(feeAmount) && !feeCoin) {
    feeCoin = inferredFeeCoin;
  }

  if (Number.isFinite(feeAmount)) {
    feeAmount = Math.abs(feeAmount);
  }

  const feeUSDT = convertFeeToUsdt(symbol, feeAmount, feeCoin, avgPrice);
  return {
    feeAmount: Number.isFinite(feeAmount) ? feeAmount : null,
    feeCoin: feeCoin || null,
    feeUSDT: Number.isFinite(feeUSDT) ? feeUSDT : null
  };
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

  const avgPrice = Number(row.priceAvg || row.avgPrice || row.fillPrice || row.price || 0);
  const feeMeta = parseOrderFee(row, symbol, avgPrice);

  return {
    orderId: row.orderId || row.order_id || orderId || null,
    clientOrderId: row.clientOid || row.clientOrderId || clientOrderId || null,
    symbol: row.symbol || symbol,
    side: String(row.side || "").toLowerCase(),
    requestedSize: Number(row.size || row.quantity || 0),
    filledSize: Number(row.baseVolume || row.filledQty || row.filledQuantity || row.dealSize || 0),
    avgPrice,
    feeAmount: feeMeta.feeAmount,
    feeCoin: feeMeta.feeCoin,
    feeUSDT: feeMeta.feeUSDT,
    status: normalizeOrderStatus(row.state || row.status),
    raw: row,
    timestamp: Date.now()
  };
}

/**
 * Fetch individual fill records for an order from Bitget v2.
 * Returns VWAP avgPrice and aggregated fee computed from all fills.
 * Used as fallback when orderInfo returns avgPrice=0 for a FILLED order.
 */
async function getOrderFills(symbol, orderId) {
  const params = new URLSearchParams({ symbol, orderId });
  let res;
  try {
    res = await request(
      config.baseUrl,
      config.apiKey,
      config.secretKey,
      config.passphrase,
      "GET",
      `/api/v2/spot/trade/fills?${params.toString()}`,
      null,
      1
    );
  } catch (err) {
    logEvent(LOG_FILE, "WARN", `getOrderFills failed for ${symbol}/${orderId}: ${err.message}`);
    return { avgPrice: null, feeAmount: null, feeCoin: null, feeUSDT: null };
  }

  // Bitget v2 wraps fills in fillList or returns array directly
  const list = Array.isArray(res)
    ? res
    : (Array.isArray(res?.fillList) ? res.fillList
      : (Array.isArray(res?.data) ? res.data : []));

  if (!list.length) {
    return { avgPrice: null, feeAmount: null, feeCoin: null, feeUSDT: null };
  }

  // Compute VWAP from individual fill legs
  let totalQty = 0;
  let totalVal = 0;
  let totalFeeAmount = 0;
  let fillFeeCoin = null;
  for (const f of list) {
    const fPrice = Number(f.price || f.fillPrice || 0);
    const fQty   = Number(f.size  || f.fillSize  || f.qty || 0);
    const fFee   = Math.abs(Number(f.fee || f.fillFee || 0));
    if (fPrice > 0 && fQty > 0) {
      totalQty += fQty;
      totalVal += fPrice * fQty;
      totalFeeAmount += fFee;
      if (!fillFeeCoin) fillFeeCoin = normalizeFeeCoin(f.feeCoin || f.fillFeeCoin);
    }
  }

  if (totalQty <= 0) {
    return { avgPrice: null, feeAmount: null, feeCoin: null, feeUSDT: null };
  }

  const avgPrice  = totalVal / totalQty;
  const feeAmount = totalFeeAmount > 0 ? totalFeeAmount : null;
  const feeCoin   = fillFeeCoin || null;
  const feeUSDT   = convertFeeToUsdt(symbol, feeAmount, feeCoin, avgPrice);
  return { avgPrice, feeAmount, feeCoin, feeUSDT };
}

async function reconcileOrder(symbol, side, requestedSize, orderMeta) {
  const startedAt = Date.now();
  let latest = orderMeta;

  // Poll strategy: first attempt immediately (market orders fill in <500ms on Bitget),
  // then backoff. Total max wait: ~2.7s vs old 3.6s, and usually resolves at attempt 0.
  const delays = [0, 400, 800, 1500];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    const status = normalizeOrderStatus(latest?.status);
    if (isTerminalOrderStatus(status)) break;
    if (delays[attempt] > 0) await sleep(delays[attempt]);
    const fetched = await getOrder(symbol, {
      orderId: latest?.orderId,
      clientOrderId: latest?.clientOrderId
    });
    if (fetched) latest = { ...latest, ...fetched };
  }

  const status    = normalizeOrderStatus(latest?.status);
  const filledSize = Number(latest?.filledSize || 0);
  let avgPrice    = Number(latest?.avgPrice || 0);
  let feeAmount   = toFiniteNumber(latest?.feeAmount);
  let feeCoin     = normalizeFeeCoin(latest?.feeCoin);
  let feeUSDT     = toFiniteNumber(latest?.feeUSDT);
  let fillsUsed   = false;

  // Fallback: orderInfo sometimes returns avgPrice=0 even on FILLED orders.
  // Query /fills endpoint for VWAP-accurate price and fee from individual legs.
  if (status === "FILLED" && (!Number.isFinite(avgPrice) || avgPrice <= 0) && latest?.orderId) {
    const fills = await getOrderFills(symbol, latest.orderId);
    if (Number.isFinite(fills.avgPrice) && fills.avgPrice > 0) {
      avgPrice  = fills.avgPrice;
      fillsUsed = true;
      logEvent(LOG_FILE, "INFO", `reconcile ${symbol}: avgPrice from /fills VWAP=${safeToFixed(avgPrice, 6)} (orderInfo returned 0)`);
      // Prefer fills fee data if orderInfo fee is also missing
      if (!Number.isFinite(feeAmount) || feeAmount <= 0) {
        feeAmount = fills.feeAmount;
        feeCoin   = fills.feeCoin;
        feeUSDT   = fills.feeUSDT;
      }
    }
  }

  if (status === "REJECTED" || status === "CANCELED") {
    throw new Error(`Order ${status.toLowerCase()}: ${symbol} ${side}`);
  }
  if (status === "OPEN" || status === "UNKNOWN") {
    throw new Error(`Order not finalized: ${symbol} ${side} status=${status}`);
  }
  if (!Number.isFinite(filledSize) || filledSize <= 0) {
    throw new Error(`Order returned no filled size: ${symbol} ${side} status=${status}`);
  }

  const reconcileLatencyMs = Date.now() - startedAt;
  logEvent(LOG_FILE, "DEBUG",
    `reconcile ${symbol} done: status=${status} avgPrice=${safeToFixed(avgPrice,6)} ` +
    `fee=${safeToFixed(feeUSDT,6)}USDT latency=${reconcileLatencyMs}ms fills=${fillsUsed}`);

  return {
    ...latest,
    status,
    requestedSize,
    filledSize,
    avgPrice,
    feeAmount,
    feeCoin,
    feeUSDT,
    fillsUsed,
    partialFill: filledSize > 0 && filledSize + 1e-12 < requestedSize,
    reconcileLatencyMs
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
  config.usePairReentryBlock = config.usePairReentryBlock !== false;
  config.pairReentryBlockLossPct = clampNum(config.pairReentryBlockLossPct, 0.001, 0.2, 0.01);
  config.pairReentryBlockMinutes = Math.max(1, Math.min(1440, Math.floor(Number(config.pairReentryBlockMinutes) || 10)));
  config.usePairReentryBlock = config.usePairReentryBlock !== false;
  config.pairReentryBlockLossPct = clampNum(config.pairReentryBlockLossPct, 0.001, 0.2, 0.01);
  config.pairReentryBlockMinutes = Math.max(1, Math.min(1440, Math.floor(Number(config.pairReentryBlockMinutes) || 10)));
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
    'minCandleStrength', 'breakoutPct', 'maxOpenPositions', 'exposureCapPct',
    'pairReentryBlockLossPct', 'pairReentryBlockMinutes', 'holdCheckIntervalMs'
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
  if (!nextState.entryBlockBySymbol || typeof nextState.entryBlockBySymbol !== "object") {
    nextState.entryBlockBySymbol = {};
  }
  if (!nextState.recentEntriesBySymbol || typeof nextState.recentEntriesBySymbol !== "object") {
    nextState.recentEntriesBySymbol = {};
  }
  return positions;
}

function cleanupExpiredEntryBlocks(nextState, now = Date.now()) {
  if (!nextState || typeof nextState !== "object") return false;
  if (!nextState.entryBlockBySymbol || typeof nextState.entryBlockBySymbol !== "object") {
    nextState.entryBlockBySymbol = {};
    return false;
  }
  let changed = false;
  for (const [symbol, meta] of Object.entries(nextState.entryBlockBySymbol)) {
    const until = Number(meta?.until || 0);
    if (!symbol || !Number.isFinite(until) || until <= now) {
      delete nextState.entryBlockBySymbol[symbol];
      changed = true;
    }
  }
  return changed;
}

function getActiveEntryBlock(nextState, symbol, now = Date.now()) {
  const key = String(symbol || "").toUpperCase();
  if (!key) return null;
  const meta = nextState?.entryBlockBySymbol?.[key];
  if (!meta) return null;
  const until = Number(meta.until || 0);
  if (!Number.isFinite(until) || until <= now) return null;
  return meta;
}

function cleanupRecentEntries(nextState, now = Date.now(), ttlMs = 10 * 60 * 1000) {
  if (!nextState || typeof nextState !== "object") return false;
  if (!nextState.recentEntriesBySymbol || typeof nextState.recentEntriesBySymbol !== "object") {
    nextState.recentEntriesBySymbol = {};
    return false;
  }
  let changed = false;
  for (const [symbol, meta] of Object.entries(nextState.recentEntriesBySymbol)) {
    const at = Number(meta?.at || 0);
    if (!symbol || !Number.isFinite(at) || (now - at) > ttlMs) {
      delete nextState.recentEntriesBySymbol[symbol];
      changed = true;
    }
  }
  return changed;
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

function getStartupMarketProfileLabel() {
  const profileKey = config.selectedMarketProfile || "auto";
  if (profileKey === "auto") return "Auto";
  const profile = config.marketProfiles?.[profileKey];
  return profile?.label || profileKey;
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
  console.log(`Profile aktif: ${getStartupMarketProfileLabel()}`);
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
  const aiDecision = config.aiAgent?.lastDecision;
  if (getAiAgentSettings(config).enabled && aiDecision?.status === "applied" && config.marketProfiles?.[aiDecision.marketProfile]) {
    return aiDecision.marketProfile;
  }

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
if (state.realizedNetPnlToday === undefined) state.realizedNetPnlToday = 0;
if (state.lastReportedPnlBySymbol === undefined) state.lastReportedPnlBySymbol = {};
if (state.entryBlockBySymbol === undefined || typeof state.entryBlockBySymbol !== "object") state.entryBlockBySymbol = {};
if (state.recentEntriesBySymbol === undefined || typeof state.recentEntriesBySymbol !== "object") state.recentEntriesBySymbol = {};

// Globals
let lastHeartbeatTime = 0, lastMarketReportTime = 0, lastBalanceReportTime = 0, lastHoldReportTime = 0, lastNoSignalReportTime = 0;
let lastBalanceFetchTime = 0;
let cachedBalances = null;
let lastPriceFetchTime = 0;
let cachedPrices = null;
let position = state.position;
let loopTimer = null;
let holdLoopTimer = null;
let loopInProgress = false;
let holdLoopInProgress = false;
let shutdownRequested = false;
let shutdownInProgress = false;
let shutdownExitCode = 0;
const alertTimestamps = {};
const unlistedCoinsCache = new Set();
const jobLocks = {
  market: false,
  reports: false,
  hold: false,
  rotation: false
};

async function withJobLock(jobName, fn, busyMessage = null) {
  if (jobLocks[jobName]) {
    if (busyMessage) {
      logEvent(LOG_FILE, "DEBUG", busyMessage);
    }
    return { skipped: true };
  }
  jobLocks[jobName] = true;
  try {
    const result = await fn();
    return { skipped: false, result };
  } finally {
    jobLocks[jobName] = false;
  }
}

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
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  if (holdLoopTimer) {
    clearTimeout(holdLoopTimer);
    holdLoopTimer = null;
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
  process.exit(shutdownExitCode);
}

function requestSafeExit(source = "manual", exitCode = 0) {
  if (Number.isInteger(exitCode) && exitCode !== 0) {
    shutdownExitCode = exitCode;
  }
  if (shutdownRequested) return;
  shutdownRequested = true;

  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  if (holdLoopTimer) {
    clearTimeout(holdLoopTimer);
    holdLoopTimer = null;
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
function describeTelegramError(err, context = {}) {
  const parts = [];
  if (context.status) parts.push(`status=${context.status}`);
  if (context.statusText) parts.push(`statusText=${context.statusText}`);
  if (context.description) parts.push(`description=${context.description}`);
  if (context.errorCode) parts.push(`errorCode=${context.errorCode}`);

  const causeCode = err?.cause?.code || err?.code;
  const causeMessage = err?.cause?.message;
  if (causeCode) parts.push(`code=${causeCode}`);
  if (err?.name) parts.push(`name=${err.name}`);
  if (err?.message) parts.push(`message=${err.message}`);
  if (causeMessage && causeMessage !== err?.message) parts.push(`cause=${causeMessage}`);

  return parts.filter(Boolean).join(" | ") || "unknown error";
}

async function report(msg) {
  logEvent(LOG_FILE, "REPORT", msg);
  const botToken = config.telegram?.botToken;
  const chatId = config.telegram?.chatId;
  if (!botToken || !chatId) return false;

  const escapedMsg = String(msg)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let timer = null;
    try {
      const controller = new AbortController();
      const timeoutMs = Number(config.telegram?.timeoutMs) > 0 ? Number(config.telegram.timeoutMs) : 15000;
      timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          chat_id: chatId,
          text: `<pre>${escapedMsg}</pre>`,
          parse_mode: "HTML",
          disable_web_page_preview: true
        })
      });
      clearTimeout(timer);
      timer = null;

      let data = null;
      try {
        data = await res.json();
      } catch (parseErr) {
        throw new Error(`telegram response parse failed: ${parseErr.message}`);
      }
      if (!res.ok || !data?.ok) {
        const error = new Error("telegram api rejected message");
        error.context = {
          status: res.status,
          statusText: res.statusText,
          description: data?.description,
          errorCode: data?.error_code
        };
        throw error;
      }

      if (attempt > 1) logEvent(LOG_FILE, "PASS", `Telegram send recovered on attempt ${attempt}/${maxAttempts}`);
      return true;
    } catch (err) {
      const detail = describeTelegramError(err, err?.context);
      if (attempt < maxAttempts) {
        logEvent(LOG_FILE, "WARN", `Telegram send attempt ${attempt}/${maxAttempts} failed: ${detail}`);
        await sleep(1000 * attempt);
      } else {
        logEvent(LOG_FILE, "ERROR", `Telegram send failed after ${maxAttempts} attempts: ${detail}`);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return false;
}

function shouldReport(intervalMs, lastTime) {
  return Date.now() - lastTime >= intervalMs;
}

function estimateNetPnlPct(grossPnlFraction, options = {}) {
  const grossPct = Number(grossPnlFraction) * 100;
  const feePct = Number(config.roundTripFeePct || 0) * 100;
  const slippagePct = Number.isFinite(options.actualSlippagePct)
    ? Number(options.actualSlippagePct) * 100
    : Number(config.slippageBufferPct || 0) * 100;
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

function extractTickerQuoteVolume(ticker) {
  const candidates = [
    ticker?.quoteVol,
    ticker?.quoteVolume,
    ticker?.usdtVolume,
    ticker?.turnover,
    ticker?.amount,
    ticker?.volumeUsd,
    ticker?.volCcy24h,
    ticker?.quoteVolume24h,
    ticker?.turnover24h,
    ticker?.quoteTurnover,
    ticker?.baseVolume
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function extractTickerChangePct(ticker) {
  const candidates = [
    ticker?.changeUtc24h,
    ticker?.change24h,
    ticker?.priceChangePercent,
    ticker?.priceChangePct,
    ticker?.chgUtc,
    ticker?.riseFallRate,
    ticker?.changeRate
  ];
  for (const candidate of candidates) {
    const raw = Number(candidate);
    if (!Number.isFinite(raw)) continue;
    if (Math.abs(raw) <= 1) return raw * 100;
    return raw;
  }
  return 0;
}

// Returns 24h high-low range as percentage of low price
function extractTickerRange24h(ticker) {
  const high = Number(ticker?.high24h || ticker?.highPr || ticker?.high || 0);
  const low  = Number(ticker?.low24h  || ticker?.lowPr  || ticker?.low  || 0);
  if (!high || !low || low <= 0 || high < low) return 0;
  return (high - low) / low * 100;
}

async function getCandles(symbol, timeframe = "3min", limit = 50, silent = false) {
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
      const data = await request(config.baseUrl, config.apiKey, config.secretKey, config.passphrase, "GET", path, null, 3, silent);
      const rows = normalizeCandleRows(Array.isArray(data) ? data : [], timeframe);
      if (!silent) logEvent(LOG_FILE, "DEBUG", `Candle fetch ${symbol} (${timeframe}) ${describeRows(rows, source)}`);
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
    if (!silent) logEvent(LOG_FILE, "ERROR", `getCandles failed for ${symbol} (${timeframe}): ${err.message}`);
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
    // Include all coins from baseCoins AND any coins currently held in state
    const coinsToTrack = new Set(config.baseCoins || []);
    for (const pos of getOpenPositions(state)) {
      if (pos && pos.symbol) {
        coinsToTrack.add(pos.symbol.replace(/USDT$/i, "").toUpperCase());
      }
    }
    for (const coin of coinsToTrack) {
      balances[coin.toLowerCase()] = byCoin[coin] || 0;
    }
    // Also blindly include anything that has > 0 balance from API
    for (const [coin, available] of Object.entries(byCoin)) {
      if (available > 0 && coin !== "USDT") {
        balances[coin.toLowerCase()] = available;
      }
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
    
    // Skip checking coins that we already know are unlisted or dead
    if (unlistedCoinsCache.has(lower)) {
      continue;
    }

    if (bal > 0 && (!priceMap[lower] || priceMap[lower] <= 0)) {
      missingCoins.push(lower);
    }
  }
  if (missingCoins.length > 0) {
    logEvent(LOG_FILE, 'DEBUG', `Missing prices for: ${missingCoins.join(',')}, fetching candles...`);
    for (const coin of missingCoins) {
      const symbol = coin.toUpperCase() + 'USDT';
      try {
        const candles = await getCandles(symbol, config.signalTimeframe, 1, true);
        if (candles && candles.length > 0) {
          const close = extractLastClosedPrice(candles);
          if (close > 0) {
            priceMap[coin] = close;
            logEvent(LOG_FILE, 'DEBUG', `Fallback price for ${coin}: ${close} (from candles)`);
          }
        }
      } catch (e) {
        // If it throws an API error like "Parameter does not exist" (400), we cache it
        if (e.isApiError || (e.status && e.status === 400)) {
          unlistedCoinsCache.add(coin);
          logEvent(LOG_FILE, 'DEBUG', `Marking ${symbol} as unlisted/dead to skip future checks.`);
        }
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
    dustThreshold: config.minManagedPositionUSDT ?? config.logDustThreshold ?? 0.01,
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

    // Always add to total equity, even if it's dust
    total += value;

    if (qty < qtyDustThreshold || value < dustThreshold) {
      continue;
    }
    breakdown[lowerCoin] = value;
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
    const coinLower = sym.replace(/USDT$/i, "").toLowerCase();
    
    // Include if it's in active pairs OR if we currently have a balance for it
    const isInPairs = config.pairs.includes(sym);
    const hasBalance = cachedBalances && cachedBalances[coinLower] && cachedBalances[coinLower] > 0;
    
    if ((isInPairs || hasBalance) && price > 0) {
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

let lastAutoPairRotationAt = 0;
let lastAutoPairRotationSignature = "";

function getAutoPairRotationConfig() {
  const defaults = {
    enabled: false,
    requireNoOpenPositions: true,
    refreshIntervalHours: 6,
    topPairs: 10,
    disableOnStopLoss: true,
    disableOnStaleTrade: false,
    disableOnAnyLoss: false,
    stopLossCooldownHours: 24,
    minQuoteVolumeUSDT: 500000,
    maxAbsChangePct: 40,
    minChangePct: -8
  };
  const raw = isPlainObject(config.autoPairRotation) ? config.autoPairRotation : {};
  const rawCat = isPlainObject(raw.categories) ? raw.categories : {};
  return {
    enabled: raw.enabled === true,
    requireNoOpenPositions: raw.requireNoOpenPositions !== false,
    refreshIntervalHours: Math.max(1, Math.min(12, Number.isFinite(Number(raw.refreshIntervalHours)) ? Number(raw.refreshIntervalHours) : defaults.refreshIntervalHours)),
    topPairs: Math.max(5, Math.min(15, Number.isFinite(Number(raw.topPairs)) ? Number(raw.topPairs) : defaults.topPairs)),
    disableOnStopLoss: raw.disableOnStopLoss !== false,
    disableOnStaleTrade: raw.disableOnStaleTrade === true,
    disableOnAnyLoss: raw.disableOnAnyLoss === true,
    stopLossCooldownHours: Math.max(1, Number(raw.stopLossCooldownHours ?? defaults.stopLossCooldownHours)),
    minQuoteVolumeUSDT: Math.max(0, Number(raw.minQuoteVolumeUSDT ?? defaults.minQuoteVolumeUSDT)),
    maxAbsChangePct: Math.max(1, Number(raw.maxAbsChangePct ?? defaults.maxAbsChangePct)),
    minChangePct: Number(raw.minChangePct ?? defaults.minChangePct),
    // Category toggles — each can be enabled/disabled and weighted independently
    categories: {
      bestVolume:       { enabled: rawCat.bestVolume?.enabled       !== false, weight: Number(rawCat.bestVolume?.weight       ?? 1.2) },
      bestMomentum:     { enabled: rawCat.bestMomentum?.enabled     !== false, weight: Number(rawCat.bestMomentum?.weight     ?? 0.8) },
      bestTrend:        { enabled: rawCat.bestTrend?.enabled        === true,  weight: Number(rawCat.bestTrend?.weight        ?? 1.0) },
      bestPrice:        { enabled: rawCat.bestPrice?.enabled        === true,  weight: Number(rawCat.bestPrice?.weight        ?? 1.0) },
      notOverextended:  { enabled: rawCat.notOverextended?.enabled  !== false, weight: Number(rawCat.notOverextended?.weight  ?? 1.5) }
    }
  };
}

function getStopLossBlacklistSymbols(rotationCfg, now = Date.now()) {
  const symbols = new Set();
  if (!rotationCfg.disableOnStopLoss && !rotationCfg.disableOnStaleTrade && !rotationCfg.disableOnAnyLoss) return symbols;

  try {
    if (!fs.existsSync(JOURNAL_PATH)) return symbols;
    const raw = fs.readFileSync(JOURNAL_PATH, "utf8").trim();
    if (!raw) return symbols;
    const journal = JSON.parse(raw);
    if (!Array.isArray(journal)) return symbols;

    const lookbackMs = rotationCfg.stopLossCooldownHours * 60 * 60 * 1000;
    const cutoff = now - lookbackMs;
    for (let i = journal.length - 1; i >= 0; i--) {
      const row = journal[i];
      if (!row || row.status !== "closed") continue;
      const reason = String(row.exit?.reason || row.reason || "").toLowerCase();
      const pnlPct = Number(row.exit?.pnlPct ?? row.PnL_pct ?? row.pnlPct ?? 0);
      const stopLossHit = reason.includes("emergency sl") || reason.includes("atr stop loss");
      const staleTradeHit = reason.includes("stale trade");
      const costGuardHit = reason.includes("cost guard");
      const anyLossHit = Number.isFinite(pnlPct) && pnlPct < 0 && !costGuardHit;
      const shouldFlag =
        (rotationCfg.disableOnStopLoss && stopLossHit) ||
        (rotationCfg.disableOnStaleTrade && staleTradeHit) ||
        (rotationCfg.disableOnAnyLoss && anyLossHit);
      if (!shouldFlag) continue;
      const pair = String(row.pair || "").toUpperCase();
      if (!pair) continue;
      const closedAt = new Date(row.closedAt || row.openedAt || 0).getTime();
      if (!Number.isFinite(closedAt) || closedAt < cutoff) continue;
      symbols.add(pair);
    }
  } catch (err) {
    logEvent(LOG_FILE, "WARN", `Auto-rotate blacklist read failed: ${err.message}`);
  }
  return symbols;
}

function setRuntimePairs(nextPairs = [], source = "manual") {
  const unique = [];
  const seen = new Set();
  for (const pair of nextPairs) {
    const symbol = String(pair || "").toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    unique.push(symbol);
  }
  if (!unique.length) return false;

  const nextPairSettings = {};
  const existingPairSettings = isPlainObject(config.pairSettings) ? config.pairSettings : {};
  const allSymbols = new Set([
    ...Object.keys(existingPairSettings).map(symbol => String(symbol || "").toUpperCase()),
    ...unique
  ]);
  for (const symbol of allSymbols) {
    nextPairSettings[symbol] = { enabled: unique.includes(symbol) };
  }

  config.pairSettings = nextPairSettings;
  config.pairs = unique;
  config.baseCoins = unique.map(symbol => symbol.replace(/USDT$/i, "").toUpperCase());
  config.runtimePairSource = source;
  persistConfigSnapshot();
  return true;
}

function markAutoRotatePending(now, reason) {
  config.lastAutoPairRotation = {
    ...(config.lastAutoPairRotation || {}),
    pending: true,
    pendingAt: new Date(now).toISOString(),
    pendingReason: reason
  };
  persistConfigSnapshot();
}

async function maybeRotatePairUniverseInner({ now, state, force = false }) {
  const rotationCfg = getAutoPairRotationConfig();

  if (!rotationCfg.enabled) {
    if (config.runtimePairSource === "auto-rotate") {
      const normalized = normalizePairConfig(config);
      setRuntimePairs(normalized.pairs || [], "manual");
      config.lastAutoPairRotation = {
        at: new Date(now).toISOString(),
        enabled: false,
        reason: "disabled",
        pending: false,
        pendingAt: null,
        pendingReason: null
      };
      persistConfigSnapshot();
      logEvent(LOG_FILE, "INFO", "Auto-rotate disabled, reverted to config pairSettings");
    }
    return;
  }

  // Guard: skip if any open position exists
  if (rotationCfg.requireNoOpenPositions) {
    const openCount = getOpenPositions(state).length;
    if (openCount > 0) {
      const pendingReason = `${openCount} open position(s)`;
      logEvent(LOG_FILE, "INFO", `Auto-rotate pending: ${pendingReason} active`);
      config.lastAutoPairRotation = {
        ...(config.lastAutoPairRotation || {}),
        skippedAt: new Date(now).toISOString(),
        skippedReason: pendingReason
      };
      markAutoRotatePending(now, pendingReason);
      return;
    }
  }

  const balances = await getBalancesCached();
  const portfolio = await getPortfolioValue();
  const managedSymbolsSet = new Set(getOpenPositions(state).map(pos => pos.symbol));
  const dustThresholdUsdt = config.minManagedPositionUSDT ?? 3;
  const recoveryThresholdUsdt = Math.max(config.minRecoverUSDT ?? dustThresholdUsdt, dustThresholdUsdt);
  let recoverableSymbol = null;

  for (const [coin, qty] of Object.entries(balances || {})) {
    if (coin === "usdt") continue;
    if (!qty || qty <= 0) continue;

    const symbol = coin.toUpperCase() + "USDT";
    const pairEnabled = Array.isArray(config.pairs) && config.pairs.includes(symbol);
    if (!managedSymbolsSet.has(symbol) && !pairEnabled) continue;

    const price = cachedPrices?.[coin] ?? portfolio.prices?.[coin] ?? portfolio.prices?.[symbol] ?? 0;
    if (!price || price <= 0) continue;

    const value = qty * price;
    if (value >= recoveryThresholdUsdt && !managedSymbolsSet.has(symbol)) {
      recoverableSymbol = symbol;
      break;
    }
  }

  if (recoverableSymbol) {
    const pendingReason = `recoverable balance ${recoverableSymbol}`;
    logEvent(LOG_FILE, "INFO", `Auto-rotate pending: ${pendingReason}`);
    config.lastAutoPairRotation = {
      ...(config.lastAutoPairRotation || {}),
      skippedAt: new Date(now).toISOString(),
      skippedReason: pendingReason
    };
    markAutoRotatePending(now, pendingReason);
    return;
  }

  const refreshMs = rotationCfg.refreshIntervalHours * 60 * 60 * 1000;
  const pendingRotation = config.lastAutoPairRotation?.pending === true;
  if (!force && !pendingRotation && lastAutoPairRotationAt > 0 && (now - lastAutoPairRotationAt) < refreshMs) return;

  const { categories } = rotationCfg;
  const activeCategories = Object.entries(categories)
    .filter(([, v]) => v.enabled)
    .map(([k, v]) => `${k}(×${v.weight})`)
    .join(", ") || "none";
  logEvent(LOG_FILE, "INFO", `Auto-rotate running | categories: ${activeCategories}`);

  const data = await request(config.baseUrl, config.apiKey, config.secretKey, config.passphrase, "GET", "/api/v2/spot/market/tickers");
  const rows = extractTickerRows(data);
  const stopLossBlacklist = getStopLossBlacklistSymbols(rotationCfg, now);
  const scored = [];

  for (const row of rows) {
    const symbol = extractTickerSymbol(row);
    if (!symbol.endsWith("USDT")) continue;
    if (symbol.includes("3L") || symbol.includes("3S") || symbol.includes("5L") || symbol.includes("5S")) continue;
    if (stopLossBlacklist.has(symbol)) continue;

    const last = extractTickerPrice(row);
    const quoteVol = extractTickerQuoteVolume(row);
    const changePct = extractTickerChangePct(row);
    const rangePct = extractTickerRange24h(row);  // 24h high-low swing %

    if (!Number.isFinite(last) || last <= 0) continue;
    if (quoteVol < rotationCfg.minQuoteVolumeUSDT) continue;
    if (Math.abs(changePct) > rotationCfg.maxAbsChangePct) continue;
    if (changePct < rotationCfg.minChangePct) continue;
    // Hard filter: skip pairs that are already heavily overextended (range > 25%)
    if (rangePct > 25) continue;

    // Multi-category scoring
    let score = 0;

    // bestVolume: reward most liquid pairs (log scale)
    if (categories.bestVolume.enabled) {
      score += Math.log10(Math.max(quoteVol, 1)) * categories.bestVolume.weight;
    }

    // bestMomentum: reward strong upward movement — moderate range (not wild pump)
    if (categories.bestMomentum.enabled) {
      // Sweet spot: +1% to +8% = max reward, >15% tapers
      const mom = changePct >= 0
        ? changePct <= 8 ? changePct : Math.max(0, 8 - (changePct - 8) * 0.5)
        : Math.max(-4, changePct * 0.3); // soft penalize small pullbacks
      score += mom * categories.bestMomentum.weight;
    }

    // bestTrend: steady green — reward +1%~+8%, heavy penalize >15% or negative
    if (categories.bestTrend.enabled) {
      const trendScore = changePct >= 1 && changePct <= 8
        ? changePct                            // sweet spot, full reward
        : changePct > 8 && changePct <= 15
          ? Math.max(0, 8 - (changePct - 8))  // taper above 8%
          : changePct > 15
            ? 0                                // pump, no reward
            : Math.max(-2, changePct * 0.2);   // negative = small penalty
      score += trendScore * categories.bestTrend.weight;
    }

    // bestPrice: reward coins going up — only positive changePct, scale to sweet spot
    if (categories.bestPrice.enabled) {
      // Reward: +0.5% to +12% naik, cap. Tidak ada negative reward.
      const priceScore = changePct >= 0.5
        ? Math.min(12, changePct)  // can go up to 12pt reward
        : 0;                       // flat or negative = no reward
      score += priceScore * categories.bestPrice.weight;
    }

    // notOverextended: reward low-range pairs, penalize overextended
    // Range < 8% = very tight/good, 8–15% = ok, 15–25% = penalize, skip >25% already filtered
    if (categories.notOverextended.enabled) {
      const rangeScore = rangePct <= 8
        ? 3.0                                  // tight range, bonus
        : rangePct <= 15
          ? 3.0 - ((rangePct - 8) / 7) * 2.0  // linear taper 3.0 → 1.0
          : rangePct <= 25
            ? 1.0 - ((rangePct - 15) / 10) * 1.5  // 1.0 → -0.5
            : -2.0;                                 // (shouldn't reach, hard filtered above)
      score += rangeScore * categories.notOverextended.weight;
    }

    scored.push({ symbol, score, quoteVol, changePct, rangePct, last });
  }

  scored.sort((a, b) => b.score - a.score || b.quoteVol - a.quoteVol || a.symbol.localeCompare(b.symbol));
  const picked = scored.slice(0, rotationCfg.topPairs).map(item => item.symbol);

  if (!picked.length) {
    config.lastAutoPairRotation = {
      at: new Date(now).toISOString(),
      enabled: true,
      changed: false,
      reason: "no-candidates",
      activeCategories,
      blacklistCount: stopLossBlacklist.size,
      pending: false,
      pendingAt: null,
      pendingReason: null
    };
    persistConfigSnapshot();
    logEvent(LOG_FILE, "WARN", "Auto-rotate found no eligible pair candidates");
    lastAutoPairRotationAt = now;
    return;
  }

  const signature = picked.join(",");
  const changed = signature !== lastAutoPairRotationSignature;
  const prevPairs = new Set(lastAutoPairRotationSignature ? lastAutoPairRotationSignature.split(",") : []);
  setRuntimePairs(picked, "auto-rotate");
  lastAutoPairRotationAt = now;
  lastAutoPairRotationSignature = signature;
  config.lastAutoPairRotation = {
    at: new Date(now).toISOString(),
    enabled: true,
    changed,
    refreshIntervalHours: rotationCfg.refreshIntervalHours,
    topPairs: rotationCfg.topPairs,
    activePairs: config.pairs,
    activeCategories,
    blacklistCount: stopLossBlacklist.size,
    pending: false,
    pendingAt: null,
    pendingReason: null
  };
  persistConfigSnapshot();

  await runAiAgentAfterRotation({
    config,
    rotation: config.lastAutoPairRotation,
    candidates: scored,
    now,
    report,
    log: (level, message, meta) => logEvent(LOG_FILE, level, message, meta)
  });
  persistConfigSnapshot();

  if (changed) {
    logEvent(LOG_FILE, "INFO", `Auto-rotate active pairs (${config.pairs.length}): ${config.pairs.join(",")}`);
  } else {
    logEvent(LOG_FILE, "DEBUG", `Auto-rotate checked, no pair changes (${config.pairs.length} active)`);
  }

  // Build and send Telegram rotation report
  const pickedSet = new Set(picked);
  const newPairs    = picked.filter(s => !prevPairs.has(s));
  const droppedPairs = [...prevPairs].filter(s => !pickedSet.has(s));
  const nextRotateAt = new Date(now + rotationCfg.refreshIntervalHours * 60 * 60 * 1000)
    .toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });

  const pickedDisplay = picked.map(s => s.replace('USDT', '')).join(', ');
  const lineActive  = '🔹 Active Pairs (' + picked.length + '):\n\n' + pickedDisplay + '\n';
  
  let lineChanges = '';
  if (prevPairs.size > 0) {
    const newDisplay = newPairs.map(s => s.replace('USDT', '')).join(', ');
    const droppedDisplay = droppedPairs.map(s => s.replace('USDT', '')).join(', ');
    const lineNew = newPairs.length ? '\n➕ In: ' + newDisplay : '';
    const lineDropped = droppedPairs.length ? '\n➖ Out: ' + droppedDisplay : '';
    lineChanges = lineNew + lineDropped + '\n';
  }

  const activeCategoriesDisplay = Object.entries(rotationCfg.categories)
      .filter(([, v]) => v.enabled)
      .map(([k, v]) => '- ' + k + '(×' + v.weight + ')')
      .join(',\n');
      
  const lineCategories = '\nCategories:\n' + activeCategoriesDisplay + '\n--------------------';
  
  const currentTime = new Date(now).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });
  const lineTime = '\nTime: ' + currentTime;
  const lineNext = '\nNext rotation: ~' + nextRotateAt + ' WIB';
  
  const rotationStatus = changed
    ? (prevPairs.size > 0 ? '💎 AUTO ROTATE SUCCESS (UPDATED)' : '💎 AUTO ROTATE SUCCESS (INITIAL)')
    : '📌 AUTO ROTATE SUCCESS (NO CHANGES)';

  const rotateMsg = rotationStatus + '\n--------------------\n' + lineActive + lineChanges + lineCategories + lineTime + lineNext;
  await report(rotateMsg).catch(err =>
    logEvent(LOG_FILE, "ERROR", `Auto-rotate report failed: ${err.message}`)
  );
}

async function maybeRotatePairUniverse(args) {
  return withJobLock(
    "rotation",
    async () => maybeRotatePairUniverseInner(args),
    "Skipping auto-rotate: previous rotation job still running"
  );
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

async function placeOrder(symbol, side, size, clientOrderId = null, simulatedPrice = null) {
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
    // Keep dry-run fills aligned with the runtime decision price whenever
    // the caller already has a validated entry/exit price.
    const coinKey = symbol.replace(/USDT$/i, "").toLowerCase();
    const simPrice = Number.isFinite(simulatedPrice) && Number(simulatedPrice) > 0
      ? Number(simulatedPrice)
      : (cachedPrices?.[coinKey] ?? 0);
    logEvent(LOG_FILE, "SIMULATE", `ORDER ${side} ${symbol} size=${sizeStr} simPrice=${simPrice}${clientOrderId ? ` cid=${clientOrderId}` : ""}`);
    return {
      orderId: `SIM_${Date.now()}`,
      clientOrderId: clientOrderId || `SIM_${Date.now()}`,
      symbol,
      side,
      requestedSize: sizeNum,
      filledSize: sizeNum,
      avgPrice: simPrice,
      feeAmount: null,
      feeCoin: null,
      feeUSDT: null,
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
      const initialAvgPrice = Number(res.priceAvg || res.avgPrice || res.price || 0);
      const feeMeta = parseOrderFee(res, symbol, initialAvgPrice);
      const initialOrder = {
        orderId,
        clientOrderId: res.clientOid || clientOrderId,
        symbol,
        side,
        requestedSize: sizeNum,
        filledSize: Number(res.filledQty || res.filled || res.baseVolume || 0),
        avgPrice: initialAvgPrice,
        feeAmount: feeMeta.feeAmount,
        feeCoin: feeMeta.feeCoin,
        feeUSDT: feeMeta.feeUSDT,
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

  // ===== STEP 1: LOOP GUARD =====
  if (shutdownRequested) return;
  if (executionKillSwitch) {
    await reportCritical("kill-switch", "🚨 EXECUTION KILL SWITCH ACTIVE\nBot stopped opening new trades due to repeated execution failures.");
    return;
  }
  if (jobLocks.rotation) {
    logEvent(LOG_FILE, "DEBUG", "Skipping runtime loop: auto-rotate is active");
    return;
  }
  if (loopInProgress) {
    logEvent(LOG_FILE, "WARN", "Skipping loop: previous cycle still running");
    return;
  }
  if (holdLoopInProgress) {
    logEvent(LOG_FILE, "DEBUG", "Skipping runtime loop: hold manager is active");
    return;
  }
  loopInProgress = true;
  try {
    const loopStartedAt = Date.now();
    const now = Date.now();
    const today = jakartaDateKey(now);

    if (config.lastAutoPairRotation?.pending === true && getOpenPositions(state).length === 0 && !state.position) {
      await maybeRotatePairUniverse({ now, state, force: true });
    }

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
      state.entryBlockBySymbol = {};
      state.recentEntriesBySymbol = {};
      saveState(STATE_PATH, state);
    } else if (!state.startOfDayEquity || state.startOfDayEquity <= 0) {
      state.startOfDayEquity = currentEquity;
      saveState(STATE_PATH, state);
    }
    if (cleanupExpiredEntryBlocks(state, now)) {
      saveState(STATE_PATH, state);
    }
    if (cleanupRecentEntries(state, now)) {
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
      state.haltReason = `Daily profit target reached (+${safeToFixed(realizedPnlPct * 100)}%)`;
      saveState(STATE_PATH, state);
      logEvent(LOG_FILE, "INFO", "Halted: " + state.haltReason);
    }
    if (realizedPnlPct <= config.dailyLossLimitPct) {
      state.haltedForDay = true;
      state.haltReason = `Daily loss limit hit (${safeToFixed(realizedPnlPct * 100)}%)`;
      saveState(STATE_PATH, state);
      logEvent(LOG_FILE, "INFO", "Halted: " + state.haltReason);
    }

    // ===== STEP 4: POSITION RECOVERY =====
    // Scan all non-USDT balances in portfolio:
    //   < minManagedPositionUSDT (dust threshold): unmanage if currently tracked, skip silently
    //   >= minManagedPositionUSDT and not yet tracked: recover into state.positions
    const DUST_THRESHOLD_USDT = config.minManagedPositionUSDT ?? 3;
    const RECOVERY_THRESHOLD_USDT = Math.max(config.minRecoverUSDT ?? DUST_THRESHOLD_USDT, DUST_THRESHOLD_USDT);
    const managedSymbolsSet = new Set(getOpenPositions(state).map(pos => pos.symbol));

    for (const [coin, qty] of Object.entries(balances)) {
      if (coin === "usdt") continue;
      if (!qty || qty <= 0) continue;

      const symbol = coin.toUpperCase() + "USDT";
      // Fix #3: fall back to portfolio tickers when cachedPrices not yet populated (startup)
      const price = cachedPrices?.[coin] ?? portfolio.prices?.[coin] ?? portfolio.prices?.[symbol] ?? 0;
      if (!price || price <= 0) continue;

      const value = qty * price;

      if (value < DUST_THRESHOLD_USDT) {
        // Dust: unmanage if previously tracked, then skip
        if (managedSymbolsSet.has(symbol)) {
          logEvent(LOG_FILE, "INFO", `Position ${symbol} dropped below dust threshold ($${DUST_THRESHOLD_USDT}), unmanaging`);
          state.positions = (state.positions || []).filter(p => p.symbol !== symbol);
          state.position = state.positions[0] || null;
          position = state.position;
          delete state.lastReportedPnlBySymbol[symbol];
          managedSymbolsSet.delete(symbol);
          saveState(STATE_PATH, state);
        }
        continue; // skip dust regardless
      }

      // Only managed or enabled pairs should be considered for recovery
      const pairEnabled = Array.isArray(config.pairs) && config.pairs.includes(symbol);
      if (!managedSymbolsSet.has(symbol) && !pairEnabled) {
        continue;
      }

      if (value < RECOVERY_THRESHOLD_USDT) {
        continue;
      }

      // value >= recovery threshold and not yet managed: recover into state
      if (!managedSymbolsSet.has(symbol)) {
        const recentEntryMeta = state.recentEntriesBySymbol?.[symbol];
        const recentEntryAt = Number(recentEntryMeta?.at || 0);
        const recentlyBoughtByBot = Number.isFinite(recentEntryAt) && (now - recentEntryAt) <= 10 * 60 * 1000;
        logEvent(
          LOG_FILE,
          recentlyBoughtByBot ? "DEBUG" : "INFO",
          recentlyBoughtByBot
            ? `Position reconcile from recent bot entry | ${symbol} est=${safeToFixed(value)} USDT`
            : `Position recovered | ${symbol} est=${safeToFixed(value)} USDT`
        );

        // Inherit TP/DTP/stop from config — same values as a normal entry would get
        const recoveryTakeProfitPct = config._effectiveTakeProfitPct ?? config.takeProfitPct ?? 0.012;
        const recoveryActivationPct = config._effectiveTrailingActivationPct ?? config.trailingActivationPct ?? 0.008;
        const recoveryStopPct = config.emergencyStopLossPct ?? config.minStopPct ?? -0.02;
        const recoveryUseDynamicTP = config.useDynamicTakeProfit === true;

        const recoveredPosition = {
          symbol,
          entry: Number.isFinite(recentEntryMeta?.entry) && recentEntryMeta.entry > 0 ? recentEntryMeta.entry : price,
          currentPrice: price,
          qty: Number.isFinite(recentEntryMeta?.qty) && recentEntryMeta.qty > 0 ? recentEntryMeta.qty : qty,
          sizeUSDT: Number.isFinite(recentEntryMeta?.sizeUSDT) && recentEntryMeta.sizeUSDT > 0 ? recentEntryMeta.sizeUSDT : value,
          peak: Number.isFinite(recentEntryMeta?.entry) && recentEntryMeta.entry > 0 ? recentEntryMeta.entry : price,
          trailingActive: false,
          stopPct: recoveryStopPct,
          takeProfitPct: recoveryTakeProfitPct,
          profitActivationPct: recoveryActivationPct,
          profitActivationFloorPct: Math.max(config.trailingProtectionPct ?? 0.0025, recoveryActivationPct * 0.35),
          useDynamicTakeProfit: recoveryUseDynamicTP,
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

        if (!recentlyBoughtByBot) {
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
        }

        const lastRecoveryTime = state.lastRecoveryTime || 0;
        const lastRecoverySymbol = state.lastRecoverySymbol;
        if (!recentlyBoughtByBot && (!lastRecoverySymbol || lastRecoverySymbol !== symbol || Date.now() - lastRecoveryTime > 5 * 60 * 1000)) {
          await report(`⚠️ POSITION RECOVERED\nPair: ${symbol}\nEstimated Entry: ${safeToFixed(price)}\nValue: ${safeToFixed(value)} USDT\n\nBot detected an existing position from balance.`);
          state.lastRecoveryTime = Date.now();
          state.lastRecoverySymbol = symbol;
          saveState(STATE_PATH, state);
        } else if (!recentlyBoughtByBot) {
          logEvent(LOG_FILE, "DEBUG", `Recovery message suppressed | last=${lastRecoverySymbol}`);
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
      let positionsRefreshed = false;
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
          try {
            const pCandles = await getCandles(symbol, config.signalTimeframe);
            if (pCandles?.length) price = extractLastClosedPrice(pCandles);
          } catch (e) {
            logEvent(LOG_FILE, "WARN", `Gagal menarik harga fallback untuk ${symbol}: ${e.message}`);
          }
        }

        const value = coinBal * price;
        if (value < DUST_THRESHOLD_USDT) {
          logEvent(LOG_FILE, "INFO", `Position ${symbol} value below dust threshold ($${DUST_THRESHOLD_USDT}), removing from managed positions`);
          positionsChanged = true;
          delete state.lastReportedPnlBySymbol[symbol];
          continue;
        }

        // State migration: inject TP/DTP/stop from config if position was created before this fix
        const migratedTp  = !Number.isFinite(openPosition.takeProfitPct)
          ? (config._effectiveTakeProfitPct ?? config.takeProfitPct ?? 0.012)
          : openPosition.takeProfitPct;
        const migratedDtp = !Number.isFinite(openPosition.profitActivationPct)
          ? (config._effectiveTrailingActivationPct ?? config.trailingActivationPct ?? 0.008)
          : openPosition.profitActivationPct;
        const migratedStop = !Number.isFinite(openPosition.stopPct) || openPosition.stopPct === -0.02
          ? (config.emergencyStopLossPct ?? config.minStopPct ?? -0.02)
          : openPosition.stopPct;
        const migratedFloor = !Number.isFinite(openPosition.profitActivationFloorPct)
          ? Math.max(config.trailingProtectionPct ?? 0.0025, migratedDtp * 0.35)
          : openPosition.profitActivationFloorPct;
        if (migratedTp !== openPosition.takeProfitPct || migratedDtp !== openPosition.profitActivationPct) {
          positionsChanged = true;
          logEvent(LOG_FILE, "INFO", `State migration: injecting TP/DTP into ${openPosition.symbol}`);
        }

        const nextCurrentPrice = price > 0 ? price : openPosition.currentPrice;
        const nextSizeUSDT = value > 0 ? value : openPosition.sizeUSDT;
        if (
          Math.abs((Number(openPosition.qty) || 0) - coinBal) > 1e-12 ||
          Math.abs((Number(openPosition.sizeUSDT) || 0) - (Number(nextSizeUSDT) || 0)) > 1e-8 ||
          Math.abs((Number(openPosition.currentPrice) || 0) - (Number(nextCurrentPrice) || 0)) > 1e-12
        ) {
          positionsRefreshed = true;
        }

        nextPositions.push({
          ...openPosition,
          qty: coinBal,
          sizeUSDT: nextSizeUSDT,
          currentPrice: nextCurrentPrice,
          takeProfitPct: migratedTp,
          profitActivationPct: migratedDtp,
          profitActivationFloorPct: migratedFloor,
          stopPct: migratedStop,
          useDynamicTakeProfit: openPosition.useDynamicTakeProfit ?? (config.useDynamicTakeProfit === true)
        });
      }

      if (positionsChanged || positionsRefreshed || nextPositions.length !== trackedPositions.length) {
        state.positions = nextPositions;
        state.position = nextPositions[0] || null;
        position = state.position;
        saveState(STATE_PATH, state);
      }

      // Update currentPositionPrice from validated state
      if (state.position) {
        currentPositionPrice = getPriceFromBreakdown(state.position.symbol, portfolioNow.balances, portfolioNow.breakdown);
        if (!currentPositionPrice || currentPositionPrice <= 0) {
          try {
            const pCandles = await getCandles(state.position.symbol, config.signalTimeframe);
            if (pCandles?.length) currentPositionPrice = extractLastClosedPrice(pCandles);
          } catch (e) {
            // Abaikan jika error (misal token delisted)
          }
        }
      }
    } else if (state.position) {
      // No tracked positions but state.position still set — resolve price for exit/reports
      currentPositionPrice = getPriceFromBreakdown(state.position.symbol, balances, portfolio.breakdown);
      if (!currentPositionPrice || currentPositionPrice <= 0) {
        try {
          const pCandles = await getCandles(state.position.symbol, config.signalTimeframe);
          if (pCandles?.length) currentPositionPrice = extractLastClosedPrice(pCandles);
        } catch (e) {}
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
    // Fix #4: haltedForDay must show in gate status so heartbeat/reports are accurate
    let entryGateStatus = "open";
    if (state.haltedForDay) {
      entryGateStatus = `halted: ${state.haltReason || "daily limit reached"}`;
    } else if (entryBlockedByLossStreak) {
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

    // ===== STEP 7: MARKET SCANNING =====
    let marketData = [];
    let topScoring = null;
    let watchlist = [];
    let marketMode = "Unknown";
    let volatilityState = "Unknown";
    let entryCandidates = [];
    let scanConfig = applyMarketProfile(config, resolveMarketProfileKey(null));
    const marketJob = await withJobLock(
      "market",
      async () => {
        const baseScan = await scanMarket(config, getCandles, botLog);
        const marketProfileKey = resolveMarketProfileKey(baseScan.marketMode);
        scanConfig = applyMarketProfile(config, marketProfileKey);
        const scanResult = marketProfileKey ? await scanMarket(scanConfig, getCandles, botLog) : baseScan;
        ({ marketData, topScoring, watchlist, marketMode, volatilityState, entryCandidates } = scanResult);
      },
      "Skipping market scan: previous market job still running"
    );
    if (marketJob.skipped) {
      scanConfig = applyMarketProfile(config, resolveMarketProfileKey(null));
    }
    const heldSymbols = new Set(getOpenPositions(state).map(pos => pos.symbol));
    const eligibleCandidates = scanConfig.marketEntriesEnabled === false
      ? []
      : (entryCandidates || [])
          .filter(candidate => candidate.eligible && !heldSymbols.has(candidate.symbol))
          .sort((a, b) => b.score - a.score);
    const bestBlockedEligible = eligibleCandidates.find(candidate => getActiveEntryBlock(state, candidate.symbol, now)) || null;
    const bestEligible = eligibleCandidates.find(candidate => !getActiveEntryBlock(state, candidate.symbol, now)) || null;
    if (entryGateStatus === "open" && !bestEligible && bestBlockedEligible) {
      const block = getActiveEntryBlock(state, bestBlockedEligible.symbol, now);
      const minsLeft = Math.max(1, Math.ceil((Number(block?.until || now) - now) / 60000));
      entryGateStatus = `pair reentry block (${bestBlockedEligible.symbol} ${minsLeft}m left)`;
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
      autoPairRotation: config.lastAutoPairRotation || { enabled: false },
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
        `⚠️ DATA STALE\nSignal ${config.signalTimeframe || "3min"}: ${sigTs}\nTrend ${config.trendTimeframe || "15min"}: ${trendTs}\nMarket mode: ${marketMode || "unknown"}`,
        20 * 60 * 1000
      );
    }

    // ===== STEP 9: REPORTS =====
    const reportsJob = await withJobLock(
      "reports",
      async () => {
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
          safeToFixed,
          runtimeJobs: {
            main: loopInProgress,
            market: jobLocks.market,
            hold: holdLoopInProgress,
            reports: jobLocks.reports,
            rotation: jobLocks.rotation
          }
        }));
      },
      "Skipping reports: previous report job still running"
    );

    // ===== STEP 10: EXIT FLOW =====
    if (getOpenPositions(state).length > 0 || state.position) {
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
      safeToFixed,
      cachedPrices
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

async function runHoldManagerCycle() {
  if (shutdownRequested) return;
  if (executionKillSwitch) return;
  if (jobLocks.rotation) {
    logEvent(LOG_FILE, "DEBUG", "Skipping hold manager: auto-rotate is active");
    return;
  }
  if (holdLoopInProgress) {
    logEvent(LOG_FILE, "DEBUG", "Skipping hold manager: previous hold job still running");
    return;
  }
  if (loopInProgress) {
    logEvent(LOG_FILE, "DEBUG", "Skipping hold manager: runtime cycle is active");
    return;
  }
  const openPositions = getOpenPositions(state);
  if (!openPositions.length && !state.position) {
    return;
  }

  holdLoopInProgress = true;
  try {
    const now = Date.now();
    const portfolio = await getPortfolioValue();
    const balances = portfolio.balances;
    const DUST_THRESHOLD_USDT = config.minManagedPositionUSDT ?? 3;
    let positionsChanged = false;
    let positionsRefreshed = false;
    const nextPositions = [];
    const marketData = [];

    for (const openPosition of openPositions) {
      const symbol = openPosition?.symbol;
      if (!symbol) continue;
      const coin = symbol.replace("USDT", "").toLowerCase();
      const coinBal = balances[coin] || 0;

      if (coinBal <= 0) {
        logEvent(LOG_FILE, "INFO", `Hold manager removed vanished position ${symbol}`);
        positionsChanged = true;
        delete state.lastReportedPnlBySymbol[symbol];
        continue;
      }

      let price = getPriceFromBreakdown(symbol, portfolio.balances, portfolio.breakdown);
      if (!price || price <= 0) {
        try {
          const pCandles = await getCandles(symbol, config.signalTimeframe);
          if (pCandles?.length) price = extractLastClosedPrice(pCandles);
        } catch (err) {
          logEvent(LOG_FILE, "WARN", `Hold manager fallback price failed for ${symbol}: ${err.message}`);
        }
      }
      if (!price || price <= 0) {
        logEvent(LOG_FILE, "WARN", `Hold manager skipping ${symbol}: no validated price`);
        continue;
      }

      const value = coinBal * price;
      if (value < DUST_THRESHOLD_USDT) {
        logEvent(LOG_FILE, "INFO", `Hold manager removed ${symbol}: value below dust threshold`);
        positionsChanged = true;
        delete state.lastReportedPnlBySymbol[symbol];
        continue;
      }

      const nextCurrentPrice = price;
      const nextSizeUSDT = value;
      if (
        Math.abs((Number(openPosition.qty) || 0) - coinBal) > 1e-12 ||
        Math.abs((Number(openPosition.sizeUSDT) || 0) - (Number(nextSizeUSDT) || 0)) > 1e-8 ||
        Math.abs((Number(openPosition.currentPrice) || 0) - (Number(nextCurrentPrice) || 0)) > 1e-12
      ) {
        positionsRefreshed = true;
      }

      nextPositions.push({
        ...openPosition,
        qty: coinBal,
        sizeUSDT: nextSizeUSDT,
        currentPrice: nextCurrentPrice
      });
      marketData.push({
        symbol,
        price,
        rsi: null
      });
    }

    if (positionsChanged || positionsRefreshed || nextPositions.length !== openPositions.length) {
      state.positions = nextPositions;
      state.position = nextPositions[0] || null;
      position = state.position;
      saveState(STATE_PATH, state);
    }

    const activePositions = getOpenPositions(state);
    if (!activePositions.length && !state.position) {
      return;
    }

    const primarySymbol = state.position?.symbol || activePositions[0]?.symbol || null;
    const currentPositionPrice = primarySymbol
      ? (marketData.find(item => item.symbol === primarySymbol)?.price || 0)
      : 0;

    await withJobLock(
      "hold",
      async () => {
        const exitFlowResult = await handleExitFlow({
          config,
          state,
          balances,
          currentPositionPrice,
          marketData,
          scanConfig: {
            activeMarketProfile: config.selectedMarketProfile || null,
            activeMarketProfileLabel: config.selectedMarketProfile || "Auto"
          },
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
      },
      "Skipping hold manager: previous hold job still running"
    );
  } catch (err) {
    logEvent(LOG_FILE, "ERROR", `runHoldManagerCycle: ${err.message}`);
  } finally {
    holdLoopInProgress = false;
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
    'minCandleStrength', 'breakoutPct', 'maxOpenPositions', 'exposureCapPct',
    'pairReentryBlockLossPct', 'pairReentryBlockMinutes'
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
  process.on("bot:restart-request", () => requestSafeExit("dashboard:restart", 42));
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

  // Startup auto-rotate should happen before the first market scan / buy cycle,
  // while still honoring open-position and recovery guards.
  const rotationCfg = getAutoPairRotationConfig();
  if (rotationCfg.enabled) {
    await maybeRotatePairUniverse({ now: Date.now(), state });
  }

  await runBot();

  // ===== AUTO PAIR ROTATION SCHEDULER =====
  // Runs independently every 6 hours — decoupled from the main bot loop.
  // The rotation interval is read from config.autoPairRotation.refreshIntervalHours (default 6).
  if (rotationCfg.enabled) {
    const rotationIntervalMs = rotationCfg.refreshIntervalHours * 60 * 60 * 1000;
    setInterval(() => {
      if (shutdownRequested) return;
      maybeRotatePairUniverse({ now: Date.now(), state }).catch(err =>
        logEvent(LOG_FILE, "ERROR", `Auto-rotate scheduled run failed: ${err.message}`)
      );
    }, rotationIntervalMs);
    logEvent(LOG_FILE, "INFO", `Auto pair rotation scheduler started | interval=${rotationCfg.refreshIntervalHours}h`);
  } else {
    logEvent(LOG_FILE, "INFO", "Auto pair rotation disabled — running on fixed pairSettings");
  }

  async function scheduleNextRun() {
    try {
      await runBot();
    } catch (err) {
      logEvent(LOG_FILE, "ERROR", `Error in runBot loop: ${err.message}`);
    } finally {
      if (!shutdownRequested) {
        const delayMs = config.loopIntervalMs || 60000;
        loopTimer = setTimeout(scheduleNextRun, delayMs);
      }
    }
  }

  async function scheduleHoldLoop() {
    try {
      await runHoldManagerCycle();
    } catch (err) {
      logEvent(LOG_FILE, "ERROR", `Error in hold manager loop: ${err.message}`);
    } finally {
      if (!shutdownRequested) {
        const delayMs = config.holdCheckIntervalMs || 30000;
        holdLoopTimer = setTimeout(scheduleHoldLoop, delayMs);
      }
    }
  }

  // Start the first loop
  scheduleNextRun();
  scheduleHoldLoop();
}

startBot().catch(err => {
  logEvent(LOG_FILE, "ERROR", `Failed to start bot: ${err.message}`);
  process.exit(1);
});
