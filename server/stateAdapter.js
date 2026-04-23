const fs = require("fs");
const path = require("path");

function dataPath(rootDir, fileName) {
  return path.join(rootDir, "data", fileName);
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function syncDisplayedConfig(nextConfig) {
  const synced = { ...nextConfig };
  const selectedBotType = synced.selectedBotType;
  const botTypeOverrides = synced.botTypeProfiles?.[selectedBotType]?.overrides;

  if (botTypeOverrides && Number.isFinite(Number(botTypeOverrides.maxHoldMinutes))) {
    synced.maxHoldMinutes = Number(botTypeOverrides.maxHoldMinutes);
  }

  return synced;
}

function getManagedPositions(state) {
  if (Array.isArray(state.positions)) {
    return state.positions.filter((position) => position && typeof position === "object");
  }
  if (state.position && typeof state.position === "object") return [state.position];
  return [];
}

function buildRuntimeStatus(rootDir) {
  const config = readJsonSafe(path.join(rootDir, "config.json"), {});
  const state = readJsonSafe(dataPath(rootDir, "state.json"), {});
  const health = readJsonSafe(dataPath(rootDir, "health.json"), {});
  const trades = readJsonSafe(dataPath(rootDir, "trade_journal.json"), []);
  const managedPositions = getManagedPositions(state);

  const closedTrades = Array.isArray(trades)
    ? trades.filter((trade) => trade && trade.status === "closed")
    : [];
  const openTrades = Array.isArray(trades)
    ? trades.filter((trade) => trade && trade.status !== "closed")
    : [];
  const lastTrade = closedTrades.length ? closedTrades[closedTrades.length - 1] : null;

  return {
    now: new Date().toISOString(),
    botType: config.selectedBotType || "N/A",
    mode: config.selectedMode || "N/A",
    marketProfileMode: config.marketProfileMode || "auto",
    selectedMarketProfile: config.selectedMarketProfile || "N/A",
    halted: Boolean(state.halted),
    position: managedPositions[0] || null,
    positions: managedPositions,
    managedPositionCount: managedPositions.length,
    lossStreak: Number(state.lossStreak || 0),
    tradesToday: Number(state.tradesToday || 0),
    realizedPnlToday: Number(state.realizedPnlToday || 0),
    realizedNetPnlToday: Number(
      state.realizedNetPnlToday ?? state.realizedPnlToday ?? 0
    ),
    lastHeartbeatAt: health.lastHeartbeatAt || null,
    lastRunAt: health.lastRunAt || null,
    dataHealthy: health.dataHealthy !== false,
    openTradeCount: openTrades.length,
    closedTradeCount: closedTrades.length,
    lastTrade
  };
}

function getPayload(rootDir, kind) {
  const map = {
    status: () => buildRuntimeStatus(rootDir),
    config: () => readJsonSafe(path.join(rootDir, "config.json"), {}),
    trades: () => readJsonSafe(dataPath(rootDir, "trade_journal.json"), []),
    state: () => readJsonSafe(dataPath(rootDir, "state.json"), {}),
    health: () => readJsonSafe(dataPath(rootDir, "health.json"), {}),
    snapshot: () => readJsonSafe(dataPath(rootDir, "market_snapshot.json"), {}),
    readme: () => {
      const filePath = path.join(rootDir, "README.md");
      try {
        return { content: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "" };
      } catch (_) {
        return { content: "" };
      }
    }
  };

  return map[kind] ? map[kind]() : null;
}

function saveConfig(rootDir, nextConfig) {
  const filePath = path.join(rootDir, "config.json");
  if (!nextConfig || typeof nextConfig !== "object" || Array.isArray(nextConfig)) {
    throw new Error("Invalid config payload");
  }

  const normalizedConfig = syncDisplayedConfig(nextConfig);
  fs.writeFileSync(filePath, JSON.stringify(normalizedConfig, null, 2), "utf8");
  return readJsonSafe(filePath, normalizedConfig);
}

module.exports = { getPayload, saveConfig };
