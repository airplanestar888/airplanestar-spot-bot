/**
 * Futures Module — Bitget USDT-M Futures support.
 *
 * Handles leverage setup, margin mode, contract info,
 * order placement, position tracking, and balance queries
 * for USDT-margined perpetual futures.
 *
 * Extracted to keep core/index.js clean and futures logic isolated.
 */

const FUTURES_BASE_PATH = "/api/v2/mix";

// Safety bounds for futures leverage. Kept in sync with server/static/dashboard.html.
const MIN_FUTURES_LEVERAGE = 1;
const MAX_FUTURES_LEVERAGE = 20;

// ================= CONFIG =================

function getFuturesConfig(config) {
  const raw = config.futures || {};
  const maxLeverage = Math.max(MIN_FUTURES_LEVERAGE, Math.min(MAX_FUTURES_LEVERAGE, Number(raw.maxLeverage) || 20));
  const requestedLeverage = Math.max(MIN_FUTURES_LEVERAGE, Math.min(MAX_FUTURES_LEVERAGE, Number(raw.leverage) || 10));
  const leverage = Math.min(requestedLeverage, maxLeverage);
  return {
    leverage,
    marginMode: raw.marginMode === "isolated" ? "isolated" : "crossed",
    marginCoin: "USDT",
    productType: "USDT-FUTURES",
    enableShorts: raw.enableShorts !== false,
    maxLeverage,
    liquidationBufferPct: Math.max(0.05, Math.min(0.5, Number(raw.liquidationBufferPct) || 0.15)),
    fundingRateThreshold: Number(raw.fundingRateThreshold) || 0.001,
    enableMarginCircuitBreaker: raw.enableMarginCircuitBreaker !== false,
    marginRatioWarningPct: Math.max(50, Math.min(95, Number(raw.marginRatioWarningPct) || 70)),
    marginRatioEntryBlockPct: Math.max(60, Math.min(98, Number(raw.marginRatioEntryBlockPct) || 80)),
    marginRatioCriticalPct: Math.max(70, Math.min(99, Number(raw.marginRatioCriticalPct) || 90))
  };
}

function isFuturesMode(config) {
  return String(config.tradingMode || "spot").toLowerCase() === "futures";
}

/**
 * Check margin ratio against circuit breaker thresholds.
 * @param {Object} config - bot config
 * @param {number} marginRatio - current margin ratio from exchange (percentage, e.g. 75 = 75%)
 * @returns {{ status: string, marginRatio: number, threshold: number, message: string }}
 */
function checkMarginCircuitBreaker(config, marginRatio) {
  const futuresCfg = getFuturesConfig(config);
  if (!futuresCfg.enableMarginCircuitBreaker) {
    return { status: "ok", marginRatio, threshold: 0, message: "" };
  }
  const mr = Number(marginRatio) || 0;
  if (mr <= 0) return { status: "ok", marginRatio: 0, threshold: 0, message: "" };

  if (mr >= futuresCfg.marginRatioCriticalPct) {
    return {
      status: "critical",
      marginRatio: mr,
      threshold: futuresCfg.marginRatioCriticalPct,
      message: `Margin ratio ${mr.toFixed(1)}% ≥ critical threshold ${futuresCfg.marginRatioCriticalPct}%`
    };
  }
  if (mr >= futuresCfg.marginRatioEntryBlockPct) {
    return {
      status: "block_entries",
      marginRatio: mr,
      threshold: futuresCfg.marginRatioEntryBlockPct,
      message: `Margin ratio ${mr.toFixed(1)}% ≥ entry block threshold ${futuresCfg.marginRatioEntryBlockPct}%`
    };
  }
  if (mr >= futuresCfg.marginRatioWarningPct) {
    return {
      status: "warning",
      marginRatio: mr,
      threshold: futuresCfg.marginRatioWarningPct,
      message: `Margin ratio ${mr.toFixed(1)}% ≥ warning threshold ${futuresCfg.marginRatioWarningPct}%`
    };
  }
  return { status: "ok", marginRatio: mr, threshold: 0, message: "" };
}

// ================= CONTRACT INFO =================

/**
 * Get contract info for a symbol (multiplier, min size, etc.)
 * Caches results to avoid repeated API calls.
 */
const contractInfoCache = {};

