
// custom_avatar_3d.js - 3D Try-On for Party Quiz companion
// Adds a Three.js preview of Body.obj textured with the same payload (Scale/Offset/Rotation/Tiling) as the flat canvas.
// Keep this module presentation-only; it never touches upload/send logic.

import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// === Calibration constants (manual, one-time check needed) ==================
// TEXTURE_FLIP_Y: whether to flip the uploaded image vertically to match Unity's
//   V-axis. Default true (Three.js default). If a test image with "TOP" text
//   appears upside-down in-game vs preview, change to false once.
//   Flip once and compare against a real in-game screenshot.
const TEXTURE_FLIP_Y = true; // <- easy-to-flip constant

// DEFAULT_CAMERA_POSE: assume in-game pose is arms-down (not the T-pose in
//   Body.obj) unless told otherwise. So we frame front of figure (torso+head),
//   slightly above center, with moderate distance.
const DEFAULT_CAMERA_POSE = {
    position: new THREE.Vector3(0, 0.008, 0.08),
    target: new THREE.Vector3(0, 0.008, 0),
    fov: 45,
};

// Must mirror avatars.js value so 2D and 3D stay visually consistent.
const CUSTOM_AVATAR_PREVIEW_BASE_ZOOM = 1.5;

// Clamp helpers for OrbitControls
const MIN_DISTANCE = 0.01;
const MAX_DISTANCE = 0.5;
const MIN_POLAR = 0.1;
const MAX_POLAR = Math.PI * 0.48;

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let mesh = null;
let texture = null;
let animId = null;
let isInitialized = false;
let isVisible = false;
window.currentView = 'flat';
let currentView = window.currentView; // 'flat' | '3d'
let hasWebGL = true;

// ---------------------------------------------------------------------------

function hasWebGLSupport() {
    try {
        const c = document.createElement('canvas');
        return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
}

function getThemeColor(varName, fallback) {
    try {
        const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
        return v || fallback;
    } catch (e) { return fallback; }
}

function isCustomAvatarPayloadAvailable() {
    const p = window.customAvatar && window.customAvatar.payload;
    return !!(p && p.Data && window.customAvatar.dataUrl);
}

function safeNumber(v, fallback) {
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
}

function getPayload() {
    return (window.customAvatar && window.customAvatar.payload) || null;
}

// Texture transform: keep consistent with 2D preview.
// In 2D: effectiveScale = Scale * PREVIEW_BASE_ZOOM, drawW = cw * effectiveScale.
// In 3D UV space: repeat = Tiling / effectiveScale so both zoom together.
// Offset is screen-space in 2D but UV-space in 3D; we map directly via payload.OffsetX/Y
// because Body.obj UVs already span ~0..1 front-projection, same as canvas 0..1.
function applyPayloadToTexture() {
    if (!texture) return;
    const p = getPayload();
    if (!p) return;
    const tilingX = safeNumber(p.TilingX, 1.0);
    const tilingY = safeNumber(p.TilingY, 1.0);
    const offsetX = safeNumber(p.OffsetX, 0.0);
    const offsetY = safeNumber(p.OffsetY, 0.0);
    const scale = safeNumber(p.Scale, 1.0);
    const rotation = safeNumber(p.Rotation, 0.0);
    // Update texture (for fallback) and shader uniforms (pixel-perfect)
    const effectiveScale = scale * CUSTOM_AVATAR_PREVIEW_BASE_ZOOM;
    const safeScale = Math.max(0.01, effectiveScale);
    texture.repeat.set(tilingX / safeScale, tilingY / safeScale);
    texture.offset.set(offsetX, offsetY);
    texture.rotation = rotation;
    texture.center.set(0.5, 0.5);
    texture.needsUpdate = true;
    // Also update shader uniforms if present (planar projection)
    if (mesh && mesh.material && mesh.material.uniforms) {
        mesh.material.uniforms.tiling.value.set(tilingX, tilingY);
        mesh.material.uniforms.offset.value.set(offsetX, offsetY);
        mesh.material.uniforms.scale.value = scale;
        mesh.material.uniforms.rotation.value = rotation;
        mesh.material.uniforms.map.value = texture;
    } else if (mesh && mesh.userData && mesh.userData.shaderMat) {
        const m = mesh.userData.shaderMat;
        m.uniforms.tiling.value.set(tilingX, tilingY);
        m.uniforms.offset.value.set(offsetX, offsetY);
        m.uniforms.scale.value = scale;
        m.uniforms.rotation.value = rotation;
    }
}

async function loadTextureFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
        const loader = new THREE.TextureLoader();
        // Ensure flipY constant is respected
        loader.setCrossOrigin('anonymous');
        const tex = loader.load(dataUrl, () => resolve(tex), undefined, reject);
        // THREE will set flipY after load; we override immediately
        tex.flipY = TEXTURE_FLIP_Y;
    });
}

