function fmtNum(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "-";
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "-";
}

function fmtDate(value) {
  if (!value) return "-";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return String(value);
  return dt.toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function setRows(targetId, rows) {
  const el = document.getElementById(targetId);
  if (!rows.length) {
    el.innerHTML = '<div class="empty">Belum ada data.</div>';
    return;
  }

  el.innerHTML = rows.map(([label, value]) => `
    <div class="row">
      <span>${label}</span>
      <span>${value}</span>
    </div>
  `).join("");
}

function renderTrades(trades) {
  const tbody = document.getElementById("tradesTable");
  const items = Array.isArray(trades)
    ? trades
        .slice()
        .sort((a, b) => {
          const aTime = new Date(a.closedAt || a.exitTime || a.openedAt || a.entryTime || 0).getTime();
          const bTime = new Date(b.closedAt || b.exitTime || b.openedAt || b.entryTime || 0).getTime();
          return bTime - aTime;
        })
        .slice(0, 12)
    : [];

  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">Belum ada histori trade.</td></tr>';
    return;
  }

  tbody.innerHTML = items.map((trade) => {
    const gross = Number(trade.grossPnlPct || trade.pnlPct || 0);
    const net = Number(trade.netPnlEstPct || 0);
    return `
      <tr>
        <td>${trade.pair || "-"}</td>
        <td><span class="pill">${trade.status || "-"}</span></td>
        <td>${trade.mode || "-"}</td>
        <td>${fmtDate(trade.openedAt || trade.entryTime)}</td>
        <td>${fmtDate(trade.closedAt || trade.exitTime)}</td>
        <td class="${gross >= 0 ? "green" : "red"}">${fmtPct(gross)}</td>
        <td class="${net >= 0 ? "green" : "red"}">${fmtPct(net)}</td>
        <td>${trade.exitReason || trade.reason || "-"}</td>
      </tr>
    `;
  }).join("");
}

async function loadApi(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function refresh() {
  const statusText = document.getElementById("statusText");
  statusText.textContent = "Memuat data lokal...";

  try {
    const [status, config, trades] = await Promise.all([
      loadApi("/api/status"),
      loadApi("/api/config"),
      loadApi("/api/trades")
    ]);

    document.getElementById("botTypeValue").textContent = status.botType || "-";
    document.getElementById("modeValue").textContent = status.mode || "-";
    document.getElementById("tradesTodayValue").textContent = String(status.tradesToday ?? 0);
    document.getElementById("pnlValue").textContent = fmtNum(status.realizedPnlToday, 4);

    setRows("statusRows", [
      ["Profile mode", config.marketProfileMode || "auto"],
      ["Selected profile", config.selectedMarketProfile || "-"],
      ["Halted", status.halted ? "yes" : "no"],
      ["Position", status.position?.pair || "None"],
      ["Loss streak", String(status.lossStreak ?? 0)],
      ["Data healthy", status.dataHealthy ? "yes" : "no"],
      ["Last heartbeat", fmtDate(status.lastHeartbeatAt)],
      ["Last run", fmtDate(status.lastRunAt)]
    ]);

    const lastTrade = status.lastTrade;
    setRows("lastTradeRows", lastTrade ? [
      ["Pair", lastTrade.pair || "-"],
      ["Opened", fmtDate(lastTrade.openedAt || lastTrade.entryTime)],
      ["Closed", fmtDate(lastTrade.closedAt || lastTrade.exitTime)],
      ["Gross PnL", fmtPct(lastTrade.grossPnlPct || lastTrade.pnlPct)],
      ["Net est.", fmtPct(lastTrade.netPnlEstPct)],
      ["Exit reason", lastTrade.exitReason || lastTrade.reason || "-"]
    ] : []);

    setRows("configRows", [
      ["Bot type", config.selectedBotType || "-"],
      ["Trade style", config.selectedMode || "-"],
      ["Market profile mode", config.marketProfileMode || "-"],
      ["Telegram", config.telegram?.enabled ? "enabled" : "disabled"],
      ["Loop interval", `${config.loopIntervalMs || 0} ms`],
      ["Max rounds/day", String(config.maxRoundsPerDay ?? config.maxTradesPerDay ?? "-")],
      ["Multi trade", config.enableMultiTrade ? `on (${config.maxOpenPositions ?? 1} max)` : "off"],
      ["Exposure cap", fmtPct((config.exposureCapPct ?? 0) * 100)],
      ["Loss streak halt", `${config.stopAfterThreeConsecutiveLosses ? "on" : "off"} (${config.lossStreakHaltThreshold ?? "-"})`],
      ["Log file", config.logging?.logFile || "logs/bot.log"]
    ]);

    renderTrades(trades);
    statusText.textContent = `Data lokal terakhir: ${fmtDate(status.now)}`;
  } catch (err) {
    statusText.textContent = `Gagal memuat data: ${err.message}`;
  }
}

document.getElementById("refreshBtn").addEventListener("click", refresh);
refresh();
