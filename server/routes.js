const fs = require("fs");
const path = require("path");
const { getPayload, saveConfig } = require("./stateAdapter");

const CLEAR_SCOPES = new Set(["today", "yesterday", "month", "all"]);
const CLEAR_TARGETS = new Set(["trades", "logs", "ai", "positions", "runtime", "state", "all"]);

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": `${contentType}; charset=utf-8`,
    "Cache-Control": "no-store"
  });
  res.end(fs.readFileSync(filePath, "utf8"));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function jsonPath(rootDir, ...parts) {
  return path.join(rootDir, ...parts);
}

function readJsonArray(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function jakartaParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const out = {};
  for (const part of parts) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  return out;
}

function jakartaKey(date = new Date()) {
  const p = jakartaParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function jakartaMonthKey(date = new Date()) {
  const p = jakartaParts(date);
  return `${p.year}-${p.month}`;
}

function scopeMatches(timestamp, scope, now = new Date()) {
  if (scope === "all") return true;
  const ts = new Date(timestamp || 0);
  if (!Number.isFinite(ts.getTime())) return false;
  if (scope === "today") return jakartaKey(ts) === jakartaKey(now);
  if (scope === "yesterday") {
    const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return jakartaKey(ts) === jakartaKey(y);
  }
  if (scope === "month") return jakartaMonthKey(ts) === jakartaMonthKey(now);
  return false;
}

function tradeTimestamp(trade) {
  return trade?.closedAt || trade?.openedAt || trade?.timestamp || trade?.entry?.timestamp || null;
}

function clearTradeJournal(rootDir, scope) {
  const filePath = jsonPath(rootDir, "data", "trade_journal.json");
  const entries = readJsonArray(filePath);
  const kept = scope === "all"
    ? []
    : entries.filter((entry) => !scopeMatches(tradeTimestamp(entry), scope));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(kept, null, 2), "utf8");
  return { target: "trades", removed: entries.length - kept.length, remaining: kept.length };
}

function extractLogTimestamp(line) {
  const match = String(line || "").match(/^\[([^\]]+)\]/);
  return match ? match[1] : null;
}

