# Cycling Coach

An AI cycling coach — a single-file web app backed by live WHOOP recovery and
Strava ride data, with WHOOP-aware plan adaptation.

## Layout

```
cycling-coach/
├── app/
│   └── cycling-coach.html   # the entire front-end (one file, no build step)
└── proxy/
    ├── server.js            # local Strava proxy (Node, no dependencies)
    └── package.json
```

`~/Desktop/cycling-coach.html` is a **symlink** to `app/cycling-coach.html`, so
double-clicking it on the Desktop opens the canonical file. Edit either path —
they're the same file.

## How it talks to data

The app (opened in a browser) calls three local endpoints:

| Endpoint                  | Served by                              | Provides            |
|---------------------------|----------------------------------------|---------------------|
| `localhost:3001/api/chat` | Claude Desktop bridge                  | Coach replies (Claude) |
| `localhost:3001/api/whoop`| Claude Desktop bridge → `~/whoop-mcp`  | Recovery, HRV, sleep |
| `localhost:3002/api/strava`| `proxy/server.js`                     | Last 7 days of rides |

The Strava proxy calls the Strava REST API directly (refresh-token flow) and
normalises the response into the shape the app expects. It surfaces
`suffer_score` per ride. (The athlete has no power meter, so watts are not
surfaced.)

## Secrets

Strava credentials live **outside this repo** at `~/.strava-proxy/auth.json`
(`client_id`, `client_secret`, `refresh_token` — the refresh token auto-rotates).
Never commit credentials here.

## Running

The proxy runs as a launchd service that auto-starts on login and restarts if it
crashes:

- Plist: `~/Library/LaunchAgents/com.cyclingcoach.stravaproxy.plist`
- Check status: `launchctl list | grep stravaproxy`
- Restart after editing `server.js`:
  ```
  launchctl unload ~/Library/LaunchAgents/com.cyclingcoach.stravaproxy.plist
  launchctl load   ~/Library/LaunchAgents/com.cyclingcoach.stravaproxy.plist
  ```
- Logs: `proxy/proxy.log` and `proxy/proxy.error.log` (gitignored)

Chat and WHOOP still require Claude Desktop to be running; Strava does not.

## Implementation Status

| Feature / Module | Status | Notes |
|---|---|---|
| Chat with coach | ✅ Complete | Two-tier memory: durable coach notes (never expire, editable in My Data) + a rolling raw window; older turns are folded into notes rather than dropped |
| WHOOP sync | ✅ Complete | Fetches recovery, HRV, RHR, sleep efficiency, sleep duration, SpO2, strain — all injected into system prompt |
| Strava sync | ✅ Complete | 7-day rolling window via REST proxy; surfaces distance, elevation, moving time, suffer score per ride |
| 7-day schedule generation | ✅ Complete | Claude generates JSON plan; stored in localStorage; rendered as session cards |
| Session feedback (RPE) | ✅ Complete | RPE 1–10 + feel chips + notes; auto-triggers `adaptPlan()` every 2 logged sessions |
| WHOOP-aware adaptation | ✅ Complete | Red (<34%): intervals replaced with Z2/rest; yellow (34–66%): sets trimmed 15–20%; green: no restriction |
| Schedule updates from chat | ✅ Complete | Coach emits fenced `schedule_update` JSON blocks mid-conversation; app patches plan in place |
| Per-session edit modal | ✅ Complete | Manual override of type, duration, intensity, targets, description |
| Strava ↔ schedule reconciliation | ✅ Complete | "Sync & Update Schedule" compares recent Strava rides to plan and applies corrections via coach |
| Resistance band workouts | ✅ Complete | Prescribed against the five bands actually owned (colour + kg), with choke, anchor, tempo and RIR; coach picks the two session days |
| Strength logging | ✅ Complete | Per-set reps achieved + session RPE; load = RPE × minutes; fed back into the prompt so the coach progresses from real numbers |
| Strava proxy (launchd) | ✅ Complete | Auto-starts on login, KeepAlive respawn, logs to `proxy/proxy.log` |
| Mobile layout | 🚧 Partial | Data panel hidden below 600px (`@media`); chat and tabs usable but not optimised for small screens |
| Strava lookback > 7 days | ❌ Missing | Proxy hardcodes `after = now - 7d`, single page (`per_page=50`); no pagination; 42-day window discussed but not implemented |
| Multi-device persistence | ❌ Missing | All state in browser localStorage; plan and history don't follow the user across devices |
| Tests | ❌ Missing | No test files exist |
