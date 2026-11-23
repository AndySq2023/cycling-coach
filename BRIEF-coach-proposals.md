# Brief for Claude Code: Coach Proposals + Strength Hub (preview branch)

**Repo:** `AndySq2023/cycling-coach` · **Branch to create:** `feature/coach-proposals`
**Goal:** Build a new version of the app on its own branch. It gets a Vercel preview URL that Andy can open and use on his phone, and production stays untouched until he decides to merge.

Read `CLAUDE.md` in full before starting. Its rules still apply: there is one coach brain (`buildSystemPrompt()`), shared shaping lives in `shared/*-core.js`, and pure logic gets tests.

---

## 0. Ground rules

- **Git:** pull the latest `main`, then `git checkout -b feature/coach-proposals`. Commit after each phase below and push the branch. **Never commit to, merge into or force-push `main`.** Andy merges himself (he uses GitHub Desktop).
- **Ask Andy first** before you change any Vercel project setting or environment variable, delete any KV key, or merge.
- **Cost:** no paid services and no new runtime dependencies. Tests stay zero-dependency (`node --test`).
- **Licensing:** the ideas come from `alexpcosta/opengym`, which is AGPL-3.0. **Do not copy its code. Write everything fresh.** Exercise *text* may come from `hasaneyldrm/exercises-dataset` (MIT) with attribution. **No images or GIFs** from it (those are © Gym visual).
- **Why this matters:** right now the coach's `schedule_set` / `schedule_update` / `resistance_set` blocks change the plan automatically. The aim is a coach whose changes are **checked, backed by evidence, approved by Andy and reversible**. Trusted advice is what makes the app usable as the hub for "keep muscle while performing".

---

## Phase 1: Isolate the preview (do this first, before any feature)

Vercel preview deployments use the **same KV database** as production. Without isolation, the preview's `pushState()` would overwrite the real `coach_state` (plan, chat, coach notes, strength log).