async function getContractInfo(request, config, symbol) {
  if (contractInfoCache[symbol]) return contractInfoCache[symbol];

  const futuresCfg = getFuturesConfig(config);
  const path = `${FUTURES_BASE_PATH}/market/contracts?productType=${futuresCfg.productType}&symbol=${symbol}`;
  const data = await request(config.baseUrl, null, null, null, "GET", path, null, 3);

  const items = Array.isArray(data) ? data : [];
  const info = items.find(item => item.symbol === symbol) || items[0];

  if (!info) return null;

  const result = {
    symbol: info.symbol,
    baseCoin: info.baseCoin,
    quoteCoin: info.quoteCoin,
    contractMultiplier: Number(info.minTradeNum || info.contractSize || 1),
    minSize: Number(info.minTradeNum || 1),
    pricePrecision: Number(info.pricePrecision || 2),
    quantityPrecision: Number(info.quantityPrecision || 0),
    symbolStatus: info.symbolStatus || "normal"
  };

  contractInfoCache[symbol] = result;
  return result;
}

// ================= LEVERAGE & MARGIN =================

async function setLeverage(request, config, symbol, leverage) {
  const futuresCfg = getFuturesConfig(config);
  const safeLeverage = Math.max(MIN_FUTURES_LEVERAGE, Math.min(futuresCfg.maxLeverage, Number(leverage) || futuresCfg.leverage));

  const body = {
    symbol,
    coin: futuresCfg.marginCoin,
    leverage: String(safeLeverage),
    productType: futuresCfg.productType
  };

  const result = await request(
    config.baseUrl, config.apiKey, config.secretKey, config.passphrase,
    "POST", `${FUTURES_BASE_PATH}/account/set-leverage`, body, 1
  );

  return { leverage: safeLeverage, result };
}

async function setMarginMode(request, config, symbol, marginMode) {
  const futuresCfg = getFuturesConfig(config);
  const safeMode = marginMode === "isolated" ? "isolated" : "crossed";

  const body = {
    symbol,
    coin: futuresCfg.marginCoin,
    marginMode: safeMode,
    productType: futuresCfg.productType
  };

  const result = await request(
    config.baseUrl, config.apiKey, config.secretKey, config.passphrase,
    "POST", `${FUTURES_BASE_PATH}/account/set-margin-mode`, body, 1
  );

  return { marginMode: safeMode, result };
}

/**
 * Ensure leverage and margin mode are set for a symbol before trading.
 * Called once per symbol before first futures order.
 */
const initializedSymbols = new Set();

async function ensureFuturesSetup(request, config, symbol, logEvent, LOG_FILE) {
  // Dry-run paper mode: skip live API calls so we don't mutate exchange state.
  // Cache is intentionally NOT populated so flipping back to live triggers a real setup.
  if (config && config.dryRun === true) {
    logEvent(LOG_FILE, "DEBUG", `Skipping futures leverage setup for ${symbol} (dry-run mode)`);
    return;
  }

  const futuresCfg = getFuturesConfig(config);
  const key = `${symbol}:${futuresCfg.leverage}:${futuresCfg.marginMode}`;
  if (initializedSymbols.has(key)) return;

  try {
    await setMarginMode(request, config, symbol, futuresCfg.marginMode);
    logEvent(LOG_FILE, "INFO", `Futures margin mode set: ${symbol} → ${futuresCfg.marginMode}`);
  } catch (err) {
    // Margin mode already set or error — log and continue
    logEvent(LOG_FILE, "DEBUG", `Futures margin mode for ${symbol}: ${err.message}`);
  }

  try {
    await setLeverage(request, config, symbol, futuresCfg.leverage);
    logEvent(LOG_FILE, "INFO", `Futures leverage set: ${symbol} → ${futuresCfg.leverage}x`);
  } catch (err) {
    logEvent(LOG_FILE, "WARN", `Failed to set leverage for ${symbol}: ${err.message}`);
    throw err;
  }

  initializedSymbols.add(key);
}

// ================= BALANCE =================

async function getFuturesBalance(request, config) {
  const futuresCfg = getFuturesConfig(config);
  const path = `${FUTURES_BASE_PATH}/account/accounts?productType=${futuresCfg.productType}&marginCoin=${futuresCfg.marginCoin}`;
  const data = await request(config.baseUrl, config.apiKey, config.secretKey, config.passphrase, "GET", path, null, 1);

  const account = Array.isArray(data) ? data[0] : data;
  if (!account) return { usdt: 0, equity: 0, available: 0, marginUsed: 0, unrealizedPnl: 0 };

  return {
    usdt: Number(account.available || 0),
    equity: Number(account.equity || 0),
    available: Number(account.available || 0),
    marginUsed: Number(account.frozen || 0) + Number(account.locked || 0),
    unrealizedPnl: Number(account.unrealizedPL || 0),
    marginRatio: Number(account.marginRatio || 0)
  };
}

