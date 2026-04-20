const axios = require("axios");

const PROFILE_KEYS = new Set(["bullish", "bullish_slow", "neutral", "bearish", "choppy", "custom"]);
const MARKET_FILTER_KEYS = new Set([
  "minExpectedNetPct",
  "minVolumeRatio",
  "minTrendRsi",
  "minAtrPct",
  "maxAtrPct",
  "maxEmaGapPct",
  "rsiBandLower",
  "rsiBandUpper",
  "minCandleStrength",
  "minEmaGapNeg",
  "optimalRsiLow",
  "optimalRsiHigh",
  "optimalAtrLow",
  "optimalAtrHigh"
]);
const QUALITY_FILTER_KEYS = new Set([
  "requireRsiMomentum",
  "requireBreakout",
  "enableRsiBandFilter",
  "enableAtrFilter",
  "enableVolumeFilter",
  "enableCandleStrengthFilter",
  "enablePriceExtensionFilter",
  "enableRangeRecoveryFilter"
]);
const AI_AGENT_PROFILE_KEY = "ai_agent";

const RANGES = {
  minExpectedNetPct: [0, 0.05],
  minVolumeRatio: [0, 50],
  minTrendRsi: [0, 100],
  minAtrPct: [0, 0.2],
  maxAtrPct: [0, 0.2],
  maxEmaGapPct: [0, 0.2],
  rsiBandLower: [0, 100],
  rsiBandUpper: [0, 100],
  minCandleStrength: [0, 1],
  minEmaGapNeg: [0, 0.2],
  optimalRsiLow: [0, 100],
  optimalRsiHigh: [0, 100],
  optimalAtrLow: [0, 0.2],
  optimalAtrHigh: [0, 0.2]
};

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function clampNumber(key, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !RANGES[key]) return null;
  const [min, max] = RANGES[key];
  return Math.max(min, Math.min(max, n));
}

function normalizeCustomNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getAiAgentSettings(config) {
  const raw = isPlainObject(config.aiAgent) ? config.aiAgent : {};
  const allowed = isPlainObject(raw.allowedDecisions) ? raw.allowedDecisions : {};
  const safety = isPlainObject(raw.safety) ? raw.safety : {};
  return {
    enabled: raw.enabled === true || process.env.AI_AGENT_ENABLED === "true",
    provider: String(process.env.AI_PROVIDER || raw.provider || "openai").toLowerCase(),
    model: process.env.OPENAI_MODEL || raw.model || "gpt-5-mini",
    geminiModel: process.env.GEMINI_MODEL || raw.geminiModel || "gemini-2.5-flash",
    openrouterModel: process.env.OPENROUTER_MODEL || raw.openrouterModel || "openai/gpt-5-mini",
    timeoutMs: Math.max(3000, Math.min(20000, Number(process.env.AI_AGENT_TIMEOUT_MS || raw.timeoutMs || 8000))),
    retryAttempts: Math.max(1, Math.min(3, Number(process.env.AI_AGENT_RETRY_ATTEMPTS || raw.retryAttempts || 3))),
    allowMarketProfile: allowed.marketProfile !== false,
    allowEntriesToggle: allowed.entriesToggle !== false,
    allowMarketFilters: allowed.marketFilters !== false,
    allowQualityFilters: allowed.qualityFilters !== false,
    fallbackRuleBased: safety.fallbackRuleBased !== false,
    telegramReport: safety.telegramReport !== false
  };
}

