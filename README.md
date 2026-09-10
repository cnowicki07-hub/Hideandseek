# Hide & Seek — MVP

Web app, no install required. Players open a link on their phone, screen
stays on and in hand for the whole game (this is what avoids needing a
native app — see the design doc for why).

## Status

**All five tiers of the build brief are implemented.**

| Tier | What | State |
|---|---|---|
| 1 | Host/join, roles, position sync, capture, charge, timer | done |
| 2 | Every power in design doc Section 5 | done |
| 3 | Totems + two-player sabotage | done |
| 4 | Hunt + Snitch | done |
| 5 | Signposts, boundary, panic/quit | done |

Also added, because the game can't resolve without them: host pause /
resume / end-now, survival-time scoring and an end-of-game scoreboard,
the head start, offline flagging and auto-elimination.

**Not done: outdoor testing on real phones.** See
[Before Friday](#before-friday) — this is the remaining risk, and it is
not something that could be checked from here.

## Stack

Cloudflare Workers, with one **Durable Object per game** (`src/server.js`)
built on the Agents SDK. The Worker serves the front end too, so there is
one thing to deploy and no separate static host.

Firebase and Netlify are gone. The game logic still runs in each player's
browser — the Durable Object is a shared, authoritative document store with
a push channel, which is all Firestore was doing here.

## Two ways to play

**Outdoors** — the real game. Everyone walks a real area the host draws on
the map, on real GPS, for as long as the host sets.

**Living room** — chosen when hosting, for playing indoors sitting together
in about ten minutes. GPS cannot work indoors: a living room is a few metres
across, indoor position error is tens of metres, and often there is no fix
at all. So indoors the game swaps walking for **tap-to-travel** — you tap a
destination and your token walks there at speed. Travel time is the
substance of the game (can you reach that totem before a seeker sweeps it?),
so it is kept, just compressed.

Everything else is identical — the same uncertainty circles, powers, totems,
hunts, sabotage and capture. Timings are scaled by the same factor
throughout, so the game feels proportionally the same, and the play area is
generated so there is nothing to set up. It needs no location permission at
all.

## 1. Run it locally

```
npm install
npx wrangler dev
```

Serves the whole app, Durable Object included, on http://localhost:8787.
Open that on your phone (same wifi as your laptop) or in a desktop browser.

### Playing offline, on one machine

`?mock=1` swaps the Worker for a localStorage store (`js/store-local.js`)
shared between **tabs of the same browser** — a whole game walked through
by yourself with no server running at all. Open one tab per player:

```
http://localhost:8787/?mock=1&pid=p0&sim=51.5074,-0.1278     <- host
http://localhost:8787/?mock=1&pid=p1&sim=51.5077,-0.1275
http://localhost:8787/?mock=1&pid=p2&sim=51.5071,-0.1281
```

- `?pid=` gives each tab its own player identity. **Without it every tab
  is the same player**, because they share one browser profile.
- `?sim=lat,lng` replaces GPS with a position that tab controls. Move it
  from that tab's console: `__sim.moveBy(20, -35)` walks 20m east and 35m
  south; `__sim.setPos(lat, lng)` teleports.
- Three tabs is the useful minimum (one seeker, two hiders — sabotage
  needs two hiders standing together).

Then: host names themselves and hosts, draws a boundary by tapping the
lobby map, others join with the code, host assigns roles and starts.
**Set the head start to 0 in the lobby** or seekers will sit still for
several minutes before they're released.

Drop `?mock=1` and the same tabs talk to the real Durable Object, which is
how you check two actual phones can see each other.

### Traffic check

```
node test/quota.mjs                                  # offline store
BASE_URL=http://localhost:8787 node test/quota.mjs   # real Worker
```

Walks five simulated players for a minute and projects the traffic onto a
90-minute game. Currently ~5,400 writes and **5.2 MB down per phone** —
which matters because those phones are on mobile data. Deltas are what keep
it there; broadcasting whole game state instead would multiply it.

### Automated check

```
npm i -D playwright && npx playwright install chromium

node test/e2e.mjs                                          # outdoor, offline store
BASE_URL=http://localhost:8787 node test/e2e.mjs           # outdoor, real Durable Object
node test/living-room.mjs                                  # indoor
BASE_URL=http://localhost:8787 node test/living-room.mjs   # indoor, real Durable Object
```

Run the outdoor suite both ways — the second is the one that proves the real
backend works. `living-room.mjs` runs a browser with **no geolocation
permission granted at all**, which is the point: the indoor game has to work
on a device with no usable GPS.

The outdoor suite drives a full five-player game and asserts 78 rules from
the design doc:
ping cadence and uncertainty growth, every power's effect as seen from the
*other* player's client, totem scaling and sabotage accrual/decay, hunt
bearings, snitch fidelity bands, boundary breach, capture, scoring, and
that two concurrent transactions can't lose an update. Worth re-running
after any change to `public/js/config.js`.

## 2. Deploy

```
npx wrangler deploy
```

One command puts the Worker, the Durable Object and the front end live, and
prints the URL everyone opens. `wrangler login` first if you haven't.

## Running a game

1. Host fills in a name and taps **Host Game**.
2. In the lobby the host **draws the boundary** by tapping corners on the
   map. This is worth doing properly: the area sets `M`, and every
   distance rule (totem radius, sabotage time, uncertainty cap, head
   start) scales from it. The lobby shows those numbers as you draw.
3. Everyone else joins with the code and picks a **loadout** of 3–4 hider
   powers (ignored if they end up a seeker).
4. Host sets the seeker count, taps **Randomly Assign Roles**, then
   **Start Game**. Hiders get the computed head start before seekers are
   released.
5. Capture is a conversation, not a button: the hider reads out their
   4-letter code, the seeker types it in and confirms the name.

## Where the numbers live

`public/js/config.js` is the single source of truth, ported from design doc
Section 18. Every tunable value is there — nothing is hardcoded in the
game logic. That file is the lever for post-playtest rebalancing.

## Design decisions worth knowing

Two places where the design doc left room, and the reading that got built:

- **Totem pings report a real position.** Section 6 says the totem "pings
  a random anonymous circle-position within its radius". Read literally as
  a uniformly random point, the ping would carry no location information
  at all, and the same section's note about reading "stacked vs. drifting
  circles" would be impossible. It is built as: pick one hider currently
  inside at random, report *their* position at base accuracy, with no
  identity attached. So a camper produces stacked circles and someone
  passing through produces drifting ones, which is what that note
  describes.

- **Sabotage requires standing at the totem centre**, within the base GPS
  accuracy radius (10m), per the "sabotage precision radius" row in
  Section 3. The tick sketch in Section 17 loosely says "within
  totem.radius" instead, which at a 76m radius would make sabotage nearly
  free. Section 8 is the specific rule, so it wins. It shows on the map as
  a dashed ring inside the totem.

The two-player sabotage sync was flagged in the brief as the highest-risk
piece. It did not need the fallback: each participant's client writes a
presence heartbeat onto the totem doc, so any client can count who is
currently there, and progress accrues inside a transaction keyed on the
last accrual time — so two clients crediting the same elapsed second
credit it once, not twice. Decay is computed from the gap since the last
accrual rather than written by a timer, which means it works correctly
even when nobody is present to run it.

One behaviour fix from Tier 1: hider uncertainty was calculated at ping
time from the gap since the *previous* ping, so a circle was at its widest
the moment someone pinged and then stayed frozen. It now grows at render
time from the age of the last ping, so staying still genuinely accumulates
exposure and Go Quiet is indistinguishable from signal loss.

## Before Friday

The automated suite covers the rules; it cannot cover GPS. Do these
outdoors, on real phones, before the real game:

- [ ] Two phones a few hundred metres apart, confirming positions and
      uncertainty circles behave sensibly under tree cover — GPS drift
      outdoors is the thing most likely to feel wrong
- [ ] Walk the boundary you drew, checking the warning zone triggers where
      you expect and that incidental drift doesn't start breach countdowns
- [ ] One full capture, end to end, code read aloud
- [ ] One power activated and checked on the *other* player's screen
- [ ] A totem sabotage with two people actually standing at it — this is
      the one that depends on real GPS precision, and if 10m proves too
      tight in practice, raise `baseAccuracyRadiusM` in `public/js/config.js`
      (it widens the sabotage ring with it)

## What the port to Cloudflare changed

The backend was Firestore until the day before the game. The move was worth
recording because most of it was *not* a rewrite:

- **The game logic did not move.** It still runs in each player's browser.
  `app.js`, `powers.js`, `world.js` and `hunt.js` are untouched by the port
  beyond two lines. What changed is what `db` is.
- **The store API stayed.** `js/store-core.js` keeps the
  collections/documents/listeners shape the game was written against. That
  shape was never Firebase-specific — it is "documents with listeners",
  which is exactly what a Durable Object can be.
- **Firestore's transactions had no equivalent**, so they were replaced with
  optimistic concurrency: a transaction records the version of every
  document it read, and the Durable Object refuses the write if any of them
  moved. Because a Durable Object handles one message at a time, that check
  is genuinely atomic. This is what stops two hiders' clients each crediting
  the same second of sabotage progress, and the suite asserts it directly
  (and was checked by breaking it on purpose to confirm the test fails).
- **Deltas, not whole-state sync.** The Agents SDK will sync a whole state
  object for you, which would have meant re-sending the entire game on every
  position update. The Agent broadcasts only changed documents instead —
  5.2 MB per phone per game rather than a multiple of it.
- **`docops.js` is shared verbatim** between the Durable Object and the
  offline store, so the offline tests can't pass while the real backend
  misbehaves.

Firestore's write quota — which the previous version had to be tuned hard to
stay under — simply doesn't apply here. The position-write throttling in
`CONFIG.sync` was kept anyway: it costs nothing and it is still less traffic
over someone's mobile data.

## Security note

There are no credentials in this repo any more — the Worker is addressed by
its own URL and there is no API key to leak. That is a real improvement over
the Firebase setup, where a public config plus test-mode rules meant anyone
who found the repo could read and write the database.

What remains is that the Durable Object trusts its clients. Any rule can be
bypassed by someone editing game state from dev tools, including seeing
hiders they shouldn't — the build brief traded anti-cheat away deliberately,
and the port kept that trade. Anyone who knows a game code can join it.

Worth knowing: the server *could* now enforce rules, because for the first
time there is a server. If this game gets played more than once, moving the
authoritative checks into `src/server.js` is the obvious next step.

## Known limitations of this build

- Screen must stay on and the tab must stay in the foreground the whole
  game — backgrounding will pause GPS updates on most phones.
- No cheat-prevention: there is no server, so every rule is enforced by
  each player's own client against itself. A technically-minded player
  could open dev tools and read or write game state directly, including
  seeing hiders they shouldn't. Fine for trusted friends, not beyond that.
- Capture code lookup assumes capture codes are unique within a game (they
  will be in practice at five players, but isn't formally enforced).
- A dead battery is a dead player. Bring a power bank for anything over
  90 minutes; the app deliberately does not degrade its ping rate to save
  power, because that would be unfair.
