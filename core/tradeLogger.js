const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const JOURNAL_PATH = path.join(DATA_DIR, "trade_journal.json");
const LEGACY_CSV_PATH = path.join(ROOT_DIR, "trades.csv");

function safeNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  result.push(current);
  return result;
}

function loadJournal() {
  if (!fs.existsSync(JOURNAL_PATH)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(JOURNAL_PATH, "utf8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Failed to load trade journal:", err.message);
    return [];
  }
}

function saveJournal(entries) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(JOURNAL_PATH, JSON.stringify(entries, null, 2));
}

function buildTradeId(trade) {
  const pair = trade.symbol || trade.pair || "UNKNOWN";
  const source = trade.source || "manual";
  const ts = trade.timestamp || new Date().toISOString();
  return `${pair}:${source}:${ts}`;
}

function createEntryRecord(trade) {
  return {
    id: buildTradeId(trade),
    status: "open",
    botType: trade.botType || "",
    mode: trade.mode || "",
    marketProfile: trade.marketProfile || "",
    marketProfileMode: trade.marketProfileMode || "",
    source: trade.source || "",
    pair: trade.symbol || trade.pair || "",
    side: "buy",
    openedAt: trade.timestamp || new Date().toISOString(),
    closedAt: null,
    holdMinutes: null,
    entry: {
      price: safeNumber(trade.price),
      qty: safeNumber(trade.qty),
      sizeUSDT: safeNumber(trade.sizeUSDT),
      reason: trade.reason || "",
      rsi: safeNumber(trade.entry_rsi),
      atrPct: safeNumber(trade.entry_atrPct),
      score: safeNumber(trade.entry_score),
      marketMode: trade.entry_marketMode || "",
      volatility: trade.entry_volatility || ""
    },
    exit: null,
    metrics: {
      grossPnlUSDT: null,
      grossPnlPct: null,
      netPnlEstPct: safeNumber(trade.netPnlEstPct),
      peakPnlPct: null,
      drawdownFromPeak: null
    }
  };
}

function closeEntryRecord(record, trade) {
  const closedAt = trade.timestamp || new Date().toISOString();
  const openedAtMs = new Date(record.openedAt).getTime();
  const closedAtMs = new Date(closedAt).getTime();
  const holdMinutes =
    Number.isFinite(openedAtMs) && Number.isFinite(closedAtMs)
      ? Math.max(0, Math.round((closedAtMs - openedAtMs) / 60000))
      : null;

  record.status = "closed";
  record.closedAt = closedAt;
  record.holdMinutes = holdMinutes;
  if (trade.botType && !record.botType) {
    record.botType = trade.botType;
  }
  if (trade.mode && !record.mode) {
    record.mode = trade.mode;
  }
  if (trade.marketProfile && !record.marketProfile) {
    record.marketProfile = trade.marketProfile;
  }
  if (trade.marketProfileMode && !record.marketProfileMode) {
    record.marketProfileMode = trade.marketProfileMode;
  }

  record.exit = {
    price: safeNumber(trade.price),
    qty: safeNumber(trade.qty),
    sizeUSDT: safeNumber(trade.sizeUSDT),
    reason: trade.exit_reason || trade.reason || "",
    rsi: safeNumber(trade.exit_rsi)
  };

  record.metrics.grossPnlUSDT = safeNumber(trade.PnL);
  record.metrics.grossPnlPct = safeNumber(trade.PnL_pct);
  record.metrics.netPnlEstPct = safeNumber(trade.netPnlEstPct);
  record.metrics.peakPnlPct = safeNumber(trade.peakPnlPct);
  record.metrics.drawdownFromPeak = safeNumber(trade.drawdownFromPeak);

  return record;
}

function findOpenRecord(entries, pair) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.pair === pair && entry.status === "open") {
      return entry;
    }
  }
  return null;
}