function extractResponseText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  const parts = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n");
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function extractFirstJsonObject(text) {
  const source = String(text || "");
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function parseJson(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  const direct = tryParseJson(cleaned);
  if (direct) return direct;

  const extracted = extractFirstJsonObject(cleaned);
  if (extracted) {
    const parsed = tryParseJson(extracted);
    if (parsed) return parsed;
  }

  const normalized = cleaned
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .trim();
  const normalizedParsed = tryParseJson(normalized);
  if (normalizedParsed) return normalizedParsed;

  const normalizedExtracted = extractFirstJsonObject(normalized);
  if (normalizedExtracted) return tryParseJson(normalizedExtracted);
  return null;
}

function normalizeRotationCandidates(candidates) {
  if (!Array.isArray(candidates)) return [];
  return candidates
    .filter((item) => isPlainObject(item) && typeof item.symbol === "string" && item.symbol)
    .map((item) => ({
      symbol: String(item.symbol).toUpperCase(),
      score: Number(item.score),
      quoteVol: Number(item.quoteVol),
      changePct: Number(item.changePct),
      rangePct: Number(item.rangePct),
      last: Number(item.last)
    }))
    .filter((item) =>
      Number.isFinite(item.score) &&
      Number.isFinite(item.quoteVol) &&
      Number.isFinite(item.changePct) &&
      Number.isFinite(item.rangePct) &&
      Number.isFinite(item.last)
    );
}

function buildPrompt({ config, rotation, candidates }) {
  const mkField = (value, meaning) => ({
    value,
    meaning
  });
  const activePairSet = new Set(Array.isArray(rotation?.activePairs) ? rotation.activePairs : []);
  const rankedCandidates = normalizeRotationCandidates(candidates).slice(0, 20).map((item, index) => ({
    rank: index + 1,
    symbol: item.symbol,
    score: Number(item.score?.toFixed ? item.score.toFixed(4) : item.score),
    changePct: item.changePct,
    rangePct: item.rangePct,
    activeNow: activePairSet.has(item.symbol)
  }));
  const aiAgentProfile = isPlainObject(config.marketProfiles?.[AI_AGENT_PROFILE_KEY])
    ? config.marketProfiles[AI_AGENT_PROFILE_KEY]
    : {};
  const richContext = {
    role: {
      persona: "Senior crypto spot trader in 2026",
      objective: "Preserve capital, tune the AI agent workspace profile only, avoid weak or overextended entries."
    },
    botContext: {
      selectedBotType: mkField(config.selectedBotType || "custom", "entry style"),
      selectedMode: mkField(config.selectedMode || "custom", "trade style"),
      signalTimeframe: mkField(config.signalTimeframe, "entry timeframe"),
      trendTimeframe: mkField(config.trendTimeframe, "trend timeframe"),
      minScalpTargetPct: mkField(config.minScalpTargetPct, "min target"),
      maxScalpTargetPct: mkField(config.maxScalpTargetPct, "max target"),
      timeStopMinutes: mkField(config.timeStopMinutes, "time stop"),
      maxHoldMinutes: mkField(config.maxHoldMinutes, "max hold"),
      breakEvenMinutes: mkField(config.breakEvenMinutes, "break-even timing"),
      minConfirmation: mkField(config.minConfirmation, "confirmations"),
      breakoutPct: mkField(config.breakoutPct, "breakout threshold"),
      requireEma21Rising: mkField(config.requireEma21Rising, "EMA21 rising"),
      requireFastTrend: mkField(config.requireFastTrend, "fast trend"),
      requirePriceAboveEma9: mkField(config.requirePriceAboveEma9, "price above EMA9"),
      requireEdge: mkField(config.requireEdge, "edge filter"),
      requireRsiMomentum: mkField(config.requireRsiMomentum, "RSI momentum"),
      requireBreakout: mkField(config.requireBreakout, "breakout check"),
      enableRsiBandFilter: mkField(config.enableRsiBandFilter, "RSI band"),
      enableAtrFilter: mkField(config.enableAtrFilter, "ATR filter"),
      enableVolumeFilter: mkField(config.enableVolumeFilter, "volume filter"),
      enableCandleStrengthFilter: mkField(config.enableCandleStrengthFilter, "candle strength"),
      enablePriceExtensionFilter: mkField(config.enablePriceExtensionFilter, "price extension"),
      enableRangeRecoveryFilter: mkField(config.enableRangeRecoveryFilter, "range recovery")
    },
    aiAgentWorkspaceProfile: {
      allowEntries: aiAgentProfile.allowEntries !== false,
      entryOverrides: { ...(aiAgentProfile.entryOverrides || {}) }
    },
    rankedCandidates,
    minimalGlobalContext: {
      candidateCount: candidates?.length || 0,
      activePairCount: activePairSet.size,
      averageCandidateChangePct: rankedCandidates.length ? Number((rankedCandidates.reduce((sum, item) => sum + (Number(item.changePct) || 0), 0) / rankedCandidates.length).toFixed(4)) : 0,
      averageCandidateRangePct: rankedCandidates.length ? Number((rankedCandidates.reduce((sum, item) => sum + (Number(item.rangePct) || 0), 0) / rankedCandidates.length).toFixed(4)) : 0,
      rotationTopPairs: rotation?.topPairs || null,
      rotationCategories: rotation?.activeCategories || "-"
    },
    constraints: {
      allowedChanges: ["allowEntries", "entryOverrides", "reason"],
      forbiddenChanges: ["riskPercent", "sizing", "pair list", "bot type", "trade mode", "TP", "SL", "cooldown"]
    },
    expectedOutputSchema: {
      allowEntries: "<boolean_if_you_want_to_change_it>",
      entryOverrides: {
        minExpectedNetPct: "<number_if_changed>",
        minVolumeRatio: "<number_if_changed>",
        minTrendRsi: "<number_if_changed>",
        minAtrPct: "<number_if_changed>",
        maxAtrPct: "<number_if_changed>",
        maxEmaGapPct: "<number_if_changed>",
        rsiBandLower: "<number_if_changed>",
        rsiBandUpper: "<number_if_changed>",
        minCandleStrength: "<number_if_changed>",
        minEmaGapNeg: "<number_if_changed>",
        optimalRsiLow: "<number_if_changed>",
        optimalRsiHigh: "<number_if_changed>",
        optimalAtrLow: "<number_if_changed>",
        optimalAtrHigh: "<number_if_changed>",
        requireRsiMomentum: "<boolean_if_changed>",
        requireBreakout: "<boolean_if_changed>",
        enableRsiBandFilter: "<boolean_if_changed>",
        enableAtrFilter: "<boolean_if_changed>",
        enableVolumeFilter: "<boolean_if_changed>",
        enableCandleStrengthFilter: "<boolean_if_changed>",
        enablePriceExtensionFilter: "<boolean_if_changed>",
        enableRangeRecoveryFilter: "<boolean_if_changed>"
      },
      reason: "<short reason>"
    }
  };

  return [
    "You are a senior crypto spot trader in 2026.",
    "Read the full structured trading context carefully. Understand the bot objective, bot type, trade style, market profile values, and pair candidates before deciding.",
    "Return one valid JSON object only. No markdown. No extra text.",
    "Do not place orders. Do not change risk, sizing, pair list, bot type, trade mode, TP, SL, or cooldown.",
    "You are updating the ai_agent workspace profile only. Do not choose or switch market profiles.",
    "Do not mirror the current AI workspace profile blindly. Change only fields that truly need adjustment.",
    "In entryOverrides, include only fields you want to change. Omit unchanged fields.",
    JSON.stringify(richContext, null, 2)
  ].join("\n\n");
}

async function askOpenAi({ apiKey, model, timeoutMs, prompt }) {
  const res = await axios.post(
    "https://api.openai.com/v1/responses",
    {
      model,
      input: prompt,
      max_output_tokens: 10000
    },
    {
      timeout: timeoutMs,
      proxy: false,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
    }
  );
  return parseJson(extractResponseText(res.data));
}

function extractGeminiText(data) {
  const parts = [];
  for (const candidate of data?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      if (typeof part?.text === "string") parts.push(part.text);
    }
  }
  return parts.join("\n");
}

