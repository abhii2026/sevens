# Table extras: quick phrases, voice notes, table themes, haptics

Date: 2026-11-25. Release target: v1.11.

## Intent

Make the table more social and personal without anything that can fail the way live voice chat did (v1.4–v1.6). Every addition rides on the transport that already works on every phone network: `POST` to our server, fan-out over the existing SSE stream. No peer-to-peer links, no live media streams, no third-party services.

## Goals

- **Quick phrases:** one tap to say something during play, seen by everyone without opening chat.
- **Voice notes:** short recorded clips (≤8s) that every player can play, on any network.
- **Table themes:** a few felt colours, chosen per phone.
- **Haptics:** short buzzes on key moments (Android; iPhones ignore web vibration), with an on/off setting.

## Non-goals

- Live voice/video, push notifications, accounts, server-side persistence (Render free wipes memory on restart; clips are ephemeral by design).
- Themes that other players see (a theme is personal).

## Anti-goals (a failure even if it "works")

- Any existing flow changes behaviour: joining, rejoin, dealing, optimistic moves, pass countdown, results cards, practice mode, chat.
- Any move or tap becomes slower, or the table re-renders because a phrase/voice note arrived (chat changes must keep going through `paintChat`, never `render`).
- Voice data travelling inside game state pushes (chat is in every push).
- New layout height on the table screen (the card-fit `layout()` budget must not shrink on small phones).

## Constraints (from the code today)

- CSP: `default-src 'self'`; media loaded from our own origin is already allowed (`media-src` falls back to `default-src`). No `blob:` needed if clips are fetched by URL.
- `Permissions-Policy: microphone=()` currently forbids the mic; it must become `microphone=(self)`.
- `/api` takes JSON only, ≤2000 bytes, so clips need their own endpoint.
- Chat entries are `{id, name, text, sys, kind}`; `view()` sends `chat.slice(-40)` in every push. `stateSig` excludes chat, so chat-only changes already avoid full renders.
- Per-seat rate limit `SEAT_MAX` (60/10s); chat has a 400ms per-seat gap.
- Practice mode duplicates server behaviour on the client; new features must either work locally there or be hidden there.
- Single inline script pinned by hash: no inline handlers; `addEventListener` only.

## Approaches considered (voice notes)

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | Upload clip to `POST /voice`, server keeps it in memory per table; chat entry references its id; phones fetch `GET /voice/...` only when tapped | One small upload, fetched on demand; clips vanish on restart (fine) |
| B | Base64 audio inside the chat message | Re-sent with every push; far too heavy |
| C | Broadcast once as a separate SSE event | Reconnecting / reloading players miss it |

The other three features had one sensible way each (below). Chosen by the user: "go with the recommendations".

## Design

### Shared: chat entries gain a sender id and a kind

