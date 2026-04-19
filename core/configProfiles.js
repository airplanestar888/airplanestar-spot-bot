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
  "requireEdge"
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

  return {
    ...currentConfig,
    pairs: enabledPairs,
    baseCoins: enabledPairs.map(symbol => symbol.replace(/USDT$/i, "").toUpperCase())
  };
}

function resolveMarketProfileKey(config, marketMode) {
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
      _effectiveAllowEntries: baseConfig._effectiveAllowEntries
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
  merged._effectiveAllowEntries = ["bearish", "choppy"].includes(marketProfileKey)
    ? false
    : profile.allowEntries !== false;
  return merged;
}

function composeActiveConfig(baseConfig, { botTypeKey, modeKey, marketMode } = {}) {
  let config = normalizePairConfig({ ...baseConfig });

  const botTypeProfile = config.botTypeProfiles?.[botTypeKey];
  if (botTypeProfile) {
    config = normalizePairConfig(
      mergeConfig(config, filterOverrides(botTypeProfile.overrides || {}, BOT_TYPE_OVERRIDE_KEYS))
    );
    config.selectedBotType = botTypeKey;
    config.activeBotType = botTypeKey;
    config.activeBotTypeLabel = botTypeProfile.label || botTypeKey;
  }

  const modeProfile = config.modeProfiles?.[modeKey];
  if (modeProfile) {
    config = normalizePairConfig(
      mergeConfig(config, filterOverrides(modeProfile.overrides || {}, null, BOT_TYPE_OVERRIDE_KEYS))
    );
    config.selectedMode = modeKey;
    config.activeMode = modeKey;
    config.activeModeLabel = modeProfile.label || modeKey;
  }

  const marketProfileKey = resolveMarketProfileKey(config, marketMode);
  config = applyMarketProfile(config, marketProfileKey);
  return config;
}

module.exports = {
  BOT_TYPE_OVERRIDE_KEYS,
  mergeConfig,
  filterOverrides,
  normalizePairConfig,
  resolveMarketProfileKey,
  applyMarketProfile,
  composeActiveConfig
};