async function updateTexture() {
    const dataUrl = window.customAvatar && window.customAvatar.dataUrl;
    if (!dataUrl) {
        if (texture && mesh) {
            // show placeholder color
            mesh.material.map = null;
            mesh.material.needsUpdate = true;
        }
        return;
    }
    try {
        const newTex = await loadTextureFromDataUrl(dataUrl);
        newTex.wrapS = THREE.RepeatWrapping;
        newTex.wrapT = THREE.RepeatWrapping;
        newTex.flipY = TEXTURE_FLIP_Y; // clearly labeled constant; flip to false if Unity V is opposite
        newTex.colorSpace = THREE.SRGBColorSpace;
        newTex.center.set(0.5, 0.5);
        // dispose old
        if (texture) texture.dispose();
        texture = newTex;
        applyPayloadToTexture();
        if (mesh) {
            if (mesh.material.uniforms) {
                mesh.material.uniforms.map.value = texture;
                mesh.material.needsUpdate = true;
            } else {
                mesh.material.map = texture;
                mesh.material.needsUpdate = true;
            }
        }
    } catch (e) {
        console.error('Failed to load avatar texture', e);
        const status = document.getElementById('ca_3d_status');
        if (status) status.textContent = 'Failed to load image for 3D view';
    }
}

function ensureScene() {
    if (isInitialized) return;
    const container = document.getElementById('ca_3d_container');
    if (!container) return;
    if (!hasWebGLSupport()) {
        hasWebGL = false;
        const tab3d = document.getElementById('ca_tab_3d');
        if (tab3d) tab3d.style.display = 'none';
        const status = document.getElementById('ca_3d_status');
        if (status) status.textContent = 'WebGL not available';
        return;
    }

    // Scene
    scene = new THREE.Scene();
    // Use transparent background; renderer alpha true will show modal CSS bg (theme --card)
    // Keep scene background null so CSS variables shine through.

    camera = new THREE.PerspectiveCamera(DEFAULT_CAMERA_POSE.fov, 1, 0.1, 100);
    camera.position.copy(DEFAULT_CAMERA_POSE.position);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Use theme-aware clear color (transparent so modal bg shows)
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    container.appendChild(renderer.domElement);

    // Lights - simple key + ambient
    const ambient = new THREE.AmbientLight(0xffffff, 0.85);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(0.8, 1.2, 1.0);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-0.8, 0.5, 0.8);
    scene.add(fill);

    // Controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(DEFAULT_CAMERA_POSE.target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = MIN_DISTANCE;
    controls.maxDistance = MAX_DISTANCE;
    controls.minPolarAngle = MIN_POLAR;
    controls.maxPolarAngle = MAX_POLAR;
    controls.enablePan = false;
    controls.enableZoom = true;
    // Only left button rotates (spec: left-drag to orbit), right does nothing
    controls.mouseButtons = { LEFT: THREE.MOUSE.NONE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    controls.update();

    // --- 3D texture pan: left-drag moves OffsetX/Y (same payload as flat), right-drag orbits ---
    let isPanningTexture = false;
    let panStart = { x: 0, y: 0, offX: 0, offY: 0 };
    const TEX_PAN_SPEED = 0.8;
    renderer.domElement.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // left only for texture pan
        if (window.currentView !== '3d') return;
        const payload = window.customAvatar && window.customAvatar.payload;
        if (!payload || !payload.Data) return;
        // Only if inside 3D container and not on controls' right button
        isPanningTexture = true;
        panStart.x = e.clientX;
        panStart.y = e.clientY;
        panStart.offX = payload.OffsetX;
        panStart.offY = payload.OffsetY;
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!isPanningTexture) return;
        if (window.currentView !== '3d') return;
        const payload = window.customAvatar && window.customAvatar.payload;
        if (!payload) return;
        const rect = container.getBoundingClientRect();
        const w = rect.width || 260;
        const h = rect.height || 260;
        const dx = (e.clientX - panStart.x) / w;
        const dy = (e.clientY - panStart.y) / h;
        // Match flat logic: drag moves offset, scaled by 1/Scale
        const scale = Math.max(0.1, (payload.Scale || 1) * 1.5);
        payload.OffsetX = panStart.offX - dx * TEX_PAN_SPEED / scale;
        payload.OffsetY = panStart.offY + dy * TEX_PAN_SPEED / scale;
        if (typeof window.renderCustomAvatarPreview === 'function') window.renderCustomAvatarPreview();
        applyPayloadToTexture();
        if (typeof updateSetInfoButtonState === 'function') updateSetInfoButtonState();
    });
    window.addEventListener('mouseup', (e) => {
        if (e.button === 0) isPanningTexture = false;
    });
    // Touch: one finger pan texture, two fingers pinch handled by OrbitControls already
    renderer.domElement.addEventListener('touchstart', (e) => {
        if (window.currentView !== '3d') return;
        if (e.touches.length !== 1) return;
        const payload = window.customAvatar && window.customAvatar.payload;
        if (!payload || !payload.Data) return;
        isPanningTexture = true;
        panStart.x = e.touches[0].clientX;
        panStart.y = e.touches[0].clientY;
        panStart.offX = payload.OffsetX;
        panStart.offY = payload.OffsetY;
    }, { passive: false });
    renderer.domElement.addEventListener('touchmove', (e) => {
        if (!isPanningTexture || e.touches.length !== 1) return;
        if (window.currentView !== '3d') return;
        const payload = window.customAvatar && window.customAvatar.payload;
        if (!payload) return;
        const rect = container.getBoundingClientRect();
        const w = rect.width || 260;
        const dx = (e.touches[0].clientX - panStart.x) / w;
        const dy = (e.touches[0].clientY - panStart.y) / (rect.height || 260);
        const scale = Math.max(0.1, (payload.Scale || 1) * 1.5);
        payload.OffsetX = panStart.offX - dx * TEX_PAN_SPEED / scale;
        payload.OffsetY = panStart.offY + dy * TEX_PAN_SPEED / scale;
        if (typeof window.renderCustomAvatarPreview === 'function') window.renderCustomAvatarPreview();
        applyPayloadToTexture();
        e.preventDefault();
    }, { passive: false });
    renderer.domElement.addEventListener('touchend', (e) => {
        if (e.touches.length === 0) isPanningTexture = false;
    });

    // Prevent page scroll when wheeling over 3D viewport
    renderer.domElement.addEventListener('wheel', (e) => e.stopPropagation(), { passive: false });

    // Handle size
    const resize = () => {
        if (!container || !renderer || !camera) return;
        const w = container.clientWidth || 260;
        const h = container.clientHeight || 260;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
    };
    window.addEventListener('resize', resize);
    // Observe modal resize
    if (window.ResizeObserver) {
        const ro = new ResizeObserver(resize);
        ro.observe(container);
    }
    resize();

    // Load mesh
    const loader = new OBJLoader();
    // Try primary Body.obj, fallback to placeholder if not found / not allowed publicly
    const primary = '../../assets/models/Body.obj';
    const fallback = '../../assets/models/Body.placeholder.obj';
    function onMeshLoaded(object) {
        object.traverse((child) => {
            if (child.isMesh) {
                mesh = child;
                // Ensure geometry has UVs (Body.obj already does)
                // Use a simple material that respects map transform
                // Use ShaderMaterial that does planar projection like Custom/AlbedoTiling
                // Base UV = worldPos.xz * 31.25 + 0.5, then user transform: uv * Scale * Tiling + Offset, rotation about 0.5
                const mat = new THREE.ShaderMaterial({
                    uniforms: {
                        map: { value: texture },
                        tiling: { value: new THREE.Vector2(1, 1) },
                        offset: { value: new THREE.Vector2(0, 0) },
                        scale: { value: 1.0 },
                        rotation: { value: 0.0 },
                        baseZoom: { value: 31.25 },
                        flipY: { value: TEXTURE_FLIP_Y ? 1 : 0 }
                    },
                    vertexShader: `
                        varying vec3 vWorldPos;
                        void main() {
                            vec4 worldPos = modelMatrix * vec4(position, 1.0);
                            vWorldPos = worldPos.xyz;
                            gl_Position = projectionMatrix * viewMatrix * worldPos;
                        }
                    `,
                    fragmentShader: `
                        uniform sampler2D map;
                        uniform vec2 tiling;
                        uniform vec2 offset;
                        uniform float scale;
                        uniform float rotation;
                        uniform float baseZoom;
                        uniform float flipY;
                        varying vec3 vWorldPos;
                        void main() {
                            // Planar projection: U~X, V~Z (world space), centered
                            vec2 baseUV = vWorldPos.xz * baseZoom + vec2(0.5);
                            // User scale (like flat preview 1.5)
                            float effectiveScale = scale * 1.5;
                            vec2 uv = baseUV;
                            // Apply tiling and scale
                            uv *= tiling / effectiveScale;
                            // Apply offset (payload Offset is UV units)
                            uv += offset;
                            // Rotation about 0.5
                            float c = cos(rotation);
                            float s = sin(rotation);
                            uv -= 0.5;
                            uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);
                            uv += 0.5;
                            // Flip Y if needed (Unity vs Three)
                            if (flipY < 0.5) uv.y = 1.0 - uv.y;
                            // Sample
                            vec4 col = texture2D(map, uv);
                            if (col.a < 0.01) discard;
                            gl_FragColor = col;
                        }
                    `,
                    side: THREE.DoubleSide,
                    transparent: true
                });
                // Store reference for live updates
                child.userData.shaderMat = mat;
                if (texture) mat.uniforms.map.value = texture;
                child.material = mat;
                // Center and scale model to fit view
                // Body.obj spans small units (~0.02), normalize
                // Body.obj uses Z as height (X=width, Z=height, Y=depth) — rotate to stand (Y-up)
                // Keep original world size (0.032) for correct planar projection: shader does baseUV = worldPos.xz * 31.25
                // Do not scale via object.scale (would distort UV); instead keep world size and adjust camera distance
                object.rotation.x = -Math.PI / 2;
                object.updateMatrixWorld(true);
                const box = new THREE.Box3().setFromObject(object);
                const center = box.getCenter(new THREE.Vector3());
                object.position.sub(center);
                // Centered, keep original size — camera is very close (see DEFAULT_CAMERA_POSE)
                object.position.y += 0.008; // slight lift so feet not clipped
                // Ensure front faces camera (+Z)
                // Model is already front-facing; no rotation needed
            }
        });
        scene.add(object);
        // Trigger initial texture load if already available
        if (isCustomAvatarPayloadAvailable()) updateTexture();
        else applyPayloadToTexture();
        animate();
    }
    loader.load(primary, onMeshLoaded, undefined, (err) => {
        console.warn('Primary Body.obj failed, trying placeholder', err);
        const status = document.getElementById('ca_3d_status');
        if (status) status.textContent = 'Using placeholder body (Body.obj not available)';
        loader.load(fallback, onMeshLoaded, undefined, (e2) => {
            console.error('Fallback also failed', e2);
            if (status) status.textContent = '3D model not available';
        });
    });

    isInitialized = true;
}

