# Contributing

Thanks for poking at this. The repo is a small static bundle, so the barrier is low — but
it does have one hard rule: **keep the upstream/fork boundary clean.**

## The one rule

Upstream code stays as close to the original as possible, because the next sync is a diff.

| Where | What belongs there |
|---|---|
| `core/templates/js/revamped.js` | Settings sheet, language glue, mobile helpers, leave confirm |
| `core/templates/js/custom_avatar_3d.js` | The 3D Try-On module |
| `core/templates/css/pq-revamped.css` | All of our styling |
| `core/templates/game.html`, `js/i18n.js`, `js/main.js` | Small patches, always prefixed with a `PQRevamped:` comment explaining *why* |

If a change touches more than those six files, check first whether it can live in
`revamped.js` instead. If it cannot, say so in the PR.

## Local loop

```bash
python3 scripts/preview.py --lan     # serve; open the printed URL on a phone
python3 scripts/check.py             # must be green before you push
```

There is no bundler and no `npm install`. If a change needs a build step, it probably
belongs in a different project.

## Testing on a phone (please do)

Most of this fork exists for phones, so a desktop resize is not enough:

1. `python3 scripts/preview.py --lan`
2. Open `http://<lan-ip>:8000/core/templates/game.html` on a phone.
3. Bump through: language sheet → avatar editor (2D and 3D, pinch) → join screen →
   answer field (keyboard must not cover it) → settings while a modal is open.

Note what you tested in the PR — model and OS are useful ("iPhone 13, Safari 17",
"Pixel 7, Chrome 129").

## Syncing with upstream

```bash
python3 scripts/fetch-upstream.py --out _upstream
diff -ru _upstream/core/templates core/templates
```

Port upstream changes first as *upstream* files, then re-apply our patches on top. Never
mix the two in one commit — a reviewer must be able to see which side a line came from.
New keys go into `localized/<locale>/lang.json` via `scripts/sync-i18n.py`.

## Adding a language string

1. Add the English text to `REVAMPED_KEYS` in `scripts/sync-i18n.py`.
2. Add translations to `TRANSLATIONS` (missing locales fall back to English on purpose).
3. `python3 scripts/sync-i18n.py && python3 scripts/check.py`.

## Code style

- Vanilla ES2019+; no frameworks, no build-time transforms.
- 4-space indent, single quotes in JS, `const`/`let`, no `var` in new code.
- Prefer `textContent` over `innerHTML`; never inject a translation with `innerHTML`.
- Guard every optional API (`navigator.vibrate`, `wakeLock`, `visualViewport`) — an old
  webview should lose a feature, not the screen.
- Comments explain *why*, not *what*.

## Pull requests

- One topic per PR, conventional-commit subject (`feat:`, `fix:`, `chore:`, `docs:`).
- `python3 scripts/check.py` must pass; CI runs it plus `node --check` on every script.
- Screenshots or a short screen recording for UI changes (phone + desktop if it matters).
- Bug reports: browser, OS, game state, and whether the official client behaves the same.

By contributing you agree the code lands under the repo's [MIT license](LICENSE).
