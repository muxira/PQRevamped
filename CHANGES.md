# CHANGES.md — Diff vs original Party Quiz companion export

This fork is intentionally a **short, reviewable diff**. All lobby / team / WebSocket / i18n / question / scoring flows remain unchanged.

## New files
- `client/core/templates/js/custom_avatar_3d.js` — 3D Try-On module (~300 lines):
 - Loads `client/assets/models/Body.obj` via `THREE.OBJLoader` using its baked-in UVs as-is (no regeneration).
 - Creates lit scene (ambient + key light) on transparent/theme-matching background (`--card`, `--border`, `--foreground`, `--primary`).
 - OrbitControls-equivalent: left-drag / one-finger touch to orbit, wheel/pinch to zoom, clamped `minDistance/maxDistance` and `minPolarAngle/maxPolarAngle`.
 - Material: applies `window.customAvatar.dataUrl` as `THREE.Texture` with `RepeatWrapping`; maps `payload.TilingX/Y`, `payload.OffsetX/Y`, `payload.Rotation` (center 0.5,0.5) and folds `payload.Scale` via `effectiveScale = Scale * 1.5` into `repeat = Tiling / effectiveScale` (mirrors `renderCustomAvatarPreview` math).
 - `TEXTURE_FLIP_Y` and `DEFAULT_CAMERA_POSE` exposed as named constants at top (see Calibration below).
 - Live sync: wraps `window.renderCustomAvatarPreview` so both 2D canvas and 3D texture re-render on every drag/wheel/ctrl-drag gesture; single source of truth `window.customAvatar.payload`; switching tabs preserves state.
 - Graceful degrade: if WebGL unavailable, hides the 3D tab and leaves flat-only flow.
 - No face-crop mask, no placeholder geometry — tiling visibly wraps across whole body silhouette as in-game.
- `client/core/templates/css/custom_avatar_3d.css` — tabs (`Flat` / `3D Try-On`), 3D container, status line, theme-aware styling mirroring `.ca-hints`.
- `client/assets/models/Body.obj` — reference mesh (1059 verts, 1864 tris; full-body T-pose, front-projection UVs spanning ~0..1).
- `client/assets/models/Body.placeholder.obj` — generic fallback box if real mesh not yet cleared for public redistribution.
- `README.md`, `CHANGES.md`, `.github/workflows/pages.yml`, `index.html` (redirect), `.gitignore`.

## Modified files
- `client/core/templates/game.html` (was `PARTY QUIZ.html`):
 - Cleaned darkreader-injected styles/attrs from the browser export.
 - Renamed asset refs from `PARTY%20QUIZ_files/*__Jg6.*` to `css/*` / `js/*` / `video-camera.png` (behavior identical, just clean paths).
 - Added `<link>` for `custom_avatar_3d.css` and `<script type="importmap">` for pinned `three@0.160.0` CDN ESM (no bundler).
 - Extended `custom_avatar_modal`: inserted tab bar `#custom_avatar_view_tabs` (`Flat` / `3D Try-On`) above the preview; wrapped existing flat preview in `#ca_flat_view` and added `#ca_3d_view` containing `#ca_3d_container` + 3D legend (`Drag to orbit / Wheel to zoom`) + `#ca_3d_status`; kept original upload/reset/confirm buttons and `custom_avatar_error` label unchanged.
 - Added `<script type="module" src="js/custom_avatar_3d.js">` after `emoji.js` (presentation-only; does not affect send flow).

## Unchanged (intentionally byte-for-byte behavior)
- `client/core/templates/js/avatars.js` — not forked; 3D module wraps `renderCustomAvatarPreview` at runtime instead of editing gestures/payload math.
- `client/core/templates/js/commands.js` — `ConfirmCustomAvatar() -> SetInfo()`, `uploadCustomAvatarIfNeeded`, `customAvatarMetaOnly`, and the chunked WebSocket upload still send exactly the same `Scale/Offset/Rotation/TilingX/TilingY` fields computed as before.
- `client/core/templates/js/{i18n,main,selection,utils,emoji,avatars_list}.js`, all `css/*`, and all non-preview UI.

## Calibration assumptions (must be checked once against live game)
1. `TEXTURE_FLIP_Y = true` in `custom_avatar_3d.js` — assumes Three.js default matches Unity. Verify with an asymmetric test image ("TOP") side-by-side vs in-game; flip to `false` if inverted. One-line change.
2. `DEFAULT_CAMERA_POSE` — assumes in-game pose is arms-down (not the T-pose) and frames a frontal torso+head view. Only affects default camera/lighting framing, not UV math. Adjust after one real screenshot if needed.

Leave a one-line comment in the module and update this file after the smoke test.

## Hosting
- Static-only, relative asset paths, works from `https://<user>.github.io/<repo>/client/core/templates/game.html` (root `index.html` redirects there).
- Added `.github/workflows/pages.yml` (static deploy; also works via Settings -> Pages -> Deploy from branch).

## Verification of hard constraints
- No `.dll`, Unity `AssetBundle`, or other game binary/asset was read, referenced, or embedded — only `Body.obj` as a reference mesh, plus parameters this site already computed.
- All other site functionality (lobby, teams, WebSocket, i18n, Q/A, scoring) is untouched.
