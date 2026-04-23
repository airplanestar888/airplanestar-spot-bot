const fs = require("fs");
const path = require("path");
const axios = require("axios");

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
const OPENROUTER_MAX_TOKENS = 6000;
const DEFAULT_PROMPT_PERSONA = "Senior crypto spot trader in 2026";
const DEFAULT_PROMPT_OBJECTIVE = "Tune the bot for the next several trades over the next couple of hours, aiming for the best overall trading result during that temporary window.";
const DEFAULT_PROMPT_INSTRUCTIONS = [
  "Focus on market recap from rankedCandidates and minimalGlobalContext.",
  "Update the ai_agent workspace profile only when market conditions justify it.",
  "Prefer small, deliberate changes over broad rewrites.",
  "If conditions are mixed or unclear, keep changes minimal and explain the reason briefly.",
  "Always include a dedicated top-level reason field that explains why the entryOverrides were changed."
].join("\n");
const RUNTIME_APPENDED_PROMPT_LINES = new Set([
  "Focus on tuning entryOverrides for the next several trades. Do not change allowEntries. That toggle is controlled manually from the dashboard for ai_agent.",
  "Return one valid JSON object only. No markdown. No extra text.",
  "Your response must be a compact final decision object only. Do not repeat or echo the provided context.",
  "The JSON must include a dedicated top-level reason field with a short human explanation of why the changes were made.",
  "If you change only a few fields, that is fine. Delta-only entryOverrides are preferred.",
  "Do not place orders. Do not change risk, sizing, pair list, bot type, trade mode, TP, SL, or cooldown.",
  "You are updating the ai_agent workspace profile only. Do not choose or switch market profiles.",
  "Do not mirror the current AI workspace profile blindly. Change only fields that truly need adjustment.",
  "In entryOverrides, include only fields you want to change. Omit unchanged fields."
]);

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

