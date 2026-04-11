# airplanestar Spot Trading Bot

Bot spot trading Bitget berbasis Node.js dengan:
- CLI runtime
- dashboard lokal di `http://localhost:3841`
- journaling trade
- report Telegram
- konfigurasi terpusat di `config.json`
- mode single-trade atau multi-trade ringan

## Disclaimer

Project ini dibuat untuk learning, research, dan eksperimen pribadi saja. Ini bukan financial advice, investment advice, atau rekomendasi beli/jual aset apa pun.

Trading crypto memiliki risiko tinggi, termasuk kehilangan modal. Gunakan bot ini dengan risiko sendiri, selalu uji di `dryRun` terlebih dahulu, pahami strategi dan konfigurasi, dan jangan gunakan dana yang tidak siap hilang.

Author tidak bertanggung jawab atas kerugian finansial, error exchange, penyalahgunaan API, salah konfigurasi, atau perilaku bot yang tidak terduga.

## Tech Stack

- `Node.js`
- `JavaScript (CommonJS)`
- `axios` untuk integrasi REST API exchange
- `HTML`, `CSS`, `Vanilla JavaScript` untuk dashboard localhost
- `JSON` untuk runtime persistence

## Menjalankan Bot

Isi `.env`:

```env
BITGET_API_KEY=your_key
BITGET_SECRET_KEY=your_secret
BITGET_PASSPHRASE=your_passphrase
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

Lalu jalankan:

```powershell
npm install
npm start
```

Atau di Windows:

```bat
run.bat
```

Atau di Linux:

```bash
./run.sh
```

`run.bat` dan `run.sh` akan:
- cek dependency runtime
- install dependency yang kurang bila perlu
- lalu menjalankan startup validation sebelum loop bot dimulai

Stop bot:
- tekan `Ctrl+C`

## Dashboard

Dashboard lokal tersedia di:
- `http://localhost:3841`

Fungsi utama:
- melihat report dan histori trade
- melihat status runtime bot
- mengubah `config.json`
- membaca README langsung dari dashboard

## Struktur Layer

Bot ini memakai 4 layer utama:

### 1. Bot Setting

Untuk setting umum yang berlaku lintas strategi:
- `dryRun`
- `minBuyUSDT`, `maxBuyUSDT`, `reserveUSDT`
- `enableMultiTrade`, `maxOpenPositions`, `exposureCapPct`
- `roundTripFeePct`, `slippageBufferPct`
- `useDynamicTakeProfit`
- `dynamicTakeProfitAtrMultiplier`
- `enableCostGuard`, `costGuardArmPct`, `costGuardFloorPct`
- `maxRoundsPerDay`
- `dailyProfitTargetPct`, `dailyLossLimitPct`
- `loopIntervalMs`
- `report.*`
- `pairSettings`

`pairSettings` hanya menentukan pair aktif:

```json
"pairSettings": {
  "BTCUSDT": { "enabled": true },
  "ETHUSDT": { "enabled": true },
  "BNBUSDT": { "enabled": false }
}
```

### 2. Entry Style

`botType` adalah gaya masuk utama bot.

Preset bawaan:
- `scalp_trend`
- `day_trade`
- `swing_trade`
- `range_scalp`
- `custom`

Layer ini mengatur:
- timeframe signal dan trend
- confirmation
- breakout / continuation style
- filter entry
- struktur setup masuk

### 3. Market Profile

Market profile adalah kondisi market.

Preset bawaan:
- `bullish`
- `bullish_slow`
- `neutral`
- `bearish`
- `choppy`
- `custom`

Layer ini hanya mengatur filter entry sesuai kondisi market, seperti:
- `allowEntries`
- `minExpectedNetPct`
- `minVolumeRatio`
- `minTrendRsi`
- `minAtrPct`
- `maxAtrPct`
- `maxEmaGapPct`

### 4. Trading Style

Trading style mengatur agresivitas, risk, dan exit.

Preset bawaan:
- `conservative`
- `normal`
- `aggressive`
- `professional`
- `bigmoney`
- `hyper`
- `custom`

Field umumnya:
- `riskPercent`
- `takeProfitPct`
- `trailingActivationPct`
- `trailingDrawdownPct`
- `trailingProtectionPct`
- `enableTimeStop`
- `enableStaleTrade`
- `timeStopProfitPct`
- `minHoldPnlPct`
- `breakEvenArmedPct`
- `breakEvenFloorPct`
- `minMomentumExitPct`
- `exitRSIThreshold`
- `cooldownMs`

## Entry Logic

Scoring pair berbasis live market, bukan bobot pair manual.

Komponen utama:
- trend pada timeframe trend
- kualitas candle pada timeframe signal
- volume ratio
- breakout atau recovery sesuai entry style
- ATR dan RSI quality
- expected net edge
- `live weight` pair dari market snapshot

Istilah penting:
- `eligible` = pair lolos syarat entry
- `watch only` = pair dipantau tapi belum layak entry
- `failed filters` = pair kalah di satu atau beberapa filter

## Exit Logic

Core exit saat ini:
- `Take Profit`
- `Dynamic TP`
- `Emergency SL`
- `ATR Stop Loss`
- `Cost Guard`
- `Break-even Fade`
- `Time Stop`
- `Stale Trade`
- `Momentum Failure`
- `RSI Reversal`
- `Trailing Hit`
- `Profit Protection`

Jika `useDynamicTakeProfit=true`, target profit utama dihitung dari ATR saat entry:

```text
dynamic TP = clamp(ATR signal * dynamicTakeProfitAtrMultiplier, minScalpTargetPct, maxScalpTargetPct)
```

Saat Dynamic TP aktif:
- level yang lebih tinggi antara `dynamic TP` dan `takeProfitPct` menjadi target utama
- level yang lebih rendah ditampilkan sebagai `DTP`
- jika profit tidak sanggup lanjut ke target utama, bot bisa keluar lewat jalur `DTP` / proteksi

## File Runtime

File runtime penting:
- `logs/bot.log`
- `data/trade_journal.json`
- `data/state.json`
- `data/health.json`
- `data/market_snapshot.json`

## Kombinasi Umum

- `scalp_trend + professional + bullish`
- `day_trade + professional + bullish_slow`
- `swing_trade + bigmoney + bullish`
- `range_scalp + professional + choppy`
- `custom + custom + custom`

## Runtime Notes

- `Rounds` berarti satu siklus trade yang sudah closed, bukan jumlah aksi buy/sell mentah.
- `Entry gate` di heartbeat dan market report menjelaskan kenapa bot tidak entry walau ada pair `eligible`.
- `HOLD SUMMARY` menampilkan snapshot posisi teks ringan, bukan chart PNG.
- `Enable Multi Trade=true` mengizinkan beberapa posisi terbuka sekaligus, tetap dibatasi oleh:
  - `maxOpenPositions`
  - `exposureCapPct`

## Command Berguna

```powershell
Get-Content .\logs\bot.log -Tail 100
Get-Content .\data\trade_journal.json -Tail 80
Get-Content .\data\market_snapshot.json -Tail 80
node --check .\index.js
node .\tests\run.js
```
