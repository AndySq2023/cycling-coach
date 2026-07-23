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
package.json   # root deps for the functions (@vercel/kv)
vercel.json    # serves the app at "/", gives chat + team 60s to respond
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
| `APP_PASSWORD` | a password you choose — the app asks for it on first load. **This is now the *master* login** (team owner); members get their own generated passwords (see "Team accounts"). |
| `MASTER_NAME` | *(optional — teams)* your display name on the Team Report (default "Coach") |
| `CHAT_DAILY_LIMIT` | *(optional — teams)* coach messages per member per day (default 40; master exempt) |
| `WINDY_API_KEY` | *(optional)* Point Forecast key from api.windy.com → enables the Weather panel |
| `GRAPHHOPPER_URL` | *(optional)* `https://graphhopper.com/api/1` for the hosted Directions API, or your own instance's base URL if self-hosting → enables route planning from chat. The hosted service also provides the geocoding used for destinations and coach-set home locations; a self-hosted OSS instance has no geocoder, so those fall back to the coach's approximate coordinates |
| `GRAPHHOPPER_API_KEY` | *(optional)* your GraphHopper API key (required for the hosted service, not always for self-hosted) — **never commit this to the repo**, Vercel env vars only |
| `ROUTE_LOOP_SEEDS` | *(optional)* how many `round_trip` candidates to try per loop request, default 2 — each is a billed request on the hosted plan |
| `ROUTE_CACHE_TTL_SECONDS` | *(optional)* how long identical route requests are cached in KV before re-querying GraphHopper, default 86400 (1 day) |

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
>
> `GRAPHHOPPER_URL` is optional: leave it unset and route-planning requests from chat
> will just fail with an error, everything else works unaffected. Using GraphHopper's
> **hosted** Directions API is the simplest path — sign up at graphhopper.com, set
> `GRAPHHOPPER_URL=https://graphhopper.com/api/1` and `GRAPHHOPPER_API_KEY=<your key>`,
> no infrastructure of your own to run. Self-hosting the open-source engine is the
> alternative if you outgrow the hosted plan's credits — it needs to hold the
> road-network graph in memory, which doesn't fit Vercel's serverless model, so it'd
> run as its own always-on process (Fly.io/Railway/Render/a VPS) loaded with an
> OpenStreetMap extract. See `api/route.js` for the request shape either expects, and
> for the credit-saving measures (fewer round_trip seeds, KV response caching) built
> in for the metered hosted plan.

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
  hosted build the app also **mirrors it to KV** (`api/state.js`) so your other devices can
  see the same schedule, plan and recent conversation. The app pushes on every change and
  pulls on load/focus, so schedule edits made on one device show up on the others.
  KV is required for this (and for WHOOP); without it the bot just runs on empty state.

## Team accounts (multi-user, optional)

The app supports **up to 6 members plus you as master**. Full spec, architecture and
rollout checklist: **[TEAM.md](TEAM.md)**. Short version:

1. **KV is required** (same Upstash integration as above — roster, per-user state and
   tokens live there).
2. Register the OAuth callback with both providers so members can connect their own
   accounts: **Strava** → add the Vercel domain to *Authorization Callback Domain* AND
   request an athlete-capacity increase (apps start capped at 1 athlete);
   **WHOOP** → add `https://<app>.vercel.app/api/oauth` to *Redirect URIs*.
3. Log in with `APP_PASSWORD` → **👥 Team** tab → **+ Add member** → copy the one-time
   password and send it to the rider with the URL.
4. The rider logs in with that password and taps **Connect your Strava / WHOOP** in the
   data panel. Their row on your Team Report fills in from live data (5-min cache).
5. Manage from the same tab: reset password, or remove (deletes their plan, chat and
   connections).

Members chat with the same coach on your Anthropic key — hence `CHAT_DAILY_LIMIT`.
A member's browser stores their own password under the same `cyclingCoachPw`
localStorage key; wrong password → the app clears it and re-prompts on reload.

## Morning briefing

The coach writes you a short briefing — recovery read, today's session, best ride window —
shown as a card at the top of the **Today** tab. It generates once on the first open of each
day and is cached in localStorage, so reopening the app doesn't re-spend a Claude call.
It can adapt today's session if recovery warrants (same `schedule_update` mechanism as chat),
and the exchange is added to your conversation so the coach remembers what it told you.

No setup: it needs only `ANTHROPIC_API_KEY`, which chat already requires.

> Earlier versions delivered this over Telegram via a Vercel Cron (`api/briefing.js`) and
> offered a Telegram bot (`api/telegram.js`). Both were removed — they required a duplicate,
> hand-maintained copy of the coach's prompt on the server, which drifted out of sync with
> the app. If you want a proactive push again, add web push rather than a second coach.

## Troubleshooting WHOOP on the hosted site
The Strava-style debugging applies — read Network → `/api/whoop` Response:
- **401** = wrong `APP_PASSWORD` cached in the browser (clear localStorage `cyclingCoachPw`, reload).
- **503** = `APP_PASSWORD` env unset.
- **200 `{error: "WHOOP token refresh failed (400/401)…"}`** = the KV refresh token is
  missing, stale, or was invalidated (e.g. the local bridge refreshed after you seeded KV).
  Re-seed from a fresh authorise (`cd ~/whoop-mcp && npm run auth`), update `WHOOP_REFRESH_TOKEN`, redeploy.
- **200 `{error: "Missing WHOOP credentials…"}`** = `WHOOP_CLIENT_ID/SECRET` unset, or no
  token in KV and no `WHOOP_REFRESH_TOKEN` env seed.
