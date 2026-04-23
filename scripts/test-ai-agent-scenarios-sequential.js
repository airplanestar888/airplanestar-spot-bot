require("dotenv").config();
const path = require("path");
const axios = require("axios");
const aiAgent = require(path.join(__dirname, "..", "core", "aiAgent.js"));
const config = require(path.join(__dirname, "..", "config.json"));

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildScenario(name, pairs) {
  return {
    name,
    rotation: {
      activePairs: pairs.map((p) => p.symbol),
      topPairs: pairs.length,
      activeCategories: "bestVolume(×1.2), bestMomentum(×0.8), notOverextended(×1.5)"
    },
    candidates: pairs
  };
}

async function runScenario(apiKey, settings, scenario) {
  const prompt = aiAgent.__buildPromptForTest({
    config: clone(config),
    rotation: scenario.rotation,
    candidates: scenario.candidates
  });

  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
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
    },
    {
      timeout: Math.max(settings.timeoutMs, 30000),
      proxy: false,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://airplanestar.local",
        "X-Title": "airplanestar-bot"
      }
    }
  );

  const rawText = res.data?.choices?.[0]?.message?.content || "";
  const parsed = aiAgent.__parseJsonForTest(rawText);
  let validated = null;
  let validationError = null;
  try {
    validated = aiAgent.validateDecision(parsed, settings);
  } catch (err) {
    validationError = err.message;
  }

  return {
    scenario: scenario.name,
    finish_reason: res.data?.choices?.[0]?.finish_reason,
    validated,
    validationError,
    rawText
  };
}

async function main() {
  const settings = aiAgent.getAiAgentSettings(config);
  if (settings.provider !== "openrouter") throw new Error(`Expected openrouter provider, got ${settings.provider}`);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");

  const scenarios = [
    buildScenario("trend-strong-clean", [
      { symbol: "BTCUSDT", score: 16.2, quoteVol: 1800000, changePct: 2.4, rangePct: 3.1, last: 74500 },
      { symbol: "ETHUSDT", score: 15.9, quoteVol: 1550000, changePct: 2.9, rangePct: 3.6, last: 2295 },
      { symbol: "SOLUSDT", score: 15.1, quoteVol: 1300000, changePct: 3.8, rangePct: 4.2, last: 85.2 },
      { symbol: "AAVEUSDT", score: 14.7, quoteVol: 910000, changePct: 4.1, rangePct: 4.8, last: 96.1 },
      { symbol: "NEARUSDT", score: 14.2, quoteVol: 820000, changePct: 3.3, rangePct: 4.1, last: 1.39 }
    ]),
    buildScenario("choppy-overextended", [
      { symbol: "TRUMPUSDT", score: 15.8, quoteVol: 1400000, changePct: 11.8, rangePct: 18.5, last: 3.18 },
      { symbol: "WLDUSDT", score: 15.3, quoteVol: 1220000, changePct: 10.4, rangePct: 16.2, last: 0.294 },
      { symbol: "XPLUSDT", score: 14.9, quoteVol: 990000, changePct: 9.7, rangePct: 17.8, last: 0.118 },
      { symbol: "CHZUSDT", score: 14.4, quoteVol: 880000, changePct: 8.6, rangePct: 15.1, last: 0.047 },
      { symbol: "EDGEUSDT", score: 14.0, quoteVol: 760000, changePct: 7.9, rangePct: 14.7, last: 0.221 }
    ]),
    buildScenario("low-vol-flat", [
      { symbol: "BTCUSDT", score: 12.4, quoteVol: 950000, changePct: 0.35, rangePct: 0.9, last: 74120 },
      { symbol: "ETHUSDT", score: 12.1, quoteVol: 910000, changePct: 0.28, rangePct: 0.8, last: 2278 },
      { symbol: "PAXGUSDT", score: 11.8, quoteVol: 640000, changePct: 0.16, rangePct: 0.5, last: 4768 },
      { symbol: "XAUTUSDT", score: 11.5, quoteVol: 610000, changePct: 0.12, rangePct: 0.4, last: 4767 },
      { symbol: "USDCUSDT", score: 10.9, quoteVol: 590000, changePct: 0.01, rangePct: 0.06, last: 1.0 }
    ])
  ];

  const results = [];
  for (let i = 0; i < scenarios.length; i += 1) {
    const scenario = scenarios[i];
    try {
      const result = await runScenario(apiKey, settings, scenario);
      results.push(result);
    } catch (err) {
      results.push({
        scenario: scenario.name,
        error: err.response?.data || { message: err.message || String(err) }
      });
    }
    if (i < scenarios.length - 1) await sleep(60000);
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify(err.response?.data || { error: err.message || String(err) }, null, 2));
  process.exit(1);
});
