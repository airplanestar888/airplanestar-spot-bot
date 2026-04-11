function fmtNum(val, dec = 2, fallback = "N/A") {
  const n = Number(val);
  if (!isFinite(n) || isNaN(n)) return fallback;
  return n.toFixed(dec);
}

function fmtPct(val, dec = 2, fallback = "N/A") {
  const n = Number(val);
  if (!isFinite(n) || isNaN(n)) return fallback;
  return `${n.toFixed(dec)}%`;
}

function fmtPrice(val, fallback = "N/A") {
  const n = Number(val);
  if (!isFinite(n) || isNaN(n)) return fallback;
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  if (Math.abs(n) >= 0.1) return n.toFixed(4);
  if (Math.abs(n) >= 0.01) return n.toFixed(5);
  if (Math.abs(n) >= 0.001) return n.toFixed(6);
  return n.toFixed(8);
}

function sanitizeNumber(val, defaultVal = 0) {
  const n = Number(val);
  return (isFinite(n) && !isNaN(n)) ? n : defaultVal;
}

function withFooterTime(title, body, timeText) {
  const divider = "--------------------";
  return `${title}\n${divider}\n${body}\n${divider}\nTime: ${timeText}`;
}

function fmtReportTime(value) {
  const dt = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(dt.getTime())) {
    return "N/A";
  }
  return dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });
}

