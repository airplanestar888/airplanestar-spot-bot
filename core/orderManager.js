/**
 * Order Manager — handles order status normalization, fee parsing,
 * order info retrieval, fill fetching, and order reconciliation.
 *
 * Extracted from core/index.js to reduce monolith size.
 */

// ================= STATUS HELPERS =================

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

// ================= FEE HELPERS =================

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

// ================= ORDER API =================

/**
 * Create order manager with injected dependencies.
 * @param {Object} deps
 * @param {Object} deps.config - Bot config (baseUrl, apiKey, secretKey, passphrase)
 * @param {Function} deps.request - Exchange request function
 * @param {Function} deps.logEvent - Log function
 * @param {string} deps.LOG_FILE - Log file path
 * @param {Function} deps.safeToFixed - Safe toFixed helper
 * @param {Function} deps.sleep - Sleep helper
 */
function createOrderManager({ config, request, logEvent, LOG_FILE, safeToFixed, sleep }) {

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

  return { getOrder, getOrderFills, reconcileOrder };
}

module.exports = {
  normalizeOrderStatus,
  isTerminalOrderStatus,
  toFiniteNumber,
  normalizeFeeCoin,
  parseOrderFee,
  convertFeeToUsdt,
  createOrderManager
};