function sanitizePromptInstructions(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let cleaned = raw;
  const jsonMarkers = ['\n{\n  "role"', '\n{\r\n  "role"', '\n{\n  "botContext"', '\n{\r\n  "botContext"'];
  let cutAt = -1;
  for (const marker of jsonMarkers) {
    const index = cleaned.indexOf(marker);
    if (index >= 0 && (cutAt < 0 || index < cutAt)) cutAt = index;
  }
  if (cutAt >= 0) cleaned = cleaned.slice(0, cutAt).trim();
  const filtered = cleaned
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => !RUNTIME_APPENDED_PROMPT_LINES.has(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return filtered;
}

function getPromptConfig(config) {
  const raw = isPlainObject(config?.aiAgent?.promptConfig) ? config.aiAgent.promptConfig : {};
  const legacyInstructions = typeof config?.aiAgent?.promptOverride === "string" && config.aiAgent.promptOverride.trim()
    ? sanitizePromptInstructions(config.aiAgent.promptOverride)
    : "";
  return {
    persona: typeof raw.persona === "string" && raw.persona.trim() ? raw.persona.trim() : DEFAULT_PROMPT_PERSONA,
    objective: typeof raw.objective === "string" && raw.objective.trim() ? raw.objective.trim() : DEFAULT_PROMPT_OBJECTIVE,
    instructions: typeof raw.instructions === "string" && raw.instructions.trim()
      ? sanitizePromptInstructions(raw.instructions)
      : (legacyInstructions || DEFAULT_PROMPT_INSTRUCTIONS)
  };
}

function getAiAgentSettings(config) {
  const raw = isPlainObject(config.aiAgent) ? config.aiAgent : {};
  const allowed = isPlainObject(raw.allowedDecisions) ? raw.allowedDecisions : {};
  const safety = isPlainObject(raw.safety) ? raw.safety : {};
  return {
    enabled: raw.enabled === true || process.env.AI_AGENT_ENABLED === "true",
    provider: String(raw.provider || process.env.AI_PROVIDER || "openrouter").toLowerCase(),
    model: process.env.OPENAI_MODEL || raw.model || "gpt-5-mini",
    geminiModel: process.env.GEMINI_MODEL || raw.geminiModel || "gemini-2.5-flash",
    openrouterModel: process.env.OPENROUTER_MODEL || raw.openrouterModel || "openai/gpt-5-mini",
    timeoutMs: Math.max(3000, Math.min(20000, Number(process.env.AI_AGENT_TIMEOUT_MS || raw.timeoutMs || 8000))),
    retryAttempts: Math.max(1, Math.min(3, Number(process.env.AI_AGENT_RETRY_ATTEMPTS || raw.retryAttempts || 3))),
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
  const promptConfig = getPromptConfig(config);
  const activePairSet = new Set(Array.isArray(rotation?.activePairs) ? rotation.activePairs : []);
  // Kurangi dari 20 ke 12 kandidat untuk hemat token
  const rankedCandidates = normalizeRotationCandidates(candidates).slice(0, 12).map((item, index) => ({
    rank: index + 1,
    symbol: item.symbol,
    score: Number(item.score?.toFixed ? item.score.toFixed(3) : item.score),
    chg: item.changePct,
    rng: item.rangePct,
    active: activePairSet.has(item.symbol)
  }));
  const aiAgentProfile = isPlainObject(config.marketProfiles?.[AI_AGENT_PROFILE_KEY])
    ? config.marketProfiles[AI_AGENT_PROFILE_KEY]
    : {};
  // Kirim nilai langsung tanpa wrapper {value, meaning} untuk hemat token
  const richContext = {
    role: {
      persona: promptConfig.persona,
      objective: promptConfig.objective
    },
    botContext: {
      selectedBotType: config.selectedBotType || "custom",
      selectedMode: config.selectedMode || "custom",
      signalTimeframe: config.signalTimeframe,
      trendTimeframe: config.trendTimeframe,
      minScalpTargetPct: config.minScalpTargetPct,
      maxScalpTargetPct: config.maxScalpTargetPct,
      timeStopMinutes: config.timeStopMinutes,
      maxHoldMinutes: config.maxHoldMinutes,
      breakEvenMinutes: config.breakEvenMinutes,
      minConfirmation: config.minConfirmation,
      breakoutPct: config.breakoutPct,
      requireEma21Rising: config.requireEma21Rising,
      requireFastTrend: config.requireFastTrend,
      requirePriceAboveEma9: config.requirePriceAboveEma9,
      requireEdge: config.requireEdge,
      requireRsiMomentum: config.requireRsiMomentum,
      requireBreakout: config.requireBreakout,
      enableRsiBandFilter: config.enableRsiBandFilter,
      enableAtrFilter: config.enableAtrFilter,
      enableVolumeFilter: config.enableVolumeFilter,
      enableCandleStrengthFilter: config.enableCandleStrengthFilter,
      enablePriceExtensionFilter: config.enablePriceExtensionFilter,
      enableRangeRecoveryFilter: config.enableRangeRecoveryFilter
    },
    currentOverrides: { ...(aiAgentProfile.entryOverrides || {}) },
    rankedCandidates,
    globalCtx: {
      candidateCount: candidates?.length || 0,
      activePairs: activePairSet.size,
      avgChgPct: rankedCandidates.length ? Number((rankedCandidates.reduce((s, i) => s + (Number(i.chg) || 0), 0) / rankedCandidates.length).toFixed(3)) : 0,
      avgRngPct: rankedCandidates.length ? Number((rankedCandidates.reduce((s, i) => s + (Number(i.rng) || 0), 0) / rankedCandidates.length).toFixed(3)) : 0,
      topPairs: rotation?.topPairs || null,
      categories: rotation?.activeCategories || "-"
    },
    constraints: {
      allowed: ["entryOverrides", "reason"],
      forbidden: ["allowEntries", "riskPercent", "sizing", "pairs", "botType", "TP", "SL", "cooldown"]
    }
  };

  // Instruksi output diringkas jadi satu baris — hemat ~300 token dari expectedOutputSchema
  const outputInstruction = "Return only: {\"entryOverrides\":{<changed_fields_only>},\"reason\":\"<short_reason>\"}. Numbers for MARKET_FILTER_KEYS, booleans for QUALITY_FILTER_KEYS. Omit unchanged fields.";

  const promptLines = [
    promptConfig.instructions,
    "Tune entryOverrides only. Do not change allowEntries, risk, sizing, pairs, botType, TP, SL, cooldown.",
    "Return one valid JSON object only. No markdown. No extra text. Do not echo context.",
    outputInstruction,
    // Compact JSON tanpa pretty-print untuk hemat ~25% token
    JSON.stringify(richContext)
  ];

  return {
    prompt: promptLines.join("\n\n"),
    promptConfig,
    rankedCandidates
  };
}


async function askOpenAi({ apiKey, model, timeoutMs, prompt }) {
  const payload = {
    model,
    input: prompt,
    max_output_tokens: 6000
  };
  const res = await axios.post(
    "https://api.openai.com/v1/responses",
    payload,
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
  const payload = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: 6000
    }
  };
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(safeModel)}:generateContent`,
    payload,
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
  const payload = {
    model,
    messages: [
      {
        role: "user",
        content: prompt
      }
    ],
    response_format: { type: "json_object" },
    max_tokens: OPENROUTER_MAX_TOKENS,
    temperature: 0.2
  };
  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    payload,
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

function buildRequestPayload({ provider, model, geminiModel, openrouterModel, prompt }) {
  if (provider === "gemini") {
    return {
      provider,
      model: geminiModel,
      endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(String(geminiModel || "gemini-2.5-flash").replace(/^models\//, ""))}:generateContent`,
      body: {
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 6000
        }
      }
    };
  }
  if (provider === "openrouter") {
    return {
      provider,
      model: openrouterModel,
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      body: {
        model: openrouterModel,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        response_format: { type: "json_object" },
        max_tokens: OPENROUTER_MAX_TOKENS,
        temperature: 0.2
      }
    };
  }
  return {
    provider,
    model,
    endpoint: "https://api.openai.com/v1/responses",
    body: {
      model,
      input: prompt,
      max_output_tokens: 6000
    }
  };
}

