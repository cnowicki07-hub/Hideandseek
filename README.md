# Hide & Seek — MVP

Web app, no install required. Players open a link on their phone, screen
stays on and in hand for the whole game (this is what avoids needing a
native app — see the design doc for why).

## Status

**All five tiers of the build brief are implemented.**

| Tier | What | State |
|---|---|---|
| 1 | Host/join, roles, position sync, capture, charge, timer | done |
| 2 | Powers | done, then redesigned — see [The powers](#the-powers) |
| 3 | Totems + two-player sabotage | done |
| 4 | Hunt + Snitch | done |
| 5 | Signposts, boundary, panic/quit | done |

Also added, because the game can't resolve without them: host pause /
resume / end-now, survival-time scoring and an end-of-game scoreboard,
the head start and hiding phase, offline flagging and auto-elimination,
a QR to join, and a living-room mode for playing indoors.

The **position system is not the design doc's.** Uncertainty circles and the
movement/stillness trade are gone; the roster of powers is smaller and
differently priced. What replaced them is described under
[What a dot means](#what-a-dot-means). Everything else — totems, sabotage,
hunts, snitching, capture, scoring — is as specified.

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

Everything else is identical — the same dots, powers, totems, hunts,
sabotage and capture. Timings are scaled by the same factor throughout
(dot lifetimes included), so the game feels proportionally the same, and the
play area is generated so there is nothing to set up. It needs no location
permission at all.

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

The outdoor suite drives a full five-player game and asserts 87 rules:
that nothing pings on its own, the Probe's half-world sweep and the 30m
error on what it reports, dot colour across its ten-minute life, every
power's effect as seen from the *other* player's client, totem scaling and
sabotage accrual/decay, hunt bearings, snitch fidelity bands, boundary
breach exposure, capture, scoring, and that two concurrent transactions
can't lose an update. Worth re-running after any change to
`public/js/config.js`.

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
3. Everyone else joins with the code, or scans the QR in the lobby.
4. Host sets the seeker count, taps **Randomly Assign Roles**, then
   **Start Game**. There is nothing to pick — everyone gets their whole
   side's powers.
5. That starts **hiding time**, not the hunt. Seekers are held; hiders walk
   out and tap **I'm hidden** when they're happy. Once everyone has
   declared — or the head start runs out — the seekers are released.
6. Capture is a conversation, not a button: the hider reads out their
   4-letter code, the seeker types it in and confirms the name.

## The powers

Charge is the whole game. It caps at 100 and refills at **15 a minute**, with
a 60-second cooldown between uses. That regen rate is the pacing dial: at a
Probe's 30, a seeker can sweep about **every two minutes**, and everything
else is priced against that. Halve `charge.regenPerMs` and the whole game
slows down at once.

**Seekers**

| Power | Cost | What it does |
|---|---|---|
| Tripwire | 5 | A hidden trap where you stand. A hider within 20m is reported **exactly** — the only unfuzzy reading in the game. You have to guess where they walk. |
| Scan | 15 | One coloured glow per hider at the edge of your screen. Direction only, infinite range, no distance and no dots. The opener before a Probe. |
| Lockout | 25 | One hider can use no power at all for 3 minutes. |
| Probe | 30 | Tap the map: a wave sweeps that whole **180°** half of the world, out to the boundary, putting a dot on everyone it passes. Two of them cover everything, which is why it costs what it does. |
| Totem | 60 | A permanent watchtower. Any hider inside is reported anonymously and exactly. Two hiders standing at it can destroy it. |

**Hiders** — everyone gets all four; there is nothing to pick.

| Power | Cost | What it does |
|---|---|---|
| Disarm | 15 | Destroys hidden tripwires within 50m. Spend it before a gate or a bridge. |
| Go quiet | 20 | The next ping *aimed at you* simply fails. A wave washes over you and reports nothing. Lasts 3 minutes or until it eats one. |
| Decoy | 35 | For 3 minutes, anything that pings you pings a fake you instead, walking off at 3 km/h on a bearing you choose. Real dots, wrong place, moving. |
| Seeker scan | 40 | Pins every seeker on your map, exactly. Your only way of ever seeing them. |

Plus **Snitch** (20), which only unlocks while you are being hunted: sell out
another hider to the seeker chasing you. They are never told it was you.

## What a dot means

Nothing appears on the map by itself. Every dot was paid for by somebody.

A dot is **wrong by up to 30m**, rolled fresh each time, so two readings on a
player who has not moved an inch can land 60m apart in unrelated directions —
and the faint smear drawn between consecutive dots can point the wrong way
entirely. That error is the counterweight to how much ground a Probe covers.

Dots age in colour: **white** at birth, shading to **bright red** over five
minutes, then fading to nothing over five more. Your own trail is **green**,
so you can always see exactly what you have given away.

Four readings skip the error and report the truth: a **tripwire**, a
**totem**, a hider's **Seeker scan**, and a **panic alert**. Seekers' own
trails are never jittered either.

One thing still pings for free: **leaving the boundary**. Step outside and the
game gives your position away over and over until you come back, and nothing
you can buy will stop it.

## Where the numbers live

`public/js/config.js` is the single source of truth, ported from design doc
Section 18. Every tunable value is there — nothing is hardcoded in the
game logic. That file is the lever for post-playtest rebalancing.

## Design decisions worth knowing

Two places where the design doc left room, and the reading that got built:

- **Totem pings report a real position.** Section 6 says the totem "pings
  a random anonymous position within its radius". Read literally as a
  uniformly random point, the ping would carry no location information at
  all, and the same section's note about reading stacked vs. drifting
  readings would be impossible. It is built as: pick one hider currently
  inside at random and report *their* position, exactly, with no identity
  attached. So a camper produces a stack of dots and someone passing
  through produces a drifting line of them, which is what that note
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

Ping jitter is **display only**. `emitPing` moves the *reported* point by up
to 30m; nothing else in the game ever reads it. Tripwire triggering,
sabotage presence, capture range and boundary checks all run on true
positions, so a fuzzy reading can never make a physical rule fire wrongly.

## Before Friday

The automated suite covers the rules; it cannot cover GPS. Do these
outdoors, on real phones, before the real game:

- [ ] Two phones a few hundred metres apart, one probing the other, checking
      the dots land somewhere believable under tree cover — GPS drift
      outdoors stacks on top of the deliberate 30m error
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