// ================= FUNDING RATE =================

// Per-symbol funding rate cache with TTL to avoid hammering the endpoint.
// Bitget charges funding every 8h; 5min TTL is plenty fresh for entry gating.
const fundingRateCache = new Map();
const FUNDING_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch current funding rate for a symbol. Returns decimal (e.g. 0.0001 = 0.01%)
 * or null on error/parse failure. Cached per symbol for FUNDING_CACHE_TTL_MS.
 */
async function getLiveFundingRate(request, config, symbol) {
  const cached = fundingRateCache.get(symbol);
  if (cached && Date.now() - cached.ts < FUNDING_CACHE_TTL_MS) return cached.rate;

  const futuresCfg = getFuturesConfig(config);
  const path = `${FUTURES_BASE_PATH}/market/funding-rate?productType=${futuresCfg.productType}&symbol=${symbol}`;
  let data;
  try {
    data = await request(config.baseUrl, config.apiKey, config.secretKey, config.passphrase, "GET", path, null, 3);
  } catch (_err) {
    return null; // graceful: caller skips guard when rate is unavailable
  }

  // Bitget v2 wraps in { data: [...] } or returns array directly
  const item = Array.isArray(data) ? data[0] : (Array.isArray(data?.data) ? data.data[0] : data);
  const rate = Number(item?.fundingRate ?? item?.rate ?? item?.funding_rate ?? NaN);
  if (!Number.isFinite(rate)) return null;

  fundingRateCache.set(symbol, { rate, ts: Date.now() });
  return rate;
}

// ================= POSITIONS =================

async function getFuturesPositions(request, config, logEvent = null, LOG_FILE = null) {
  const futuresCfg = getFuturesConfig(config);
  const path = `${FUTURES_BASE_PATH}/position/all-position?productType=${futuresCfg.productType}&marginCoin=${futuresCfg.marginCoin}`;
  const data = await request(config.baseUrl, config.apiKey, config.secretKey, config.passphrase, "GET", path, null, 1);

  const items = Array.isArray(data) ? data : [];
  const positions = items
    .filter(item => Number(item.total || 0) !== 0)
    .map(item => ({
      symbol: item.symbol,
      side: item.holdSide === "long" ? "long" : "short",
      qty: Math.abs(Number(item.total || 0)),
      avgPrice: Number(item.averageOpenPrice || 0),
      currentPrice: Number(item.markPrice || 0),
      unrealizedPnl: Number(item.unrealizedPL || 0),
      leverage: Number(item.leverage || 1),
      marginUsed: Number(item.margin || 0),
      liquidationPrice: Number(item.liquidationPrice || 0),
      marginMode: item.marginMode || "crossed",
      profitRatio: Number(item.profitRatio || 0)
    }));

  // Validate exchange leverage matches configured leverage (warn on drift)
  if (typeof logEvent === "function" && LOG_FILE) {
    const configured = futuresCfg.leverage;
    for (const pos of positions) {
      if (pos.leverage > 0 && pos.leverage !== configured) {
        logEvent(LOG_FILE, "WARN",
          `Position ${pos.symbol} exchange leverage ${pos.leverage}x ≠ config ${configured}x — run ensureFuturesSetup to re-sync`
        );
      }
    }
  }

  return positions;
}

// ================= ORDER PLACEMENT =================

/**
 * Place a futures order (open or close).
 * @param {Object} params
 * @param {string} params.symbol - e.g. "BTCUSDT"
 * @param {string} params.side - "buy" or "sell"
 * @param {string} params.orderType - "market" or "limit"
 * @param {string} params.size - contract quantity
 * @param {boolean} params.reduceOnly - true for close orders
 * @param {string} params.clientOid - optional client order ID
 */
async function placeFuturesOrder(request, config, params, logEvent, LOG_FILE) {
  const futuresCfg = getFuturesConfig(config);
  const { symbol, side, orderType = "market", size, reduceOnly = false, clientOid } = params;

  const body = {
    symbol,
    productType: futuresCfg.productType,
    marginMode: futuresCfg.marginMode,
    marginCoin: futuresCfg.marginCoin,
    side,
    orderType,
    size: String(size),
    force: "gtc"
  };

  if (reduceOnly) body.reduceOnly = "true";
  if (clientOid) body.clientOid = clientOid;

  logEvent(LOG_FILE, "INFO", `Futures order: ${side} ${symbol} size=${size} reduceOnly=${reduceOnly}`);

  const result = await request(
    config.baseUrl, config.apiKey, config.secretKey, config.passphrase,
    "POST", `${FUTURES_BASE_PATH}/order/place-order`, body, 1
  );

  return {
    orderId: result?.orderId || null,
    clientOrderId: result?.clientOid || clientOid || null,
    symbol,
    side,
    size,
    reduceOnly,
    status: "submitted",
    raw: result
  };
}