function upsertEntryRecord(entries, trade) {
  const pair = trade.symbol || trade.pair || "";
  const existing = findOpenRecord(entries, pair);

  if (existing) {
    existing.botType = trade.botType || existing.botType || "";
    existing.mode = trade.mode || existing.mode;
    existing.marketProfile = trade.marketProfile || existing.marketProfile || "";
    existing.marketProfileMode = trade.marketProfileMode || existing.marketProfileMode || "";
    existing.source = trade.source || existing.source;
    existing.openedAt = trade.timestamp || existing.openedAt;
    existing.entry = {
      price: safeNumber(trade.price),
      qty: safeNumber(trade.qty),
      sizeUSDT: safeNumber(trade.sizeUSDT),
      reason: trade.reason || existing.entry.reason || "",
      rsi: safeNumber(trade.entry_rsi),
      atrPct: safeNumber(trade.entry_atrPct),
      score: safeNumber(trade.entry_score),
      marketMode: trade.entry_marketMode || existing.entry.marketMode || "",
      volatility: trade.entry_volatility || existing.entry.volatility || ""
    };
    return existing;
  }

  const record = createEntryRecord(trade);
  entries.push(record);
  return record;
}

function migrateLegacyCsv() {
  if (!fs.existsSync(LEGACY_CSV_PATH)) return;
  if (fs.existsSync(JOURNAL_PATH)) return;

  const lines = fs.readFileSync(LEGACY_CSV_PATH, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) {
    saveJournal([]);
    return;
  }

  const header = parseCsvLine(lines[0]);
  const entries = [];

  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const row = {};
    for (let i = 0; i < header.length; i++) {
      row[header[i]] = cols[i] ?? "";
    }

    const trade = {
      timestamp: row.timestamp,
      type: row.type || (row.side === "sell" ? "exit" : "entry"),
      source: row.source,
      pair: row.pair,
      side: row.side,
      price: row.price,
      qty: row.qty,
      sizeUSDT: row.sizeUSDT,
      PnL: row.PnL,
      PnL_pct: row.PnL_pct,
      reason: row.reason,
      entry_rsi: row.entry_rsi,
      entry_atrPct: row.entry_atrPct,
      entry_score: row.entry_score,
      entry_marketMode: row.entry_marketMode,
      entry_volatility: row.entry_volatility,
      exit_reason: row.exit_reason,
      exit_rsi: row.exit_rsi,
      peakPnlPct: row.peakPnlPct,
      drawdownFromPeak: row.drawdownFromPeak
    };

    if (trade.type === "exit" || trade.side === "sell") {
      const openRecord = findOpenRecord(entries, trade.pair);
      if (openRecord) {
        closeEntryRecord(openRecord, trade);
      } else {
        const synthetic = createEntryRecord({
          ...trade,
          reason: "legacy reconstructed entry",
          sizeUSDT: trade.sizeUSDT
        });
        closeEntryRecord(synthetic, trade);
        entries.push(synthetic);
      }
      continue;
    }

    upsertEntryRecord(entries, trade);
  }

  saveJournal(entries);
}

function logTrade(trade) {
  try {
    migrateLegacyCsv();
    const entries = loadJournal();

    if (trade.type === "exit") {
      const openRecord = findOpenRecord(entries, trade.pair || trade.symbol || "");
      if (openRecord) {
        closeEntryRecord(openRecord, trade);
      } else {
        const synthetic = createEntryRecord({
          ...trade,
          reason: "reconstructed entry",
          source: trade.source || "unknown"
        });
        closeEntryRecord(synthetic, trade);
        entries.push(synthetic);
      }
    } else if (trade.type === "entry" || trade.type === "BUY" || !trade.type) {
      upsertEntryRecord(entries, trade);
    }

    saveJournal(entries);
  } catch (err) {
    console.error("Failed to log trade:", err.message);
  }
}

migrateLegacyCsv();

module.exports = { logTrade, JOURNAL_PATH };
