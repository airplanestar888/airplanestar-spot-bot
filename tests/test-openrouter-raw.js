require("dotenv").config();
const axios = require("axios");

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL || "openai/gpt-5-mini";
  if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");

  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model,
      messages: [
        { role: "system", content: "Reply with exactly the requested text." },
        { role: "user", content: "Reply with exactly: openrouter-ok" }
      ],
      max_tokens: 2000,
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

  console.log(JSON.stringify(res.data, null, 2));
}

main().catch((err) => {
  console.error(err.response?.data || err.message || err);
  process.exit(1);
});
