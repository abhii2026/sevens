# Live talk (walkie-talkie)

## Why
Voice notes arrive only after the sender lets go. Players want to hear each other while talking, on phones on mobile
data, where peer-to-peer WebRTC failed (v1.4–v1.6: carrier-grade NAT, no TURN relay, Render has no UDP).

## Decided with the user
- Hold the 🎤 to talk; others hear it live, about a second behind. Let go to stop.
- At most **three** people talking at once; a fourth press is told to wait.
- **15 seconds** per press.
- A talk you didn't hear live (muted, screen off, another app, live talk off) becomes a replayable clip with the
  existing ▶ badge on the talker's chip. Heard live: no badge.
- **A switch in the code, not in the app, with voice notes as the fallback.** `LIVE_TALK` in `server.js` (on;
  the `LIVE_TALK=0` environment variable overrides it without a code change). Off: the server refuses `/talk`, the
  view says `lt:0`, and every phone's 🎤 records voice notes exactly as in v1.18. There is no player-facing setting.
  A phone whose browser can't capture live audio falls back to voice notes on its own.

## Approaches considered
1. **Plain audio over the existing server (chosen).** The phone captures raw audio (Web Audio), downsamples to 8 kHz
   and encodes G.711 μ-law (64 kbps), posts 250 ms chunks to `POST /talk`; the server fans each chunk out on the SSE
   stream it already holds to every phone at the table; listeners decode and schedule them with Web Audio. Works on
   every browser (no codec or container differences between iPhone and Android, no MediaSource), mixes three voices
   for free, needs no third party. Cost: phone-call quality, ~85 kbps per talker heard (base64 on SSE).
2. Stream MediaRecorder chunks (Opus/AAC) and play with MediaSource. Better quality, half the data, but iPhones
   record AAC/MP4 and Android WebM/Opus, live MediaSource playback of the other format is unreliable, and iPhones
   before iOS 17 have no MediaSource at all.
3. Hosted voice (LiveKit, Agora) or TURN relay. Real duplex calls, but an account, a key, a cost, and loosening the
   strict CSP. Rejected by the user for now.

## Design
**Server.** `POST /talk?t=&id=&s=<seq>` with up to 4 KB of μ-law bytes; `POST /talk?t=&id=&end=<n>[&cancel=1]`.
- The first chunk of an unknown id opens a talk: refused with 409 when three talks are open at the table, 429 when
  the seat starts talks too often; one open talk per player.
- Each chunk goes to every other player's streams as `event: talk` `{id,pid,s,a:<base64>}`; it is kept for the replay.
- A talk ends on `end` (waits up to 1.5 s for chunks still in flight), after 2.5 s without a chunk, or at 15 s.
  Shorter than 0.5 s or cancelled: dropped. Otherwise it becomes a 16-bit WAV clip in the voice store (same TTL,
  budget and per-table cap as notes) and a chat entry `{kind:'voice', vid, dur, pid, live:id}`; the stream gets
  `event: talk {id,pid,end:n}` just before the state push.
- `LIVE_TALK=0` refuses `/talk` (403) and the view says `lt:0`.
- Rate limits: chunk posts count in their own per-address bucket (a table sharing one Wi-Fi must not starve /api).

**Client.**
- *Talking:* the hold gesture (v1.18) starts `startTalk()` when live talk is on, the server allows it and the
  browser has Web Audio + getUserMedia; otherwise it records a voice note as before (automatic fallback, said once).
  Capture: mic → ScriptProcessor → downsample → μ-law → 250 ms chunks posted in parallel. The bar reads
  "LIVE 0:03 / 0:15". Slide off still cancels (no replay is kept). Under 0.5 s: cancelled with the hint.
- *Listening:* `event: talk` chunks are scheduled by sequence number on `audioCtx` (unlocked on the first tap) with a
  ~300 ms jitter buffer; a late chunk pushes that talk's timeline back rather than overlapping. Several talkers mix
  naturally. Only when live talk is on, not muted, and the page is visible.
- *Indicators:* a talking talker's chip shows live bars (no table redraw); a talker who stops sending for 3 s is
  cleared.
- *Heard live:* a talk counts as heard when at least 60% of its chunks were scheduled; its clip then gets no badge
  and no arrival bubble.

## Left to the builder
Exact visuals of the talking indicator; chunk scheduling details.
