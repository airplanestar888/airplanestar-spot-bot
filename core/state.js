const fs = require("fs");
const path = require("path");

function writeJsonAtomic(filePath, payload) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tempPath, filePath);
}

function loadState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return {
      position: null,
      positions: [],
      lastTradeTime: 0,
      tradesToday: 0,
      date: null,
      lastTradePnl: 0,
      lossStreak: 0,
      lastReportedPnl: null,
      lastReportedPnlBySymbol: {},
      entryBlockBySymbol: {},
      recentEntriesBySymbol: {},
      startOfDayEquity: null,
      haltedForDay: false,
      haltReason: null,
      realizedPnlToday: 0,
      realizedNetPnlToday: 0
    };
  }
}

function saveState(statePath, state) {
  writeJsonAtomic(statePath, state);
}

function loadHealth(healthPath) {
  try {
    return JSON.parse(fs.readFileSync(healthPath, "utf8"));
  } catch {
    return { startedAt: null, lastHeartbeat: null, uptimeSeconds: 0, status: "starting" };
  }
}

function saveHealth(healthPath, health, updates) {
  const newHealth = { ...health, ...updates };
  writeJsonAtomic(healthPath, newHealth);
  return newHealth;
}

function saveJsonFile(filePath, payload) {
  writeJsonAtomic(filePath, payload);
}

function loadJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

module.exports = { loadState, saveState, loadHealth, saveHealth, saveJsonFile, loadJsonFile };
