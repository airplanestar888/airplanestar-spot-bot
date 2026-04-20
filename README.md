# airplanestar Spot Trading Bot

Bot spot trading Bitget berbasis Node.js dengan:
- CLI runtime
- dashboard lokal di `http://localhost:3841`
- journaling trade
- report Telegram
- konfigurasi terpusat di `config.json`
- mode single-trade atau multi-trade ringan
- startup validation untuk file engine, config, dan dependency

## Disclaimer

Project ini dibuat untuk learning, research, dan eksperimen pribadi saja. Ini bukan financial advice, investment advice, atau rekomendasi beli/jual aset apa pun.

Trading crypto memiliki risiko tinggi, termasuk kehilangan modal. Gunakan bot ini dengan risiko sendiri, selalu uji di `dryRun` terlebih dahulu, pahami strategi dan konfigurasi, dan jangan gunakan dana yang tidak siap hilang.

Author tidak bertanggung jawab atas kerugian finansial, error exchange, penyalahgunaan API, salah konfigurasi, atau perilaku bot yang tidak terduga.

## Quick Start

Clone repository:

```bash
git clone https://github.com/airplanestar888/airplanestar-spot-bot.git
cd airplanestar-spot-bot
```

Install dependency:

```bash
npm install
```

Copy env template:

```bash
cp .env.example .env
```

Untuk Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Isi `.env` dengan API key dan Telegram token milik sendiri:

```env
# Bitget Exchange
BITGET_API_KEY=your_bitget_api_key
BITGET_SECRET_KEY=your_bitget_secret_key
BITGET_PASSPHRASE=your_bitget_passphrase

# Telegram Bot
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id

# AI Agent
AI_AGENT_ENABLED=false
AI_PROVIDER=openrouter
AI_AGENT_TIMEOUT_MS=8000
AI_AGENT_RETRY_ATTEMPTS=3

# OpenRouter
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=openai/gpt-5-mini

# Gemini
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash

# OpenAI
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5.4
```

Sebelum trading live, jalankan dengan `dryRun: true` di `config.json`.

Start bot:

```bash
npm start
```

Dashboard lokal:

```text
http://localhost:3841
```

## Deploy Notes

- File `.env` tidak ikut repository dan wajib dibuat sendiri di server/komputer deploy.
- Jangan pernah upload API key, secret key, passphrase, token Telegram, log trading, atau runtime state.
- Mulai dari `dryRun: true`, lalu test report, dashboard, balance, dan order flow sebelum memakai dana asli.
- Gunakan API key exchange dengan permission minimum yang diperlukan. Hindari permission withdrawal.

## Tech Stack

- `Node.js`
- `JavaScript (CommonJS)`
- `axios` untuk integrasi REST API exchange
- `HTML`, `CSS`, `Vanilla JavaScript` untuk dashboard localhost
- `JSON` untuk runtime persistence

## Menjalankan Bot

Isi `.env`:

