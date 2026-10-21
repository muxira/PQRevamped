# Changelog

All notable changes to this fork. Upstream changes are described in terms of what a
player or a maintainer notices, not as a file-by-file dump.

The short version: `2.0.0` re-syncs the whole client with the live site and rebuilds the
fork-owned layer on top of it; `1.x` was the first port, which shipped the 2D-only editor
plus a 3D preview that had to be rewritten for phones.

---

## 2.0.0 — 2026-10-20

Synced with `partyquiz.club` as it was served on 2026-10-20 (snapshot captured with
`scripts/fetch-upstream.py`, 80 files).

### Upstream features now included

- **Bonus system** — `bonus.js`, `bonus-lootbox.js`, `pq-bonus.css`: lootbox reel, hint,
  joker, shield, x-ray and pick-a-victim cards, the tray, hints and announcements.
- **Appeals** — "I'm right" button, vote screen with avatars, countdown and results.
- **Returning players** — `<name> is already in the game` offer, waiting screen, host
  approval list, and the "your profile moved to another device" notice.
- **Fast-forward** — one button that reacts to press-and-hold with a speed multiplier and
  a `pq-ff-plaque`, replacing the old `skip_sequence` / `skip_displaying` pair.
- **Manage players** — the score table became a popup with kick and ± point stepper.
- **Reconnect terminal** — a failed reconnect now offers *Retry / Leave* instead of
  reloading forever.
- **Design system** — `pq-tokens`, `pq-components`, `pq-screens`, self-hosted
  `party-quiz-sans` in woff2, `studio` / `night` themes with a header toggle.
- **Accessibility pass** — buttons instead of clickable `<div>`s, `aria-label`s on icon
  buttons, dialog roles on modals, keyboard support for buzzers.
- Removed upstream: jQuery, `config.js` (never present), `skip_*` screens, `__proto__`
  era shims. The fork's copies of those files are gone too.

### Added by this fork

- **Settings sheet** (`revamped.js`, `pq-revamped.css`) — 18-language grid, appearance
  (auto / light / dark), haptics, keep-screen-awake. Swipe-down and hardware Back close
  it, focus is trapped while it is open, and it works from any screen.
- **3D Try-On, rewritten** (`custom_avatar_3d.js`) — Three.js is imported on demand,
  frames are drawn only when something changes, device pixel ratio is capped at 2, the
  canvas tracks its container with a `ResizeObserver`, pinch/orbit gestures are bounded,
  and a reset-camera button, loading state and per-error messages were added. No WebGL,
  blocked CDN or missing model each degrade to a message instead of an empty circle.
- **Language switching without a reload** (`i18n.js`) — dictionaries are merged over
  English, templates and `data-i18n` attributes are replayed from their saved source,
  `dir`/`lang` follow the language, and `main.js` repaints the current screen from its
  last state. Upstream reloaded the page, which dropped the socket mid-round.
- **Leave confirmation** (`revamped.js` → upstream `pqConfirm`) — leaving during a round
  asks first.
- **Last game ID memory** — the join field is pre-filled from `localStorage`.
- **PWA** — `manifest.webmanifest`, maskable icons, and `sw.js`: network-first pages,
  stale-while-revalidate assets keyed without the `?v=` buster. `?nosw=1` opts out.
- **Mobile layer** — safe-area padding, `dvh` sizing, `--pq-vvh` / `--pq-keyboard`
  variables, visual-viewport tracking, 16 px minimum field font, pinch-zoom re-enabled,
  compact landscape layout, 44 px tap targets.
- **Socket host fix** (`main.js`) — a static host now connects to
  `wss://partyquiz.club:3012` instead of `wss://<page-host>:3012`.
- **Repo layout** now mirrors the upstream tree (`core/`, `assets/`, `avatars/`,
  `localized/` at the root). The old `client/` wrapper is gone — and with it a broken
  `../../assets/…` path that made the footer camera image 404 on GitHub Pages.
- **Preview renderer** (`scripts/render-previews.py`) — draws `docs/screenshots/*.png` with
  Pillow from the shipped tokens, font, avatars and markup order; used by both READMEs.
- **Tooling** — `scripts/preview.py` (LAN-friendly static server with correct MIME types),
  `scripts/check.py` (references, i18n keys, JSON, leftovers), `scripts/sync-i18n.py`
  (dictionary audit + upstream scrape), `scripts/fetch-upstream.py` (snapshot for a diff),
  a CI workflow and a Pages deploy that runs the checks first.

### Removed

- `jquery_min.js`, `config.js`, `Body.placeholder.obj`, the duplicate
  `assets/custom_avatar_background.png`, the stray `localized/lang.json`, and the old
  `custom_avatar_3d.css` (folded into `pq-revamped.css`).

### Fixed

- **Accidentally closing the page lost the game.** Leaving mid-round was only guarded by
  the old dismissible confirm modal, which a closed tab or a phone evicting the tab
  bypassed. A `beforeunload` guard now asks first (it stays silent for an intentional
  leave), and the resume screen is no longer a dead end: it offers *Try again*, which
  re-claims the seat with the same `ResumeGame()` call the bot uses, shows a note when the
  retry goes unanswered, and only reports a lost session after the server says the player
  is gone.
- **The leaderboard flashed for a frame, or never appeared.** `DisplayFinalResult` had
  become a no-op upstream after the podium was removed, so the end-of-game table had
  nowhere to land, and the round table was painted at the moment the screen was switching
  away. Standings now repaint while the result screen *and* the applause screen are up,
  the applause screen carries the final table (gold/silver/bronze rows and medals), and a
  late roster update can no longer wipe it.
- **The avatar circle next to a nickname was sometimes empty.** Avatars are now a circle
  with initials painted immediately plus an image layered on top: it hides the initials on
  `load` and removes itself on `error`, so a slow, blocked or 404 picture leaves readable
  initials instead of a hole (also applied to team rows and custom avatars).
- The camera/screenshot asset in the footer resolved to a non-existent path.
- Arabic no longer inherits the Latin `lang` attribute (`<html lang="ar" dir="rtl">`).
- A `<select>` value in the header could not be styled on iOS; the language picker is now
  a sheet, not a native select.

---

## 1.1.0 — 2026-09-05

- Ported the `2026-09-05` upstream bundle (24 files) into `client/`.
- Added the 18 locale dictionaries, the gold *All-in* button, the purple clap button, the
  leave-confirm modal and Enter-to-send on every input.
- Added the first 3D Try-On prototype (T-pose mesh, always-on render loop, three.js from
  unpkg) and the GitHub Pages workflow.

## 1.0.0 — 2026-08-24

- Initial repo: the companion HTML/CSS/JS, stock avatars, fonts and a redirect
  `index.html`.
