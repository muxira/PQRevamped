# CHANGES.md — Diff vs upstream Party Quiz companion

This fork re-packs the **upstream `partyquiz.club` companion (downloaded 2026-09-05)** with PQRevamped QoL additions. The companion core (WebSocket protocol, lobby, scoring, auction, questions, themes, teams) is byte-for-byte upstream behaviour except where noted below.

## Upstream baseline (snapshot 2026-09-05)

**24 files** pulled from `https://partyquiz.club/core/templates/...`:

| File | Size | Notes |
|---|---|---|
| `core/templates/game.html` | 43.6 KB | Mustache `{{key}}` templates, no `<select>` switcher |
| `css/{reset,pwa,input,normalize,index,styles,popup,mobile-ux,pq-tokens,pq-components,pq-screens}.css` | 12 → 56 KB | Includes new design-system `pq-tokens.css` (theme vars) + `pq-components.css` + `pq-screens.css` |
| `js/{i18n,avatars_list,avatars,commands,jquery_min,main,selection,utils,emoji}.js` | 0.6 → 161 KB | `main.js` grew from 111 KB to 161 KB (theme, reconnect, bid-stepper, celebrations) |
| `assets/party_quiz_logo_wordmark.png` | 71 KB | identical |
| `localized/<18 langs>/lang.json` | 7.6 → 11.1 KB each | English adds 11 new keys (theme_switch, mm_game_is_full, mm_host_is_not_connected, reconnect_retry, your_place, …) |
| `favicon.ico` | 4.3 KB | identical |

## Renames forced by upstream

- `jquery.min.js` → `jquery_min.js` (upstream `<script src="./js/jquery_min.js?v=7">`). We keep the upstream name and drop the dotted one.

## New files (PQRevamped unique)

- `client/core/templates/js/custom_avatar_3d.js` (~24 KB) — **3D Try-On** module: Three.js `0.160.0`, `OBJLoader`, `OrbitControls`. Loads `Body.obj`, mirrors 2D payload (`Scale`, `OffsetX/Y`, `Rotation`, `TilingX/Y`) onto `THREE.Texture` via `repeat = Tiling / (Scale * 1.5)`, `rotation` centred at `(0.5, 0.5)`. Calibration: `TEXTURE_FLIP_Y = true` (Three.js default; flip once if real test image is upside-down). Graceful degrade on WebGL-unavailable. Tab switching preserves state.
- `client/core/templates/css/custom_avatar_3d.css` — tab strip `.ca-tabs`, `.ca-view` containers, `.ca-3d-status`. Uses upstream `--pq-*` tokens, no hard-coded colours.
- `client/assets/models/Body.obj` — reference mesh.
- `client/assets/models/Body.placeholder.obj` — fallback.
- `client/assets/custom_avatar_background.png` — local copy for canvas-CORS bypass.
- `client/core/templates/video-camera.png` — host video button.

## Modified upstream files (PQRevamped patches)

### `core/templates/game.html`

- Added `<link>` for `css/custom_avatar_3d.css` (kept last so our rules win the cascade).
- Added `<script type="importmap">` for `three@0.160.0` ESM CDN.
- Added 3D Try-On tab markup: `<div class="ca-tabs">` with `#ca_tab_flat` / `#ca_tab_3d`, and `#ca_flat_view` / `#ca_3d_container` containers inside `custom_avatar_panel`. Original `custom_avatar_preview` canvas preserved (Flat view keeps its id so `avatars.js` gestures are untouched).
- Added `<script type="module" src="js/custom_avatar_3d.js?v=1">` after `avatars.js`.
- Added `<select id="lang_switcher">` with 18 options in `header.pq-header` (between connection-dot and theme-toggle). `onchange="i18n.setLanguage(this.value)"` — no-reload.
- Added `<button id="final_bid_all_in" class="all-in-btn">` inside `final_bid_player_group` next to `final_bid_button`, wrapped in `<div class="final-bid-actions">`.
- Added leave-confirm modal: `#leave_confirm_overlay` + `#leave_confirm_modal` with `data-i18n` placeholders, before the change-score popup.
- Replaced `color-pink` with `color-purple` on the applause clap button (`#applause_group`).
- Renamed `LeaveGame()` → `RequestLeaveGame()` on the resume-game block.

### `core/templates/js/i18n.js`

- `setLanguage(nextLang)` is **no-reload**: fetches new `lang.json`, swaps `dict`, re-runs `applyTemplates`, dispatches `CustomEvent('pq:languageChanged', { detail: { lang } })`. URL `?lang=` is updated via `history.replaceState`. Upstream implementation called `window.location.href` which broke mid-game (PASS / exit / no-bid counters).
- `lang` is now mutable (`let`) and exposed via getter/setter on `window.i18n`.

### `core/templates/js/commands.js`