function pickDecisionReason(raw, payload) {
  const candidates = [
    payload?.reason,
    raw?.reason,
    payload?.summary,
    raw?.summary,
    payload?.rationale,
    raw?.rationale,
    payload?.note,
    raw?.note
  ];

  for (const value of candidates) {
    if (typeof value === "string") {
      const trimmed = value.trim().replace(/\s+/g, " ");
      if (trimmed) return trimmed;
    }
  }

  return "AI market adjustment";
}

function looksLikePromptEcho(raw) {
  if (!isPlainObject(raw)) return false;
  return (
    isPlainObject(raw.role) ||
    isPlainObject(raw.botContext) ||
    Array.isArray(raw.rankedCandidates) ||
    isPlainObject(raw.minimalGlobalContext) ||
    isPlainObject(raw.constraints) ||
    isPlainObject(raw.expectedOutputSchema) ||
    isPlainObject(raw.aiAgentWorkspaceProfile)
  );
}

function validateDecision(raw, settings) {
  if (!isPlainObject(raw)) throw new Error("invalid JSON decision");
  if (looksLikePromptEcho(raw)) {
    throw new Error("model echoed prompt context instead of returning a decision");
  }
  const payload = raw;
  const decision = {
    entryOverrides: {},
    reason: pickDecisionReason(raw, payload)
  };

  const overrides = isPlainObject(payload.entryOverrides) ? payload.entryOverrides : {};
  for (const [key, value] of Object.entries(overrides)) {
    if (MARKET_FILTER_KEYS.has(key) && settings.allowMarketFilters) {
      const normalized = normalizeCustomNumber(value);
      if (normalized != null) decision.entryOverrides[key] = normalized;
    }
    if (QUALITY_FILTER_KEYS.has(key) && settings.allowQualityFilters && typeof value === "boolean") {
      decision.entryOverrides[key] = value;
    }
  }

  if (!Object.keys(decision.entryOverrides).length) {
    throw new Error("decision has no allowed changes");
  }

  return decision;
}

