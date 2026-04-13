# Bot Runtime Flow - Core Loop

## Main Loop Sequence (`runBot()` in core/index.js)

### 1. Loop Guard & Setup
```
- Check shutdownRequested
- Check executionKillSwitch (halts if 3+ consecutive failures)
- Check loopInProgress (prevent concurrent cycles)
- Set loopInProgress = true
```

### 2. Portfolio Valuation
```
- getPortfolioValue() → fetches balances + tickers
- usdtFree, currentEquity, balances
- currentPositionPrice (from portfolio or candle fallback)
```

### 3. Daily Reset (if new Jakarta day)
```
- Reset: tradesToday, lossStreak, realizedPnlToday, realizedNetPnlToday
- Set: startOfDayEquity, date
- Clear: lastReportedPnlBySymbol
```

### 4. Auto Pair Rotation (if enabled)
```
- maybeRotatePairUniverse()
- Fetches top 10 pairs by volume + momentum
- Respects stop-loss blacklist (24h cooldown)
- Pins open positions (won't rotate them out)
- Updates config.pairs at runtime
```

### 5. Position Recovery (if state.position missing)
```
- detectOpenPositionFromBalance()
- Scans balances for coins > minRecoverUSDT
- Estimates entry from current price
- Logs to trade journal as "recovery" entry
```

### 6. Position Validation (dust check)
```
- For each tracked position:
  - Check balance > 0
  - Check value >= minManagedPositionUSDT
  - Remove invalid positions from state
```

### 7. Entry Gate Checks
```
Entry blocked if ANY:
- Loss streak halt (>= 3 consecutive losses, no open positions)
- Daily round limit (tradesToday >= maxRoundsPerDay)
- Cooldown active (now < lastTradeTime)
- Position slots full (openPositions >= maxOpenPositions)
- Exposure cap reached (currentExposure >= exposureCapPct)

Sets: entryGateStatus for reporting
```

### 8. Market Scanning
```
- scanMarket(config, getCandles, botLog)
- 15m trend scan (EMA21, RSI, ATR)
- 3m entry scan (breakout, volume, RSI band, candle strength)
- Returns: marketData, bestEligible, marketMode, volatilityState
- Applies market profile overrides (bullish/bearish/neutral/etc.)
```

### 9. Data Freshness Check
```
- Update lastCandleData timestamps
- Check if 3m and 15m candles are fresh (< 2-3x timeframe age)
- Save health.json with dataFresh status
- Alert if stale (> 20 min)
```

### 10. Scheduled Reports
```
runScheduledReports():
- Heartbeat (5 min): status, positions, data freshness
- Market Report (60 min): market mode, top scorers, watchlist
- Balance Report (60 min): equity, USDT free, PnL today
```

### 11. Multi-Trade Recovery + Auto-Sell Safety
```
- Recover unmanaged balances into state.positions
- Auto-sell any remaining unmanaged assets (> minManagedPositionUSDT)
- Prevents "orphan" positions outside bot tracking
```

### 12. Exit Flow (handleExitFlow)
```
For EACH open position:
  a. Get current price (from marketData or candle fetch)
  b. evaluateExit() → checks all exit conditions:
     - Take Profit
     - Emergency SL / ATR SL
     - Trailing stop / profit protection
     - Time stop / stale trade
     - Momentum failure / RSI blowoff
     - Break-even fade / cost guard
  c. If exit triggered:
     - Execute sell order
     - Reconcile fill price, fees, slippage
     - Update state (remove position or reduce qty for partial)
     - Log trade journal
     - Send sell report
     - Set exitOccurred = true
     - CONTINUE to next position (NOT return!)
  d. If no exit:
     - Check trailing activation
     - Build holdItems for report

After loop:
  - If holdItems.length && (due OR pnl changed OR exitOccurred):
    - Send hold summary report
    - Update lastReportedPnlBySymbol
  - Return { handledExit: exitOccurred, lastHoldReportTime }
```

### 13. Post-Exit Check
```
if (exitFlowResult.handledExit) {
  return; // End cycle, wait for next loop
}
```

### 14. Entry Flow (handleEntryFlow)
```
Only if entry gate is open:
- Check bestEligible symbol not already held
- Check position slots available
- Check exposure cap
- buildEntryPlan() → calculate size, stop, TP
- buildPositionMeta() → create position object
- Execute buy order (or dry-run)
- Reconcile fill price, fees, slippage
- Add to state.positions
- Send buy report
- Log trade journal
```

### 15. Loop Cleanup
```
- Set loopInProgress = false
- Check shutdownRequested → performSafeShutdown()
```

---

## Key Timing

| Interval | Default | Config Key |
|----------|---------|------------|
| Loop cycle | 60s | loopIntervalMs |
| Heartbeat | 5 min | report.heartbeatIntervalMs |
| Market Report | 60 min | report.marketReportIntervalMs |
| Balance Report | 60 min | report.balanceReportIntervalMs |
| Hold Report | 10 min | report.holdReportIntervalMs |
| Pair Rotation | 6h | autoPairRotation.refreshIntervalHours |
| Entry Cooldown | 5-10 min | cooldownMs (mode-dependent) |
| Loss Cooldown | 10 min | lossCooldownMs |

---

## Bug Fix Applied (exitFlow.js)

**Problem:** Early return after first exit prevented checking remaining positions.

**Before:**
```javascript
if (exitEval?.exit) {
  // ... execute exit ...
  return { handledExit: true, lastHoldReportTime }; // ❌ Stops loop
}
```

**After:**
```javascript
let exitOccurred = false;

for (let idx = 0; idx < positions.length; idx++) {
  if (exitEval?.exit) {
    // ... execute exit ...
    exitOccurred = true;
    continue; // ✅ Check next position
  }
  // ... build holdItems ...
}

// Send hold report if exit occurred (shows updated state)
if (holdItems.length && (holdReportDue || shouldSendHoldSummary || exitOccurred)) {
  // send report
}

return { handledExit: exitOccurred, lastHoldReportTime };
```

**Impact:**
- All open positions now checked for exit each cycle
- Hold report sent after exits (shows remaining positions)
- Multi-trade scenarios work correctly