function formatProfileLabel(marketProfileLabel, marketProfileMode) {
  const label = marketProfileLabel || "Auto";
  return marketProfileMode === "auto" ? `${label} (auto)` : label;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function buildPositionSnapshot({ currentPct = 0, peakPct = null, activationPct = null, takeProfitPct = null, stopPct = null, label = "Now" }) {
  const stop = Number.isFinite(stopPct) ? stopPct * 100 : -0.6;
  const dynamicTarget = Number.isFinite(activationPct) ? activationPct * 100 : 0.8;
  const target = Number.isFinite(takeProfitPct) ? takeProfitPct * 100 : 1.3;
  const current = Number.isFinite(currentPct) ? currentPct : 0;
  const peak = Number.isFinite(peakPct) ? peakPct : null;
  const minBound = Math.min(stop, current, peak ?? current, -0.2);
  const maxBound = Math.max(target, dynamicTarget, current, peak ?? current, 0.2);
  const width = 26;
  const chars = Array(width).fill("─");
  const slot = (pct) => clamp(Math.round(((pct - minBound) / Math.max(0.0001, (maxBound - minBound))) * (width - 1)), 0, width - 1);
  const place = (pct, ch) => { chars[slot(pct)] = ch; };

  place(stop, "S");
  place(0, "E");
  place(dynamicTarget, "D");
  place(target, "T");
  if (peak != null) place(peak, "P");
  place(current, "●");

  const levelText = [
    `S ${fmtPct(stop, 2)}`,
    `E 0.00%`,
    `DTP ${fmtPct(dynamicTarget, 2)}`,
    `T ${fmtPct(target, 2)}`
  ].join(" | ");
  return `Snapshot: ${chars.join("")}\nLevels: ${levelText}`;
}

function summarizePositions(positionOrPositions) {
  const positions = Array.isArray(positionOrPositions)
    ? positionOrPositions.filter(Boolean)
    : (positionOrPositions ? [positionOrPositions] : []);
  if (!positions.length) return "None";
  const symbols = positions.map(pos => pos.symbol).filter(Boolean);
  if (!symbols.length) return `${positions.length} open`;
  const shown = symbols.slice(0, 3).join(", ");
  return symbols.length > 3 ? `${shown} (+${symbols.length - 3} more)` : shown;
}

function buildMarketReport({
  marketMode,
  volatilityState,
  topScoring,
  bestEligible,
  watchlist,
  marketData,
  position,
  now,
  activeBotTypeLabel,
  activeModeLabel,
  marketProfileLabel,
  marketProfileMode,
  marketEntriesEnabled = true,
  entryGateStatus = "open",
  dynamicTakeProfitEnabled = false,
  baseTakeProfitPct = null
}) {
  const mdBySym = {};
  for (const md of marketData) mdBySym[md.symbol] = md;

  const detail = (md) => {
    if (!md) return "";
    const ec = md.entryCandidate;
    let status;
    if (ec) {
      if (!marketEntriesEnabled && ec.eligible) status = "entry blocked by profile";
      else if (ec.eligible) status = "eligible";
      else if (md.trendOk15) status = "watch only";
      else status = "failed 15m";
    } else {
      status = md.trendOk15 ? "no 3m data" : "failed 15m";
    }

    let line = `${md.symbol}
- 15m Trend: ${md.trendOk15 ? "rising" : "falling"}
- Price: ${fmtNum(md.price, 4)}
- 3m Status: ${status}
- RSI: ${fmtNum(md.rsi, 1)} | ATR: ${fmtPct(md.atrPct, 2)}
- Score: ${fmtNum(md.score, 2)} | Live weight: ${fmtNum(md.liveWeight, 2, "1.00")}x`;

    if (ec?.failed?.length) {
      line += `\n- Failed: ${ec.failed.join(", ")}`;
    }

    return line + "\n";
  };

  const watchlistArr = Array.isArray(watchlist)
    ? watchlist.map(w => typeof w === "string" ? w : w.symbol).filter(Boolean)
    : [];

  const trendOkCount = marketData.filter(md => md.trendOk15).length;
  const rawEligibleCount = marketData.filter(md => md.entryCandidate?.eligible).length;
  const eligibleCount = marketEntriesEnabled ? rawEligibleCount : 0;
  const watchOnlyCount = marketData.filter(md => md.trendOk15 && !md.entryCandidate?.eligible).length;
  const watchlistText = watchlistArr.length ? watchlistArr.slice(0, 5).join(", ") : "none";
  const bestEligibleText = marketEntriesEnabled
    ? (bestEligible ? bestEligible.symbol : "none")
    : (rawEligibleCount > 0 ? "blocked by profile" : "none");

  let txt = `Market state: ${marketMode}
Volatility: ${volatilityState}
Pairs scanned: ${marketData.length}
Trend OK: ${trendOkCount} | Eligible: ${eligibleCount} | Watch only: ${watchOnlyCount}
Top scorer: ${topScoring?.symbol || "none"} (score ${fmtNum(topScoring?.score || 0, 2, "0.00")} | weight ${fmtNum(topScoring?.liveWeight || 1, 2, "1.00")}x)
Best eligible setup: ${bestEligibleText}
Entry gate: ${entryGateStatus}
Watchlist flags: ${watchlistText}${watchlistArr.length > 5 ? ` (+${watchlistArr.length - 5} more)` : ""}

`;

  const seen = new Set();

  if (topScoring?.symbol) {
    txt += detail(mdBySym[topScoring.symbol]);
    seen.add(topScoring.symbol);
  }

  if (bestEligible?.symbol && !seen.has(bestEligible.symbol)) {
    txt += detail(mdBySym[bestEligible.symbol]);
    seen.add(bestEligible.symbol);
  }

  for (const symbol of watchlistArr) {
    if (seen.has(symbol) || seen.size >= 4) continue;
    txt += detail(mdBySym[symbol]);
    seen.add(symbol);
  }

  const openPositions = Array.isArray(position)
    ? position.filter(Boolean)
    : (position ? [position] : []);
  if (openPositions.length) {
    txt += `\nOpen positions: ${summarizePositions(openPositions)}`;
  } else {
    txt += `\nNo open position.`;
  }

  txt += `\n\nAll active pairs remain scanned each cycle. Watchlist is only a report flag.`;
  return withFooterTime(
    "📊 MARKET REPORT",
    txt,
    now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" })
  );
}

function buildBalanceReport(usdtFree, totalEquity, posValue, plannedSize, state, realizedPnlPct, otherAssets = 0, positionEntrySizeUSDT = null, startOfDayEquity = null, stats = {}) {
  const now = Date.now();
  const cooldownStatus = (now < state.lastTradeTime)
    ? `cooldown active (${Math.round((state.lastTradeTime - now) / 60000)}m left)`
    : "cleared";

  // Sanitize inputs
  const usdtFreeSafe = sanitizeNumber(usdtFree);
  const totalEquitySafe = sanitizeNumber(totalEquity, usdtFreeSafe);
  const posValueSafe = sanitizeNumber(posValue);
  const positionEntrySizeUSDTSafe = sanitizeNumber(positionEntrySizeUSDT, posValueSafe);
  const otherAssetsSafe = sanitizeNumber(otherAssets);
  const plannedSizeSafe = sanitizeNumber(plannedSize);
  const reserveTarget = sanitizeNumber(stats.reserveUSDT ?? 0);
  const startOfDayEquitySafe = sanitizeNumber(startOfDayEquity, totalEquitySafe);

  // Realized PnL (from state, already net after fees)
  const realizedUSDT = sanitizeNumber(state.realizedPnlToday);
  const realizedPct = startOfDayEquitySafe > 0 ? (realizedUSDT / startOfDayEquitySafe) * 100 : 0;

  // Unrealized PnL (gross) and Net (after estimated fees)
  let unrealizedUSDT = 0;
  let unrealizedPct = 0;
  let unrealizedNetUSDT = 0;
  let unrealizedNetPct = 0;
  
  if (positionEntrySizeUSDTSafe > 0 && posValueSafe > 0) {
    unrealizedUSDT = posValueSafe - positionEntrySizeUSDTSafe;
    unrealizedPct = (unrealizedUSDT / positionEntrySizeUSDTSafe) * 100;
    
    // Estimate net after fee (round trip 0.4% default)
    const feeRate = sanitizeNumber(stats.roundTripFeePct, 0.004);
    unrealizedNetUSDT = unrealizedUSDT - (positionEntrySizeUSDTSafe * feeRate);
    unrealizedNetPct = (unrealizedNetUSDT / positionEntrySizeUSDTSafe) * 100;
  }

  const totalUSDT = realizedUSDT + unrealizedNetUSDT;
  const totalPct = startOfDayEquitySafe > 0 ? (totalUSDT / startOfDayEquitySafe) * 100 : 0;

  // Exposure: position value as % of total equity
  const exposurePct = totalEquitySafe > 0 ? (posValueSafe / totalEquitySafe) * 100 : 0;

  return withFooterTime(
    "💰 BALANCE REPORT",
    `USDT free: ${fmtNum(usdtFreeSafe)} USDT
Open positions value: ${fmtNum(posValueSafe)} USDT
Other assets: ${fmtNum(otherAssetsSafe)} USDT
Total equity: ${fmtNum(totalEquitySafe)} USDT
Exposure: ${exposurePct.toFixed(1)}% of equity
Planned size: ${fmtNum(plannedSizeSafe)} USDT
Reserve target: ${fmtNum(reserveTarget)} USDT
Rounds today: ${state.tradesToday}
Loss streak: ${state.lossStreak}
Cooldown: ${cooldownStatus}
Realized PnL (net): ${realizedUSDT >= 0 ? "+" : ""}${fmtNum(realizedUSDT)} USDT (${realizedPct >= 0 ? "+" : ""}${fmtPct(realizedPct, 2)})
Unrealized PnL (gross): ${unrealizedUSDT >= 0 ? "+" : ""}${fmtNum(unrealizedUSDT)} USDT (${unrealizedPct >= 0 ? "+" : ""}${fmtPct(unrealizedPct, 2)})
Unrealized PnL (net est.): ${unrealizedNetUSDT >= 0 ? "+" : ""}${fmtNum(unrealizedNetUSDT)} USDT (${unrealizedNetPct >= 0 ? "+" : ""}${fmtPct(unrealizedNetPct, 2)})
Total PnL today (net): ${totalUSDT >= 0 ? "+" : ""}${fmtNum(totalUSDT)} USDT (${totalPct >= 0 ? "+" : ""}${fmtPct(totalPct, 2)})
Halted: ${state.haltedForDay ? state.haltReason : "no"}`,
    new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" })
  );
}

function buildHeartbeatReport(usdtFree, position, equity, realizedPnlPct, state, timeStr, dataFresh = true, last3mCandleTs = 0, last15mCandleTs = 0, stats = {}) {
  const dataStatus = dataFresh ? "fresh" : "stale";
  const signalTfLabel = stats.signalTimeframe || "3m";
  const trendTfLabel = stats.trendTimeframe || "15m";
  const fmtTs = (ts) => ts
    ? new Date(ts).toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" })
    : "n/a";

  return withFooterTime(
    "💡 BOT HEARTBEAT",
    `Entry style: ${stats.activeBotTypeLabel || "N/A"}
Mode: ${stats.activeModeLabel || "N/A"}
Profile: ${formatProfileLabel(stats.marketProfileLabel, stats.marketProfileMode)}
Pairs active: ${stats.activePairs ?? "N/A"}
Loop interval: ${stats.loopMinutes ?? "N/A"}m
Entry gate: ${stats.entryGateStatus || "open"}
Position: ${summarizePositions(position)}
Halted: ${state.haltedForDay ? state.haltReason : "no"}
Data status: ${dataStatus}
Last ${signalTfLabel} candle: ${fmtTs(last3mCandleTs)}
Last ${trendTfLabel} candle: ${fmtTs(last15mCandleTs)}`,
    timeStr
  );
}

function buildHoldReport(position, now, pnlPct, peakPnLPct, useTrailing, drawdownFromPeak, stopPct, ageMin, extra = {}) {
  const status = useTrailing ? "Trailing Active" : "Building";
  const trailingLine = useTrailing && isFinite(drawdownFromPeak)
    ? `\nDrawdown from peak: ${(drawdownFromPeak * 100).toFixed(2)}%`
    : "";
  const tpMain = Number(position?.takeProfitPct);
  const activation = Number(position?.profitActivationPct);
  const tpLine = Number.isFinite(tpMain)
    ? `\nTP: +${(tpMain * 100).toFixed(2)}%`
    : "";
  const activationLine = Number.isFinite(activation)
    ? `\nDTP: +${(activation * 100).toFixed(2)}%`
    : "";
  const snapshot = buildPositionSnapshot({
    currentPct: pnlPct,
    peakPct: peakPnLPct,
    activationPct: activation,
    takeProfitPct: tpMain,
    stopPct,
    label: "Now"
  });
  const openPositionsLine = Number.isFinite(extra.openPositionsCount) && extra.openPositionsCount > 1
    ? `\nOpen positions: ${extra.openPositionsCount} | ${extra.openPositionsText || "multi trade active"}`
    : "";
  const reportModeLine = extra.reportMode
    ? `\nReport mode: ${extra.reportMode}`
    : "";

  return `🟡 HOLD UPDATE
Pair: ${position?.symbol || "N/A"}
Entry: ${fmtPrice(position?.entry)}
Current: ${fmtPrice(position?.currentPrice)}
PnL: ${isFinite(pnlPct) ? pnlPct.toFixed(2) : "N/A"}%
Peak PnL: ${isFinite(peakPnLPct) ? peakPnLPct.toFixed(2) : "N/A"}%
Trailing: ${useTrailing ? "active" : "inactive"}${trailingLine}${tpLine}${activationLine}
Stop: ${isFinite(stopPct) ? (stopPct * 100).toFixed(2) : "N/A"}%
Age: ${isFinite(ageMin) ? `${ageMin}m` : "N/A"}
State: ${status}${openPositionsLine}${reportModeLine}
${snapshot}`;
}

function buildHoldSummaryReport(positions, now, extra = {}) {
  const list = Array.isArray(positions) ? positions.filter(Boolean) : [];
  const header = [
    `Open positions: ${list.length}`,
    extra.openPositionsText ? `Symbols: ${extra.openPositionsText}` : null,
    Number.isFinite(extra.totalExposureUsdt)
      ? `Exposure: ${fmtNum(extra.totalExposureUsdt)} USDT${Number.isFinite(extra.exposureCapPct) ? ` | Cap ${fmtPct(extra.exposureCapPct * 100, 0)}` : ""}`
      : null
  ].filter(Boolean).join("\n");

  const blocks = list.map((item, index) => {
    const position = item.position || {};
    const status = item.useTrailing ? "Trailing Active" : "Building";
    const trailingLine = item.useTrailing && Number.isFinite(item.drawdownFromPeak)
      ? ` | DD ${fmtPct(item.drawdownFromPeak * 100, 2)}`
      : "";
    const snapshot = buildPositionSnapshot({
      currentPct: item.pnlPct,
      peakPct: item.peakPnLPct,
      activationPct: position.profitActivationPct,
      takeProfitPct: position.takeProfitPct,
      stopPct: position.stopPct
    });

    return `${index + 1}. ${position.symbol || "N/A"}
Entry: ${fmtPrice(position.entry)} | Current: ${fmtPrice(item.currentPrice)}
PnL: ${fmtPct(item.pnlPct, 2)} | Peak: ${fmtPct(item.peakPnLPct, 2)}
TP: ${Number.isFinite(position.takeProfitPct) ? `+${fmtPct(position.takeProfitPct * 100, 2)}` : "N/A"} | DTP: ${Number.isFinite(position.profitActivationPct) ? `+${fmtPct(position.profitActivationPct * 100, 2)}` : "N/A"} | Stop: ${Number.isFinite(position.stopPct) ? fmtPct(position.stopPct * 100, 2) : "N/A"}
Age: ${Number.isFinite(item.ageMin) ? `${item.ageMin}m` : "N/A"} | State: ${status}${trailingLine}
${snapshot}`;
  });

  return withFooterTime(
    "🟡 HOLD SUMMARY",
    `${header}\n\n${blocks.join("\n\n")}`,
    fmtReportTime(now)
  );
}

function buildDecisionReport(action, reasons, extra = "") {
  return `🧠 DECISION REPORT
Action: ${action}
Reasons:
- ${reasons.join("\n- ")}${extra ? "\n" + extra : ""}`;
}

function buildBuyReport(
  symbol,
  price,
  size,
  qty,
  stopPct,
  emergencyStopPct,
  trailingActPct,
  balanceAfter,
  reasons = [],
  takeProfitPct = null,
  activationPct = null
) {
  const reasonBlock = Array.isArray(reasons) && reasons.length
    ? `\nDecision:\n- ${reasons.join("\n- ")}`
    : "";
  const snapshot = buildPositionSnapshot({
    currentPct: 0,
    activationPct,
    takeProfitPct,
    stopPct,
    label: "Entry"
  });
  return `🟢 BUY EXECUTED
Pair: ${symbol}
Entry: ${fmtPrice(price)}
Size: ${isFinite(size) ? `${size} USDT` : "N/A"}
Qty: ${isFinite(qty) ? qty : "N/A"}
ATR stop: ${isFinite(stopPct) ? `${(stopPct * 100).toFixed(2)}%` : "N/A"}
Emergency stop: ${isFinite(emergencyStopPct) ? `${(emergencyStopPct * 100).toFixed(2)}%` : "N/A"}
Trailing trigger: ${isFinite(trailingActPct) ? `+${(trailingActPct * 100).toFixed(2)}%` : "N/A"}
Balance after buy: ${isFinite(balanceAfter) ? `${balanceAfter.toFixed(2)} USDT` : "N/A"}
Reason: best pullback-continuation setup
${snapshot}${reasonBlock}`;
}

function buildSellReport(
  symbol,
  price,
  pnl,
  reason,
  entry,
  peakPnLPct,
  usdtFree,
  lossStreak,
  tradesToday,
  details = [],
  netPnlPct = null,
  takeProfitPct = null,
  activationPct = null
) {
  const detailBlock = Array.isArray(details) && details.length
    ? `\nExit context:\n- ${details.join("\n- ")}`
    : "";
  const snapshot = buildPositionSnapshot({
    currentPct: Number.isFinite(pnl) ? pnl * 100 : 0,
    peakPct: peakPnLPct,
    activationPct,
    takeProfitPct,
    label: "Exit"
  });
  return `🔴 SELL EXECUTED
Pair: ${symbol}
Exit: ${fmtPrice(price)}
Gross PnL: ${isFinite(pnl) ? `${(pnl * 100).toFixed(2)}%` : "N/A"}
Net PnL est.: ${isFinite(netPnlPct) ? `${netPnlPct.toFixed(2)}%` : "N/A"}
Reason: ${reason}
Entry: ${fmtPrice(entry)}
Peak: ${isFinite(peakPnLPct) ? `+${peakPnLPct.toFixed(2)}%` : "N/A"}
Balance: ${isFinite(usdtFree) ? `${usdtFree.toFixed(2)} USDT` : "N/A"}
Loss streak: ${lossStreak}
Rounds today: ${tradesToday}
${snapshot}${detailBlock}`;
}

function buildTrailingActivatedReport(symbol, entry, price, pnlPct, triggerPct) {
  return `🟠 TRAILING ACTIVATED
Pair: ${symbol}
Entry: ${fmtPrice(entry)}
Current: ${fmtPrice(price)}
PnL: ${typeof pnlPct === "number" ? `${pnlPct.toFixed(2)}%` : "N/A"}
Trigger: ${typeof triggerPct === "number" ? `+${(triggerPct * 100).toFixed(2)}%` : "N/A"}`;
}

module.exports = {
  buildMarketReport,
  buildBalanceReport,
  buildHeartbeatReport,
  buildHoldSummaryReport,
  buildDecisionReport,
  buildBuyReport,
  buildSellReport,
  buildTrailingActivatedReport
};