- `addChat` stores `pid` (sender's player id) for player messages. New kinds: `'phrase'` (text = the phrase) and `'voice'` (adds `vid`, `dur` seconds). Old clients/messages without these keep working.
- The client shows a **seat bubble** for each *new* phrase/voice entry (id greater than the newest seen at the previous paint; never for history on first paint, rejoin, or room switch). Bubbles live in their own fixed overlay (`#bubbles`), positioned from the sender's `.pl` chip rect, so strip repaints and table renders don't destroy them; re-anchor after each render/layout; fade after ~3.5s (voice: ~6s). If the sender's chip isn't visible (lobby, results card up), no bubble; chat still has it.
- Detection hooks into `paintChat()`'s existing "changed" branch; nothing new is added to `stateSig`.

### 1. Quick phrases

- A 💬 button in the table's banner row (right side, same row height, so `layout()` is unaffected). Tapping opens a small tray above the hand: 8 phrases plus the 🎤 button. Tap outside / tap a phrase closes it.
- Phrases (fixed list, server-validated by index so nobody can spoof arbitrary "phrases"): "Nice one!", "Hurry up 😴", "Ouch 😬", "Who's holding the 6?", "Sorry!", "Good game 👏", "Lucky! 🍀", "Hmm… 🤔".
- Sent as `{a:'chat', phrase: i}`; server: `kind:'phrase'`, same rate rules as chat plus a 2s per-seat phrase gap (error toast if faster). Shown in chat as a normal message from the sender (styled slightly as a phrase).
- Sending is optimistic in feel: the tray closes and your own bubble shows at once; the server echo is deduplicated by not re-bubbling your own entry.
- Practice mode: phrases work locally (bubble over you; bots don't reply). Spectators may send phrases.

### 2. Voice notes

- **Record:** 🎤 in the phrase tray and in the chat panel's form. **Tap to start, tap to send** (✕ to cancel), auto-stop at 8s, visible timer. Not hold-to-talk: the first use triggers the browser's mic prompt, which swallows a held press, and holding conflicts with the hand's touch handling. Min length 0.5s (shorter is discarded silently).
- `getUserMedia({audio:true})` on first use only; mic tracks are stopped as soon as recording ends (no lingering mic indicator). Recording also stops (discarded) if the tab is hidden or the player leaves the table.
- Format: first supported of `audio/mp4`, `audio/webm;codecs=opus`, `audio/ogg;codecs=opus`, at ~24 kbps (≈24 KB for 8s). If `MediaRecorder` or the mic is unavailable / denied, the 🎤 button explains why in a toast instead of failing silently.
- **Upload:** `POST /voice?t=<token>&d=<durationMs>` with the raw bytes and the recorder's `Content-Type`. Server checks: valid seat token; same-origin `Origin`; content type allowlist (`audio/mp4`, `audio/webm`, `audio/ogg`, `audio/aac`, `audio/mpeg`) and matching magic bytes; body ≤ 64 KB (abort past it); per seat at most 1 clip per 3s and 10 per minute; table in any phase. Then `S.voices` gets `{id, buf, type, at, pid}`; adds a chat entry `kind:'voice'` (text "🎤 voice note", `vid`, `dur`); `push(S)`; replies `{ok:true}`.
- **Storage limits:** last 15 clips per table, 10 minutes each (expired on access and swept on the existing 15s heartbeat), a global cap of 32 MB (oldest clips anywhere dropped first). Table deletion frees them.
- **Play:** `GET /voice/<id>?t=<token>`; served only to a token seated at the same table; `Content-Type` as stored, `nosniff`, `Cache-Control: private, max-age=600`, 404 once expired. The client plays with one shared `Audio` element (starting a clip stops the previous). Chat shows a ▶ bubble with duration; expired clips show "expired". A seat bubble with a pulsing ▶ appears over the sender for ~6s; tapping it plays. Mute (existing sound button) also silences clips. Nothing auto-plays.
- Practice mode: 🎤 hidden (no table to send to).

### 3. Table themes

- Four felts: Classic green (current, default), Midnight blue, Burgundy, Charcoal. Implemented as `html[data-felt=…]` overriding a handful of new tokens extracted from today's literals (board felt gradient at the `.board` rule, the page backdrop glow, the results panel gradient, `--bg`, and `<meta name="theme-color">`). Gold accent, cards and text stay the same so contrast stays AA.
- Picker: a palette button in the top bar opens a small popover with four swatches + the haptics toggle ("Table settings"). Choice saved in `localStorage` (`sevensFelt`), applied before first paint so there's no flash. The shared scorecard canvas keeps its fixed green look.
- Lite mode (`html.lite`) still applies on top of any theme.

### 4. Haptics

- One helper `buzz(pattern)`: no-op when unsupported, when off (`sevensHaptics`, default on), or when the page is hidden. Wrapped in try/catch.
- Events: your turn (existing 40ms, moved onto `buzz`), your card played (10ms, at tap time), phrase/voice note from someone else (15ms, at most once per 2s), round over (30,60,30), invite copied (existing).
- Toggle lives in the table settings popover, shown only where `navigator.vibrate` exists.

## Server changes summary

- `Permissions-Policy`: `microphone=(self)`.
- `act('chat')`: accept `phrase` index; chat entries carry `pid`, `kind`.
- New routes `POST /voice`, `GET /voice/<id>`; `S.voices` + global byte counter; sweep on heartbeat; free on `dropRoom`.
- CLAUDE.md: document the above and add v1.11 to the release list.

## Testing (user asked for extensive coverage, with agents)

All existing suites must pass unchanged (`test`, `passtest`, `rendertest`, `finaltest`, `fixtest`, `reloadtest`, `fixui`, `latejoin`, `uitest`, `optimtest`, `perftest`, `soaktest`). New suites, split across parallel agents by area:

1. **Server voice/phrase API:** auth, cross-table access, origin, type/magic bytes, size cap and mid-stream abort, rate limits, expiry, per-table and global caps, room drop frees memory, phrase index validation, chat backward compatibility.
2. **Browser (headless Chrome, fake mic via `--use-fake-device-for-media-stream`):** record→upload→other player sees bubble and plays; cancel; 8s auto-stop; denied mic toast; tab hidden mid-record; bubbles not shown for history on reload/rejoin; bubble survives strip repaint and table render; tray doesn't change card sizes; no extra `render()` on chat-only pushes; optimistic moves still instant while phrases arrive (optimtest under phrase spam).
3. **Themes/haptics/practice:** each theme renders without layout shift and keeps contrast; persists across reload; no flash; haptics calls (stubbed `navigator.vibrate`) fire on the right events and respect the toggle; practice mode phrases work and 🎤 is hidden; screenshots at 390px and desktop for all four themes.
4. **Regression sweep:** rerun every existing suite plus a soak with phrases and voice notes flowing during play.

## Calls made by Claude (check these)

- Tap-to-record instead of hold-to-talk (reason above).
- 8 phrases listed above; server validates by index.
- Limits: 8s, 64 KB, 15 clips / 10 min per table, 32 MB global, 1 clip per 3s.
- Themes + haptics toggle share one "Table settings" popover in the top bar.
- Spectators can send phrases and voice notes.