/**
 * Get futures order status.
 */
async function getFuturesOrder(request, config, symbol, orderId) {
  const futuresCfg = getFuturesConfig(config);
  const path = `${FUTURES_BASE_PATH}/order/detail?productType=${futuresCfg.productType}&symbol=${symbol}&orderId=${orderId}`;
  const data = await request(config.baseUrl, config.apiKey, config.secretKey, config.passphrase, "GET", path, null, 1);

  if (!data) return null;
  return {
    orderId: data.orderId || orderId,
    symbol: data.symbol || symbol,
    side: data.side,
    size: Number(data.size || 0),
    filledSize: Number(data.baseVolume || data.dealSize || 0),
    avgPrice: Number(data.priceAvg || data.avgPrice || 0),
    status: normalizeFuturesOrderStatus(data.state || data.status),
    fee: Number(data.fee || 0),
    raw: data
  };
}

function normalizeFuturesOrderStatus(status) {
  const raw = String(status || "").toUpperCase();
  if (!raw) return "UNKNOWN";
  if (["FILLED", "FULLY_FILLED", "SUCCESS"].includes(raw)) return "FILLED";
  if (["PARTIAL", "PARTIALLY_FILLED"].includes(raw)) return "PARTIAL";
  if (["CANCELED", "CANCELLED"].includes(raw)) return "CANCELED";
  if (["REJECTED", "FAILED"].includes(raw)) return "REJECTED";
  if (["NEW", "INIT", "LIVE", "OPEN"].includes(raw)) return "OPEN";
  return raw;
}

// ================= PNL CALCULATION =================

/**
 * Calculate PnL for a futures position (direction-aware).
 * @param {string} side - "long" or "short"
 * @param {number} entry - entry price
 * @param {number} current - current price
 * @returns {number} PnL as fraction (e.g. 0.05 = 5%)
 */
function calcFuturesPnl(side, entry, current) {
  if (!entry || entry <= 0) return 0;
  if (side === "short") {
    return (entry - current) / entry;
  }
  return (current - entry) / entry;
}

/**
 * Calculate distance to liquidation price as percentage.
 * @returns {number} 0-1 (0 = at liquidation, 1 = far from liquidation)
 */
function calcLiquidationDistance(entry, liquidationPrice, currentPrice, side) {
  if (!liquidationPrice || liquidationPrice <= 0) return 1;
  if (side === "long") {
    const total = currentPrice - liquidationPrice;
    return total > 0 ? (currentPrice - liquidationPrice) / currentPrice : 0;
  }
  const total = liquidationPrice - currentPrice;
  return total > 0 ? (liquidationPrice - currentPrice) / currentPrice : 0;
}

// ================= SIZE CALCULATION =================

/**
 * Convert USDT notional to contract quantity for futures.
 * @param {number} plannedSizeUSDT - how much USDT to allocate
 * @param {number} leverage - leverage multiplier
 * @param {number} price - current asset price
 * @param {number} contractMultiplier - from getContractInfo
 * @returns {number} contract quantity (integer)
 */
function usdtToContracts(plannedSizeUSDT, leverage, price, contractMultiplier) {
  if (!price || price <= 0 || !contractMultiplier || contractMultiplier <= 0) return 0;
  const notional = plannedSizeUSDT * leverage;
  const contracts = notional / (price * contractMultiplier);
  return Math.max(1, Math.floor(contracts));
}

/**
 * Convert contract quantity back to USDT notional.
 */
function contractsToUsdt(contracts, price, contractMultiplier) {
  return contracts * price * contractMultiplier;
}

module.exports = {
  MIN_FUTURES_LEVERAGE,
  MAX_FUTURES_LEVERAGE,
  getFuturesConfig,
  isFuturesMode,
  getContractInfo,
  setLeverage,
  setMarginMode,
  ensureFuturesSetup,
  getFuturesBalance,
  getFuturesPositions,
  getLiveFundingRate,
  placeFuturesOrder,
  getFuturesOrder,
  normalizeFuturesOrderStatus,
  calcFuturesPnl,
  calcLiquidationDistance,
  usdtToContracts,
  contractsToUsdt,
  checkMarginCircuitBreaker
};
