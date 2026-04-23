require("dotenv").config();
const axios = require("axios");
const path = require("path");
const os = require("os");

function loadOpenClawConfig() {
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  return require(configPath);
}

async function main() {
  const cfg = loadOpenClawConfig();
  const baseUrl = `http://127.0.0.1:${cfg.gateway?.port || 18789}`;
  const token = cfg.gateway?.auth?.token;
  const model = cfg.agents?.defaults?.model?.primary || "openai-codex/gpt-5.4";

  if (!token) throw new Error("OpenClaw gateway token not found");

  const prompt = "Return exactly this JSON and nothing else: {\"ok\":true,\"route\":\"openclaw\"}";

  const endpoints = [
    {
      name: "responses",
      url: `${baseUrl}/v1/responses`,
      body: {
        model,
        input: prompt,
        max_output_tokens: 200
      }
    },
    {
      name: "chat-completions",
      url: `${baseUrl}/v1/chat/completions`,
      body: {
        model,
        messages: [
          { role: "user", content: prompt }
        ],
        max_tokens: 200
      }
    }
  ];

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };

  const results = [];
  for (const ep of endpoints) {
    try {
      const res = await axios.post(ep.url, ep.body, {
        timeout: 30000,
        proxy: false,
        headers
      });
      results.push({
        endpoint: ep.name,
        ok: true,
        status: res.status,
        data: res.data
      });
      break;
    } catch (err) {
      results.push({
        endpoint: ep.name,
        ok: false,
        status: err.response?.status || null,
        data: err.response?.data || { message: err.message || String(err) }
      });
    }
  }

  console.log(JSON.stringify({ baseUrl, model, results }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message || String(err) }, null, 2));
  process.exit(1);
});
