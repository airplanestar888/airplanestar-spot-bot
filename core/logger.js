const fs = require("fs");
const path = require("path");

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  white: "\x1b[37m",
  green: "\x1b[32m",
  brightGreen: "\x1b[92m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  brightRed: "\x1b[91m",
  cyan: "\x1b[36m"
};

const lastCliDebugSummaryAt = new Map();

function cliTime(isoTime) {
  const dt = new Date(isoTime);
  if (Number.isNaN(dt.getTime())) return "--:--:--";
  return dt.toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Jakarta"
  });
}

function padRight(text, width) {
  const value = String(text || "");
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function getCliStatus(level, message) {
  const upper = String(level || "").toUpperCase();
  const text = String(message || "");

  if (upper === "ERROR" || /\bERROR\b/i.test(text)) {
    return { label: "ERROR", color: COLORS.brightRed };
  }
  if (upper === "WARN" || /\bWARN\b/i.test(text)) {
    return { label: "WARN", color: COLORS.yellow };
  }
  if (upper === "DEBUG") {
    return { label: "PASS", color: COLORS.cyan };
  }
  if (upper === "INFO") {
    return { label: "OK", color: COLORS.brightGreen };
  }
  if (upper === "REPORT") {
    return { label: "OK", color: COLORS.green };
  }

  return { label: upper || "LOG", color: COLORS.white };
}

function summarizeCliMessage(level, message) {
  const upper = String(level || "").toUpperCase();
  const text = String(message || "");

  if (upper === "REPORT") {
    const firstLine = text.split(/\r?\n/, 1)[0] || text;
    const cleaned = firstLine.replace(/^[^\p{L}\p{N}]+/u, "").trim();
    return cleaned || "Report sent";
  }

  if (upper !== "DEBUG") return text;

  const mappings = [
    { pattern: /^getTickers fetched\b/i, label: "getTickers fetched" },
    { pattern: /^PRICE MAP FINAL\b/i, label: "PRICE MAP FINAL" },
    { pattern: /^COMPUTE EQUITY ASSETS\b/i, label: "COMPUTE EQUITY ASSETS" },
    { pattern: /^COMPUTE EQUITY END\b/i, label: "COMPUTE EQUITY END" },
    { pattern: /^EXIT CHECK\b/i, label: "EXIT CHECK" },
    { pattern: /^SCANNING BALANCES FOR POSITION RECOVERY\b/i, label: "POSITION RECOVERY SCAN" },
    { pattern: /^Heartbeat check\b/i, label: "Heartbeat check" },
    { pattern: /^Heartbeat send \| start\b/i, label: "Heartbeat send" },
    { pattern: /^Heartbeat send \| sent=/i, label: "Heartbeat send" }
  ];

  const candleMatch = text.match(/^Candle fetch\s+(\S+)\s+\(([^)]+)\)/i);
  if (candleMatch) {
    return `Candle fetch ${candleMatch[2]} pass`;
  }

  for (const item of mappings) {
    if (item.pattern.test(text)) {
      return item.label;
    }
  }

  return text;
}

function printCliEntry(entry) {
  const timeText = cliTime(entry.time);
  const status = getCliStatus(entry.level, entry.message);
  const displayMessage = summarizeCliMessage(entry.level, entry.message);
  const upper = String(entry.level || "").toUpperCase();
  if (upper === "DEBUG" && /^Candle fetch\s+/i.test(displayMessage)) {
    const nowMs = Date.parse(entry.time) || Date.now();
    const lastAt = lastCliDebugSummaryAt.get(displayMessage) || 0;
    if ((nowMs - lastAt) < 5000) {
      return;
    }
    lastCliDebugSummaryAt.set(displayMessage, nowMs);
  }
  const divider = `${COLORS.dim}|${COLORS.reset}`;
  console.log(
    `${COLORS.brightGreen}${timeText}${COLORS.reset} ${divider} ${status.color}${padRight(status.label, 5)}${COLORS.reset} ${divider} ${COLORS.white}${displayMessage}${COLORS.reset}`
  );
}

function resolveLogArgs(args) {
  if (args.length >= 5) {
    const [, logFile, level, message, meta = {}] = args;
    return { logFile, level, message, meta };
  }
  const [logFile, level, message, meta = {}] = args;
  return { logFile, level, message, meta };
}

function logEvent(...args) {
  const { logFile, level, message, meta } = resolveLogArgs(args);
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...meta
  };

  if (logFile) {
    fs.appendFileSync(logFile, `[${entry.time}] [${level}] ${message}\n`);
  }

  printCliEntry(entry);
}

module.exports = { logEvent };