```env
# Bitget Exchange
BITGET_API_KEY=your_bitget_api_key
BITGET_SECRET_KEY=your_bitget_secret_key
BITGET_PASSPHRASE=your_bitget_passphrase

# Telegram Bot
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id

# AI Agent
AI_AGENT_ENABLED=false
AI_PROVIDER=openrouter
AI_AGENT_TIMEOUT_MS=8000
AI_AGENT_RETRY_ATTEMPTS=3

# OpenRouter
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=openai/gpt-5-mini

# Gemini
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash

# OpenAI
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5.4
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

Validation startup mencakup:
- file engine penting ada dan bisa dibaca
- folder runtime bisa ditulis
- field config utama valid
- profile `bot type`, `trade style`, dan `market profile` yang dipilih memang ada

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
- `minManagedPositionUSDT`, `minRecoverUSDT`
- `useDynamicTakeProfit`
- `dynamicTakeProfitAtrMultiplier`
- `enableCostGuard`, `costGuardArmPct`, `costGuardFloorPct`
- `maxRoundsPerDay`
- `dailyProfitTargetPct`, `dailyLossLimitPct`
- `loopIntervalMs`
- `holdCheckIntervalMs`
- `report.*`
- `autoPairRotation.*`
- `usePairReentryBlock`, `pairReentryBlockLossPct`, `pairReentryBlockMinutes`
- `pairSettings`

`pairSettings` hanya menentukan pair aktif:

```json
"pairSettings": {
  "BTCUSDT": { "enabled": true },
  "ETHUSDT": { "enabled": true },
  "BNBUSDT": { "enabled": false }
}
```

### 2. Bot Type

`botType` adalah struktur entry engine utama bot.

Preset bawaan:
- `scalp_trend`
- `day_trade`
- `swing_trade`
- `range_scalp`
- `custom`

Layer ini mengatur:
- timeframe signal dan trend
- hold structure
- confirmation core
- breakout threshold
- struktur setup masuk

Field umumnya:
- `signalTimeframe`
- `trendTimeframe`
- `minScalpTargetPct`
- `maxScalpTargetPct`
- `timeStopMinutes`
- `maxHoldMinutes`
- `breakEvenMinutes`
- `minConfirmation`
- `breakoutPct`
- `requireEma21Rising`
- `requireFastTrend`
- `requirePriceAboveEma9`
- `requireEdge`

### 3. Market Profile

Market profile adalah kondisi market.

Preset bawaan:
- `bullish`
- `bullish_slow`
- `neutral`
- `bearish`
- `choppy`
- `custom`

Layer ini mengatur filter entry sesuai kondisi market, seperti:
- `allowEntries`
- `minExpectedNetPct`
- `minVolumeRatio`
- `minTrendRsi`
- `minAtrPct`
- `maxAtrPct`
- `maxEmaGapPct`
- `requireRsiMomentum`
- `requireBreakout`
- `enableRsiBandFilter`
- `enableAtrFilter`
- `enableVolumeFilter`
- `enableCandleStrengthFilter`
- `enablePriceExtensionFilter`
- `enableRangeRecoveryFilter`
- `rsiBandLower`
- `rsiBandUpper`
- `minCandleStrength`
- `optimalRsiLow`
- `optimalRsiHigh`
- `optimalAtrLow`
- `optimalAtrHigh`
- `minEmaGapNeg`

### 4. Trade Style

Trade style mengatur risk behavior dan exit behavior.

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
- `atrStopMultiplier`
- `minStopPct`
- `maxStopPct`
- `emergencyStopLossPct`
- `enableTimeStop`
- `enableStaleTrade`
- `timeStopProfitPct`
- `minHoldPnlPct`
- `breakEvenArmedPct`
- `breakEvenFloorPct`
- `minMomentumExitPct`
- `exitRSIThreshold`
- `exitTimeframe`
- `cooldownMs`

Ringkasan layer dashboard:
- `Bot Settings` = runtime global, sizing, exposure, reporting, pair management
- `Bot Type` = struktur entry engine
- `Market Profile` = filter market dan quality filter entry
- `Trade Style` = risk, trailing, hard stop, stale, break-even, dan exit profile

## AI Agent

AI Agent bekerja sebagai tuner untuk workspace profile `ai_agent`.

Prinsip utamanya:
- AI Agent tidak mengganti preset market profile bawaan seperti `bullish`, `neutral`, atau `custom`
- AI Agent hanya mengupdate `marketProfiles.ai_agent`
- saat decision berhasil di-apply, bot memakai `selectedMarketProfile = ai_agent`
- `allowEntries` untuk profile `ai_agent` dikontrol manual dari dashboard, bukan diputuskan AI
- jika AI gagal, bot hanya fallback ke `custom` bila toggle `Fallback to custom profile if invalid` aktif

Yang perlu user tahu:
- pair context AI Agent hanya berasal dari hasil auto rotate
- jika auto rotate tidak jalan, AI Agent juga tidak jalan
- jika ada open position, auto rotate akan pending dan AI Agent tidak dipanggil ulang
- provider AI bisa dipilih dari dashboard: OpenRouter, Gemini, atau OpenAI
- prompt AI Agent bisa diatur dari dashboard lewat `persona`, `objective`, dan `instructions`
- dashboard juga menampilkan `Last Used Prompt Blocks`, `Last Used Ranked Candidates`, dan `Exact Request Sent To LLM` untuk validasi manual

## Entry Logic

Scoring pair berbasis live market, bukan bobot pair manual.

Komponen utama:
- trend pada timeframe trend
- kualitas candle pada timeframe signal
- volume ratio
- breakout atau recovery sesuai bot type
- ATR dan RSI quality sesuai market profile
- `live weight` pair dari market snapshot

Catatan:
- keputusan entry sekarang fokus ke kualitas setup market
- `Bot Type` menentukan struktur setup, `Market Profile` menentukan kualitas filter setup
- cost trade dipakai untuk accounting/report setelah order fill, bukan untuk memblok entry utama

Istilah penting:
- `eligible` = pair lolos syarat entry
- `watch only` = pair dipantau tapi belum layak entry
- `failed filters` = pair kalah di satu atau beberapa filter

## Exit Logic

Core exit saat ini:
- `Take Profit`
- `Dynamic TP`
- `DTP Fallback`
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
- jika profit sempat melewati `DTP` lalu gagal lanjut ke `TP`, bot bisa keluar lewat `DTP Fallback`

Catatan:
- `Exit Timeframe` menentukan candle basis analisa exit saat posisi sudah hold
- `holdCheckIntervalMs` menentukan seberapa sering posisi hold dicek ulang
- hard stop berada di layer `Trade Style`, bukan `Bot Settings`

## Runtime Flow

Urutan runtime sederhananya:
1. bot ambil balance, ticker, dan equity
2. bot cek recovery balance yang layak dikelola
3. bot validasi semua posisi managed dan refresh qty/price/value terbaru
4. bot cek entry gate
5. bot scan market
6. bot kirim report terjadwal
7. bot evaluasi exit
8. jika aman dan ada setup, bot bisa entry

Polling runtime:
- saat tidak ada posisi, loop ikut `loopIntervalMs`
- saat ada posisi hold, loop ikut `holdCheckIntervalMs`
- polling hold berbeda dari `exitTimeframe`: yang satu ritme cek, yang satu basis candle analisa

Aturan recovery:
1. asset di bawah `minManagedPositionUSDT` dianggap terlalu kecil untuk dikelola
2. recovery hanya boleh mulai dari `minRecoverUSDT`
3. recovery hanya berlaku untuk pair aktif atau pair yang memang sudah managed

Aturan auto rotate:
1. auto rotate hanya jalan jika `autoPairRotation.enabled=true`
2. auto rotate hanya boleh jalan saat tidak ada open position
3. jika ada balance recoverable `>= minRecoverUSDT`, auto rotate akan di-skip
4. saat startup, bot menjalankan satu siklus `runBot()` dulu sebelum auto rotate pertama
5. hasil rotate pair aktif akan langsung dipersist ke `config.json`, jadi dashboard dan runtime membaca sumber pair aktif yang sama
6. AI Agent membaca kandidat pair dari hasil auto rotate yang sama, bukan dari sumber pair lain

Pair flags untuk auto rotate:
- `Disable Pair on SL`
- `Disable Pair on Stale Trade`
- `Disable Pair on Any Loss`

Catatan pair flags:
- `Cost Guard` tidak ikut dihitung sebagai `Any Loss` blacklist
- reentry block berbeda dengan pair flag auto rotate; reentry block hanya mencegah buy ulang cepat pada pair yang sama

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
- `Enable Multi Trade=true` mengizinkan beberapa posisi terbuka sekaligus, tetap dibatasi oleh `maxOpenPositions` dan `exposureCapPct`.
- `Managed Position Min USDT` dan `Recovery Min USDT` bisa diatur dari dashboard untuk menentukan kapan asset kecil diabaikan dan kapan balance boleh direcover jadi posisi bot.
- accounting trade sekarang memakai actual fill price untuk gross PnL, dan memakai actual fee/slippage bila data exchange tersedia.
- dry-run memakai engine yang sama dengan live untuk decision flow; yang dibedakan hanya execution/fill simulasi.
- log CLI candle fetch sengaja diringkas pada kondisi sukses, sementara detail pair tetap muncul saat `WARN` atau `ERROR`.

## Command Berguna

```powershell
Get-Content .\logs\bot.log -Tail 100
Get-Content .\data\trade_journal.json -Tail 80
Get-Content .\data\market_snapshot.json -Tail 80
node --check .\index.js
node .\tests\run.js
```