function animate() {
    if (!isVisible) return;
    animId = requestAnimationFrame(animate);
    if (controls) controls.update();
    if (renderer && scene && camera) renderer.render(scene, camera);
}

function startRenderLoop() {
    if (!isInitialized) ensureScene();
    isVisible = true;
    if (!animId) animate();
    // ensure size correct when tab becomes visible
    setTimeout(() => {
        const container = document.getElementById('ca_3d_container');
        if (container && renderer && camera) {
            const w = container.clientWidth || 260;
            const h = container.clientHeight || 260;
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            renderer.setSize(w, h, false);
        }
    }, 50);
}

function stopRenderLoop() {
    isVisible = false;
    if (animId) { cancelAnimationFrame(animId); animId = null; }
}

// Global tab switcher (called from inline onclick)
window.switchCustomAvatarView = function(view) {
    window.currentView = currentView = view;
    const tabFlat = document.getElementById('ca_tab_flat');
    const tab3d = document.getElementById('ca_tab_3d');
    const flat = document.getElementById('ca_flat_view');
    const view3d = document.getElementById('ca_3d_view');
    if (!tabFlat || !tab3d || !flat || !view3d) return;
    if (view === '3d') {
        tabFlat.classList.remove('active');
        tabFlat.setAttribute('aria-selected', 'false');
        tab3d.classList.add('active');
        tab3d.setAttribute('aria-selected', 'true');
        flat.hidden = true;
        flat.classList.remove('active');
        view3d.hidden = false;
        view3d.classList.add('active');
        if (!isInitialized) ensureScene();
        startRenderLoop();
        // live update texture in case payload changed while on flat
        updateTexture().then(() => applyPayloadToTexture());
    } else {
        tab3d.classList.remove('active');
        tab3d.setAttribute('aria-selected', 'false');
        tabFlat.classList.add('active');
        tabFlat.setAttribute('aria-selected', 'true');
        view3d.hidden = true;
        view3d.classList.remove('active');
        flat.hidden = false;
        flat.classList.add('active');
        stopRenderLoop();
    }
};

