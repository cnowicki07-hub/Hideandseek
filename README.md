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

## 1. Firebase — done

The project `hide-and-seek-dc4ac` is wired into `js/firebase-config.js`.
Nothing more to do there.

The one remaining step, if it hasn't been done: **Build → Firestore
Database → Create database → test mode**. Registering the web app does not
create the database, and without it every read and write fails.

## 2. Test locally

```
npx serve .
```

Open the printed URL on your phone (same wifi as your laptop), or open it
in a desktop browser for a first pass.

### Playing offline, on one machine

`?mock=1` swaps Firestore for an in-memory stand-in (`js/devmode.js`) that
shares state between **tabs of the same browser** — a whole game walked
through by yourself, without touching the live project. Serve the folder,
then open one tab per player:

```
http://localhost:3000/?mock=1&pid=p0&sim=51.5074,-0.1278     <- host
http://localhost:3000/?mock=1&pid=p1&sim=51.5077,-0.1275
http://localhost:3000/?mock=1&pid=p2&sim=51.5071,-0.1281
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

Drop `?mock=1` and the same tabs talk to the real Firestore project, which
is how you check two actual phones can see each other.

### Quota check

```
node test/quota.mjs
```

Walks five simulated players for a minute, counts Firestore writes and
projects them onto a 90-minute game. Worth re-running after any change to
how often the client writes — see [Staying inside the free
tier](#staying-inside-the-free-tier).

### Automated check

```
npm i -D playwright && npx playwright install chromium
node test/e2e.mjs
```

Runs against the offline stand-in, so it never writes to the live project.
Drives a full five-player game and asserts 71 rules from the design doc:
ping cadence and uncertainty growth, every power's effect as seen from the
*other* player's client, totem scaling and sabotage accrual/decay, hunt
bearings, snitch fidelity bands, boundary breach, capture, scoring. Worth
re-running after any change to `js/config.js`.

## 3. Deploy (GitHub + Netlify)

Push, then in Netlify: **Add new site → Import from Git**, pick the repo,
leave build command blank, publish directory `/`. Netlify gives you a live
URL — that's what everyone opens on Friday. Redeploys on every push.

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

`js/config.js` is the single source of truth, ported from design doc
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
      tight in practice, raise `baseAccuracyRadiusM` in `js/config.js`
      (it widens the sabotage ring with it)

## Staying inside the free tier

Firestore's free Spark plan allows 20,000 writes and 50,000 reads a day.
That sounds like plenty and is not: the first version wrote a player's
position on every GPS fix, roughly once a second each, which measured at
**~88,000 writes for a single 90-minute five-player game**. It would have
stopped working about twenty minutes in, mid-game, on a Friday evening.

Position writes are now throttled on movement (`CONFIG.sync`): write at
most every 5s, and only if the player has actually moved 5m, with a
keepalive every 30s regardless. This is self-correcting rather than a
straight sample-rate cut — a position only goes stale while someone is
standing still, and a stationary player's last position is still correct.
A seeker's continuous broadcast now rides along in the same write instead
of costing a second one.

That brings a full game to roughly **5,100 writes and an estimated 25,000
reads** — inside the free tier with room to spare. `node test/quota.mjs`
measures it.

If you ever do go over, the fix is to enable the Blaze (pay-as-you-go)
plan: at these volumes the bill is a few pence, and it removes the cliff
where the game simply stops mid-round.

## Security note

The Firebase config in `js/firebase-config.js` is not a secret — it
identifies the project and is designed to sit in the browser where anyone
can read it. It is in the deployed page whether or not the repo is public,
so hiding the repo would not hide it.

What actually guards the data is Firestore security rules, and in test
mode there are none: anyone who has that config can read and write any
document. Since this repo is public, that means anyone who finds it, not
just anyone with the game link. For a one-evening game among five friends
the worst case is someone vandalising a game in progress, which is why the
build brief traded it away deliberately.

Worth doing after Friday: delete the Firebase project, or write real rules.
Test mode also expires on its own after 30 days.

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