1. In `api/_kv.js`, add `envKey(key)`. When `process.env.VERCEL_ENV !== 'production'`, it returns `preview:${key}`. Use it for `coach_state` (`api/_state.js`), `routes:master` (`api/routes.js`) and the route/summary cache keys.
2. **Do NOT prefix `strava_refresh_token` or `whoop_refresh_token`.** These tokens rotate. If the two environments held separate copies, one could invalidate the other and break production sync.
3. **Seed the preview from production, read-only:** when `preview:coach_state` is empty, copy the production `coach_state` into it once, so Andy sees his real plan and history. The preview must never write to an unprefixed state key.
4. `GET /api/state` also returns `env: process.env.VERCEL_ENV`. When that isn't `production`, show a clear **PREVIEW** badge in the header and set `document.title` to "Coach (Preview)". That way, if he installs the preview as a separate PWA, he can't confuse it with the real app.
5. Check (read-only, through the Vercel CLI/dashboard if available) that every env var the app needs is enabled for the **Preview** environment: `ANTHROPIC_API_KEY`, `APP_PASSWORD`, `STRAVA_*`, `WHOOP_*`, `KV_*`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `HUME_SHEET_ID`, `GRAPHHOPPER_*`. **List any that are missing and ask Andy. Don't change them yourself.**
6. Tests: `envKey` prefixing per environment, and token keys left unprefixed.
7. Commit, push, and report the branch preview URL (usually `cycling-coach-git-feature-coach-proposals-<scope>.vercel.app`; it's also on the Vercel Deployments page and in the GitHub commit check).

## Phase 2: Coach proposals with approval (the core change)

1. **A fixed list of change types.** Create `shared/proposal-core.js`, pure and importable by tests:
   - `move-session`, `swap-session` (type), `set-duration`, `set-intensity`, `set-target` (TSS / interval target), `add-rest-day`, `remove-session`, `replace-week`, `replace-resistance-library`.
   - Each change has: `{ id, type, target: { sessionId | date }, before, after, why }`. `why` must name the evidence (e.g. "HRV 18% below 7-day baseline, recovery 31%").
2. **Validator** (`validateProposal(p, state)`): rejects unknown types, missing targets, out-of-range values (duration 0–600 min, intensity from the app's existing set, dates inside the plan window, band ids from `BAND_INVENTORY`, anchors from `BAND_ANCHORS`). It also marks a change **stale** if `before` no longer matches the current state; stale changes are never applied. If validation fails, send the errors back to Claude for **one repair round**. If it fails again, show a clean error and apply nothing. The validator is the safety check. Prompt wording alone isn't enough.
3. **Route plan changes through proposals.** In `sendMessage()`, `adaptPlan()` and the morning briefing, plan-changing blocks become a pending proposal instead of being applied. `coach_notes`, `home_set` and `route_request` behave as before. Existing parsers stay backward-compatible, and `parsers.test.mjs` must still pass.
4. **Proposal card UI** (in chat, and on the Today tab when one is pending): each change shows before → after plus the why, with a tick box. Buttons: **Apply selected** and **Dismiss**. It must be thumb-friendly on a Pixel.
5. **Snapshot and undo:** snapshot the plan and resistance library before every apply. Keep the last 10 in localStorage and `coach_state`. Add an **Undo last coach change** button.
6. **Remember dismissals:** store dismissed changes (type + target + after) and feed them into `buildSystemPrompt()` with the rule "don't propose this again without new evidence".

## Phase 3: Quiet reviews

- `adaptPlan()` and the morning briefing may return `{"nochange": true, "reading": "<short honest paragraph>"}`. The prompt says plainly: **change nothing when nothing warrants it**, at most ~5 changes, few high-confidence changes beat many small ones.
- A body weight or body-comp trend moving against the goal produces a **note, not a plan change**.
- A no-change result shows a one-line status, with no card and no prompt to act. (This is the rule future WhatsApp alerts will follow too.)

## Phase 4: A fixed list of what data goes to the coach

- Keep `buildSystemPrompt()` as the single brain, but have it read athlete data through an **explicit allowlist** function. Every field is picked by name, with no spreading of whole objects. The window is capped at **12 weeks**. Categories: WHOOP (recovery, HRV, RHR, sleep), Strava/intervals.icu rides, Hume body-comp trend, strength log (last 6), coach notes, dismissed proposals.
- Add a "What the coach sees" list in My Data, rendered from the same allowlist so the two can't drift apart.
- Report the prompt size (characters) before and after.

## Phase 5: Strength hub (bands only, matching the existing kit constraints)

1. **Exercise library:** add `scripts/build-exercise-lib.mjs`. It reads a local clone of `hasaneyldrm/exercises-dataset` and writes `shared/exercise-lib.json`, keeping only `band` / `resistance band` (~61) and relevant `body weight` exercises. Fields: id, name, bodyPart, target, secondary, steps. Add attribution to the README. No media. The coach may draw on it, but the five-loop-band / no-door-anchor / Peloton-anchor rules in `CLAUDE.md` still win.
2. **Muscle mapping:** normalise muscle names to ~18 muscles (traps, delts, chest, upper back, biceps, triceps, forearms, abs, obliques, lower back, glutes, quads, hamstrings, adductors, hip flexors, calves, etc.). Tag every `resistanceLib` exercise with its primary and secondary muscles.
3. **Hard sets per muscle per week**, from `strengthLog`: a set counts as hard at RIR ≤ 3. If there's no per-set RIR, use session RPE ≥ 7. Show a weekly view plus a "neglected muscles" list. Show averages only once there are ≥ 5 rated sets.
4. Feed the weekly hard-set summary into the prompt **next to the Hume lean-mass trend**. This is the early signal for keeping muscle.
5. **Skip estimated 1RM.** Band load isn't measured, so it would be made up.
6. *(Stretch)* A body heatmap using MuscleMap outlines (MIT, `melihcolpan/MuscleMap`) with attribution.

## Phase 6: Tests, docs, handover

- New tests: every change type valid/invalid, stale detection, the repair-round path, snapshot/undo, dismissal matching, the allowlist (unknown fields don't get through), the hard-set counter, `envKey`. `npm test` is green.
- Update `CLAUDE.md`: the proposal flow, the new change types, the preview isolation, the allowlist and the strength hub.
- **Done means:** the branch is pushed, the preview URL is reported, the PREVIEW badge shows, production KV keys were never written by the preview, all tests pass, and Andy gets a short phone test checklist (approve a proposal, dismiss one, undo, a no-change review, the hard-sets view).
