# Table Extras Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add quick phrases, voice notes, table themes and haptics (v1.11) without changing any existing flow.

**Architecture:** Server gains phrase-aware chat entries (`pid`, `kind`) and two voice routes backed by an in-memory per-table clip store. Client adds a seat-bubble overlay driven from `paintChat()`, a phrase tray + recorder, a settings popover (felt + haptics) and a `buzz()` helper. Nothing new enters `stateSig`.

**Tech Stack:** Node ≥18 built-ins (`server.js`), inline JS/CSS (`index.html`), headless Chrome over CDP for browser tests (scratchpad scripts).

**Spec:** `docs/superpowers/specs/2026-11-25-table-extras-design.md`

## Global Constraints

- No dependencies; no external resources; no inline event handlers (CSP hash).
- `Permissions-Policy` microphone becomes `microphone=(self)`; everything else in `SEC_HEADERS` unchanged.
- Phrases (index 0–7): "Nice one!", "Hurry up 😴", "Ouch 😬", "Who's holding the 6?", "Sorry!", "Good game 👏", "Lucky! 🍀", "Hmm… 🤔". Phrase gap 2s per seat.
- Voice: ≤8s, ≥0.5s, body ≤160 KB (raised from the spec's 64 KB: phone MP4 encoders ignore the requested bitrate, ~12.5 KB/s), types `audio/mp4|audio/webm|audio/ogg|audio/aac|audio/mpeg`, 1 per 3s and 10 per 60s per seat, 15 per table, 10 min TTL, 32 MB global.
- Felts: `green` (default), `blue`, `wine`, `charcoal`; stored `sevensFelt`. Haptics stored `sevensHaptics` (`'0'` = off; default on).
- Chat-only changes must never call `render()`; table layout height unchanged.

## Review Focus

1. A phone that reloads/rejoins mid-game must not re-show bubbles for old phrases/voice notes — test in Task 3 browser suite.
2. Phrases/voice arriving during an optimistic move must not undo or delay it — optimtest variant with phrase spam (Task 5).
3. Old clients / old chat entries without `pid`/`kind` still render — server test sends plain chat and checks shape (Task 1).
4. A clip URL from table A requested with a token from table B → 404 (Task 2).
5. Mic denied / `MediaRecorder` missing → toast, no exception, tray still works (Task 3).

---

### Task 1: Server — phrases and chat entry shape

**Files:** Modify `server.js` (`addChat`, `act` chat branch, `SEC_HEADERS`, exports). Test: scratchpad `extras-server.js`.

**Interfaces:** Produces chat entries `{id,name,text,sys,kind,pid?,vid?,dur?}`; `act({a:'chat',t,phrase:i})`; export `PHRASES`.

- [ ] Test: plain chat → entry has `pid` = sender id, `kind:''`; `phrase:2` → text "Ouch 😬", `kind:'phrase'`; `phrase:8`/`-1`/`'x'` → err; second phrase within 2s → err "Wait a moment…"; `Permissions-Policy` contains `microphone=(self)`.
- [ ] Implement; run test; all existing server suites pass.

### Task 2: Server — voice routes and clip store

**Files:** Modify `server.js` (`handle`, `makeRoom` `voices: []`, `dropRoom`, heartbeat sweep, exports `voiceBytes()`). Test: scratchpad `extras-voice.js`.

**Interfaces:** `POST /voice?t=&d=` raw body → `{ok:true}` or `{err}` (status 400/403/404/413/415/429); `GET /voice/<id>?t=` → bytes. Chat entry `kind:'voice'`, `text:'🎤 voice note'`, `vid`, `dur` (seconds, 1 decimal).

- [ ] Tests: happy path (webm, mp4 magic) → other seat at same table GETs identical bytes with stored type and `nosniff`; other table's token → 404; bad token → 404; wrong origin → 403; type not allowed → 415; magic mismatch → 415; 70 KB body → 413 without crashing; chunked >64 KB without content-length → 413; d<500 or d>8500 → 400; 2nd clip within 3s → 429; 16th clip evicts 1st (GET 404); clip older than TTL → 404 (use exported `VOICE_TTL` override via env `VOICE_TTL_MS`); global cap evicts oldest across tables (env `VOICE_TOTAL_MAX`); `dropRoom` returns bytes to zero.
- [ ] Implement magic checks: webm `1A45DFA3`, mp4 `ftyp` at offset 4, ogg `OggS`, mpeg `ID3` or `FFFx`, aac `FFF1/FFF9`.
- [ ] Run tests; run existing suites.

### Task 3: Client — bubbles, phrase tray, recorder

**Files:** Modify `index.html`. Test: scratchpad `extras-ui.js` (Chrome with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`).

**Interfaces:** `PHRASES` (copy of server list), `showBubble(pid, html, ms)`, `placeBubbles()`, `sendPhrase(i)`, `startRec()`, `stopRec(send)`, `playClip(vid, btn)`.

- [ ] Tests: two browsers at one table; A taps 💬 → tray; taps phrase 0 → A sees own bubble at once, B sees bubble over A's chip within 2s and chat shows it; card sizes (`--hw`) identical with tray open/closed; render count unchanged by phrase arrival (wrap `render`); reload B → no bubble for old phrase; A records 1.5s → B sees ▶ bubble and chat ▶, tapping plays (`audio.currentTime>0`); cancel ✕ → nothing sent; 8s auto-stop; `getUserMedia` stubbed to reject → toast, no exception; tab hidden mid-record → discarded; practice mode: phrase bubble works, 🎤 hidden.
- [ ] Implement; run.

### Task 4: Client — themes, settings popover, haptics

**Files:** Modify `index.html` (`:root` felt tokens, `html[data-felt]` blocks, early theme apply, topbar button, popover, `buzz()`). Test: scratchpad `extras-theme.js`.

- [ ] Tests: each felt sets `data-felt` and changes `.board` background; persists over reload with no first-paint flash (`data-felt` set before `#app` content); `meta[name=theme-color]` updated; layout sizes identical across themes; stub `navigator.vibrate` → called on your turn (40), own play (10), others' phrase (15, throttled 2s), round over; toggle off → never called; popover hides haptics row when `vibrate` missing; screenshots 390px + 1280px for 4 felts.
- [ ] Implement; run.

### Task 5: Regression, docs, release

- [ ] Run every existing suite (test, passtest, rendertest, finaltest, fixtest, reloadtest, fixui, latejoin, uitest, optimtest, perftest, soaktest) — all pass.
- [ ] optimtest variant with phrases flowing every 500ms — moves still instant, no rollback.
- [ ] CLAUDE.md: features, routes, env (`VOICE_TTL_MS`, `VOICE_TOTAL_MAX`), v1.11 in releases.
- [ ] Commit + tag v1.11 locally (push only when the user asks).
