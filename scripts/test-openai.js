require("dotenv").config();
const axios = require("axios");

async function main() {
  const provider = String(process.env.AI_PROVIDER || "openai").toLowerCase();
  const apiKey = provider === "gemini"
    ? process.env.GEMINI_API_KEY
    : provider === "openrouter"
      ? process.env.OPENROUTER_API_KEY
      : process.env.OPENAI_API_KEY;
  const model = provider === "gemini"
    ? (process.env.GEMINI_MODEL || "gemini-2.5-flash")
    : provider === "openrouter"
      ? (process.env.OPENROUTER_MODEL || "openai/gpt-5-mini")
    : (process.env.OPENAI_MODEL || "gpt-5-mini");

  if (!apiKey) {
    console.error(`${provider === "gemini" ? "GEMINI_API_KEY" : provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY"} is missing in .env`);
    process.exit(1);
  }

  try {
    let text = "";
    if (provider === "gemini") {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.replace(/^models\//, ""))}:generateContent`,
        {
          contents: [{ parts: [{ text: "Reply with exactly: gemini-ok" }] }],
          generationConfig: { maxOutputTokens: 20 }
        },
        {
          timeout: 12000,
          proxy: false,
          headers: {
            "x-goog-api-key": apiKey,
            "Content-Type": "application/json"
          }
        }
      );
      text = (res.data?.candidates || [])
        .flatMap(candidate => candidate?.content?.parts || [])
        .map(part => part?.text || "")
        .join("")
        .trim();
    } else if (provider === "openrouter") {
      const res = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model,
          messages: [
            { role: "system", content: "Reply with exactly the requested text." },
            { role: "user", content: "Reply with exactly: openrouter-ok" }
          ],
          max_tokens: 20,
          temperature: 0
        },
        {
          timeout: 12000,
          proxy: false,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://airplanestar.local",
            "X-Title": "airplanestar-bot"
          }
        }
      );
      text = String(res.data?.choices?.[0]?.message?.content || "").trim();
    } else {
      const res = await axios.post(
        "https://api.openai.com/v1/responses",
        {
          model,
          input: "Reply with exactly: openai-ok",
          max_output_tokens: 20
        },
        {
          timeout: 12000,
          proxy: false,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          }
        }
      );
      text = res.data?.output_text || JSON.stringify(res.data?.output || "").slice(0, 200);
    }

    console.log(`AI API OK | provider=${provider} | model=${model} | response=${text}`);
  } catch (err) {
    const status = err.response?.status || "NO_STATUS";
    const message = err.response?.data?.error?.message || err.message;
    console.error(`AI API FAILED | provider=${provider} | status=${status} | ${message}`);
    process.exit(1);
  }
}

main();