async function askGemini({ apiKey, model, timeoutMs, prompt }) {
  const safeModel = String(model || "gemini-2.5-flash").replace(/^models\//, "");
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(safeModel)}:generateContent`,
    {
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 10000
      }
    },
    {
      timeout: timeoutMs,
      proxy: false,
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json"
      }
    }
  );
  return parseJson(extractGeminiText(res.data));
}

async function askOpenRouter({ apiKey, model, timeoutMs, prompt }) {
  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model,
      messages: [
        {
          role: "system",
          content: "You are a conservative market-profile tuner for a spot crypto bot. Return one valid JSON object only, with no markdown and no extra text."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: { type: "json_object" },
      max_tokens: 10000,
      temperature: 0.2
    },
    {
      timeout: timeoutMs,
      proxy: false,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://airplanestar.local",
        "X-Title": "airplanestar-bot"
      }
    }
  );
  return parseJson(res.data?.choices?.[0]?.message?.content || "");
}

function validateDecision(raw, settings) {
  if (!isPlainObject(raw)) throw new Error("invalid JSON decision");
  const decision = {
    marketProfile: null,
    allowEntries: null,
    entryOverrides: {},
    reason: String(raw.reason || "AI market adjustment").slice(0, 240)
  };

  const requestedProfile = String(raw.marketProfile || "");
  if (settings.allowMarketProfile && PROFILE_KEYS.has(requestedProfile)) {
    decision.marketProfile = requestedProfile;
  }
  const customTarget = decision.marketProfile === "custom";

  if (settings.allowEntriesToggle && typeof raw.allowEntries === "boolean") {
    decision.allowEntries = raw.allowEntries;
  }

  const overrides = isPlainObject(raw.entryOverrides) ? raw.entryOverrides : {};
  for (const [key, value] of Object.entries(overrides)) {
    if (MARKET_FILTER_KEYS.has(key) && settings.allowMarketFilters) {
      const normalized = customTarget ? normalizeCustomNumber(value) : clampNumber(key, value);
      if (normalized != null) decision.entryOverrides[key] = normalized;
    }
    if (QUALITY_FILTER_KEYS.has(key) && settings.allowQualityFilters && typeof value === "boolean") {
      decision.entryOverrides[key] = value;
    }
  }

  if (!decision.marketProfile && decision.allowEntries == null && !Object.keys(decision.entryOverrides).length) {
    throw new Error("decision has no allowed changes");
  }

  return decision;
}

function summarizeDecisionScopes(decision) {
  const overrideKeys = Object.keys(decision?.entryOverrides || {});
  return {
    marketProfile: true,
    allowEntriesToggle: typeof decision?.allowEntries === "boolean",
    marketFilters: overrideKeys.some((key) => MARKET_FILTER_KEYS.has(key)),
    qualityFilters: overrideKeys.some((key) => QUALITY_FILTER_KEYS.has(key))
  };
}

function applyDecision(config, decision, now = Date.now()) {
  if (!isPlainObject(config.aiAgent)) config.aiAgent = {};
  if (!isPlainObject(config.marketProfiles)) config.marketProfiles = {};

  const existingAiProfile = isPlainObject(config.marketProfiles[AI_AGENT_PROFILE_KEY])
    ? config.marketProfiles[AI_AGENT_PROFILE_KEY]
    : null;
  const fallbackProfileKey = config.marketProfiles?.custom ? "custom" : "neutral";

  if (!existingAiProfile) {
    const seedProfile = config.marketProfiles?.[fallbackProfileKey];
    if (!seedProfile) throw new Error(`market profile not found: ${fallbackProfileKey}`);
    config.marketProfiles[AI_AGENT_PROFILE_KEY] = {
      label: "AI Agent Profile",
      description: "Profile kerja AI Agent. Diisi otomatis dari keputusan agent tanpa mengubah preset market profile bawaan.",
      allowEntries: seedProfile.allowEntries !== false,
      entryOverrides: { ...(seedProfile.entryOverrides || {}) }
    };
  }

  const aiProfile = config.marketProfiles[AI_AGENT_PROFILE_KEY];
  const requestedProfileKey = decision.marketProfile || fallbackProfileKey;
  const requestedProfile = config.marketProfiles?.[requestedProfileKey] || config.marketProfiles?.[fallbackProfileKey];
  if (!requestedProfile) throw new Error(`market profile not found: ${requestedProfileKey}`);

  const before = {
    marketProfile: config.selectedMarketProfile,
    sourceMarketProfile: requestedProfileKey,
    allowEntries: aiProfile.allowEntries !== false,
    entryOverrides: { ...(aiProfile.entryOverrides || {}) }
  };

  aiProfile.label = aiProfile.label || "AI Agent Profile";
  aiProfile.description = aiProfile.description || "Profile kerja AI Agent. Diisi otomatis dari keputusan agent tanpa mengubah preset market profile bawaan.";

  if (decision.marketProfile && decision.marketProfile !== AI_AGENT_PROFILE_KEY) {
    aiProfile.allowEntries = requestedProfile.allowEntries !== false;
    aiProfile.entryOverrides = { ...(requestedProfile.entryOverrides || {}) };
  } else {
    aiProfile.allowEntries = aiProfile.allowEntries !== false;
    aiProfile.entryOverrides = { ...(aiProfile.entryOverrides || {}) };
  }

  if (decision.allowEntries != null) aiProfile.allowEntries = decision.allowEntries;
  aiProfile.entryOverrides = {
    ...aiProfile.entryOverrides,
    ...decision.entryOverrides
  };

  config.marketProfiles[AI_AGENT_PROFILE_KEY] = aiProfile;
  config.selectedMarketProfile = AI_AGENT_PROFILE_KEY;
  const scopeSummary = summarizeDecisionScopes(decision);
  config.aiAgent.lastDecision = {
    at: new Date(now).toISOString(),
    status: "applied",
    marketProfile: AI_AGENT_PROFILE_KEY,
    sourceMarketProfile: requestedProfileKey,
    allowEntries: aiProfile.allowEntries !== false,
    entryOverrides: decision.entryOverrides,
    scopeSummary,
    reason: decision.reason,
    before
  };
  return config.aiAgent.lastDecision;
}

function buildReport(lastDecision) {
  const summary = lastDecision.scopeSummary || {};
  const statusLine = (label, passed) => `- ${label}: ${passed ? "PASS" : "SKIP"}`;
  return [
    "🤖 AI AGENT UPDATE",
    "--------------------",
    `Provider: ${lastDecision.provider || "openai"} / ${lastDecision.model || "-"}`,
    `Profile: ${lastDecision.marketProfile}`,
    `Allow entries: ${lastDecision.allowEntries ? "yes" : "no"}`,
    "Applied:",
    statusLine("Market Recap", summary.marketProfile),
    statusLine("Allow Entries toggle", summary.allowEntriesToggle),
    statusLine("Tune Market Entry Filters", summary.marketFilters),
    statusLine("Tune Quality Filters", summary.qualityFilters),
    `Reason: ${lastDecision.reason}`,
    "--------------------"
  ].join("\n");
}

async function runAiAgentAfterRotation({ config, rotation, candidates, now = Date.now(), report, log }) {
  if (!isPlainObject(config.aiAgent)) config.aiAgent = {};
  const settings = getAiAgentSettings(config);
  if (!settings.enabled) return { skipped: true, reason: "disabled" };
  const rotationCandidates = normalizeRotationCandidates(candidates);
  if (!rotationCandidates.length) {
    const reason = "missing auto-rotate candidates";
    config.aiAgent.lastDecision = {
      at: new Date(now).toISOString(),
      status: "skipped",
      reason
    };
    log?.("WARN", `AI Agent skipped: ${reason}`);
    return { skipped: true, reason };
  }

  const apiKey =
    settings.provider === "gemini"
      ? process.env.GEMINI_API_KEY
      : settings.provider === "openrouter"
        ? process.env.OPENROUTER_API_KEY
        : process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const missingKey =
      settings.provider === "gemini"
        ? "GEMINI_API_KEY missing"
        : settings.provider === "openrouter"
          ? "OPENROUTER_API_KEY missing"
          : "OPENAI_API_KEY missing";
    config.aiAgent.lastDecision = {
      at: new Date(now).toISOString(),
      status: "skipped",
      reason: missingKey
    };
    return { skipped: true, reason: missingKey };
  }

  try {
    const prompt = buildPrompt({ config, rotation, candidates: rotationCandidates });
    let decision = null;
    let lastError = null;

    for (let attempt = 1; attempt <= settings.retryAttempts; attempt += 1) {
      try {
        const raw = settings.provider === "gemini"
          ? await askGemini({ apiKey, model: settings.geminiModel, timeoutMs: settings.timeoutMs, prompt })
          : settings.provider === "openrouter"
            ? await askOpenRouter({ apiKey, model: settings.openrouterModel, timeoutMs: settings.timeoutMs, prompt })
          : await askOpenAi({ apiKey, model: settings.model, timeoutMs: settings.timeoutMs, prompt });
        decision = validateDecision(raw, settings);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        log?.("WARN", `AI Agent attempt ${attempt}/${settings.retryAttempts} failed: ${err.message}`);
        if (attempt < settings.retryAttempts) {
          await sleep(750 * attempt);
        }
      }
    }

    if (!decision) {
      throw lastError || new Error("AI Agent failed after retries");
    }

    const lastDecision = applyDecision(config, decision, now);
    lastDecision.provider = settings.provider;
    lastDecision.model = settings.provider === "gemini"
      ? settings.geminiModel
      : settings.provider === "openrouter"
        ? settings.openrouterModel
        : settings.model;
    log?.("INFO", `AI Agent applied market profile ${lastDecision.marketProfile} via ${lastDecision.provider}/${lastDecision.model}`);
    try {
      if (settings.telegramReport && report) await report(buildReport(lastDecision));
    } catch (reportErr) {
      log?.("WARN", `AI Agent report failed: ${reportErr.message}`);
    }
    return { applied: true, decision: lastDecision };
  } catch (err) {
    const fallbackProfileKey = config.marketProfiles?.custom ? "custom" : (config.marketProfiles?.neutral ? "neutral" : null);
    if (fallbackProfileKey) config.selectedMarketProfile = fallbackProfileKey;
    config.aiAgent.lastDecision = {
      at: new Date(now).toISOString(),
      status: "failed",
      reason: err.message,
      fallbackProfile: fallbackProfileKey,
      attempts: settings.retryAttempts
    };
    log?.("WARN", `AI Agent failed after ${settings.retryAttempts} attempt(s): ${err.message}${fallbackProfileKey ? `, fallback to ${fallbackProfileKey}` : ""}`);
    return { skipped: true, reason: err.message, fallbackProfile: fallbackProfileKey };
  }
}

module.exports = {
  getAiAgentSettings,
  runAiAgentAfterRotation,
  validateDecision,
  applyDecision,
  __buildPromptForTest: buildPrompt,
  __parseJsonForTest: parseJson
};
