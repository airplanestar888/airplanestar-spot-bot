const axios = require("axios").default;
const crypto = require("crypto");
const { logEvent } = require("./logger");

function sign(ts, method, path, body = "", secretKey) {
  const msg = ts + method.toUpperCase() + path + body;
  return crypto.createHmac("sha256", secretKey).update(msg).digest("base64");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeErrorMessage(err) {
  const raw =
    err?.response?.data?.msg ||
    err?.response?.data?.message ||
    err?.message ||
    "Unknown request error";
  return String(raw).replace(/\s+/g, " ").trim().slice(0, 220);
}

async function request(baseUrl, apiKey, secretKey, passphrase, method, path, body = null, retries = 3) {
  const upperMethod = method.toUpperCase();
  const bodyStr = body ? JSON.stringify(body) : "";

  // Public endpoints don't require authentication
  const isPublicEndpoint = path.includes('/market/') || path.includes('/public/');

  for (let attempt = 1; attempt <= retries; attempt++) {
    // Build headers fresh each attempt (timestamp for private endpoints)
    const headers = {
      "Content-Type": "application/json"
    };

    if (!isPublicEndpoint) {
      const ts = Date.now().toString();
      const signature = sign(ts, upperMethod, path, bodyStr, secretKey);
      headers["ACCESS-KEY"] = apiKey;
      headers["ACCESS-SIGN"] = signature;
      headers["ACCESS-TIMESTAMP"] = ts;
      headers["ACCESS-PASSPHRASE"] = passphrase;
    }

    const config = {
      method: upperMethod,
      url: baseUrl + path,
      headers,
      timeout: 60000,
      validateStatus: () => true
    };

    if (upperMethod !== "GET" && upperMethod !== "DELETE" && bodyStr) {
      config.data = bodyStr;
    }

    let controller = null;
    let timeoutId = null;
    try {
      controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), 60000);
      config.signal = controller.signal;

      const res = await axios(config);
      clearTimeout(timeoutId);
      timeoutId = null;

      const rawText = res.data;
      let json;
      try {
        json = typeof rawText === "string" ? JSON.parse(rawText) : rawText;
      } catch (parseErr) {
        throw new Error(`Non-JSON response: HTTP ${res.status} body=${String(rawText).slice(0, 300)}`);
      }

      // Rate limit
      if (res.status === 429 || json.code === "429") {
        const delayMs = Math.pow(2, attempt) * 1000;
        if (attempt === retries) {
          throw new Error(`Rate limited after ${retries} attempts`);
        }
        await sleep(delayMs);
        continue;
      }

      // HTTP error – do not retry 4xx (except 429)
      if (res.status < 200 || res.status >= 300) {
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new Error(`Client error HTTP ${res.status}: ${json.msg || String(rawText).slice(0, 200)}`);
        }
        throw new Error(`Server error HTTP ${res.status}: ${json.msg || String(rawText).slice(0, 200)}`);
      }

      // API error code
      if (json.code && json.code !== "00000") {
        throw new Error(`API error ${json.code}: ${json.msg || "Unknown error"}`);
      }

      return json.data;
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId);

      // Enhance timeout error
      if (err.code === "ECONNABORTED" || err.name === "AbortError") {
        err.message = `Request timeout after 60000ms: ${upperMethod} ${path}`;
      }

      const status = err?.response?.status ?? "n/a";
      const code = err?.code || "n/a";
      const safeMessage = sanitizeErrorMessage(err);
      logEvent(null, "ERROR", `[REQUEST ERROR] ${upperMethod} ${path} attempt=${attempt}/${retries} status=${status} code=${code} message=${safeMessage}`);

      // Decide retry: network errors, 5xx, 429, timeout
      const shouldRetry = !err.response || err.response.status >= 500 || err.response.status === 429;
      if (!shouldRetry) {
        err.requestContext = { method: upperMethod, path, attempt };
        throw err;
      }

      if (attempt === retries) {
        err.requestContext = { method: upperMethod, path, attempt };
        throw err;
      }

      const delayMs = Math.pow(2, attempt) * 1000;
      await sleep(delayMs);
    }
  }
}

module.exports = { sign, request };
