# Team Edition — product requirements & deployment plan

The cycling coach, extended from one athlete to a squad: **up to 6 team members plus
you as the master user**, who can see everyone's data on a Team Report page. This
document is the product spec, the architecture, and the runbook for taking it live.

---

## 1. Product requirements

### Personas & roles

| Role | Who | Can do |
|---|---|---|
| **Master** (1) | You — coach *and* athlete | Everything a member can, plus: see the Team Report (all athletes' recovery/rides/adherence), add/remove members, reset passwords. Your own data keeps flowing through the original env-var credentials. |
| **Member** (up to 6) | Invited riders | Own dashboard, own AI coach chat, own 7-day plan + adaptation, own WHOOP/Strava once they connect them. Cannot see anyone else's data. Capped at `CHAT_DAILY_LIMIT` coach messages/day (default 40) since chat spends your Anthropic credits. |

### Functional requirements (v1 — all built)

- **F1 — Per-user login.** Same UX as today (one password prompt, stored in the
  browser). The password *is* the identity: `APP_PASSWORD` → master; a roster
  password → that member. No email/signup flow — the master hands each rider a
  generated password (`velo-xxxx-xxxx`), shown once at creation.
- **F2 — Private state per athlete.** Plan, feedback, goal, home location and chat
  history live in a per-user KV blob. A member can never read or overwrite another
  athlete's data (enforced server-side by who authenticated, never by client input).
- **F3 — Bring-your-own wearables.** Each member connects their *own* Strava and/or
  WHOOP via OAuth (Connect buttons appear in the data panel when not linked). Not
  connecting is fine — the coach just works from plan + feedback.
- **F4 — Team Report (master only).** One card per athlete: WHOOP recovery
  (red/yellow/green), strain, sleep, rides + distance last 7 days, last ride, plan
  adherence bar, goal, last active. Server-side aggregation with a 5-minute cache
  and a Refresh button.
- **F5 — Member management (master only).** Add member (→ one-time password),
  remove member (deletes their state + tokens — full offboarding), reset password.
- **F6 — Cost control.** Per-member daily chat quota; master exempt. Fail-open on
  KV outage so a Redis blip never locks the team out.
- **F7 — Everything existing keeps working.** Single-user deploys are unaffected:
  master state stays on the legacy KV key, Telegram bot stays master-bound,
  local dev (localhost:3001/3002) untouched.

### Non-functional requirements

- **Security:** passwords stored as salted SHA-256 hashes, constant-time compares,
  OAuth callback validated by one-time KV nonce (10-min TTL), master-only endpoints
  gated server-side, API refuses to run without `APP_PASSWORD` (fail closed).
- **Privacy & consent:** WHOOP recovery/sleep is health data. Each member must be
  told, before they connect, that the master sees their metrics. Removal deletes
  their data (UK GDPR "right to erasure" in spirit). Keep the team ≤7 friends —
  this is not a public product tier.
- **Performance:** team report fans out (7 athletes × 2 providers) in parallel with
  an 8 s per-source timeout; worst case ~8 s, cached 5 min.
- **Rate limits:** Strava app-level limits (100 req/15 min, 1 000/day) comfortably
  fit 7 athletes at this call volume; WHOOP similar. The report cache is the main
  protection against refresh-spamming.

### v1 scope decisions (deliberate)

- Passwords instead of real accounts/OAuth login — right-sized for 7 trusted users,
  zero new dependencies, and the existing password UX already handles it.
- One shared Strava/WHOOP developer app for all athletes (standard OAuth pattern);
  requires the provider-side approvals in the checklist below.
- Telegram stays master-only (multi-member Telegram is a v2 item).
- KV (Upstash Redis) remains the only store — no SQL migration for 7 users.

---

## 2. Infrastructure architecture

```
                      ┌─────────────────────────── Vercel project ───────────────────────────┐
 Master browser ──┐   │                                                                       │
 Member browsers ─┼──►│  app/cycling-coach.html (static, served at /)                         │
   (x-app-password)   │        │ same-origin fetch                                            │
                      │        ▼                                                              │
 Telegram ───────────►│  api/telegram.js ─┐        ┌── api/_auth.js ── api/_users.js          │
  (webhook secret)    │                   │        │   (password → { id, name, role })        │
                      │  api/chat.js ─────┤        │                                          │
                      │  api/state.js ────┼── requireUser ──► per-user KV keys                │
                      │  api/strava.js ───┤        │                                          │
                      │  api/whoop.js ────┤        │        Upstash Redis (KV)                │
                      │  api/windy.js ────┤        │  team_roster                             │
                      │  api/oauth.js ────┤        │  coach_state           (master, legacy)  │
                      │  api/team.js ─────┘        │  coach_state:<uid>     (members)         │
                      │   (master-only)            │  strava_refresh_token  (master, legacy)  │
                      │                            │  strava_tokens:<uid>   (members)         │
                      │                            │  whoop_refresh_token   (master, legacy)  │
                      │                            │  whoop_tokens:<uid>    (members)         │
                      │                            │  oauth_state:<nonce>   (10-min TTL)      │
                      │                            │  chat_uses:<uid>:<day> (48-h TTL)        │
                      │                            │  team_report_cache     (5-min TTL)       │
                      └──────────┬─────────────────┴──────────────────────────────────────────┘
                                 │ server-side calls
                                 ▼
                 Anthropic API · Strava API · WHOOP API · Windy API · Telegram API
```

Key properties:

- **8 serverless functions** (chat, state, strava, whoop, windy, telegram, oauth,
  team) — under the Hobby-plan limit of 12. `_`-prefixed files are shared helpers,
  not routes.
- **Identity is server-side only.** The browser never says who it is; the password
  header resolves to a user id in `_auth.js`, and every KV key is derived from that.
- **Master paths are the legacy paths.** `coach_state`, `strava_refresh_token`,
  `whoop_refresh_token` keep their original names/shapes, so the existing deploy,
  Telegram bot and seeded tokens carry over with zero migration.
- **Local dev is out of scope for teams** by design: `IS_LOCAL` keeps using the
  localhost bridges as a single-user sandbox. `?teamDemo=1` previews the Team tab
  with canned data anywhere.

---

## 3. Deployment workflow

Day-to-day (matches how this repo already works):

1. **Branch** off `main`: `git checkout -b feat/<thing>`.
2. **Local check:** open `app/cycling-coach.html` (or the preview server) — the
   static app must load clean; `node --check api/*.js` for the functions;
   `?teamDemo=1` to eyeball the Team tab.
3. **Push the branch** → Vercel builds a **Preview deployment** automatically
   (unique URL, same env vars as production unless you scope them). Smoke-test the
   preview URL: log in as master, log in as a member (second browser/incognito),
   check `/api/team`.
4. **PR → merge to `main`** → Vercel deploys **Production** automatically.
5. **Verify prod:** `curl -s https://<app>.vercel.app/ | grep -c teamView` (a
   deterministic "new bundle is live" check), then a real login.
6. Env-var changes always need a **Redeploy** to take effect (Vercel bakes them in
   at build time for functions).

Rollback: Vercel → Deployments → previous good build → "Promote to Production"
(instant, no rebuild). KV data is forward/backward compatible (new keys are
additive), so rolling code back never corrupts state.

---

## 4. Vercel requirements

| Requirement | Detail |
|---|---|
| Plan | **Hobby works** for 7 users: 8/12 functions, 60 s `maxDuration` (set for chat, telegram, team), KV via Upstash Marketplace. Consider **Pro** if you want >1 team, analytics, or password-protected preview deploys. |
| Store | Upstash Redis integration (`cycling-coach-kv`) — **required** (roster, tokens, state, quotas all live there). Free tier (10k commands/day) is fine: ~2k commands/day at full team usage. |
| Env vars (existing) | `ANTHROPIC_API_KEY`, `APP_PASSWORD`, `STRAVA_CLIENT_ID/SECRET/REFRESH_TOKEN`, `WHOOP_CLIENT_ID/SECRET` (+ seeded KV token), `WINDY_API_KEY` (optional), `TELEGRAM_*` (optional) |
| Env vars (new, optional) | `MASTER_NAME` — your display name on the Team Report (default "Coach"). `CHAT_DAILY_LIMIT` — member daily chat quota (default 40). |
| Function config | `vercel.json` already sets `maxDuration: 60` for `api/chat.js`, `api/telegram.js`, `api/team.js`. |
| Domains | The OAuth callback is registered per-domain. If you add a custom domain, re-register `https://<domain>/api/oauth` with Strava and WHOOP. |

Provider-side requirements (the real gating items):

- **Strava:** your API app (client 249742) is capped at **1 connected athlete**
  until Strava grants a capacity increase — request it in
  [API application settings](https://www.strava.com/settings/api) *before* inviting
  members. Also add the Vercel host to the app's **Authorization Callback Domain**.
- **WHOOP:** developer apps allow a small number of users (currently 10) without
  review — fits 7. Add `https://<app>.vercel.app/api/oauth` to the app's
  **Redirect URIs** (exact match required).

---

## 5. Production deployment checklist

Pre-deploy (one-time):

- [ ] **Strava:** add the Vercel domain to Authorization Callback Domain; request
      athlete-capacity increase (target ≥7).
- [ ] **WHOOP:** add `https://<app>.vercel.app/api/oauth` to Redirect URIs.
- [ ] **Vercel env:** set `MASTER_NAME`; set `CHAT_DAILY_LIMIT` if 40/day isn't right.
- [ ] Confirm KV integration is linked (`KV_REST_API_URL` present in env).
- [ ] Rotate `APP_PASSWORD` if it has ever been shared beyond you — it is now the
      *master* credential specifically.

Deploy:

- [ ] Merge to `main` (or push branch first and test the preview URL as both roles).
- [ ] Redeploy so any new env vars take effect.
- [ ] `curl -s https://<app>.vercel.app/ | grep -c teamView` → non-zero = new bundle live.
- [ ] Log in as master → Team tab appears; report shows your own row.

Team rollout (per member):

- [ ] Team tab → **+ Add member** → copy the one-time password.
- [ ] Send the rider the URL + password **and the consent line**: "the app shows me
      your recovery, sleep and ride data — connect only what you're happy sharing."
- [ ] Rider logs in, sets goal, hits **Connect your Strava / Connect your WHOOP**
      in the data panel (buttons appear automatically while unconnected).
- [ ] Verify their row fills in on the Team Report (Refresh forces live data).

Post-deploy watchpoints:

- [ ] Vercel → Functions → logs for `/api/team` and `/api/oauth` on first uses.
- [ ] Upstash dashboard: command volume (should stay well under free tier).
- [ ] Anthropic console: spend after the first week of team chat; tune
      `CHAT_DAILY_LIMIT` accordingly.
- [ ] Telegram bot still replies (it is untouched, master-only — a quick `/plan` is
      a deterministic check).

---

## 6. Recommended next requirements (v1.x → v2)

1. **Consent screen in-app** — a first-login notice for members ("your coach can
   see your metrics") with an explicit accept, stored in their state blob.
2. **Session-day view for the master** — "who is due to train today" strip on the
   Team Report (the data is already in each plan).
3. **Weekly team digest** — a Monday Telegram message to you summarising the squad
   (reuse `api/team.js`'s report + a Vercel cron).
4. **Per-member Telegram** — map additional `TELEGRAM_CHAT_ID`s to roster ids in
   KV; the bot code is already parameterised by user id.
5. **Real auth when the team outgrows passwords** — swap `_auth.js` for magic-link
   or OAuth login (Clerk/Auth.js) without touching the data layer; the
   `{ id, name, role }` contract is the seam.
6. **SQL when data outgrows blobs** — plan history, long-run trends (CTL/ATL
   charts) want per-session rows; Vercel Postgres/Supabase, keyed by the same user
   ids. KV keeps tokens/quotas.
7. **Observability** — at minimum, log one structured line per chat call (user id,
   tokens in/out) so cost-per-member is a query, not a guess.
8. **Strava compliance pass before any public growth** — Strava's API agreement
   restricts showing one athlete's data to another user beyond a "club" context;
   fine for a private team of friends, a real review item for anything bigger.
