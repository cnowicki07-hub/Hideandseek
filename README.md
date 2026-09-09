# Hide & Seek — MVP

Web app, no install required. Players open a link on their phone, screen
stays on and in hand for the whole game (this is what avoids needing a
native app — see the design doc for why).

## Status

**Tier 1 — done:** host/join flow, role assignment, live position sync,
hider ping cadence with growing uncertainty circles, seeker continuous
broadcast, code-based capture, charge economy (regen/spend/cooldown),
game timer.

**Tier 2 — next:** the actual power effects (Smear, Go Quiet, Decoy,
Scan, Probe, etc.) currently have costs defined in `js/config.js` but no
buttons or effect logic wired up yet. That's the next thing to build.

**Not started:** Totems + sabotage, Hunt + Snitch, Signposts, boundary
enforcement, panic/withdraw, host pause/end controls.

## 1. Set up Firebase (~5 min, one-time)

1. Go to console.firebase.google.com → Create a project (any name, no
   need to enable Analytics).
2. In the project, click the **Web** icon (`</>`) to add a web app.
3. Copy the `firebaseConfig` object it shows you.
4. Paste it into `js/firebase-config.js`, replacing the placeholder.
5. In the left sidebar: **Build → Firestore Database → Create database**.
   Choose **test mode** (fine for a short friendly game — see Security
   note below).

## 2. Test locally

Any static file server works, e.g. from this folder:

```
npx serve .
```

Open the printed URL on your phone (same wifi/network as your laptop),
or just open `index.html` directly in a desktop browser for a first
pass — GPS won't have a real fix on desktop, but the join/lobby/role
flow can be checked without it.

## 3. Deploy (GitHub + Netlify)

```
git add -A
git commit -m "MVP tier 1"
```

Push to a new GitHub repo, then in Netlify: **Add new site → Import
from Git**, pick the repo, leave build command blank, publish
directory `/`. Netlify will give you a live URL — that's what everyone
opens on their phones on Friday.

Redeploys on every push, so Tier 2/3/4 additions just need a `git push`
to go live again.

## Security note

Firestore is in test mode, meaning anyone with the project's public
config (which is embedded in the page, always visible) can read and
write any document while test mode is on. For five friends running a
one-off game this is a non-issue. Test mode expires after 30 days by
default — if this is still running past that, either extend it in the
Firebase console or write real security rules. Don't reuse this setup
for anything with strangers in it.

## Known limitations of this build

- Screen must stay on and the tab must stay in the foreground the
  whole game — backgrounding will pause GPS updates on most phones.
- No cheat-prevention: a technically-minded player could open dev
  tools and read/write game state directly. Fine for trusted friends,
  not fine beyond that.
- Capture code lookup assumes capture codes are unique within a game
  (they will be in practice at 5 players, but isn't formally enforced).