function summarizeDecisionScopes(decision) {
  const overrideKeys = Object.keys(decision?.entryOverrides || {});
  return {
    marketProfile: true,
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
  const preservedAllowEntries = aiProfile.allowEntries !== false;

  const before = {
    marketProfile: config.selectedMarketProfile,
    allowEntries: aiProfile.allowEntries !== false,
    entryOverrides: { ...(aiProfile.entryOverrides || {}) }
  };

  aiProfile.label = aiProfile.label || "AI Agent Profile";
  aiProfile.description = aiProfile.description || "Profile kerja AI Agent. Diisi otomatis dari keputusan agent tanpa mengubah preset market profile bawaan.";
  aiProfile.entryOverrides = { ...(aiProfile.entryOverrides || {}) };
  aiProfile.allowEntries = preservedAllowEntries;
  aiProfile.entryOverrides = {
    ...aiProfile.entryOverrides,
    ...decision.entryOverrides
  };

  config.marketProfiles[AI_AGENT_PROFILE_KEY] = aiProfile;
  config.selectedMarketProfile = AI_AGENT_PROFILE_KEY;
  const scopeSummary = summarizeDecisionScopes(decision);
  const dashboardAllowEntries = aiProfile.allowEntries !== false;
  config.aiAgent.lastDecision = {
    at: new Date(now).toISOString(),
    status: "applied",
    marketProfile: AI_AGENT_PROFILE_KEY,
    allowEntries: dashboardAllowEntries,
    entryOverrides: decision.entryOverrides,
    scopeSummary,
    reason: decision.reason,
    before
  };
  return config.aiAgent.lastDecision;
}

function appendAiAgentState(entry) {
  try {
    const filePath = path.join(__dirname, "..", "data", "ai_agent_state.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (_) {}
}

function buildReport(lastDecision) {
  const summary = lastDecision.scopeSummary || {};
  const changeLine = (label, applied) => `- ${label}: ${applied ? "YES" : "NO"}`;
  const timeLabel = lastDecision.at
    ? new Date(lastDecision.at).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Jakarta"
      })
    : "-";
  return [
    "🤖 AI AGENT UPDATE",
    "--------------------",
    `Provider: ${lastDecision.provider || "openai"} / ${lastDecision.model || "-"}`,
    `Profile: ${lastDecision.marketProfile}`,
    `Allow entries: ${lastDecision.allowEntries ? "yes" : "no"}`,
    "Input read:",
    "- Market Recap: OK",
    "Changes applied:",
    changeLine("Market Entry Filters", summary.marketFilters),
    changeLine("Quality Filters", summary.qualityFilters),
    `Reason: ${lastDecision.reason}`,
    "--------------------",
    `Time: ${timeLabel}`
  ].join("\n");
}
async function runAiAgentAfterRotation({ config, rotation, candidates, now = Date.now(), report, log }) {
  if (!isPlainObject(config.aiAgent)) config.aiAgent = {};
  const settings = getAiAgentSettings(config);
  if (!settings.enabled) {
    const reason = "disabled";
    config.aiAgent.lastDecision = {
      at: new Date(now).toISOString(),
      status: "skipped",
      reason
    };
    return { skipped: true, reason };
  }
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
    log?.("WARN", `AI Agent skipped: ${missingKey}`);
    return { skipped: true, reason: missingKey };
  }

  try {
    const builtPrompt = buildPrompt({ config, rotation, candidates: rotationCandidates });
    const prompt = builtPrompt.prompt;
    const requestPayload = buildRequestPayload({
      provider: settings.provider,
      model: settings.model,
      geminiModel: settings.geminiModel,
      openrouterModel: settings.openrouterModel,
      prompt
    });
    config.aiAgent.lastSystemPrompt = "";
    config.aiAgent.lastPrompt = prompt;
    config.aiAgent.lastRequestPayload = requestPayload;
    config.aiAgent.lastPromptBlocks = builtPrompt.promptConfig;
    config.aiAgent.lastRankedCandidates = builtPrompt.rankedCandidates;
    config.aiAgent.lastPromptAt = new Date(now).toISOString();
    config.aiAgent.lastPromptProvider = settings.provider;
    config.aiAgent.lastPromptModel = settings.provider === "gemini"
      ? settings.geminiModel
      : settings.provider === "openrouter"
        ? settings.openrouterModel
        : settings.model;
    config.aiAgent.lastRawResponse = null;
    let decision = null;
    let lastError = null;

    for (let attempt = 1; attempt <= settings.retryAttempts; attempt += 1) {
      try {
        config.aiAgent.lastRawResponse = null;
        const raw = settings.provider === "gemini"
          ? await askGemini({ apiKey, model: settings.geminiModel, timeoutMs: settings.timeoutMs, prompt })
          : settings.provider === "openrouter"
            ? await askOpenRouter({ apiKey, model: settings.openrouterModel, timeoutMs: settings.timeoutMs, prompt })
          : await askOpenAi({ apiKey, model: settings.model, timeoutMs: settings.timeoutMs, prompt });
        config.aiAgent.lastRawResponse = raw;
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
    appendAiAgentState({
      at: new Date(now).toISOString(),
      status: "applied",
      provider: lastDecision.provider,
      model: lastDecision.model,
      prompt,
      systemPrompt: config.aiAgent.lastSystemPrompt || "",
      rawResponse: config.aiAgent.lastRawResponse || null,
      decision: lastDecision
    });
    try {
      if (settings.telegramReport && report) await report(buildReport(lastDecision));
    } catch (reportErr) {
      log?.("WARN", `AI Agent report failed: ${reportErr.message}`);
    }
    return { applied: true, decision: lastDecision };
  } catch (err) {
    const previousMarketProfile = config.selectedMarketProfile || null;
    const fallbackProfileKey = settings.fallbackRuleBased
      ? (config.marketProfiles?.custom ? "custom" : (config.marketProfiles?.neutral ? "neutral" : null))
      : null;
    if (fallbackProfileKey) config.selectedMarketProfile = fallbackProfileKey;
    config.aiAgent.lastDecision = {
      at: new Date(now).toISOString(),
      status: "failed",
      reason: err.message,
      fallbackProfile: fallbackProfileKey,
      previousMarketProfile,
      marketProfile: fallbackProfileKey || previousMarketProfile,
      attempts: settings.retryAttempts
    };
    appendAiAgentState({
      at: new Date(now).toISOString(),
      status: "failed",
      provider: settings.provider,
      model: settings.provider === "gemini"
        ? settings.geminiModel
        : settings.provider === "openrouter"
          ? settings.openrouterModel
          : settings.model,
      prompt: config.aiAgent.lastPrompt || "",
      systemPrompt: config.aiAgent.lastSystemPrompt || "",
      rawResponse: config.aiAgent.lastRawResponse || null,
      decision: config.aiAgent.lastDecision
    });
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
