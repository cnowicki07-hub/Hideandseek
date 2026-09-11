# Backlog

Everything from the first outdoor test is now built. What is left here is the
one structural change that was never in scope for this build.

## Bigger, if this game gets played more than once

- **The server could enforce the rules.** Every rule is currently checked by
  each player's own client against itself, so anyone with dev tools can read
  or write game state, including seeing hiders they shouldn't. There is a
  server now — `src/server.js` — so the authoritative checks could move into
  it. The build brief traded anti-cheat away deliberately; this is what
  un-trading it would look like.

  The kick is worth noting as the first crack in that trade: it holds against
  a stranger's browser, not against someone who clears their storage. That is
  the right strength for the problem it was built for, and it is also a
  reminder of where the line currently sits.

## Done

- ~~The QR skips the name step~~ — a scanned link now fills the form in and
  stops; joining still goes through the button, so the name step and the
  location prompt both happen. A blank name is refused outright rather than
  becoming "Player".
- ~~The host can't kick anyone~~ — every lobby row has a kick control, the
  host menu carries one per active player mid-game, a removed player is told
  and taken back to the start, and the same code will not get them back in.
- ~~Roles can only be assigned randomly~~ — tap any lobby row to cycle a
  player through no role → seeker → hider. Random assignment stays as the
  shortcut, and the lobby refuses to start a one-sided game.
- ~~The UI is too dark outdoors~~ — daylight mode, per player, from the
  landing screen or the ☀ button on the map. Resolved the two open questions
  as: per player (the sun is where the player is standing), and drop the tile
  inversion entirely rather than lightening it. Dots get a dark ring in
  daylight so a white one does not vanish into a pale tile.
