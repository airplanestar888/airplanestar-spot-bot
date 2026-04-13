/**
 * core/pairRotation.js
 * 
 * Standalone auto pair rotation module.
 * Completely independent from the main trading loop (runBot).
 * 
 * Runs on its own scheduler (setInterval). Only rotates pairs when:
 * 1. autoPairRotation.enabled === true
 * 2. refreshIntervalHours have elapsed since last rotation
 * 3. Zero open positions (all tokens sold)
 * 
 * When triggered, fetches tickers from exchange, scores pairs based on
 * configurable criteria (sortBy), picks topN, and writes to config.json
 * pairSettings. The main loop naturally picks up the new pairs.
 */

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.resolve(__dirname, "..", "config.json");
const JOURNAL_PATH = path.resolve(__dirname, "..", "data", "trade_journal.json");
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes

let schedulerTimer = null;
let lastRotationAt = 0;
let lastRotationSignature = "";
let rotationStatus = {
  enabled: false,
  lastRotationAt: null,
  nextCheckAt: null,
  lastResult: null,
  activePairs: [],
  skippedReason: null
};

// ================= HELPERS =================

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function getRotationConfig(config) {
  const defaults = {
    enabled: false,
    refreshIntervalHours: 6,
    topPairs: 10,
    sortBy: "combined",
    disableOnStopLoss: true,
    stopLossCooldownHours: 24,
    minQuoteVolumeUSDT: 500000,
    maxAbsChangePct: 40,
    minChangePct: -8
  };
  const raw = isPlainObject(config.autoPairRotation) ? config.autoPairRotation : {};
  return {
    enabled: raw.enabled === true,
    refreshIntervalHours: Math.max(1, Number(raw.refreshIntervalHours ?? defaults.refreshIntervalHours)),
    topPairs: Math.max(1, Number(raw.topPairs ?? defaults.topPairs)),
    sortBy: ["volume", "momentum", "combined"].includes(raw.sortBy) ? raw.sortBy : defaults.sortBy,
    disableOnStopLoss: raw.disableOnStopLoss !== false,
    stopLossCooldownHours: Math.max(1, Number(raw.stopLossCooldownHours ?? defaults.stopLossCooldownHours)),
    minQuoteVolumeUSDT: Math.max(0, Number(raw.minQuoteVolumeUSDT ?? defaults.minQuoteVolumeUSDT)),
    maxAbsChangePct: Math.max(1, Number(raw.maxAbsChangePct ?? defaults.maxAbsChangePct)),
    minChangePct: Number(raw.minChangePct ?? defaults.minChangePct)
  };
}

function getStopLossBlacklistSymbols(rotationCfg, now = Date.now()) {
  const symbols = new Set();
  if (!rotationCfg.disableOnStopLoss) return symbols;

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
      if (!(reason.includes("emergency sl") || reason.includes("atr stop loss"))) continue;
      const pair = String(row.pair || "").toUpperCase();
      if (!pair) continue;
      const closedAt = new Date(row.closedAt || row.openedAt || 0).getTime();
      if (!Number.isFinite(closedAt) || closedAt < cutoff) continue;
      symbols.add(pair);
    }
  } catch (_) {
    // Silently ignore read errors
  }
  return symbols;
}

function scorePair(row, sortBy, extractors) {
  const quoteVol = extractors.quoteVolume(row);
  const changePct = extractors.changePct(row);
  const volumeScore = Math.log10(Math.max(quoteVol, 1));
  const momentumScore = Math.max(-8, Math.min(18, changePct));

  switch (sortBy) {
    case "volume":
      return volumeScore;
    case "momentum":
      return momentumScore;
    case "combined":
    default:
      return (volumeScore * 1.2) + (momentumScore * 0.35);
  }
}

function updateConfigPairSettings(pickedPairs, log) {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const configOnDisk = JSON.parse(raw);
    const currentPairSettings = isPlainObject(configOnDisk.pairSettings) ? configOnDisk.pairSettings : {};

    // Build new pairSettings: picked pairs enabled, everything else disabled
    const newPairSettings = {};

    // First add picked pairs as enabled
    for (const symbol of pickedPairs) {
      newPairSettings[symbol] = { enabled: true };
    }

    // Then add existing pairs that are NOT in picked list as disabled
    for (const [symbol, value] of Object.entries(currentPairSettings)) {
      if (!newPairSettings[symbol]) {
        newPairSettings[symbol] = { enabled: false };
      }
    }

    configOnDisk.pairSettings = newPairSettings;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(configOnDisk, null, 2) + "\n", "utf8");
    log("INFO", `Auto-rotate wrote ${pickedPairs.length} pairs to config.json`);
    return true;
  } catch (err) {
    log("ERROR", `Auto-rotate failed to write config.json: ${err.message}`);
    return false;
  }
}

// ================= CORE ROTATION =================

