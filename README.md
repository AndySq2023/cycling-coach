# Cycling Coach

An AI cycling coach — a single-file web app backed by live WHOOP recovery and
Strava ride data, with FTP power zones and WHOOP-aware plan adaptation.

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
`avg_watts` and `suffer_score` per ride.

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
