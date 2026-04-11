const fs = require("fs");
const path = require("path");
const { getPayload, saveConfig } = require("./stateAdapter");

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": `${contentType}; charset=utf-8`,
    "Cache-Control": "no-store"
  });
  res.end(fs.readFileSync(filePath, "utf8"));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function handleApi(req, res, rootDir, pathname) {
  if (pathname === "/api/config" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const saved = saveConfig(rootDir, body);
      sendJson(res, 200, { ok: true, config: saved });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return true;
  }

  const key = pathname.replace("/api/", "").trim();
  const payload = getPayload(rootDir, key);

  if (payload === null) {
    sendJson(res, 404, { error: "Unknown endpoint" });
    return true;
  }

  sendJson(res, 200, payload);
  return true;
}

function handleRequest(req, res, { rootDir }) {
  const pathname = (req.url || "/").split("?")[0];
  const staticDir = path.join(rootDir, "server", "static");

  if (pathname.startsWith("/api/")) {
    return handleApi(req, res, rootDir, pathname);
  }

  if (pathname === "/" || pathname === "/dashboard" || pathname === "/dashboard/") {
    sendFile(res, path.join(staticDir, "dashboard.html"), "text/html");
    return;
  }

  if (pathname === "/dashboard.js") {
    sendFile(res, path.join(staticDir, "dashboard.js"), "application/javascript");
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

module.exports = { handleRequest };
