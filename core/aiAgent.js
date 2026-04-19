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

function parseJson(text) {
  const cleaned = String(text || "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

function buildPrompt({ config, rotation, candidates }) {
  const marketProfiles = Object.fromEntries(
    Object.entries(config.marketProfiles || {}).map(([key, value]) => [
      key,
      {
        allowEntries: value?.allowEntries !== false,
        entryOverrides: value?.entryOverrides || {}
      }
    ])
  );

  return [
    "You are a conservative market-profile tuner for a spot crypto bot.",
    "Return JSON only. Do not place orders. Do not change risk, sizing, bot type, trade style, stops, TP, or pair list.",
    "Allowed JSON shape:",
    '{"marketProfile":"custom","allowEntries":true,"entryOverrides":{"minExpectedNetPct":0.0026,"minVolumeRatio":1.08,"minTrendRsi":40,"minAtrPct":0.0028,"maxAtrPct":0.02,"maxEmaGapPct":0.015,"requireRsiMomentum":true,"requireBreakout":true},"reason":"short reason"}',
    `Allowed profiles: ${[...PROFILE_KEYS].join(", ")}`,
    `Active pairs: ${(rotation?.activePairs || config.pairs || []).join(", ")}`,
    `Top market candidates: ${JSON.stringify((candidates || []).slice(0, 12))}`,
    `Current selected market profile: ${config.selectedMarketProfile || "neutral"}`,
    `Current profiles: ${JSON.stringify(marketProfiles)}`
  ].join("\n");
}

async function askOpenAi({ apiKey, model, timeoutMs, prompt }) {
  const res = await axios.post(
    "https://api.openai.com/v1/responses",
    {
      model,
      input: prompt,
      max_output_tokens: 500
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
        maxOutputTokens: 500
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
      max_tokens: 500,
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
  const targetProfile = decision.marketProfile || config.selectedMarketProfile || "neutral";
  if (!config.marketProfiles?.[targetProfile]) throw new Error(`market profile not found: ${targetProfile}`);

  const profile = config.marketProfiles[targetProfile];
  const before = {
    marketProfile: config.selectedMarketProfile,
    allowEntries: profile.allowEntries !== false,
    entryOverrides: { ...(profile.entryOverrides || {}) }
  };

  if (decision.marketProfile) config.selectedMarketProfile = decision.marketProfile;
  if (decision.allowEntries != null) profile.allowEntries = decision.allowEntries;
  profile.entryOverrides = {
    ...(profile.entryOverrides || {}),
    ...decision.entryOverrides
  };
  config.marketProfiles[targetProfile] = profile;
  config.aiAgent.lastDecision = {
    at: new Date(now).toISOString(),
    status: "applied",
    marketProfile: targetProfile,
    allowEntries: profile.allowEntries !== false,
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
    "AI AGENT UPDATE",
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
    const raw = settings.provider === "gemini"
      ? await askGemini({ apiKey, model: settings.geminiModel, timeoutMs: settings.timeoutMs, prompt })
      : settings.provider === "openrouter"
        ? await askOpenRouter({ apiKey, model: settings.openrouterModel, timeoutMs: settings.timeoutMs, prompt })
      : await askOpenAi({ apiKey, model: settings.model, timeoutMs: settings.timeoutMs, prompt });
    const decision = validateDecision(raw, settings);
    const lastDecision = applyDecision(config, decision, now);
    lastDecision.provider = settings.provider;
    lastDecision.model = settings.provider === "gemini"
      ? settings.geminiModel
      : settings.provider === "openrouter"
        ? settings.openrouterModel
        : settings.model;
    log?.("INFO", `AI Agent applied market profile ${lastDecision.marketProfile} via ${lastDecision.provider}/${lastDecision.model}`);
    if (settings.telegramReport && report) await report(buildReport(lastDecision));
    return { applied: true, decision: lastDecision };
  } catch (err) {
    config.aiAgent.lastDecision = {
      at: new Date(now).toISOString(),
      status: "error",
      reason: err.message
    };
    log?.("WARN", `AI Agent skipped: ${err.message}`);
    return { skipped: true, reason: err.message };
  }
}

module.exports = {
  getAiAgentSettings,
  runAiAgentAfterRotation,
  validateDecision,
  applyDecision
};
