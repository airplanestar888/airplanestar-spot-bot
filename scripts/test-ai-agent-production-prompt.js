require("dotenv").config();
const path = require("path");
const axios = require("axios");
const aiAgent = require(path.join(__dirname, "..", "core", "aiAgent.js"));
const config = require(path.join(__dirname, "..", "config.json"));

async function main() {
  const settings = aiAgent.getAiAgentSettings(config);
  const apiKey = settings.provider === "openrouter"
    ? process.env.OPENROUTER_API_KEY
    : settings.provider === "gemini"
      ? process.env.GEMINI_API_KEY
      : process.env.OPENAI_API_KEY;

  if (!apiKey) throw new Error("Missing provider API key");

  const rotation = config.lastAutoPairRotation || {
    activePairs: config.pairs || [],
    topPairs: 15,
    activeCategories: "bestVolume(×1.2), bestMomentum(×0.8), notOverextended(×1.5)"
  };

  const candidates = (rotation.activePairs || []).map((symbol, index) => ({
    symbol,
    score: Number((15 - index * 0.37).toFixed(4)),
    quoteVol: 1000000 - index * 35000,
    changePct: Number((4.8 - index * 0.21).toFixed(4)),
    rangePct: Number((6.5 + index * 0.3).toFixed(4)),
    last: Number((100 + index * 3.17).toFixed(4))
  }));

  const prompt = aiAgent.__buildPromptForTest({ config, rotation, candidates });

  const reqBody = settings.provider === "openrouter"
    ? {
        model: settings.openrouterModel,
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
        max_tokens: 5000,
        temperature: 0.2
      }
    : null;

  if (!reqBody) throw new Error(`Manual script currently supports openrouter only, got ${settings.provider}`);

  const res = await axios.post("https://openrouter.ai/api/v1/chat/completions", reqBody, {
    timeout: settings.timeoutMs,
    proxy: false,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://airplanestar.local",
      "X-Title": "airplanestar-bot"
    }
  });

  const rawText = res.data?.choices?.[0]?.message?.content || "";
  const parsed = aiAgent.__parseJsonForTest(rawText);
  let validated = null;
  let validationError = null;
  try {
    validated = aiAgent.validateDecision(parsed, settings);
  } catch (err) {
    validationError = err.message;
  }

  console.log(JSON.stringify({
    provider: res.data?.provider,
    model: res.data?.model,
    finish_reason: res.data?.choices?.[0]?.finish_reason,
    promptChars: prompt.length,
    promptApproxTokens: Math.ceil(prompt.length / 4),
    rawText,
    parsed,
    validated,
    validationError
  }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify(err.response?.data || { error: err.message || String(err) }, null, 2));
  process.exit(1);
});
