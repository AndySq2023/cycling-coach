# Deploying to Vercel — chat + Strava + WHOOP + weather

Puts the app online with **coach chat**, **Strava**, **WHOOP**, and **weather** all
working hosted. (WHOOP is the `~/whoop-mcp` bridge logic ported into `api/whoop.js`.)

The local desktop app is **unaffected** — it still talks to your localhost servers.
The app auto-detects where it's running (`localhost`/`file://` → local servers; a real
domain → same-origin `/api`).

## What's in the repo now

```
api/
  _auth.js     # shared password check for the hosted API
  _kv.js       # shared Vercel KV (Upstash) get/set helpers
  _state.js    # shared single-user state blob (plan, goal, chat) the app + bot both use
  _prompt.js   # server-side buildSystemPrompt + schedule-block parser (mirror of the app's)
  chat.js      # → Anthropic Messages API (replaces the Claude Desktop bridge)
  strava.js    # → Strava REST API (port of proxy/server.js)
  whoop.js     # → WHOOP v2 API (port of the ~/whoop-mcp localhost:3001 bridge)
  windy.js     # → Windy Point Forecast API (ride-planning weather)
  state.js     # → GET/PUT the shared state blob (the app syncs its localStorage here)
  telegram.js  # → Telegram webhook: chat with the coach over Telegram (see "Telegram bot")
package.json   # root deps for the functions (@vercel/kv)
vercel.json    # serves the app at "/", gives chat + telegram 60s to respond
```

## One-time setup in Vercel

### 1. Rotate your secrets first
These have lived in plaintext local config, so generate fresh ones before they go
near a public URL:
- **Anthropic API key** — console.anthropic.com → API keys → create new (revoke old).
- **Strava** — only the **refresh token** needs care; you can keep client id/secret,
  but rotate the secret if you want to be thorough.
- **WHOOP** — same idea; the **refresh token** is the sensitive part (rotate the client
  secret too if you want). You'll seed the refresh token into KV in step 4.

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
| `WHOOP_CLIENT_ID` | from `~/whoop-mcp/.env` |
| `WHOOP_CLIENT_SECRET` | from `~/whoop-mcp/.env` |
| `WHOOP_REFRESH_TOKEN` | from `~/whoop-mcp/.whoop-tokens.json` (seed — migrates to KV on first call) |
| `APP_PASSWORD` | a password you choose — the app asks for it on first load |
| `WINDY_API_KEY` | *(optional)* Point Forecast key from api.windy.com → enables the Weather panel |
| `TELEGRAM_BOT_TOKEN` | *(optional — for the Telegram bot)* from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | *(optional)* a random string you choose; also passed to `setWebhook` |
| `TELEGRAM_CHAT_ID` | *(optional)* the **only** Telegram chat id allowed to use the bot (yours) |

