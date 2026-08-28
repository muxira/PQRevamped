# PQRevamped — Party Quiz Companion (QOL Edition)

> Unofficial browser companion for [Party Quiz](https://partyquiz.club) — Jackbox-style party game where phones join via browser. This is a static fork focused on quality-of-life improvements without touching core gameplay logic.

**Live:** `https://muxira.github.io/PQRevamped/client/core/templates/game.html` (root `index.html` redirects there)  
**Upstream:** `https://partyquiz.club`

---

## What is this?

Party Quiz is a multiplayer quiz game where the host runs the game on PC and players join from their phones through a web companion. This repo is a **port of the browser companion** with QOL enhancements — most notably a live **3D Try-On** preview for custom avatars, gold **All-In**, full i18n and safer UX.

No game binaries, no Unity AssetBundles, no server code — just the HTML/CSS/JS companion made hostable anywhere (GitHub Pages, any static host).

## Features / QOL Changes

### 3D Try-On for Custom Avatars
The main addition. Inside the custom avatar modal you get two tabs:

- **Flat** — original 2D canvas preview (drag to pan, scroll to zoom, Ctrl+drag to rotate)
- **3D Try-On** — real-time preview on the `Body.obj` reference mesh with the uploaded PNG projected exactly as in-game

Why it matters: `TilingX / TilingY` repetition was previously invisible (cropped to a face oval). Now you see how the texture wraps across the whole body silhouette.

- Drag to orbit, wheel/pinch to zoom (clamped distance + polar angle, no clipping)
- Both views share the same payload — `Scale / OffsetX / OffsetY / Rotation / TilingX / TilingY` — gestures in either view update both previews live, tab switching preserves state
- WebGL check: if unavailable, the 3D tab auto-hides and flat-only flow remains

Texture mapping (mirrors `avatars.js`):
```
texture.wrapS/T = RepeatWrapping
effectiveScale  = Scale * 1.5  // PREVIEW_BASE_ZOOM
texture.repeat  = Tiling / effectiveScale
texture.offset  = (OffsetX, OffsetY)
texture.rotation = Rotation (center 0.5, 0.5)
texture.flipY   = TEXTURE_FLIP_Y  // default true, see Calibration
```

### Final Bidding — Gold All-In
- New gold **ВА-БАНК / ALL IN** button in `final_bid_player_group` (`game.html:455`, `commands.js:414`, `index.css:866`) — sets `window.finalBidMax` (`YOUR SCORE: MaxBid`) and sends `FinalRoundBid` in one tap. Placed side-by-side with `Ставка` via `.final-bid-actions` flex row (responsive). `Enter` in the bid input sends the custom bid (not All-In).

### Language — 18 Locales, No-Reload Switch
- Original had only `english/russian` locally; now **18** locales mirrored from `partyquiz.club` in `client/localized/*/lang.json` (EN/RU/ES/ES-LA/DE/PT/FR/PL/IT/UK/TR/ZH/AR/CS/KK/SV/KO/JA).
- Top-left dropdown `#lang_switcher` (`game.html:34`, `index.css:843`) — `onchange="i18n.setLanguage"` uses `history.replaceState` + `fetchJson` + `applyDataI18n` (`i18n.js:151`) — no `location.reload`, no `WebSocket` disconnect, so changing language mid-bid/answer/applause no longer counts as **PASS**. Titles/under-titles re-render from `lastStateData` (`main.js:251`).
- All hardcoded RU strings in `game.html` converted to `data-i18n="key"` / `data-i18n-placeholder` (115 keys) — fully dynamic. Added `all_in/cancel/leave_confirm_text` for all 18 locales. Fixed double `UTF-8` BOM that caused `ÐÑÐºÑÐ¸Ð¾Ð½` krakozyabry.

### UX Polish
- **Enter to send:** `final_bid`, `final_answer`, `number_guess`, `revealing_clues`, `player_answer` inputs now handle `Enter` (`game.html:382,455` etc.) — custom bid/answer sent.
- **Purple Clap:** `applause_group` clap button `color-pink` → `color-purple` like answer buttons (`game.html:385`).
- **Leave fool-protection:** `Покинуть игру` now shows confirmation modal (`game.html:758`, `commands.js:60`) with `Отмена` / `Покинуть` (`leave_confirm_text`) + `ESC` / overlay click to cancel — no accidental leaves in `RESUME_GAME` / `APPLAUSE`.

### Everything else stays identical
Lobby, team management, WebSocket flow (`wss://partyquiz.club:3012`), question/answer, auction, scoring — **byte-for-byte behavior** is preserved except the QOL above, see [`CHANGES.md`](CHANGES.md).

### Static-hosting ready
- No build step, no bundler, no secrets
- Vanilla JS + Three.js via pinned CDN ESM (`three@0.160.0`)
- All assets use relative paths, works from a project Pages URL (`/<repo>/...`)
- Config lives in one place: `client/core/templates/js/config.js` → `PQ_ORIGIN = 'https://partyquiz.club'`

## Tech Stack

- Vanilla JS / HTML / CSS (ported from original companion)
- Three.js `0.160.0` via importmap (`three` + `three/addons/`)
- `OBJLoader` + `OrbitControls` for the 3D preview
- `i18n.js` with `data-i18n` dynamic switching (no reload)
- GitHub Pages (static deploy via `.github/workflows/pages.yml` on `master`/`main`)

## Project Structure

```
/
├── index.html                              # redirect → game.html
├── favicon.ico
├── client/
│   ├── assets/
│   │   ├── custom_avatar_background.png    # local copy (canvas CORS, see below)
│   │   └── models/
│   │       ├── Body.obj                    # reference mesh for 3D preview
│   │       └── Body.placeholder.obj        # fallback if Body.obj not cleared
│   ├── localized/
│   │   ├── arabic/ czech/ english/ french/ german/ italian/ japanese/ kazakh/
│   │   │   korean/ polish/ portuguese/ russian/ simplifiedchinese/ spanish/
│   │   │   spanishlatinamerica/ swedish/ turkish/ ukrainian/ → lang.json (18 locales)
│   └── core/templates/
│       ├── game.html                       # main companion page (data-i18n)
│       ├── css/
│       │   ├── index.css / styles.css / ...
│       │   └── custom_avatar_3d.css        # tabs + 3D container
│       ├── js/
│       │   ├── config.js                   # PQ_ORIGIN constant
│       │   ├── i18n.js                     # 18 langs, dynamic switch
│       │   ├── avatars.js                  # avatar + custom avatar logic
│       │   ├── custom_avatar_3d.js         # 3D Try-On module (~300 lines)
│       │   ├── commands.js / main.js / ... # AllIn, leave confirm, Enter handlers, lang events
│       │   └── jquery.min.js
│       ├── favicon.ico
│       └── video-camera.png
├── .github/workflows/pages.yml             # deploys on master/main
├── CHANGES.md
└── LICENSE
```

## Quick Start

### Local preview
```bash
# from repo root
python -m http.server 8000
# open http://localhost:8000/client/core/templates/game.html
# or http://localhost:8000/ (redirects automatically)
```

Any static server works — `npx serve`, `php -S`, VS Code Live Server, etc.

### Joining a real game
1. Host starts a Party Quiz session on PC (gives you a Game ID + optional password)
2. Open the companion URL above, enter Game ID / password, pick role (Host / Player)
3. Pick avatar → for custom avatar click **Кастомизировать** → upload PNG/JPG → tweak with pan/zoom/rotate, check 3D tab → **Подтвердить**

> **WebSocket override:** `main.js` defaults to `partyquiz.club` (`wss://partyquiz.club:3012`) from any domain. To point elsewhere add `?server=partyquiz.club` (or `stage.partyquiz.club`) to the URL. Still requires a real host `.exe` with a matching game ID — the WebSocket alone doesn't create a lobby.
> **Language:** add `?lang=russian` (or any of 18) or use the top-left dropdown — choice is stored in `localStorage pq_lang` and survives reload.

## Configuration

Single constant in `client/core/templates/js/config.js:2`:

```js
const PQ_ORIGIN = 'https://partyquiz.club';
window.PQ_ORIGIN = PQ_ORIGIN;
```

This fork hosts only HTML/CSS/JS we wrote. Fonts, sprites, avatar art and i18n are fetched live from `PQ_ORIGIN`:

- `avatars.js:130` → `PQ_ORIGIN + "/avatars/" + file`
- `i18n.js:48` → `PQ_ORIGIN + "/localized/<lang>/lang.json"` (falls back to local, see CORS)
- `main.js:939` → `PQ_ORIGIN + "/pqlog?bot="`
- `index.css` → `PQ_ORIGIN + "/assets/..."` (logo, spritesheets)
- `main.js:1099` → WebSocket host `partyquiz.club`

## Assets & CORS Notes

Verified `2026-08-24/25` via `curl -I` — most `partyquiz.club` static assets **don't send** `Access-Control-Allow-Origin`:

- Plain `<img>` / CSS `url()` loads are fine (logo, sprites, avatars)
- Two cases need same-origin, so local copies are kept:

| Asset | Why local |
|-------|-----------|
| `client/assets/custom_avatar_background.png` (20714 bytes) | `canvas.toDataURL()` + Three.js texture upload would taint canvas if cross-origin |
| `client/localized/*/lang.json` (18 locales, ~7-16 KB each) | `fetch()` for i18n JSON is blocked by CORS (double UTF-8 fix) |
| `play.regular.ttf` (font) | blocked by CORS (`downloadable font: cross-site access not allowed`) — now `local("Arial")` fallback in `index.css:50`, no binary shipped |

## Calibration (one-time manual check)

Two constants at the top of `custom_avatar_3d.js` need a live in-game comparison:

- **`TEXTURE_FLIP_Y`** (`true` by default) — Unity vs Three.js V-axis. Upload an asymmetric image with text "TOP" and compare preview vs in-game screenshot. Flip to `false` if upside-down.
- **`DEFAULT_CAMERA_POSE`** (`position`, `target`, `fov`) — the mesh is a T-pose, but in-game may be arms-down. Default frames torso+head. Tweak framing after one real screenshot if needed.

Document any fix in `CHANGES.md`.

## Hosting on GitHub Pages

**Option A — Actions (included):**
Push to `master` or `main` → workflow `.github/workflows/pages.yml` publishes the repo root.

**Option B — Branch deploy:**
`Settings → Pages → Deploy from branch → Branch: master / root`

No build step — the site works from `https://<user>.github.io/<repo>/client/core/templates/game.html` thanks to relative paths.

## What changed vs original?

See [`CHANGES.md`](CHANGES.md) for the full, reviewable diff:

- **New:** `custom_avatar_3d.js`, `custom_avatar_3d.css`, `Body.obj` (+ placeholder), `index.html` redirect, `pages.yml`, 16 new `localized/*/lang.json`, `leave_confirm` modal
- **Modified:** `game.html` — `data-i18n` (115 keys), `#lang_switcher` (18 opts), `#ca_flat_view` / `#ca_3d_view`, `final_bid` gold All-In + `Enter` handlers, `applause` purple + leave confirm, importmap; `i18n.js` — dynamic switch without reload; `commands.js`/`main.js` — AllIn, leave confirm, `pq:languageChanged`; `index.css` — gold/purple/final-bid-actions/lang-switcher
- **Untouched:** `avatars.js` gestures/payload (except new 3D), `main.js` lobby/WebSocket/scoring (except lang events)

Hard constraint verified: **no `.dll`, no Unity AssetBundles** — only `Body.obj` as a reference mesh.

## Courtesy Note

This companion hits the real `partyquiz.club` infrastructure (assets, WebSocket, `/pqlog`). Fine for personal / friends use — please don't stress-test or automate mass traffic.

## License

[MIT](LICENSE) — Copyright (c) 2026 muxira (Artem Muzyra). See `LICENSE` for details.

> `client/assets/models/Body.obj` — ensure you have rights to redistribute before making the repo public. If not confirmed, keep private or deploy with `Body.placeholder.obj`. See `CHANGES.md` / old README notes for context.

## Disclaimer

Unofficial, personal fork. Not affiliated with or endorsed by Party Quiz. No game code or paid assets are redistributed beyond the documented `Body.obj` reference mesh and the local copies noted above.

---

**QOL wins in this fork:** 18-language dynamic switch (no PASS), gold All-In side-by-side, purple clap + leave fool-protection, Enter to send bids/answers, see-it-before-you-send 3D preview, zero-build static hosting, and a tiny auditable diff.
