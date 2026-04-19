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
  minExpectedNetPct: [0.0015, 0.006],
  minVolumeRatio: [1.0, 1.5],
  minTrendRsi: [35, 55],
  minAtrPct: [0.0015, 0.008],
  maxAtrPct: [0.008, 0.035],
  maxEmaGapPct: [0.006, 0.025]
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

function buildPrompt({ config, rotation, candidates }) {
  const mkField = (value, example, meaning) => ({
    type: typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string",
    value,
    example,
    meaning
  });
  const activePairSet = new Set(rotation?.activePairs || config.pairs || []);
  const rankedCandidates = (candidates || []).slice(0, 20).map((item, index) => ({
    rank: index + 1,
    symbol: item.symbol,
    score: Number(item.score?.toFixed ? item.score.toFixed(4) : item.score),
    quoteVol: item.quoteVol,
    changePct: item.changePct,
    rangePct: item.rangePct,
    last: item.last,
    activeNow: activePairSet.has(item.symbol)
  }));
  const activePairs = rankedCandidates.filter((item) => item.activeNow).map((item) => ({
    ...item,
    status: "active"
  }));
  const marketProfiles = Object.fromEntries(
    Object.entries(config.marketProfiles || {}).map(([key, value]) => [key, {
      allowEntries: mkField(value?.allowEntries !== false, !(value?.allowEntries !== false), "Whether entries are allowed in this profile"),
      entryOverrides: Object.fromEntries(
        Object.entries(value?.entryOverrides || {}).map(([field, fieldValue]) => [
          field,
          mkField(fieldValue, typeof fieldValue === "boolean" ? !fieldValue : fieldValue, field)
        ])
      )
    }])
  );
  const richContext = {
    role: {
      persona: "Senior crypto spot trader in 2026",
      objective: [
        "Preserve capital first",
        "Match market regime with active entry style",
        "Allow entries only when market quality fits the bot",
        "Avoid forcing trades in weak or overextended conditions"
      ]
    },
    botContext: {
      selectedBotType: mkField(config.selectedBotType || "custom", "custom", "Active entry style used by the bot"),
      selectedMode: mkField(config.selectedMode || "custom", "custom", "Active trade style / exit behavior"),
      signalTimeframe: mkField(config.signalTimeframe, "5min", "Main signal timeframe for entries"),
      trendTimeframe: mkField(config.trendTimeframe, "1h", "Trend confirmation timeframe"),
      minScalpTargetPct: mkField(config.minScalpTargetPct, 0.008, "Minimum scalp target expected from a setup"),
      maxScalpTargetPct: mkField(config.maxScalpTargetPct, 0.02, "Maximum scalp target expected from a setup"),
      timeStopMinutes: mkField(config.timeStopMinutes, 15, "Trade should not stay alive too long without progress"),
      maxHoldMinutes: mkField(config.maxHoldMinutes, 60, "Maximum acceptable hold duration"),
      breakEvenMinutes: mkField(config.breakEvenMinutes, 12, "When break-even protection becomes relevant"),
      minConfirmation: mkField(config.minConfirmation, 3, "Required confirmation count before entry"),
      breakoutPct: mkField(config.breakoutPct, 0.002, "Breakout threshold used by the entry logic"),
      requireEma21Rising: mkField(config.requireEma21Rising, false, "Require EMA21 to be rising"),
      requireFastTrend: mkField(config.requireFastTrend, false, "Require fast trend alignment"),
      requirePriceAboveEma9: mkField(config.requirePriceAboveEma9, false, "Require price above EMA9"),
      requireEdge: mkField(config.requireEdge, false, "Require edge filter to confirm setup"),
      requireRsiMomentum: mkField(config.requireRsiMomentum, false, "RSI momentum filter must confirm the setup"),
      requireBreakout: mkField(config.requireBreakout, false, "Only allow entries when breakout confirmation is present"),
      enableRsiBandFilter: mkField(config.enableRsiBandFilter, false, "RSI band filter is active"),
      enableAtrFilter: mkField(config.enableAtrFilter, false, "ATR volatility filter is active"),
      enableVolumeFilter: mkField(config.enableVolumeFilter, false, "Volume quality filter is active"),
      enableCandleStrengthFilter: mkField(config.enableCandleStrengthFilter, false, "Candle strength filter is active"),
      enablePriceExtensionFilter: mkField(config.enablePriceExtensionFilter, false, "Price extension filter is active"),
      enableRangeRecoveryFilter: mkField(config.enableRangeRecoveryFilter, false, "Range recovery filter is active")
    },
    marketProfiles,
    activePairs,
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
      allowedChanges: ["marketProfile", "allowEntries", "entryOverrides", "reason"],
      forbiddenChanges: ["riskPercent", "sizing", "pair list", "bot type", "trade mode", "TP", "SL", "cooldown"]
    },
    expectedOutputSchema: {
      marketProfile: "custom",
      allowEntries: true,
      entryOverrides: {
        minExpectedNetPct: 0.0026,
        minVolumeRatio: 1.08,
        minTrendRsi: 40,
        minAtrPct: 0.0028,
        maxAtrPct: 0.02,
        maxEmaGapPct: 0.015,
        requireRsiMomentum: true,
        requireBreakout: true
      },
      reason: "short reason"
    }
  };

  return [
    "You are a senior crypto spot trader in 2026.",
    "Read the full structured trading context carefully. Understand the bot objective, bot type, trade style, market profile values, and pair candidates before deciding.",
    "Return one valid JSON object only. No markdown. No extra text.",
    "Do not place orders. Do not change risk, sizing, pair list, bot type, trade mode, TP, SL, or cooldown.",
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
  config.aiAgent.lastDecision = {
    at: new Date(now).toISOString(),
    status: "applied",
    marketProfile: AI_AGENT_PROFILE_KEY,
    sourceMarketProfile: requestedProfileKey,
    allowEntries: aiProfile.allowEntries !== false,
    entryOverrides: decision.entryOverrides,
    reason: decision.reason,
    before
  };
  return config.aiAgent.lastDecision;
}

function buildReport(lastDecision) {
  const changes = Object.entries(lastDecision.entryOverrides || {})
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n") || "- no filter changes";
  return [
    "🤖 AI AGENT UPDATE",
    "--------------------",
    `Provider: ${lastDecision.provider || "openai"} / ${lastDecision.model || "-"}`,
    `Profile: ${lastDecision.marketProfile}`,
    `Allow entries: ${lastDecision.allowEntries ? "yes" : "no"}`,
    "Applied:",
    changes,
    `Reason: ${lastDecision.reason}`,
    "--------------------"
  ].join("\n");
}

async function runAiAgentAfterRotation({ config, rotation, candidates, now = Date.now(), report, log }) {
  if (!isPlainObject(config.aiAgent)) config.aiAgent = {};
  const settings = getAiAgentSettings(config);
  if (!settings.enabled) return { skipped: true, reason: "disabled" };

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
    const prompt = buildPrompt({ config, rotation, candidates });
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
