# Deploying to Vercel — Phase 1 (chat + Strava)

Phase 1 puts the app online with **coach chat** and **Strava** working. WHOOP is
Phase 2 (it needs the logic in `~/whoop-mcp` ported into an `api/whoop.js`); until
then the WHOOP panel shows a sync error on the hosted site — that's expected.

The local desktop app is **unaffected** — it still talks to your localhost servers.
The app auto-detects where it's running (`localhost`/`file://` → local servers; a real
domain → same-origin `/api`).

## What's in the repo now

```
api/
  _auth.js     # shared password check for the hosted API
  chat.js      # → Anthropic Messages API (replaces the Claude Desktop bridge)
  strava.js    # → Strava REST API (port of proxy/server.js)
  windy.js     # → Windy Point Forecast API (ride-planning weather)
package.json   # root deps for the functions (@vercel/kv)
vercel.json    # serves the app at "/", gives chat 60s to respond
```

## One-time setup in Vercel

### 1. Rotate your secrets first
These have lived in plaintext local config, so generate fresh ones before they go
near a public URL:
- **Anthropic API key** — console.anthropic.com → API keys → create new (revoke old).
- **Strava** — only the **refresh token** needs care; you can keep client id/secret,
  but rotate the secret if you want to be thorough.

### 2. Import the GitHub repo
Vercel → **Add New → Project → Import** `AndySq2023/cycling-coach`.
- Framework Preset: **Other**
- Build Command: leave **empty**
- Output Directory: leave **empty**
- Install Command: default (`npm install`)

### 3. Add Environment Variables (Project → Settings → Environment Variables)

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your fresh Anthropic key |
| `STRAVA_CLIENT_ID` | from `~/.strava-proxy/auth.json` |
| `STRAVA_CLIENT_SECRET` | from `~/.strava-proxy/auth.json` |
| `STRAVA_REFRESH_TOKEN` | from `~/.strava-proxy/auth.json` |
| `APP_PASSWORD` | a password you choose — the app asks for it on first load |
| `WINDY_API_KEY` | *(optional)* Point Forecast key from api.windy.com → enables the Weather panel |

> Without `APP_PASSWORD` the API refuses to run, so chat can't be left open to the
> world by accident.
>
> `WINDY_API_KEY` is optional: leave it unset and the Weather panel just shows a sync
> error (everything else works). Get a free key at **api.windy.com → sign in → API keys
> → Point Forecast**. The app sends the ride location (set in the Weather panel, or 📍
> from the device); the key itself never leaves the server.

### 4. (Recommended) Add Vercel KV for Strava token rotation
Strava can hand back a new refresh token. The serverless filesystem is read-only, so
to persist it: Vercel → **Storage → Create → KV**, link it to this project. That sets
`KV_REST_API_URL` automatically and `api/strava.js` starts using it. Skip this and the
app still works until Strava rotates the token (often a long time), at which point
you'd update `STRAVA_REFRESH_TOKEN` by hand.

### 5. Deploy
Push to the branch / merge to `main` → Vercel builds automatically. Open the URL,
enter the app password when prompted, and Strava + chat should work.

## Notes & limits
- **Function timeout:** chat is capped at 60s (`vercel.json`). If long replies get cut
  off, shorten history or lower `MAX_TOKENS` in `api/chat.js`.
- **Model:** `api/chat.js` uses `claude-opus-4-8`. Switch to `claude-sonnet-4-6` there
  for faster/cheaper replies if you prefer.
- **State** (plan, chat history) still lives in the browser's localStorage — per-device,
  same as today.

## Phase 2 (later)
Port `~/whoop-mcp`'s WHOOP OAuth into `api/whoop.js` (refresh token → Vercel KV, same
pattern as Strava), then the WHOOP panel works on the hosted site too.
