require("dotenv").config();
const path = require("path");
const axios = require("axios");
const aiAgent = require(path.join(__dirname, "..", "core", "aiAgent.js"));
const config = require(path.join(__dirname, "..", "config.json"));

async function main() {
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

  const res = await axios.post(
    "http://127.0.0.1:11434/api/chat",
    {
      model: "qwen2.5:1.5b",
      messages: [
        {
          role: "system",
          content: "You are a senior crypto spot trader in 2026. Return one valid JSON object only. No markdown. No extra text."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      stream: false,
      format: "json",
      options: {
        temperature: 0.2,
        num_ctx: 20000
      }
    },
    {
      timeout: 120000,
      proxy: false,
      headers: {
        "Content-Type": "application/json"
      }
    }
  );

  const rawText = res.data?.message?.content || "";
  const parsed = aiAgent.__parseJsonForTest(rawText);
  let validated = null;
  let validationError = null;
  try {
    validated = aiAgent.validateDecision(parsed, aiAgent.getAiAgentSettings(config));
  } catch (err) {
    validationError = err.message;
  }

  console.log(JSON.stringify({
    model: res.data?.model,
    done: res.data?.done,
    promptEvalCount: res.data?.prompt_eval_count,
    evalCount: res.data?.eval_count,
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
