# Points for players who leave mid-game

## Why
Lowest total wins, and the final results only add up rounds a player appears in. Someone who leaves is dropped
at the next deal, so every round after counts as 0 for them and walking out tends to win the game.

## Rule (decided by the user)
- The round they walk out of: the bot finishes it for them and they get what the bot scores (unchanged).
- Every later round the table plays without them: they are charged that round's highest score among the players
  who played it.
- If they come back later (same browser), they get their old seat in the standings back: rounds missed while away
  stay charged, and no late-join 90% applies (they are not new). A different browser is a different player, so a
  stranger using the same name can never inherit someone else's total.
- Leaving between rounds (lobby / results card) is the same: every round played after is charged.

## Approaches considered
1. **Record a "missed" row in `S.history` at `finishRound` (chosen).** One place on the server; totals, the final
   card, `gameTotals` and the poster all sum history already, so they pick it up with no extra logic.
2. Compute the charge on the client in `finalStandings()`. Rejected: the server's `gameTotals` (late-join points)
   would disagree with what players see.
3. Rank leavers below everyone who stayed. Rejected by the user in favour of the points rule; it also hides how
   far behind they were.

## Design
- `finishRound`: after the seated rows, every id seen in earlier history but not seated this round gets
  `{id, name, pts: <round max>, place: 0, missed: true}`. The round's log line mentions it.
- `forgetPlayer` remembers departed players who have history (`S.gone`: id, cid, name); `join` for a new seat with a
  matching cid reuses that id. Cleared with the history on `resetscores` / `newgame`.
- Client: a missed round's chip is marked as away and says why; it does not count as a round won or as "best
  round". Practice mode never has missed rounds.

## Left to the builder
Exact chip wording and style.
