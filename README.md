# Party Quiz — Companion Site (Unofficial Fork)

Unofficial, personal fork of the **Party Quiz** browser companion (Jackbox-style, phone join via browser).
This repo only changes the **custom avatar preview** — it does **not** modify or redistribute the game itself.

Original site was extracted client-side from the browser; this port keeps all lobby / team / WebSocket / i18n / question / scoring flows **byte-for-byte identical**. The only functional addition is the new **3D Try-On** mode inside the existing `custom_avatar_modal`.

## What changed vs original
See [CHANGES.md](CHANGES.md) — short, reviewable diff: new `custom_avatar_3d.{js,css}` + modal/tab/CSS additions, plus the provided `Body.obj` under `client/assets/models/` (see Licensing below). No edits to `commands.js` send flow or other gameplay code.

## 3D Try-On
Inside the custom avatar modal, switch between:
- **Flat** — the original 2D canvas preview (drag to pan, scroll to zoom, Ctrl+drag to rotate)
- **3D Try-On** — real-time preview on the provided `Body.obj` reference mesh. The uploaded PNG is projected straight through the silhouette (front-projection UVs) exactly as in-game, so `TilingX/TilingY` repetition is now visible across the whole body instead of being cropped to a face oval.

Controls in 3D: drag to orbit, wheel/pinch to zoom, clamped zoom/polar-angle so you cannot clip through the model. The view uses the same `window.customAvatar.payload` (Scale/OffsetX/OffsetY/Rotation/TilingX/TilingY) as the flat editor — gestures in either view update the same payload, both previews re-render live, switching tabs preserves position/zoom/rotation.

Texture mapping:
- `texture.wrapS/T = THREE.RepeatWrapping`
- `texture.repeat = Tiling / (Scale * PREVIEW_BASE_ZOOM)` — Scale folded the same way as the flat canvas (`effectiveScale = Scale * 1.5`)
- `texture.offset = (OffsetX, OffsetY)`
- `texture.rotation = Rotation`, `texture.center = (0.5,0.5)`
- `texture.flipY = TEXTURE_FLIP_Y` (default `true`; see Calibration below)

If WebGL is unavailable, the 3D tab is hidden automatically and the flat-only flow remains.

## Hosting (GitHub Pages, static-only)
- No build step, no bundler, no secrets. Vanilla JS + Three.js via a **pinned CDN ESM import** (`three@0.160.0` via `https://cdn.jsdelivr.net/...`).
- Works from a project Pages URL because all assets use **relative paths**. The entry point is `client/core/templates/game.html`; `index.html` at the repo root redirects there for convenience.
- Enable Pages: **Settings -> Pages -> Deploy from branch** (or the included GitHub Actions workflow `.github/workflows/pages.yml` which publishes `main`).

Import map (in `game.html`):
```html
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
  }
}
</script>
```

## Licensing — Body.obj
`client/assets/models/Body.obj` was shared by the developer **explicitly for calibrating this preview**. Before publishing this repo **publicly** on GitHub Pages, you must have **explicit written confirmation** from the developer that **public redistribution** (not just personal use) is allowed.
- If that confirmation is **not** in hand: keep the repo **private**, or deploy without the real mesh — the code falls back to `client/assets/models/Body.placeholder.obj` (a generic non-game placeholder) until cleared. A `TODO` in `custom_avatar_3d.js` marks where to drop the real mesh.
- No other game binaries, DLLs, Unity AssetBundles, meshes, materials, or textures were read, referenced, or embedded — only the explicitly provided `Body.obj`.

## Calibration (manual one-time check)
Two details cannot be verified without a live in-game comparison; they are left as **named constants** at the top of `client/core/templates/js/custom_avatar_3d.js`:

- `TEXTURE_FLIP_Y` (bool, default `true`) — Unity vs this OBJ's V-axis convention. Upload an asymmetric test image (e.g. text reading "TOP") and compare the 3D preview vs a real in-game screenshot; flip to `false` if upside-down.
- `DEFAULT_CAMERA_POSE` (`position`, `target`, `fov`) — the mesh is a T-pose, but the in-game pose may be arms-down. The default camera frames the frontal torso+head to flatter that assumption; adjust after comparing a real screenshot. This affects only framing, not the underlying UV math.

Document any correction in `CHANGES.md` after the smoke test.

## Local preview
```bash
# from repo root
python -m http.server 8000
# open http://localhost:8000/client/core/templates/game.html
```

## Local testing
**WebSocket fails locally (`wss://127.0.0.1:3012` -> code 1006) is expected.** `createSocket()` in `client/core/templates/js/main.js:1099` connects to `window.location.hostname` on port `3012` and only falls back to the public matchmaker `partyquiz.club` when `hostname === "localhost"` exactly — `127.0.0.1` does not match, so testing over `127.0.0.1` tries a non-existent local matchmaker.

- **Do not modify `createSocket()`** — out of scope.
- Open the page with `?server=partyquiz.club` (already supported via `getQueryParam('server')` in `main.js:1099`), e.g.:
  ```
  http://127.0.0.1:8080/client/core/templates/game.html?server=partyquiz.club
  ```
  or simply use `http://localhost:8080/...?server=partyquiz.club` (where `localhost` would also trigger the fallback, but the explicit `?server=` is reliable for both).
- This only lets the *website* reach the real matchmaker — actually joining a live game still requires the real Party Quiz host (.exe) running with a matching game ID; the WebSocket alone will not produce a joinable lobby without a real host session.

## Confirm no game binaries
This repo contains **no** `.dll`, no Unity `AssetBundle`, no meshes/materials pulled from the actual game build beyond `Body.obj` explicitly provided. All other preview logic is derived from that mesh plus the shader parameters this site already computed.

## Structure
```
/client/core/templates/game.html   # main companion page (ported)
/client/core/templates/js/*         # original JS (renamed, behavior identical)
/client/core/templates/css/*        # original CSS
/client/assets/models/Body.obj      # provided reference mesh (or placeholder)
/client/assets/custom_avatar_background.png
/client/avatars/                    # avatar image list (referenced by avatars.js)
/client/localized/<lang>/lang.json  # i18n dictionaries
```
