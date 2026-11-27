# Voice notes with fewer taps

## Why
Sending a note took 3 taps (💬 → Voice note → Send) and hearing one meant catching a 6.5s bubble or digging in the
chat at the top of the screen. Both pull players out of the game.

## Decided with the user
- **Send: hold to talk.** A 🎤 button beside 💬 on the felt's rim. Press and hold to record, let go to send, slide
  the finger away (or the system cancels the touch) to cancel. Lifting before the mic is live, or under 0.5s,
  cancels with a hint. The very first press only gets the browser's mic permission, then teaches "hold and talk".
- **Listen: under the player's control, one tap.** Unheard notes sit as a ▶ badge with a count on the sender's
  player chip. One tap plays that player's unheard notes back to back, oldest first; tapping again stops (the
  rest stay unheard). Tapping another player's badge switches to them. One voice at a time, never auto-play.
  Notes you heard leave the badge; they stay in the chat. A note that arrives while its sender's queue plays joins
  the end.

## Approaches considered
- Send: hold-to-talk (chosen) vs tap-to-start/tap-to-send (2 taps, kept for the chat panel's mic and keyboard use).
- Listen: auto-play (rejected by the user: overlapping or slow queues, sound at moments the player didn't choose)
  vs a persistent per-seat badge (chosen).

## Calls made while building
- Badges expire after 3 minutes (stale banter; clips themselves expire after 10) and clear when leaving the table.
  No badges for notes that were already in the chat when the page loaded.
- The arrival bubble stays as the attention cue (shorter, 4.5s); tapping it plays the sender's queue.
- The tray's "Voice note" item is removed (the mic sits right beside 💬). The chat panel's mic keeps tap-to-record.
- Playback reuses one audio element so the next note in a queue can start without a new tap on iPhones.
- The recording bar lets taps through in hold mode so a card can still be played with the other hand.
- No server change.
