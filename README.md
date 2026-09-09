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

## 1. Set up Firebase (~5 min, one-time, your job not the build's)

1. Go to console.firebase.google.com → Create a project (any name, no
   need to enable Analytics).
2. In the project, click the **Web** icon (`</>`) to add a web app.
3. Copy the `firebaseConfig` object it shows you.
4. Paste it into `js/firebase-config.js`, replacing the placeholder.
5. In the left sidebar: **Build → Firestore Database → Create database**.
   Choose **test mode** (fine for a short friendly game — see Security
   note below).

Until you do this the app runs against an offline stand-in (below), so
everything works on one machine but players on different phones can't see
each other.

## 2. Test locally

```
npx serve .
```

Open the printed URL on your phone (same wifi as your laptop), or open it
in a desktop browser for a first pass.

### Playing without Firebase

While `js/firebase-config.js` still says `REPLACE_ME`, the app uses an
in-memory stand-in for Firestore (`js/devmode.js`) that shares state
between **tabs of the same browser**. That is enough to walk through a
whole game by yourself:

- open five tabs, each with `?pid=p0` … `?pid=p4` so they count as
  different players
- add `&sim=51.5074,-0.1278` to give a tab a fake GPS position, then move
  it from the console with `__sim.moveBy(eastMetres, northMetres)`

Add `?mock=1` to force the stand-in even after real credentials are in —
useful for rehearsing without touching the live game.

### Automated check

```
npm i -D playwright && npx playwright install chromium
node test/e2e.mjs
```

Drives a full five-player game and asserts 69 rules from the design doc:
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

## Security note

Firestore is in test mode, meaning anyone with the project's public config
(which is embedded in the page, always visible) can read and write any
document while test mode is on. For five friends running a one-off game
this is a non-issue. Test mode expires after 30 days by default — if this
is still running past that, either extend it in the Firebase console or
write real security rules. Don't reuse this setup for anything with
strangers in it.

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
