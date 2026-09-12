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

**Solo** — the living-room game with nobody else in the room. Chosen the same
way when hosting; you pick your side and how many opponents, and there is
nothing to wait for.

The others are ordinary players. They have documents, charge, capture codes,
trails and scores like anyone else; what they do not have is a phone, so the
one client that is open walks their tokens and spends their charge. The thing
that mattered most building it was that **a bot must not cheat**, and the
temptation is everywhere, because that client is holding every true position
in memory. So a bot seeker reads exactly what a real seeker reads — the dots
on a hider's document, which somebody had to pay for — and only looks at a
true position once it is close enough that a person would have line of sight.
A bot hider knows only that it has been pinged, because that is all the game
tells a hider.

One rule changes: there is nobody to read four letters to, so **catching is
reaching** — get within 20m and the Catch button lights up. Tokens indoors
are exact, unlike GPS, which is what makes that fair.

**Solo is also the mode to test the scaling in**, so unlike the living room it
does not fix the play area. Type any size on the landing form and the rules it
produces are previewed live underneath as you type — readings, tripwires,
disarm, totems, the boundary warning — before you commit to anything. Then in
the lobby you get the boundary map: **Find me**, or pan anywhere in the world,
drop corners, and the same numbers update as you draw. The game starts where
you put the area, with the opponents scattered inside it.

The landing preview deliberately leaves *durations* out. Indoor rounds
compress every time value about ninefold, and that scaling is only applied
once the game exists — quoting a sabotage time on the landing form would print
a number that changes the moment you press Host. Distances do not move: they
come from the area alone.

Things that only came out of playing it rather than writing it:

- Bot seekers were **probing all through the head start**, because driving
  them from this client means none of `powerBlockedReason`'s gates apply to
  them automatically. The ones that matter are stated explicitly now.
- Bot hiders **fled 200m on every single ping**, which made a seeker's last
  thirty metres impossible to close. A bot that reacts perfectly is not an
  opponent, it is a wall. They sit tight about half the time on a first
  reading now, and only really run when pinged twice in quick succession.
- Bot seekers **only ever probed** — no totems, no tripwires, so they were
  playing a third of the game and never closed the ground down. That turned
  out to be a budget problem, not a logic one. A probe fires at 40 charge and
  a totem costs 60, so a bot that always takes the sweep oscillates between
  10 and 40 and can never afford one; and laying a wire every 20 seconds at 5
  charge spends the entire income at the regen rate. Now a seeker gives up
  the *speculative* sweep while a totem is due — a real lead is still chased
  — wires are paced well under the income and always leave a probe
  affordable, and the saving is bounded so a bot can never get stuck hoarding
  for something it cannot reach. Totems go where they close space down:
  straight onto a fresh lead, or otherwise the most open ground left.

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

The outdoor suite drives a full five-player game and asserts 186 rules:
that nothing pings on its own, the Probe's half-world sweep and the 30m
error on what it reports, dot colour across its ten-minute life, that the
map carries no label of any kind except a panic alert, every power's effect
as seen from the *other* player's client, totem scaling and sabotage
accrual/decay, hunt readings and the two powers that answer them, snitch
fidelity bands, signpost discovery,
hand-assigned roles, daylight mode, the key explaining itself from this
game's own numbers, dot labels toggling, a tap still landing where you pointed
on a compass-rotated map, a found sign putting itself on screen, fireworks
appearing for everyone and leaving nothing behind, hiders-only chat, the
end-of-game walk-through of true movement, I SEE YOU appearing at 20m and letting
every tap through, closing a phone and the yellow-ringed stale readings and
repayment debt that follow, being greyed out and reinstated, boundary breach
exposure, capture, scoring, that every distance rule still relates sensibly to
every other one across nine map sizes from 100m to 3km, that the game keeps
applying its own rules when the host stops playing, that a boundary with no
room in it is refused, and that two concurrent transactions can't lose an
update.

It also drives the two things outdoor testing broke: an uninvited player
arriving by QR code — who has to stop and give a name, and cannot get back
in once the host removes them — and a removed player disappearing from the
lobby's arithmetic instead of holding the Start button down. Worth
re-running after any change to `public/js/config.js`.

### Simulation

```
node test/sim.mjs                 # every scenario
BASE_URL=http://localhost:8787 node test/sim.mjs           # against the real backend
node test/sim.mjs host            # one by name
```

A different job from the rule suite. `e2e.mjs` asks "does each rule do what
it says"; `sim.mjs` puts the game in situations nobody wrote a rule for and
watches what happens — a host who quits halfway through, two players or
twelve, three seekers capturing the same hider on the same tick, two minutes
of everybody spending everything, boundaries drawn flat or three metres
across.

