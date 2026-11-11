# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Sevens (Fan Tan): an online multiplayer card game. The whole app is two files with **no dependencies**: `server.js` (Node ≥18 built-ins only: `http`, `fs`, `path`, `crypto`, `zlib`) and `index.html` (all client HTML/CSS/JS inline). There is no build step, linter, or test suite.

## Commands

- Run: `npm start` (or `node server.js`), then open http://localhost:3000
- Health check: `GET /health` → `ok`
- `index.html` is read once at startup (`INDEX_HTML`), so **restart the server after editing it**.

Env vars (all optional): `PORT` (3000), `PUBLIC_ORIGIN` (needed for the lobby's share link `/?r=CODE`; blank hides it), `GRACE_MS` (30000, reconnect window before a bot takes over), `DEBOUNCE_MS` (1500), `JOIN_WAIT_MS` (20000), `INVALID_WAIT_MS` (5000), `BOT_MS` (50, bot think budget per move), `BOT_SHARE_MS` (300, total bot think time allowed per second across all tables), `TRUST_PROXY` (0; number of trusted reverse-proxy hops. **Set it to 1 behind a proxy/PaaS**, otherwise every visitor shares one rate-limit bucket; leave 0 when exposed directly, or clients could spoof `X-Forwarded-For`).

`server.js` exports internals (`botChoose`, `heurChoose`, `evalMove`, `handPts`, `hasFourKings`, `canFinishInThree`, `createAppServer`, `rooms`, `byToken`, …) and only listens when run directly (`require.main === module`), so it can be `require`d from an ad-hoc script to exercise logic. Rooms also honor `S.forceDeck` (a 52-card array used for the next deal) and `S.invalidWaitMs` for deterministic testing.

## Architecture

**Transport:** client → server is `POST /api` with a JSON body `{ a: <action>, t: <token>, ... }`; server → client is Server-Sent Events on `GET /events?t=<token>`. There are no WebSockets. Actions in `act()`: `join`, `start`, `play`, `chat`, `leave`, `skipwait`, `resetscores`. `/api` enforces JSON content-type, same-origin `Origin`, a 2000-byte body cap, and per-IP rate limits; strict CSP headers mean the client must not load external resources. The CSP allows only the page's single inline `<script>`, pinned by a SHA-256 hash computed at startup, so **inline event-handler attributes (`onclick="…"`) and extra inline scripts will not run**; use `addEventListener`. `index.html` is served pre-compressed (brotli/gzip) with an ETag.

**State is all in memory** (lost on restart): `rooms` (code → table `S`), `byToken` (token → `{S, p}`), `conns` (token → set of SSE responses). Each mutation ends in `push(S)`, which sends every player their own `view(S, p)` (= private `ownView` + shared `commonView`, the latter serialised once per push) (other players' hands are hidden; only counts, plus `leftCards` once the phase is `over`). `push()` also drives the game loop: it schedules auto-passes when the current player has no legal move, and bot moves for disconnected players.

**Card encoding:** `id = suit*13 + (rank-1)`, suits `♠♥♦♣`; 7♥ = 19 (`H7`) must open each round. `board[suit]` is `null` or `[lowRank, highRank]`. Card points = rank (A=1 … K=13); a round's score is the points left in hand (lower is better).

**Equal deal:** every player gets the same number of cards. When 52 does not divide by the player count, `removedFor(n)` sets aside the lowest cards one suit at a time (A♠ A♥ A♦ A♣, then 2♠ …; at most 8, for 11 players). They are in `S.removed`, sent to clients as `removed`, and must be treated as held by nobody (the bot does this through `GONE`). The client has its own copy of `removedFor` for the lobby preview.

**Table phases:** `lobby` → `playing` → `over`, plus `invalid` (when a deal gives one player all 4 Kings: the round is voided and the host must wait `INVALID_WAIT` before redealing). The host is the first connected player (`hostId`). Players who join mid-round become spectators.

**Disconnect/rejoin:** a dropped SSE connection starts a `GRACE` timer (`p.deadline`); after that `p.bot = true` and the bot plays for them. Rejoining matches a player by `cid` (a client id kept in localStorage) and/or name, issues a new token, and drops the bot. The many per-player timers (`dtimer`, `btimer`) and `S.timer`/`S.idle` must be cleared when state changes. Use `forgetPlayer()` to remove a player, because it keeps the `S.turn` index valid.

**Bot (`botChoose`):** determinization Monte Carlo. It samples the hidden hands consistent with known voids (`p.void`, filled in by `recordPass`), runs heuristic rollouts (`heurPick`/`evalMove`) per candidate move within `BOT_MS`, and falls back to `heurChoose`.

**Special announcements:** `maybeLastThree` posts a chat alert when a player's last 3 cards are guaranteed to finish (`canFinishInThree` brute-forces the 6 orderings).

**Client (`index.html`):** a single `<script>` with global state `G` (the latest server view) and full re-render functions (`render`, `lobby`, `table`, `buildRoundOverModal`, …). It also contains a fully **offline practice mode** (`startPractice`, `pPlay`, `P_STATE`, `pCanFinishInThree`, `pEvalBotMove`) that **duplicates the server's game rules on the client**, so rule changes usually have to be made in both places. All colours, fonts and easing live in the `:root` design tokens at the top of the `<style>` block (use `var(--gold-2)`, `rgba(var(--gold-rgb),.3)`, `var(--sans)`/`var(--serif)` rather than new literals; the CSP rules out web fonts, so type is system stacks only). Because the table is re-rendered from scratch on every state, table motion is FLIP-style: `snapTable()` measures the old DOM and `animateTable()` animates the new one (card flight to the felt, hand reflow, deal-in). The victory scorecard is drawn on a canvas (`generateScorecardCanvas`) and shared through the Web Share API or downloaded.
