const http = require("http");
const path = require("path");
const { handleRequest } = require("./routes");

const DEFAULT_PORT = 3841;
let serverStarted = false;
let activeServer = null;

function startServer() {
  if (serverStarted) return activeServer;
  serverStarted = true;

  const rootDir = path.resolve(__dirname, "..");
  const port = Number(process.env.DASHBOARD_PORT || DEFAULT_PORT);

  activeServer = http.createServer((req, res) => handleRequest(req, res, { rootDir }));
  activeServer.listen(port, "127.0.0.1");

  activeServer.on("error", (err) => {
    console.error(`[DASHBOARD ERROR] ${err.message}`);
  });

  return activeServer;
}

module.exports = { startServer };
