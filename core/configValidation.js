const fs = require("node:fs");
const path = require("node:path");

function isFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number);
}

function validateNumericRange(config, key, { min = -Infinity, max = Infinity } = {}) {
  const value = config[key];
  if (value === undefined) return [];
  if (!isFiniteNumber(value)) {
    return [`${key} must be a finite number`];
  }
  const num = Number(value);
  const issues = [];
  if (num < min) issues.push(`${key} must be >= ${min}`);
  if (num > max) issues.push(`${key} must be <= ${max}`);
  return issues;
}

function validatePositiveInterval(config, path, value) {
  if (!isFiniteNumber(value) || Number(value) <= 0) {
    return [`${path} must be > 0`];
  }
  return [];
}

function validateMinMax(config, minKey, maxKey) {
  if (!isFiniteNumber(config[minKey]) || !isFiniteNumber(config[maxKey])) return [];
  if (Number(config[minKey]) > Number(config[maxKey])) {
    return [`${minKey} must be <= ${maxKey}`];
  }
  return [];
}

function validateSelectedProfiles(config, { botTypeKey, modeKey, marketProfileKey }) {
  const issues = [];
  if (!config.botTypeProfiles?.[botTypeKey]) {
    issues.push(`selectedBotType "${botTypeKey}" not found`);
  }
  if (!config.modeProfiles?.[modeKey]) {
    issues.push(`selectedMode "${modeKey}" not found`);
  }
  if (config.marketProfileMode === "manual" && marketProfileKey && !config.marketProfiles?.[marketProfileKey]) {
    issues.push(`selectedMarketProfile "${marketProfileKey}" not found`);
  }
  return issues;
}

function validateConfig(config, selection = {}) {
  const issues = [
    ...validateSelectedProfiles(config, selection),
    ...validateNumericRange(config, "riskPercent", { min: 0.01, max: 0.2 }),
    ...validateNumericRange(config, "roundTripFeePct", { min: 0, max: 0.01 }),
    ...validateNumericRange(config, "slippageBufferPct", { min: 0, max: 0.01 }),
    ...validateNumericRange(config, "takeProfitPct", { min: 0.001, max: 0.2 }),
    ...validateNumericRange(config, "dynamicTakeProfitAtrMultiplier", { min: 0.1, max: 5 }),
    ...validateNumericRange(config, "trailingActivationPct", { min: 0.001, max: 0.2 }),
    ...validateNumericRange(config, "trailingDrawdownPct", { min: 0.0005, max: 0.2 }),
    ...validateNumericRange(config, "trailingProtectionPct", { min: 0, max: 0.2 }),
    ...validateNumericRange(config, "minExpectedNetPct", { min: 0, max: 0.05 }),
    ...validateNumericRange(config, "minScalpTargetPct", { min: 0.001, max: 0.2 }),
    ...validateNumericRange(config, "maxScalpTargetPct", { min: 0.001, max: 0.2 }),
    ...validateNumericRange(config, "minAtrPct", { min: 0, max: 0.2 }),
    ...validateNumericRange(config, "maxAtrPct", { min: 0, max: 0.2 }),
    ...validateNumericRange(config, "minVolumeRatio", { min: 0, max: 50 }),
    ...validateNumericRange(config, "maxEmaGapPct", { min: 0, max: 0.2 }),
    ...validateNumericRange(config, "minCandleStrength", { min: 0, max: 1 }),
    ...validateNumericRange(config, "breakoutPct", { min: 0.9, max: 1.1 }),
    ...validateNumericRange(config, "loopIntervalMs", { min: 1000, max: 86_400_000 }),
    ...validateNumericRange(config, "cooldownMs", { min: 0, max: 86_400_000 }),
    ...validateNumericRange(
      { ...config, maxRoundsPerDay: Number.isFinite(config.maxRoundsPerDay) ? config.maxRoundsPerDay : config.maxTradesPerDay },
      "maxRoundsPerDay",
      { min: 1, max: 100000 }
    ),
    ...validateNumericRange(config, "maxOpenPositions", { min: 1, max: 10 }),
    ...validateNumericRange(config, "exposureCapPct", { min: 0.05, max: 1 }),
    ...validatePositiveInterval(config, "report.heartbeatIntervalMs", config.report?.heartbeatIntervalMs),
    ...validatePositiveInterval(config, "report.marketReportIntervalMs", config.report?.marketReportIntervalMs),
    ...validatePositiveInterval(config, "report.balanceReportIntervalMs", config.report?.balanceReportIntervalMs),
    ...validatePositiveInterval(config, "report.holdReportIntervalMs", config.report?.holdReportIntervalMs),
    ...validatePositiveInterval(config, "report.noSignalReportIntervalMs", config.report?.noSignalReportIntervalMs),
    ...validateMinMax(config, "minBuyUSDT", "maxBuyUSDT"),
    ...validateMinMax(config, "minScalpTargetPct", "maxScalpTargetPct"),
    ...validateMinMax(config, "minAtrPct", "maxAtrPct"),
    ...validateMinMax(config, "rsiBandLower", "rsiBandUpper"),
    ...validateMinMax(config, "optimalRsiLow", "optimalRsiHigh"),
    ...validateMinMax(config, "optimalAtrLow", "optimalAtrHigh")
  ];

  const warnings = [];
  if (isFiniteNumber(config.reserveUSDT) && isFiniteNumber(config.minBuyUSDT) && Number(config.reserveUSDT) < 0) {
    warnings.push("reserveUSDT is negative");
  }
  if (config.useDynamicTakeProfit === true && Number(config.takeProfitPct || 0) <= 0) {
    warnings.push("dynamic TP is enabled while takeProfitPct base activation is not positive");
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings
  };
}

