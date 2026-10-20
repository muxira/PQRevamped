## What changed

<!-- One paragraph. What a player or a maintainer notices. -->

## Why

<!-- The moment in a game, the bug, or the upstream change this responds to. -->

## Where

- [ ] Fork-only files (`revamped.js`, `custom_avatar_3d.js`, `pq-revamped.css`)
- [ ] Marked patch to an upstream file (every edit has a `PQRevamped:` comment)
- [ ] Upstream sync (ported first, patched second — separate commits)

## Checks

- [ ] `python3 scripts/check.py` is green
- [ ] Tried on a phone (model/OS: …)
- [ ] Tried in both `studio` and `night` themes (if UI)
- [ ] No new network dependency without a pinned version