async function executeRotation(deps) {
  const { config, state, request, extractors, log, report, normalizePairConfig } = deps;
  const now = Date.now();
  const rotationCfg = getRotationConfig(config);

  // Guard: not enabled
  if (!rotationCfg.enabled) {
    rotationStatus.enabled = false;
    rotationStatus.skippedReason = "disabled";
    return;
  }

  rotationStatus.enabled = true;

  // Guard: not enough time elapsed
  const refreshMs = rotationCfg.refreshIntervalHours * 60 * 60 * 1000;
  if (lastRotationAt > 0 && (now - lastRotationAt) < refreshMs) {
    const nextAt = lastRotationAt + refreshMs;
    rotationStatus.nextCheckAt = new Date(nextAt).toISOString();
    rotationStatus.skippedReason = `next rotation at ${new Date(nextAt).toLocaleTimeString("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" })}`;
    return;
  }

  // Guard: open positions exist
  const positions = Array.isArray(state.positions) ? state.positions.filter(Boolean) : [];
  if (positions.length > 0) {
    rotationStatus.skippedReason = `open positions (${positions.length})`;
    log("DEBUG", `Auto-rotate skipped: ${positions.length} open position(s)`);
    return;
  }

  // Execute rotation
  log("INFO", "Auto-rotate starting pair refresh...");
  rotationStatus.skippedReason = null;

  try {
    const data = await request(
      config.baseUrl, config.apiKey, config.secretKey, config.passphrase,
      "GET", "/api/v2/spot/market/tickers"
    );
    const rows = extractors.tickerRows(data);
    const stopLossBlacklist = getStopLossBlacklistSymbols(rotationCfg, now);
    const scored = [];

    for (const row of rows) {
      const symbol = extractors.symbol(row);
      if (!symbol.endsWith("USDT")) continue;
      if (symbol.includes("3L") || symbol.includes("3S") || symbol.includes("5L") || symbol.includes("5S")) continue;
      if (stopLossBlacklist.has(symbol)) continue;

      const last = extractors.price(row);
      const quoteVol = extractors.quoteVolume(row);
      const changePct = extractors.changePct(row);

      if (!Number.isFinite(last) || last <= 0) continue;
      if (quoteVol < rotationCfg.minQuoteVolumeUSDT) continue;
      if (Math.abs(changePct) > rotationCfg.maxAbsChangePct) continue;
      if (changePct < rotationCfg.minChangePct) continue;

      const score = scorePair(row, rotationCfg.sortBy, extractors);
      scored.push({ symbol, score, quoteVol, changePct });
    }

    scored.sort((a, b) => b.score - a.score || b.quoteVol - a.quoteVol || a.symbol.localeCompare(b.symbol));
    const picked = scored.slice(0, rotationCfg.topPairs).map(item => item.symbol);

    if (!picked.length) {
      lastRotationAt = now;
      rotationStatus.lastRotationAt = new Date(now).toISOString();
      rotationStatus.lastResult = "no-candidates";
      rotationStatus.activePairs = [];
      log("WARN", "Auto-rotate found no eligible pair candidates");
      return;
    }

    const signature = picked.join(",");
    const changed = signature !== lastRotationSignature;

    // Write to config.json pairSettings
    const written = updateConfigPairSettings(picked, log);
    if (!written) return;

    // Update runtime config.pairs so bot picks up immediately
    const updated = normalizePairConfig(config);
    config.pairs = updated.pairs;
    config.baseCoins = updated.baseCoins;

    lastRotationAt = now;
    lastRotationSignature = signature;

    rotationStatus.lastRotationAt = new Date(now).toISOString();
    rotationStatus.nextCheckAt = new Date(now + refreshMs).toISOString();
    rotationStatus.lastResult = changed ? "rotated" : "no-change";
    rotationStatus.activePairs = picked;
    rotationStatus.skippedReason = null;

    if (changed) {
      log("INFO", `Auto-rotate active pairs (${picked.length}): ${picked.join(", ")}`);
      if (report) {
        const sortLabel = rotationCfg.sortBy === "volume" ? "Volume 24h" : rotationCfg.sortBy === "momentum" ? "Momentum" : "Combined";
        await report(
          `🔄 AUTO PAIR ROTATION\n` +
          `Sort: ${sortLabel}\n` +
          `Pairs (${picked.length}): ${picked.join(", ")}\n` +
          `Blacklisted: ${stopLossBlacklist.size}\n` +
          `Next rotation: ~${rotationCfg.refreshIntervalHours}h`
        );
      }
    } else {
      log("DEBUG", `Auto-rotate checked, no pair changes (${picked.length} active)`);
    }
  } catch (err) {
    log("ERROR", `Auto-rotate failed: ${err.message}`);
    rotationStatus.lastResult = "error";
    rotationStatus.skippedReason = err.message;
  }
}

// ================= SCHEDULER =================

function startRotationScheduler(deps) {
  stopRotationScheduler();
  const { log } = deps;

  // Re-read config from disk to get fresh autoPairRotation settings
  const rotationCfg = getRotationConfig(deps.config);
  rotationStatus.enabled = rotationCfg.enabled;

  if (!rotationCfg.enabled) {
    log("INFO", "Auto pair rotation: disabled in config");
    return;
  }

  log("INFO", `Auto pair rotation: enabled (every ${rotationCfg.refreshIntervalHours}h, top ${rotationCfg.topPairs}, sort by ${rotationCfg.sortBy})`);

  // Run immediately on startup (if conditions met)
  executeRotation(deps).catch(err => {
    log("ERROR", `Auto-rotate startup check failed: ${err.message}`);
  });

  // Then check periodically
  schedulerTimer = setInterval(() => {
    // Re-read enabled flag from live config (dashboard can toggle)
    const liveCfg = getRotationConfig(deps.config);
    rotationStatus.enabled = liveCfg.enabled;
    if (!liveCfg.enabled) {
      rotationStatus.skippedReason = "disabled";
      return;
    }
    executeRotation(deps).catch(err => {
      log("ERROR", `Auto-rotate check failed: ${err.message}`);
    });
  }, CHECK_INTERVAL_MS);
}

function stopRotationScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

function getRotationStatus() {
  return { ...rotationStatus };
}

module.exports = {
  startRotationScheduler,
  stopRotationScheduler,
  getRotationStatus,
  getRotationConfig
};