function renderProgressBar(current, total, label) {
  const clampedTotal = Math.max(total, 1);
  const clampedCurrent = Math.max(0, Math.min(current, clampedTotal));
  const width = 18;
  const filled = Math.round((clampedCurrent / clampedTotal) * width);
  const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
  return `[VALIDATION] [${bar}] ${clampedCurrent}/${clampedTotal} ${label}`;
}

function validateEngineFiles(projectRoot) {
  const issues = [];
  const requiredFiles = [
    "config.json",
    "core/exchange.js",
    "core/execution.js",
    "core/indicators.js",
    "core/logger.js",
    "core/portfolio.js",
    "core/reporting.js",
    "core/state.js",
    "core/strategy.js",
    "core/tradeLogger.js",
    "core/configProfiles.js",
    "core/configValidation.js",
    "core/runtime/reports.js",
    "core/runtime/exitFlow.js",
    "core/runtime/entryFlow.js"
  ];
  const requiredDirs = [
    "logs",
    "data"
  ];

  for (const relativePath of requiredFiles) {
    const fullPath = path.resolve(projectRoot, relativePath);
    if (!fs.existsSync(fullPath)) {
      issues.push(`missing engine file: ${relativePath}`);
      continue;
    }
    try {
      fs.accessSync(fullPath, fs.constants.R_OK);
    } catch (_) {
      issues.push(`engine file not readable: ${relativePath}`);
    }
  }

  for (const relativePath of requiredDirs) {
    const fullPath = path.resolve(projectRoot, relativePath);
    if (!fs.existsSync(fullPath)) {
      issues.push(`missing runtime directory: ${relativePath}`);
      continue;
    }
    try {
      fs.accessSync(fullPath, fs.constants.R_OK | fs.constants.W_OK);
    } catch (_) {
      issues.push(`runtime directory not writable: ${relativePath}`);
    }
  }

  return {
    ok: issues.length === 0,
    issues
  };
}

module.exports = {
  validateConfig,
  renderProgressBar,
  validateEngineFiles
};