> **WHOOP does not need `WHOOP_REDIRECT_URI`** (the refresh-token grant doesn't use it).
> The `WHOOP_REFRESH_TOKEN` here is just a one-time seed — see step 4 for why it then
> lives in KV.
>
> Without `APP_PASSWORD` the API refuses to run, so chat can't be left open to the
> world by accident.
>
> `WINDY_API_KEY` is optional: leave it unset and the Weather panel just shows a sync
> error (everything else works). Get a free key at **api.windy.com → sign in → API keys
> → Point Forecast**. The app sends the ride location (set in the Weather panel, or 📍
> from the device); the key itself never leaves the server.

### 4. Add a KV store (required for WHOOP, recommended for Strava)
The serverless filesystem is read-only, so rotated refresh tokens have to be persisted
somewhere. **Vercel KV is now the Marketplace "Upstash for Redis" integration** (the old
standalone "KV" button is gone): Vercel → **Storage → Create Database → Upstash for
Redis → Create**, free plan, then **Connect to Project** (`cycling-coach`). It auto-injects
`KV_REST_API_URL` + `KV_REST_API_TOKEN` (plus `KV_URL` etc.) — the exact names `@vercel/kv`
reads, so no code change needed. Ignore Upstash's "pull env vars / install SDK" quickstart
steps; those are a generic Next.js tutorial.

- **Strava:** optional. Without KV the app works until Strava rotates the token (often a
  long time), at which point you'd update `STRAVA_REFRESH_TOKEN` by hand.
- **WHOOP:** effectively **required**. WHOOP rotates the refresh token on *every* refresh
  and invalidates the old one, so the `WHOOP_REFRESH_TOKEN` env seed is single-use — the
  first hosted refresh burns it. KV is where the live token has to live.

**Seeding WHOOP:** easiest path is to just set `WHOOP_REFRESH_TOKEN` (step 3) with the
current value from `~/whoop-mcp/.whoop-tokens.json`. On the first `/api/whoop` request the
function reads that seed, refreshes, and writes the rotated token into KV itself —
correctly serialized. (Avoid pasting it straight into the KV Data Browser: `@vercel/kv`
JSON-encodes values, so a raw string set by hand won't read back cleanly.)

> ⚠️ **Seeding KV breaks the local WHOOP bridge.** Once Vercel does its first refresh, the
> token in `~/whoop-mcp/.whoop-tokens.json` is dead. WHOOP can be live *either* locally
> *or* on Vercel, not both, unless they share a token store. Re-authorise locally
> (`cd ~/whoop-mcp && npm run auth`) if you need the desktop bridge back.

### 5. Deploy
Push to the branch / merge to `main` → Vercel builds automatically. Open the URL,
enter the app password when prompted, and chat + Strava + WHOOP should work. (Remember:
**env-var or KV changes need a redeploy** to take effect.)

## Notes & limits
- **Function timeout:** chat is capped at 60s (`vercel.json`). If long replies get cut
  off, shorten history or lower `MAX_TOKENS` in `api/chat.js`.
- **Model:** `api/chat.js` uses `claude-opus-4-8`. Switch to `claude-sonnet-4-6` there
  for faster/cheaper replies if you prefer.
- **State** (plan, chat history) lives in the browser's localStorage as before, but on a
  hosted build the app also **mirrors it to KV** (`api/state.js`) so the Telegram bot can
  see the same schedule, plan and recent conversation. The app pushes on every change and
  pulls on load/focus, so Telegram messages and schedule edits show up in the web app too.
  KV is required for this (and for WHOOP); without it the bot just runs on empty state.

## Telegram bot (optional)

Chat with the coach from Telegram with full context — live WHOOP/Strava/weather (fetched
per message), your training plan and goal, and the conversation shared with the web app.
The bot can also **write your schedule** (same `schedule_set`/`schedule_update` blocks the
web chat uses), so "move tomorrow to a rest day" from Telegram updates the app's Schedule
tab on next sync.

**Requires a KV store** (step 4) — that's the shared state the bot reads/writes.

1. **Get the bot token.** In Telegram, message **@BotFather** → `/newbot` (or reuse an
   existing bot's token). Set `TELEGRAM_BOT_TOKEN` in Vercel to that token.
2. **Find your chat id.** Message your bot once, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read
   `result[].message.chat.id`. Set `TELEGRAM_CHAT_ID` to that number — the bot ignores
   every other chat, so strangers can't spend your API credits or read your data.
3. **Pick a webhook secret.** Choose any random string; set `TELEGRAM_WEBHOOK_SECRET` in
   Vercel to it. Telegram echoes it back on every call so only Telegram can drive the
   endpoint.
4. **Redeploy** (env-var changes need it), then **register the webhook** — open this URL
   once in a browser (it `200`s with `{"ok":true}`):

   ```
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-app>.vercel.app/api/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>
   ```

5. **Use it.** Message the bot. Commands: `/start` (intro), `/plan` (show this week),
   `/reset` (clear the conversation — plan/data untouched).

**Troubleshooting:** check `https://api.telegram.org/bot<TOKEN>/getWebhookInfo` —
`last_error_message` shows the most recent failure. `pending_update_count` climbing means
the function is erroring (check Vercel logs). A `401` from the webhook = the secret header
didn't match `TELEGRAM_WEBHOOK_SECRET`. Silence with no reply = your `TELEGRAM_CHAT_ID`
doesn't match the chat you're messaging from.

### Daily morning briefing (optional)

`api/briefing.js` + a Vercel Cron entry (`vercel.json` → `crons`) send an automated
Claude-written briefing to your Telegram chat every morning: WHOOP recovery read,
today's scheduled session (the coach may adapt it if recovery is poor — same
`schedule_update` path as chat), and the best weather window to ride. The exchange is
appended to the shared history, so it also appears in the web app's chat.

Setup on top of the Telegram bot:
1. Add a `CRON_SECRET` env var in Vercel (any random string). Vercel Cron sends it as
   `Authorization: Bearer <CRON_SECRET>` automatically; the endpoint refuses to run
   without it so strangers can't trigger paid briefings.
2. Redeploy. The cron registers automatically from `vercel.json`.

Schedule: `20 7 * * *` = **07:20 UTC** (8:20am UK in summer / 7:20am in winter — Vercel
crons are UTC-only, so nudge it after clock changes if the time matters). ⚠️ On the
**Hobby plan** Vercel only guarantees the run lands *within the hour* after the
scheduled time, so the briefing may arrive anywhere from 8:20–9:20 BST. For to-the-minute
delivery, use a free external pinger (e.g. cron-job.org) hitting
`https://<app>.vercel.app/api/briefing` with the `Authorization: Bearer <CRON_SECRET>`
header instead of (or as well as) the Vercel cron.

Manual test after deploying:
```
curl -H "Authorization: Bearer <CRON_SECRET>" https://<your-app>.vercel.app/api/briefing
```
— should return `{"ok":true,"sent":true,...}` and the briefing appears in Telegram.

## Troubleshooting WHOOP on the hosted site
The Strava-style debugging applies — read Network → `/api/whoop` Response:
- **401** = wrong `APP_PASSWORD` cached in the browser (clear localStorage `cyclingCoachPw`, reload).
- **503** = `APP_PASSWORD` env unset.
- **200 `{error: "WHOOP token refresh failed (400/401)…"}`** = the KV refresh token is
  missing, stale, or was invalidated (e.g. the local bridge refreshed after you seeded KV).
  Re-seed from a fresh authorise (`cd ~/whoop-mcp && npm run auth`), update `WHOOP_REFRESH_TOKEN`, redeploy.
- **200 `{error: "Missing WHOOP credentials…"}`** = `WHOOP_CLIENT_ID/SECRET` unset, or no
  token in KV and no `WHOOP_REFRESH_TOKEN` env seed.
