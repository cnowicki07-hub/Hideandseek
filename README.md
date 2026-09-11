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

Everything the first outdoor test threw up is fixed — see `BACKLOG.md` for
what those were. **What still has not been done is a second outdoor test.**
See [Before Friday](#before-friday): the suite covers the rules, it cannot
cover GPS or sunlight, and that is the remaining risk.

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

**They are one game, not two builds.** There is no separate indoor codebase:
a living-room game is an ordinary game document with `mode: 'livingroom'` on
it, served by the same Worker and the same Durable Object class, running the
same `app.js`, `powers.js`, `world.js`, `hunt.js` and `ui.js`. The only
difference is `applyGameMode('livingroom')` in `public/js/config.js`, which
overrides a short, explicit list of CONFIG numbers — and every client applies
it from the game document when it subscribes, host and joiners alike, so
nobody can end up on the wrong clock.

The practical consequence, which is the point of the mode: **change a rule
and both versions change.** Edit game logic and the indoor game gets it for
free. Edit a *number* and it lands indoors too, unless it is one of the
values `applyGameMode` explicitly overrides — that list is right there in
`config.js`, deliberately written out rather than computed, so it is obvious
which numbers indoors reinterprets. So the living-room game is a genuine
rehearsal for the outdoor one, not an approximation of it.

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

The outdoor suite drives a full five-player game and asserts 133 rules:
that nothing pings on its own, the Probe's half-world sweep and the 30m
error on what it reports, dot colour across its ten-minute life, that the
map carries no label of any kind except a panic alert, every power's effect
as seen from the *other* player's client, totem scaling and sabotage
accrual/decay, hunt readings and the two powers that answer them, snitch
fidelity bands, signpost discovery,
hand-assigned roles, daylight mode, I SEE YOU appearing at 20m and letting
every tap through, closing a phone and the yellow-ringed stale readings and
repayment debt that follow, being greyed out and reinstated, boundary breach
exposure, capture, scoring, and that two concurrent transactions can't lose an
update.

It also drives the two things outdoor testing broke: an uninvited player
arriving by QR code — who has to stop and give a name, and cannot get back
in once the host removes them — and a removed player disappearing from the
lobby's arithmetic instead of holding the Start button down. Worth
re-running after any change to `public/js/config.js`.

## 2. Deploy

```
npx wrangler deploy
```

One command puts the Worker, the Durable Object and the front end live, and
prints the URL everyone opens. `wrangler login` first if you haven't.

## Running a game

0. Everyone standing in bright sun should tap **Daylight mode** on the first
   screen. See [Daylight mode](#daylight-mode).
1. Host fills in a name and taps **Host Game**.
2. In the lobby the host **draws the boundary** by tapping corners on the
   map. This is worth doing properly: the area sets `M`, and every
   distance rule (totem radius, sabotage time, uncertainty cap, head
   start) scales from it. The lobby shows those numbers as you draw.
3. Everyone else joins with the code, or scans the QR in the lobby. A scanned
   link fills the form in and stops — you still type your name and tap
   **Join Game**, which is also where the location prompt comes from. A blank
   name is refused: the seekers have to be able to say it out loud.
4. Host sets the roles: **tap any player in the lobby list** to cycle them
   through no role → seeker → hider, or set a seeker count and tap
   **Assign Roles Randomly**. Both sides have to exist before the game will
   start. There is nothing else to pick — everyone gets their whole side's
   powers.

   The **✕** beside each row removes that player. Anyone who has the code can
   join, and in a real game a stranger did; a removed player is told what
   happened, taken back to the start, and the same code will not get them
   back in. The host menu carries the same control mid-game, for a stranger
   nobody spots until later.
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
| **I SEE YOU** | — | Passive, always on. See below. |

**I SEE YOU** is not bought and not activated. Any hider who comes within
**20m** of a seeker gets the words across their entire screen, dripping and
blinking, over everything — and from that moment **they are not allowed to
run**. Only walk, until they are clear.

The app does not enforce it and cannot: the overlay is inert, passes every tap
straight through, and the hider can read the map and spend powers exactly as
before. It is a rule about a person's legs, kept by that person, and the
screen is only there to make it impossible to pretend they didn't know. It
reports *nothing* to the seeker — a free passive reading would break the rule
that every dot on the map was paid for. What it buys the seeker is simply
this: once they are close, nobody sprints away from them.

The panic button deliberately sits above it in the stacking order. Atmosphere
never covers the safety equipment.

**Hiders** — everyone gets all four; there is nothing to pick.

| Power | Cost | What it does |
|---|---|---|
| Disarm | 15 | Destroys hidden tripwires within 50m. Spend it before a gate or a bridge. |
| Go quiet | 20 | The next ping *aimed at you* simply fails. A wave washes over you and reports nothing. Lasts 3 minutes or until it eats one. |
| Decoy | 35 | For 3 minutes, anything that pings you pings a fake you instead, walking off at 3 km/h on a bearing you choose. Real dots, wrong place, moving. |
| Seeker scan | 40 | Pins every seeker on your map, exactly. Your only way of ever seeing them. |

Plus **Snitch** (20), which only unlocks while you are being hunted: sell out
another hider to the seeker chasing you. They are never told it was you.

**The Hunt** costs no charge at all — it is gated on the game going ten
minutes without a capture, and it is the answer to a stalemate rather than a
power. A seeker declares it on one hider, and for the next ten minutes that
hider's position is reported every three minutes: four readings, free, the
first one immediately.

Those readings are **ordinary pings**. They carry the same 30m error as
anything else, and more importantly **Go quiet and Decoy both work on them** —
go quiet eats one outright, a decoy poisons the whole run. That is the point
of the mechanic: a hunt is the moment a hider most needs their two defensive
powers, so it must be the moment they work. The hunted player is told a hunt
has started and their banner counts down to each reading, which turns spending
a power into a decision with a clock on it rather than a guess.

It reports nothing back to the hider about where the seeker is. An earlier
version handed both sides a bearing cone computed from true positions, which
looked like a chase and was really just a rule no hider power could touch.

## What a dot means

Nothing appears on the map by itself. Every dot was paid for by somebody.

A dot is **wrong by up to 30m**, rolled fresh each time, so two readings on a
player who has not moved an inch can land 60m apart in unrelated directions —
and the faint smear drawn between consecutive dots can point the wrong way
entirely. That error is the counterweight to how much ground a Probe covers.

Dots age in colour: **white** at birth, shading to **bright red** over five
minutes, then fading to nothing over five more. Your own trail is **green**,
so you can always see exactly what you have given away.

**Nothing on the map is labelled.** No names, no timestamps, no "12s ago" —
colour is the only thing that tells you how fresh a reading is, and a dot
never says whose it is. The single exception is a **panic alert**, which is
named and permanent, because that one is not part of the game. Totem sabotage
progress, which used to hang off the totem as a label, reads out in the banner
strip while you are standing at it.

Four readings skip the error and report the truth: a **tripwire**, a
**totem**, a hider's **Seeker scan**, and a **panic alert**. Seekers' own
trails are never jittered either.

One thing still pings for free: **leaving the boundary**. Step outside and the
game gives your position away over and over until you come back, and nothing
you can buy will stop it.

## Daylight mode

The horror theme is right at dusk and wrong at noon — the first outdoor test
was people in a bright field squinting at a map the CSS deliberately inverts
into night. **Daylight mode** is a legibility mode, not a second theme: same
palette and the same identity, but the grain and vignette come off, the
surfaces lift far enough to read in direct sun, and the map is left at
OpenStreetMap's real colours instead of being inverted. Every dot gains a dark
ring, because a white dot on a pale tile is no dot at all.

It is **per player**, not per game — one of them is under trees and another is
in an open field — and it is remembered, so it survives the reload between
rounds. Set it from the landing screen before you start, or the **☀** button
on the map at any time.

## Closing your phone

A phone is a battery, and a ninety-minute game outlives some of them. **Menu →
Close my phone** stops you reporting: the position watch and the rules tick
both stop, and a dead screen with one button on it replaces the game. A phone
that locks itself in a pocket ends up in exactly the same state — nothing has
been heard from it for 90 seconds — and is treated identically, because to
everyone else the two are the same thing.

**What everyone else sees.** They can still be pinged, because a seeker's
probe hits their last known position — but that position is not where they
are, it is where they were when the phone went dark. Those dots are marked
stale and drawn with a **yellow ring**, so nobody runs half a mile at a
reading that was never live.

**What it costs.** One owed position report per full minute unavailable, paid
back once you are open again at **one every thirty seconds**, starting
immediately. Five minutes dark is five dots over the two and a half minutes
after you return. They are ordinary pings: the usual 30m error, and both Go
quiet and Decoy can answer them. Going dark is a cost, not a sentence — but
it is not a way to disappear.

**Fifteen minutes** unavailable and you are **greyed out** of the game. That
is a status, not an ending: you keep your role, your charge and your capture
code, and **the host can put you back in** from their menu. Your clock stops
while you are out, and the time you were dark is not scored as survival —
otherwise closing your phone would be the strongest hiding move in the game.

## Signposts

A sign is invisible until you **walk within 10m of it**. After that it stays
on your map for the rest of the game and you can read it from 18m. Discovery
is per player and never shared, so a sign appearing on your map tells you
nothing about where anybody else has been — and leaving one somewhere out of
the way is a real gamble that anyone ever finds it.

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
- [ ] Daylight mode on, in actual sun, checking the dots still read against
      undarkened tiles — the ring was added for exactly this and has only
      been checked on a desk

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

- Screen must stay on and the tab must stay in the foreground while you are
  playing — backgrounding pauses GPS updates on most phones. That is now a
  handled state rather than a silent failure: the game notices the gap, marks
  what everyone knows about you as stale, and charges you for it. See
  [Closing your phone](#closing-your-phone).
- No cheat-prevention: there is no server, so every rule is enforced by
  each player's own client against itself. A technically-minded player
  could open dev tools and read or write game state directly, including
  seeing hiders they shouldn't. Fine for trusted friends, not beyond that.
- Capture code lookup assumes capture codes are unique within a game (they
  will be in practice at five players, but isn't formally enforced).
- A dead battery is still the main enemy. Bring a power bank for anything
  over 90 minutes. Closing your phone (above) is the supported way to save
  it — the app deliberately does not degrade its reporting rate on its own,
  because that would silently make one player harder to find than the rest.
