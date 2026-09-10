# Backlog

Things that came out of outdoor testing and are **not built yet**. Kept here
so they don't get lost between sessions. Nothing in this file is implemented.

## From the first outdoor test

- **The QR skips the name step.** Scanning the join code takes a player
  straight into the lobby without ever asking who they are, so they arrive as
  a blank. The QR path needs the same name entry the manual path has, before
  it joins.

- **The host can't kick anyone.** A stranger joined a real game — the code was
  visible, and anyone who has it is in. The host needs a kick control on each
  row of the lobby list, and a kicked player needs to be told why they were
  dropped rather than silently losing state.

- **Roles can only be assigned randomly.** The host needs to be able to set a
  role per player as well — a tap on each lobby row cycling
  unassigned → seeker → hider — with the random assign kept as the shortcut.

- **The UI is too dark outdoors.** In bright daylight the map especially is
  hard to read: the horror theme darkens the tiles with a CSS filter, which is
  right indoors and wrong in a field. Open questions before building it:
  whether it's a host-wide setting or a per-player toggle (per-player, most
  likely — the sun is where the player is), and whether "bright" should drop
  the tile filter entirely or just lighten it. The dots need re-checking for
  contrast against undarkened tiles either way.

## Bigger, if this game gets played more than once

- **The server could enforce the rules.** Every rule is currently checked by
  each player's own client against itself, so anyone with dev tools can read
  or write game state, including seeing hiders they shouldn't. There is a
  server now — `src/server.js` — so the authoritative checks could move into
  it. The build brief traded anti-cheat away deliberately; this is what
  un-trading it would look like.