It reports **bugs** and **notes** rather than pass/fail, because most of what
it finds is a judgement call. It has already earned its keep: it found the
conductor problem below, which the rule suite could never have caught,
because every individual rule was working correctly.

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
   map. This is the most consequential thing anyone does: the area sets `M`,
   and every distance rule in the game — how wrong readings are, how wide a
   tripwire catches, how big a totem is, how long the head start runs —
   stretches from it. The lobby prints all of those live as you draw, so you
   can see the game you are about to play. See
   [How the numbers scale](#how-the-numbers-scale-with-the-play-area).
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

**There is no cooldown between powers.** Charge is the whole limiter: the
regen rate already decides how often anyone can act, and a minute of enforced
silence on top of it only made people miss the moment they had been saving
for. Spend it as fast as you can earn it.

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

## Maps and attribution

The play map carries **no attribution control**. Leaflet's own credit line
includes a flag and a link, and neither belongs over a game you are reading
at a glance in a field — the same reason nothing else on that map is
labelled.

OpenStreetMap still has to be credited: that is a licence condition, not a
preference. The credit moved into the **key**, under its own heading, which
is where someone looking for it would look, and it sits under the boundary
map in the lobby and the walk-through map at the end. The map data is still
OpenStreetMap's and still says so.

## Reading the map

People kept asking the map what its colours meant, so now it tells them. The
**KEY** button opens a panel built from the same palette and the same CONFIG
the map draws from — it cannot drift out of date, and it quotes *this* game's
distances rather than a rule of thumb from a 600m map. Dots, rings, the
boundary, totems, tripwires, signposts, the Scan glow: all of it, named.

Two display toggles live in there, next to the things they toggle:

- **Names and ages on dots.** Back on by default. Only the freshest dot per
  player is labelled — labelling a whole trail turns the map into a wall of
  text. One tap turns them off again if you preferred the map clean.
- **Turn the map to face the way I am going.** Heading-up rather than
  north-up, which is how most people actually read a map while walking. The
  compass needle on the map controls shows your heading either way.

Rotating a Leaflet map is not free: its own idea of where a tap landed is
wrong the moment you do it, and `getBoundingClientRect` on a rotated element
returns the box *around* the rotation — for a quarter turn the width and
height swap. So taps are read off the container first and un-rotated by hand
before Leaflet sees them, and the map is scaled up just enough to keep its
corners off the screen. The suite checks a tap still lands where the finger
pointed, at the centre and off it.

## Signs

A signpost you walk into now goes **up on your screen by itself**, written in
blood on a board, dismissed with its X. A 4px dot on a map and a one-line
toast was never going to make anyone stop and read what somebody left them.
It still doesn't say who wrote it.

## Taunts

**Taunt** sets off a firework where a hider is standing: a random shape and
colour, five seconds, visible to everyone including the seekers. Then it is
gone, and there is nothing left on the map — it is drawn *over* the map rather
than into it, so there is no trace to remove.

It costs no charge, because charge buys information and this buys none. A
firework tells a seeker that somebody nearby is pleased with themselves and
nothing else; the position it goes off at is not recorded anywhere, and
chasing one is a waste of a seeker's legs. The only limiter is a 30-second
cooldown, so it stays an event rather than a strobe.

Taunts are counted on **their own ladder** at the end, printed under the
scoreboard and never mixed into survival time. Being insufferable is its own
category.

## Hider chat

A **Hiders** button, and a chat only the hiding side can read. Warn someone a
seeker just walked past you, agree to meet at a totem, or gloat. Seekers get
no button and cannot post. Like every other rule in this build it is enforced
by the client, so a seeker with dev tools could read it — the same trade the
rest of the game makes.

## The walk-through

For the whole game nobody sees anything they did not pay for. At the end,
everybody sees everything: the end screen carries a map of **every player's
true movement for the entire round**, one coloured line each, hollow circle
where they started and solid where they finished, plus **every signpost
anybody left** whether or not you ever found it.

This is where the stories are — who walked straight past whom, who sat in the
same bush for an hour, whose decoy nobody ever fell for. True positions are
sampled every 15 seconds into a capped 400-point track written alongside the
position updates that were happening anyway, so it costs no extra traffic.

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

## How the numbers scale with the play area

The same game gets played on a school field and across a country estate, and
a distance that is right at one is wrong at the other. `M = sqrt(area)` — a
600m square is `M = 600` — and every distance rule is quoted at that
reference size, then stretched. There are three kinds of number, treated
differently on purpose:

**Fixed** — anchored to a human body or to GPS itself. How far away you can
see someone (I SEE YOU, 20m). How close two people must stand to share a spot
(sabotage, 10m). How much a phone's position wanders (5m). How close you have
to be to notice a signpost (10m) and read it (18m). None of this cares how big
the map is, and scaling it would be a lie about the physical world — a sign
that appears from 60m away is not a sign you found.

**Scaled** — about searching a space. A tripwire is a bet on where somebody
walks. A ping's error is how much ground you still have to cover after being
told where to go. These stay the same fraction of the map at any size.

**Clamped, at both ends.** Linear scaling fails twice over. Shrink a rule far
enough and it drops below GPS's own error and stops working: a 6m tripwire
fires at random or never. Grow it far enough and it stops being a game: a
reading wrong by 75m leaves 17,000 m² to walk, half an hour for one ping in a
ninety-minute round. The floors are set by physics; the ceilings by how long a
person will actually spend looking.

What that produces:

| Play area (M) | 150 | 400 | 600 | 1200 | 2000 |
|---|---|---|---|---|---|
| Reading wrong by | 10m | 20m | **30m** | 45m | 45m |
| — ground left to search | 314 m² | 1,257 m² | 2,827 m² | 6,362 m² | 6,362 m² |
| Tripwire catches at | 15m | 15m | **20m** | 40m | 60m |
| Disarm clears | 38m | 38m | **50m** | 100m | 150m |
| Boundary warning at | 15m | 15m | **20m** | 40m | 50m |
| I SEE YOU at | 18m | 20m | **20m** | 20m | 20m |
| Totem radius | 30m | 50m | **76m** | 151m | 250m |
| — sabotage takes | 1.2 min | 2.0 min | **3.0 min** | 6.0 min | 10.0 min |
| Snitch: exact / wide | 25/150m | 67/400m | **100/600m** | 200/1200m | 200/1200m |
| Head start | 2.1 min | 5.7 min | **8.5 min** | 17 min | 18 min |
| *(walk across the map)* | *3 min* | *8 min* | *12 min* | *24 min* | *40 min* |

Two things in that table are worth reading twice.

**A reading gets relatively sharper as the map grows, and that is deliberate.**
On a 2km estate the cost of a ping is not the search at the end, it is the
twenty minutes of walking to get there. Adding a half-hour search on top would
mean a seeker got three leads in a whole game. Travel already does the work.

**The head start stops growing before the map does.** Half the diagonal of a
2km estate is twenty-eight minutes, and nobody stands about for that. It is
capped at a fifth of the round — which is also the honest signal that a 2km
map does not fit in ninety minutes. The lobby prints all of these numbers live
as you draw the boundary, so the host can see what they are choosing before
anyone walks anywhere.

Derived, never quoted twice: **disarm** is always 2.5 tripwires wide, and the
**snitch bands** all come from one number, so a rebalance cannot leave a
disarm that can't clear a wire or bands that overlap. The suite sweeps every
rule across nine map sizes from 100m to 3km and asserts those relationships
hold at all of them.

## Phones

**iOS** needed specific work and got it. Safari's toolbars grow and shrink the
viewport as you scroll, which used to leave the action bar under the home
indicator half the time — the layout is on `100dvh` now, with
`-webkit-fill-available` behind it for iOS 15, and the HUD and action bar carry
`env(safe-area-inset-*)` padding so nothing hides behind the notch or the home
bar. Every control is `touch-action: manipulation`, which kills the 300ms tap
delay and double-tap-to-zoom; rubber-band scrolling and the grey tap flash are
off.

The app also takes a **screen wake lock** from the same tap that asks for
location — both have to come from a gesture on iOS — and retakes it when you
come back from the lock screen, so the phone stops sleeping mid-game. Add it
to the home screen (Share → Add to Home Screen) and it runs without Safari's
chrome, which is the only way the map gets the whole display.

The compass needs its own permission on iOS, asked for when you first turn it
on, and reads `webkitCompassHeading` where it exists — that is a true heading,
unlike the `alpha` everyone else reports, which counts the other way round.

## The conductor

Some rules belong to the game rather than to a player — releasing the seekers
when hiding time is up, greying out a phone that has gone dark, ending the
game when the last hider is found. They have to run on exactly one client or
they fire once per player.

They used to run on the host's, which made the host a single point of failure.
Simulation found it twice over:

- A host who **quits or panics** stops ticking, because the tick returns early
  for anyone who is not active. Every hider could be captured and the game
  would never end.
- A host who **closes their phone during hiding time** stops the hiding clock.
  The seekers are never released and nobody can do anything at all.

The job is elected now rather than assigned. Every client picks the same
player because every client is reading the same state: the host if they are
still playing and still reporting, otherwise the lowest id among those who
are. Nothing in it is a host *privilege* — pausing, ending early and
reinstating people still are, and stay on the host's menu.

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

- The tab must stay in the foreground while you are playing — backgrounding
  pauses GPS updates on most phones. That is a handled state rather than a
  silent failure: the game notices the gap, marks what everyone knows about
  you as stale, and charges you for it. See
  [Closing your phone](#closing-your-phone).
- The screen staying on is now mostly handled too. The app takes a **screen
  wake lock** (iOS 16.4+, Android Chrome) from the same tap that asks for
  location — both have to come from a gesture — and retakes it when you come
  back from the lock screen. On anything older, set auto-lock to Never.
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