// Hook into existing preview pipeline so 3D stays in sync with flat gestures
// We wrap renderCustomAvatarPreview (called on every drag/wheel) to also update 3D texture
(function hookFlatPreview() {
    const orig = window.renderCustomAvatarPreview;
    // If not yet defined (avatars.js loads before us), poll
    function tryHook() {
        if (typeof window.renderCustomAvatarPreview === 'function' && !window.renderCustomAvatarPreview.__3dHooked) {
            const base = window.renderCustomAvatarPreview;
            window.renderCustomAvatarPreview = async function() {
                const r = await base.apply(this, arguments);
                // keep 3D in sync even when flat view hidden (so switching preserves position)
                if (texture) applyPayloadToTexture();
                // also update thumbnail sync is handled by original; we just ensure 3D map exists
                if (isCustomAvatarPayloadAvailable() && !texture) {
                    await updateTexture();
                }
                return r;
            };
            window.renderCustomAvatarPreview.__3dHooked = true;
            console.log('3D hook attached to renderCustomAvatarPreview');
        } else if (!window.renderCustomAvatarPreview) {
            setTimeout(tryHook, 200);
        }
    }
    tryHook();
})();

// Also listen for payload changes via mutation of window.customAvatar (e.g., after file upload)
let lastHash = null;
setInterval(() => {
    const p = getPayload();
    const h = p && p.Hash;
    if (h && h !== lastHash) {
        lastHash = h;
        updateTexture();
    } else if (p && texture) {
        // Still need to keep offset/scale/rotation synced even if hash same
        applyPayloadToTexture();
    }
    // Also sync visibility: if modal closed, stop loop
    const modal = document.getElementById('custom_avatar_modal');
    if (modal && modal.hidden && isVisible) stopRenderLoop();
}, 300);

// Degrade gracefully if WebGL missing
if (!hasWebGLSupport()) {
    hasWebGL = false;
    window.addEventListener('DOMContentLoaded', () => {
        const tab3d = document.getElementById('ca_tab_3d');
        if (tab3d) tab3d.hidden = true;
        const tabs = document.getElementById('custom_avatar_view_tabs');
        if (tabs) tabs.hidden = true;
    });
}

// When modal opens, ensure 3D is ready if user had last selected 3D
const origOpen = window.OpenCustomAvatarModal;
if (typeof origOpen === 'function') {
    window.OpenCustomAvatarModal = function() {
        const r = origOpen.apply(this, arguments);
        // if previously on 3d, resume
        if (currentView === '3d') {
            setTimeout(() => window.switchCustomAvatarView('3d'), 100);
        }
        return r;
    };
}

// Also hook Close to stop loop
const origClose = window.CloseCustomAvatarModal;
if (typeof origClose === 'function') {
    window.CloseCustomAvatarModal = function() {
        stopRenderLoop();
        return origClose.apply(this, arguments);
    };
}

console.log('custom_avatar_3d.js loaded (TEXTURE_FLIP_Y=' + TEXTURE_FLIP_Y + ')');