function clearLogFile(rootDir, scope) {
  const filePath = jsonPath(rootDir, "logs", "bot.log");
  if (!fs.existsSync(filePath)) return { target: "logs", removed: 0, remaining: 0 };
  if (scope === "all") {
    fs.writeFileSync(filePath, "", "utf8");
    return { target: "logs", removed: "all", remaining: 0 };
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  let removed = 0;
  const kept = lines.filter((line) => {
    if (!line) return false;
    const ts = extractLogTimestamp(line);
    const match = ts && scopeMatches(ts, scope);
    if (match) removed += 1;
    return !match;
  });
  fs.writeFileSync(filePath, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
  return { target: "logs", removed, remaining: kept.length };
}

function clearAiState(rootDir, scope) {
  const filePath = jsonPath(rootDir, "data", "ai_agent_state.jsonl");
  if (!fs.existsSync(filePath)) return { target: "ai", removed: 0, remaining: 0 };
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  let removed = 0;
  const kept = lines.filter((line) => {
    try {
      const row = JSON.parse(line);
      const match = scopeMatches(row?.at, scope);
      if (match) removed += 1;
      return !match;
    } catch (_) {
      return true;
    }
  });
  fs.writeFileSync(filePath, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
  return { target: "ai", removed, remaining: kept.length };
}

function positionTimestamp(position) {
  return position?.entryTime || position?.openedAt || position?.timestamp || null;
}

function clearManagedPositions(rootDir, scope) {
  const filePath = jsonPath(rootDir, "data", "state.json");
  if (!fs.existsSync(filePath)) return { target: "positions", removed: 0, remaining: 0 };
  let state;
  try {
    state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    state = {};
  }
  const positions = Array.isArray(state.positions)
    ? state.positions.filter(Boolean)
    : (state.position ? [state.position] : []);
  const removedSymbols = new Set();
  const kept = [];
  for (const position of positions) {
    const shouldRemove = scope === "all" || scopeMatches(positionTimestamp(position), scope);
    if (shouldRemove) {
      if (position?.symbol) removedSymbols.add(position.symbol);
      continue;
    }
    kept.push(position);
  }

  state.positions = kept;
  state.position = kept[0] || null;
  state.lastReportedPnl = null;
  if (state.lastReportedPnlBySymbol && typeof state.lastReportedPnlBySymbol === "object") {
    for (const symbol of removedSymbols) delete state.lastReportedPnlBySymbol[symbol];
  }
  if (state.recentEntriesBySymbol && typeof state.recentEntriesBySymbol === "object") {
    for (const symbol of removedSymbols) delete state.recentEntriesBySymbol[symbol];
    for (const [symbol, entry] of Object.entries(state.recentEntriesBySymbol)) {
      if (scope === "all" || scopeMatches(entry?.at, scope)) delete state.recentEntriesBySymbol[symbol];
    }
  }
  if (state.dryRunPaperBalance?.balances && typeof state.dryRunPaperBalance.balances === "object") {
    for (const symbol of removedSymbols) {
      const coin = String(symbol || "").replace(/USDT$/i, "").toLowerCase();
      if (coin) delete state.dryRunPaperBalance.balances[coin];
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  return { target: "positions", removed: positions.length - kept.length, remaining: kept.length };
}

function clearRuntimeSnapshots(rootDir, scope) {
  if (scope !== "all") {
    return { target: "runtime", removed: 0, remaining: "unchanged", skipped: "runtime snapshots only support all time" };
  }
  const files = ["health.json", "market_snapshot.json"];
  let removed = 0;
  for (const name of files) {
    const filePath = jsonPath(rootDir, "data", name);
    if (!fs.existsSync(filePath)) continue;
    fs.writeFileSync(filePath, JSON.stringify({}, null, 2), "utf8");
    removed += 1;
  }
  return { target: "runtime", removed, remaining: 0 };
}

function clearBotState(rootDir, scope) {
  const filePath = jsonPath(rootDir, "data", "state.json");
  if (!fs.existsSync(filePath)) return { target: "state", removed: 0, remaining: 0 };
  if (scope !== "all") {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (_) {
      state = {};
    }
    const currentDate = jakartaKey(new Date());
    const scopeTouchesToday = scope === "today" || scope === "month";
    if (scopeTouchesToday) {
      state.tradesToday = 0;
      state.realizedPnlToday = 0;
      state.realizedNetPnlToday = 0;
      state.lastTradePnl = 0;
      state.lossStreak = 0;
      state.lastReportedPnl = null;
      state.lastReportedPnlBySymbol = {};
      state.recentEntriesBySymbol = {};
      state.haltedForDay = false;
      state.haltReason = null;
      state.date = currentDate;
    }
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
    return { target: "state", removed: "scoped", remaining: "kept" };
  }
  fs.writeFileSync(filePath, JSON.stringify({}, null, 2), "utf8");
  return { target: "state", removed: 1, remaining: 0 };
}

function clearDashboardData(rootDir, { target, scope, confirm }) {
  const normalizedTarget = String(target || "").toLowerCase();
  const normalizedScope = String(scope || "").toLowerCase();
  if (!CLEAR_TARGETS.has(normalizedTarget)) throw new Error("Invalid clear target");
  if (!CLEAR_SCOPES.has(normalizedScope)) throw new Error("Invalid clear scope");
  if (String(confirm || "").toUpperCase() !== "CLEAR") {
    throw new Error("Confirmation token must be CLEAR");
  }

  const results = [];
  const includeTimed = (name) => normalizedTarget === "all" || normalizedTarget === name;
  const includeAllTimeOnly = (name) => normalizedTarget === name || (normalizedTarget === "all" && normalizedScope === "all");
  if (includeTimed("trades")) results.push(clearTradeJournal(rootDir, normalizedScope));
  if (includeTimed("logs")) results.push(clearLogFile(rootDir, normalizedScope));
  if (includeTimed("ai")) results.push(clearAiState(rootDir, normalizedScope));
  if ((includeTimed("positions") || normalizedTarget === "all") && normalizedScope !== "all") {
    results.push(clearManagedPositions(rootDir, normalizedScope));
  }
  if (includeAllTimeOnly("runtime")) results.push(clearRuntimeSnapshots(rootDir, normalizedScope));
  if (normalizedTarget === "state" || normalizedTarget === "all") results.push(clearBotState(rootDir, normalizedScope));
  return { ok: true, target: normalizedTarget, scope: normalizedScope, results };
}

async function handleApi(req, res, rootDir, pathname) {
  if (pathname === "/api/restart" && req.method === "POST") {
    sendJson(res, 200, {
      ok: true,
      message: "Restart requested. Bot will shutdown safely and relaunch when run.bat/run.sh is supervising it."
    });
    setTimeout(() => {
      process.emit("bot:restart-request", { source: "dashboard" });
    }, 100);
    return true;
  }

  if (pathname === "/api/config" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const saved = saveConfig(rootDir, body);
      sendJson(res, 200, { ok: true, config: saved });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return true;
  }

  if (pathname === "/api/clear-data" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const result = clearDashboardData(rootDir, body);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return true;
  }

  const key = pathname.replace("/api/", "").trim();
  const payload = getPayload(rootDir, key);

  if (payload === null) {
    sendJson(res, 404, { error: "Unknown endpoint" });
    return true;
  }

  sendJson(res, 200, payload);
  return true;
}

function handleRequest(req, res, { rootDir }) {
  const pathname = (req.url || "/").split("?")[0];
  const staticDir = path.join(rootDir, "server", "static");

  if (pathname.startsWith("/api/")) {
    return handleApi(req, res, rootDir, pathname);
  }

  if (pathname === "/" || pathname === "/dashboard" || pathname === "/dashboard/") {
    sendFile(res, path.join(staticDir, "dashboard.html"), "text/html");
    return;
  }

  if (pathname === "/dashboard.js") {
    sendFile(res, path.join(staticDir, "dashboard.js"), "application/javascript");
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

module.exports = { handleRequest };