- New `FinalRoundAllIn()` — reads `#pq_score_value`, sets `window.finalBidMax`, calls `FinalRoundBid(score)`. Triggers from gold `ВА-БАНК / ALL IN` button.
- New `RequestLeaveGame()`, `CancelLeaveGame()`, `ConfirmLeaveGame()` — open / dismiss / commit the leave-confirm modal. ESC and overlay click both dismiss.

### `core/templates/js/main.js`

- After `var prev = currentState; currentState = stateName;`, the function now also stores `window.currentStateData = data`. This is what `pq:languageChanged` re-renders from.
- Added `pqReturnToMainMenuAfterHostLeft(reason)` — called from `onGameEnded` only when `reason === 'host-left'`. Closes WS gracefully (`window.socket.close()` without `onclose` to avoid server-side "disconnect" treatment), closes any open modals (`CloseCustomAvatarModal`, `CancelLeaveGame`, `#popup-overlay`), then re-runs `goTo('ENTER_ID')` after 1.5 s as belt-and-suspenders for the case where a stray modal was blocking ENTER_ID. **No reload** — the player sees the game-over state for ~1.5 s, then returns to the Game-ID entry screen.
- Added `document.addEventListener('pq:languageChanged', …)` listener — re-runs `goTo(currentState, currentStateData)`, syncs the `<select>` to the new lang, primes it once via `i18n.ready.then`.
- Added `bindEnterToSend` IIFE — wires `keydown` Enter on `player_answer_input`, `final_answer_input`, `final_bid_input`, `number_guess_input`, `revealing_clues_input` to send the value (upstream only had it on QR-password and join-game).

### `core/templates/css/index.css`

Added block (last lines):
- `.lang-switcher` — top-left dropdown, themed.
- `.final-bid-actions` — flex row, stacks on `<= 360px`.
- `.all-in-btn` — gold theme using `var(--pq-gold)` / `var(--pq-gold-ink)`.
- `.leave-confirm-text`, `.leave-confirm-actions` — modal layout.
- `.color-purple` — clap-button family.

### `localized/<lang>/lang.json` (×18)

Each `lang.json` now has **4 added keys**:
- `all_in` — "ALL IN" / "ВА-БАНК" / localized equivalents.
- `cancel` — "Cancel" / "Отмена".
- `leave_confirm_title` — "Leave game?" / "Покинуть игру?".
- `leave_confirm_text` — "Are you sure? Leaving mid-round may be counted as a pass." / localized.

Total per file: 184 → 188 keys. UTF-8 without BOM (PowerShell had d一个问题 with double-encoding кириллицы; validated with `py -c json.load(open(...))` for all 18).

## Hard constraints verified

- WebSocket protocol compatible with upstream: all commands sent by `commands.js` (`FinalRoundBid`, `MakeBid`, `PlayerAnswer`, `MultipleChoiceVote`, etc.) match upstream signatures. No new server-side dependency.
- No `.dll`, Unity `AssetBundle`, or paid game assets — only `Body.obj` reference mesh.
- All upstream assets fetched live from `https://partyquiz.club/` (logo, sprites, localized text). Local copies only for canvas-CORS items (`custom_avatar_background.png`) and pre-bundled lang.json files.
- Three.js loaded from pinned `unpkg.com` CDN ESM (no bundler, no build step).

## Calibration (manual one-time check)

- `TEXTURE_FLIP_Y` in `custom_avatar_3d.js` — flip to `false` if a test image with "TOP" appears upside-down vs in-game.
- `DEFAULT_CAMERA_POSE` in `custom_avatar_3d.js` — adjust framing after one real in-game screenshot.

## Known minor differences from the pre-migration PQRevamped

- Upstream's `theme_switch` token is used for the theme-toggle `aria-label` / `title`; the visible button is rendered by upstream's `ToggleTheme` (we did not fork the toggle).
- Upstream `pq-tokens.css` defines dark-theme tokens under `html[data-pq-theme="night"]` — our local CSS uses these via `var(--pq-…)` so the dark/light switch is theme-aware without us re-declaring the palette.

## Smoke test

```bash
cd client
py -m http.server 8000
# open http://localhost:8000/core/templates/game.html
```

All assets (CSS / JS / 18 lang.json / images / `Body.obj`) return HTTP 200. `game.html` final size: 48.9 KB (upstream 43.6 KB + our patches).

## Post-port cleanup

- Removed the browser-export working folder (`UpdatedPartyQUIZWebsite/`: saved page, `.har` dump, archive copy) — everything was ported into `client/`, nothing referenced it. `*.har` added to `.gitignore` so dumps never get committed.
- Removed `client/assets/fonts/play.regular.ttf` (unreferenced, non-redistributable); `index.css` falls back to `local("Arial")`.
- Stock avatar art lives in `client/avatars/*.png`; `video-camera.png` moved to `client/assets/`; jQuery keeps the upstream `jquery_min.js` name.