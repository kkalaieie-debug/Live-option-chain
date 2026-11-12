# TradePulse Live Option Chain

Netlify static frontend + Render persistent Node.js WebSocket backend + Render PostgreSQL.

## Included
- Angel One SmartAPI login using API key, client code, PIN/password and TOTP secret.
- Angel One WebSocket 2.0 connection via `smartapi-javascript`.
- REST + browser WebSocket endpoints.
- PostgreSQL tick snapshots and OI history.
- Four OI classifications for CE, PE and index futures.
- PCR, total CE/PE OI, max-pain calculation, intrinsic/time value and Black-Scholes IV/Delta/Gamma.
- NIFTY, BANKNIFTY and SENSEX configuration placeholders.
- Netlify static dashboard.

## Important setup before live data
This is a deployable implementation scaffold, not a connected account. You must add your own credentials and the correct current instrument tokens/expiry rows. No credentials are included. Confirm that your Angel One account/API subscription permits the required market-data feeds and exchanges.

### 1. Deploy PostgreSQL on Render
Create a Render PostgreSQL database. Copy its **Internal Database URL** into the backend environment as `DATABASE_URL` when the API service is in the same Render region. The service runs `db/schema.sql` automatically at startup.

### 2. Deploy backend on Render
Create a Web Service from this repository:
- Root directory: `backend`
- Build command: `npm install`
- Start command: `npm start`
- Node: 20+

Set environment variables:
- `NODE_ENV=production`
- `DATABASE_URL=<Render internal database URL>`
- `ANGEL_API_KEY=<your SmartAPI key>`
- `ANGEL_CLIENT_CODE=<your client code>`
- `ANGEL_PIN=<your Angel One PIN/password>`
- `ANGEL_TOTP_SECRET=<your TOTP base32 secret>`
- `FRONTEND_ORIGINS=https://YOUR-SITE.netlify.app`
- `INSTRUMENT_MASTER_URL=https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json`
- `AUTO_CONNECT=true`
- `SUBSCRIBE_INDEX_TOKENS=true`

Never put these credentials in the frontend, GitHub, screenshots or chat.

### 3. Instrument tokens
Angel One tokens and exchange codes change and must be taken from the current instrument master. `backend/src/instruments.js` downloads and parses the master. Review `backend/config/contracts.example.json` and copy it to `backend/config/contracts.json`, then enter the current expiry contracts you intend to stream.

For each index add:
- spot/index token and exchange type
- CE and PE option rows for the selected expiry (token, trading symbol, strike, expiry, lot size, exchange type)
- futures rows for the expiry (token, trading symbol, expiry, exchange type)

Do not guess tokens. SENSEX contracts use BSE/BFO exchange codes from the current master. NIFTY/BANKNIFTY use NSE/NFO.

### 4. Deploy frontend on Netlify
Connect the repository:
- Base directory: `frontend`
- Publish directory: `.` (or drag/drop the frontend folder)
Set the public build-time variable:
- `VITE_API_BASE=https://YOUR-RENDER-SERVICE.onrender.com`
If serving plain static HTML without Vite, edit `frontend/config.js` and set `API_BASE` to your Render URL. This URL is public; it is not a secret.

### 5. Verify
- Open `https://YOUR-RENDER-SERVICE.onrender.com/health`
- Open the Netlify URL.
- Backend status must show `connected` before the UI reports live ticks.
- The UI clearly labels missing/stale feeds and never fabricates prices.

## OI classification logic
Each instrument is classified by price change and OI change over the selected comparison window:
- Price ↑ + OI ↑ = Long buildup
- Price ↓ + OI ↑ = Short buildup
- Price ↓ + OI ↓ = Long unwinding
- Price ↑ + OI ↓ = Short covering
- Otherwise = Neutral / insufficient movement.

For an option contract, the classification describes that contract's price/OI relationship. It is an inference, not proof of buyer/seller intent. Futures classification is calculated separately.

## Greeks
IV is solved numerically from Black-Scholes using spot, strike, time-to-expiry, rate and option premium. Delta and Gamma are then calculated from the solved IV. Time value = premium - intrinsic value. These are model estimates; verify rate, expiry timestamp and dividend assumptions for production use.

## Notes
- Angel One's documented OI Buildup and PCR APIs are NSE-only; this project computes strike-wise OI analytics locally for NSE and BSE contracts when valid live data is available.
- Angel One's official WebSocket 2.0 supports dynamic subscriptions; the SDK emits decoded `tick` events. Check the exact SDK event shape against your account/feed version and adjust `normalizeAngelTick()` if necessary.
- WebSocket connections can be interrupted by deploys or upstream session expiry. The backend reconnects and re-subscribes.
- Use a paid always-on Render service for market hours. Render free services can spin down.
- This software is for market analytics, not investment advice or order execution.
