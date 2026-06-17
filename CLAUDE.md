# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

Open `app/cycling-coach.html` directly in a browser — no build step, no bundler. `~/Desktop/cycling-coach.html` is a symlink to the same file.

The Strava proxy runs as a persistent launchd service and should already be up:
```
launchctl list | grep stravaproxy        # check status (PID in first column = running)
curl http://localhost:3002/api/health    # quick liveness check
```

If the service is down, reload it:
```
launchctl unload ~/Library/LaunchAgents/com.cyclingcoach.stravaproxy.plist
launchctl load   ~/Library/LaunchAgents/com.cyclingcoach.stravaproxy.plist
```

Proxy logs: `proxy/proxy.log` and `proxy/proxy.error.log` (gitignored, created at runtime).

## Architecture

Two independent pieces that never import each other:

**`app/cycling-coach.html`** — the entire front-end in one file (HTML + CSS + JS, ~2500 lines). No framework, no build. All state lives in `localStorage` and in three JS globals: `athleteData`, `trainingPlan`, `sessionFeedback`. The app calls three localhost endpoints at runtime:

| Endpoint | Port | Provider |
|---|---|---|
| `/api/chat` | 3001 | Claude Desktop bridge |
| `/api/whoop` | 3001 | Claude Desktop bridge → `~/whoop-mcp` |
| `/api/strava` | 3002 | `proxy/server.js` |

Claude Desktop must be running for chat and WHOOP. Strava is independent (launchd service).

**`proxy/server.js`** — dependency-free Node (ESM) HTTP server. Single responsibility: call the Strava REST API (`/api/v3/athlete/activities`) with a refresh-token flow, normalise field names (e.g. `distance` → `distance_km`), and return a fixed JSON shape the app expects. Tokens auto-rotate and are persisted back to `~/.strava-proxy/auth.json` (outside this repo). Routes: `GET /api/strava`, `GET /api/health`.

## Key functions in cycling-coach.html

- **`buildSystemPrompt()`** — assembles the Claude system prompt from live `athleteData` (WHOOP + Strava + FTP zones + active training plan). Editing the coaching behaviour starts here.
- **`generateSchedule()`** — sends a one-shot Claude call to produce a 7-day plan as JSON. The plan is stored in `trainingPlan[]` and `localStorage`.
- **`adaptPlan()`** — reads `sessionFeedback` and `athleteData.whoop.recovery_score` to build a directive (red/yellow/green), then asks Claude to revise upcoming sessions. Called automatically every 2 logged sessions.
- **`syncStrava()`** — `GET localhost:3002/api/strava`, populates `athleteData.strava` and the data panel.
- **`syncWHOOP()`** — `GET localhost:3001/api/whoop`, populates `athleteData.whoop`.
- **`buildZoneText(ftp)`** — returns a formatted string of all 7 power zones from `POWER_ZONES[]`; injected into both `buildSystemPrompt()` and `generateSchedule()`.

## Schedule update protocol

The coach can mutate the training plan mid-conversation. Claude is instructed to emit a fenced block:
~~~
```schedule_update
{"id":"s3","type":"Rest Day","duration":0,"intensity":"rest"}
```
~~~
`extractScheduleUpdates()` strips these blocks from the displayed reply; `applyScheduleUpdates()` patches the matching session in `trainingPlan[]` by id and calls `savePlan()`.

## Credentials

Strava credentials live at `~/.strava-proxy/auth.json` (chmod 600, never committed):
```json
{ "client_id": "...", "client_secret": "...", "refresh_token": "..." }
```
The refresh token is rotated by Strava on each use; `server.js` writes the new token back automatically. The file is outside this repo intentionally — `.gitignore` also blocks `auth.json` and `.env` as a fallback.

## Preview (Claude Code browser preview)

`.claude/launch.json` is configured to serve `app/` on port 8743 via `python3 -m http.server`. Use `preview_start("cycling-coach")` to launch it. No rebuild needed — edits to the HTML are live on next reload.
