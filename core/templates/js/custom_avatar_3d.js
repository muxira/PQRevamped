// custom_avatar_3d.js — "3D Try-On" preview for custom avatars.
//
// Presentation only: it never uploads, sends or mutates the payload that avatars.js
// stores. The flat canvas stays the source of truth for Scale / OffsetX / OffsetY /
// Rotation / TilingX / TilingY; this module mirrors those values onto the body mesh so
// players can see how their drawing wraps around the avatar before confirming.
//
// Mobile-first details:
//  - Three.js ships in assets/vendor/three and is dynamically imported only when the
//    3D tab is opened, so the page itself never pays for it.
//  - One finger orbits, pinch zooms; `touch-action: none` keeps the page still.
//  - The device pixel ratio is capped and frames are drawn on demand, not in a
//    permanent requestAnimationFrame loop, so a phone does not heat up in a modal.
//  - Everything is torn down / paused when the modal closes or the tab is hidden.

let THREE = null;
let OBJLoader = null;
let OrbitControls = null;

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let mesh = null;
let shaderMaterial = null;
let texture = null;
let geometryRoot = null;

let container = null;
let statusEl = null;
let loadingEl = null;
let resetButton = null;

let initialized = false;
let visible = false;
let threeLoading = null;
let resizeObserver = null;
let modelBounds = { radius: 0.02, height: 0.032 };
let defaultCamera = { distance: 0.06, targetY: 0.0 };

const TEXTURE_FLIP_Y = true; // Unity's V axis vs Three.js; flip here if a test image is upside down.
const PREVIEW_BASE_ZOOM = 1.5;
const MAX_PIXEL_RATIO = 2;

/* ------------------------------------------------------------------ helpers */

function t(key, fallback) {
    try {
        const value = window.i18n && window.i18n.t(key);
        return value && value !== key ? value : fallback;
    } catch (e) { return fallback; }
}

function setStatus(message, kind) {
    if (!statusEl) return;
    if (!message) {
        statusEl.hidden = true;
        statusEl.textContent = '';
        return;
    }
    statusEl.hidden = false;
    statusEl.textContent = message;
    statusEl.dataset.kind = kind || 'info';
}

function setLoading(on) {
    if (loadingEl) loadingEl.hidden = !on;
}

function currentPayload() {
    const avatar = window.customAvatar;
    const payload = avatar && avatar.payload;
    return payload && payload.Data ? payload : null;
}

function num(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
}

function hasWebGL() {
    try {
        const canvas = document.createElement('canvas');
        return !!(window.WebGLRenderingContext && (canvas.getContext('webgl2') || canvas.getContext('webgl')));
    } catch (e) { return false; }
}

/* ------------------------------------------------------------ three loading */

async function loadThree() {
    if (THREE) return;
    if (!threeLoading) {
        threeLoading = (async () => {
            THREE = await import('three');
            ({ OBJLoader } = await import('three/addons/loaders/OBJLoader.js'));
            ({ OrbitControls } = await import('three/addons/controls/OrbitControls.js'));
        })().catch((error) => {
            threeLoading = null;
            throw error;
        });
    }
    return threeLoading;
}

/* ------------------------------------------------------------------ texture */

function applyPayloadToTexture() {
    if (!shaderMaterial) return;
    const payload = currentPayload();
    const scale = Math.max(0.01, num(payload && payload.Scale, 1));
    const uniforms = shaderMaterial.uniforms;

    uniforms.tiling.value.set(num(payload && payload.TilingX, 1), num(payload && payload.TilingY, 1));
    uniforms.offset.value.set(num(payload && payload.OffsetX, 0), num(payload && payload.OffsetY, 0));
    uniforms.scale.value = scale;
    uniforms.rotation.value = num(payload && payload.Rotation, 0);

    // Keep the plain material fallback (placeholder body / no shader) in sync too.
    if (texture && mesh && mesh.material && mesh.material !== shaderMaterial && mesh.material.map) {
        const effective = Math.max(0.01, scale * PREVIEW_BASE_ZOOM);
        texture.repeat.set(num(payload && payload.TilingX, 1) / effective, num(payload && payload.TilingY, 1) / effective);
        texture.offset.set(num(payload && payload.OffsetX, 0), num(payload && payload.OffsetY, 0));
        texture.rotation = num(payload && payload.Rotation, 0);
        texture.center.set(0.5, 0.5);
        texture.needsUpdate = true;
    }

    requestFrame();
}

function makeTextureFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin('anonymous');
        loader.load(
            dataUrl,
            (tex) => {
                tex.flipY = TEXTURE_FLIP_Y;
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.colorSpace = THREE.SRGBColorSpace;
                tex.center.set(0.5, 0.5);
                tex.needsUpdate = true;
                resolve(tex);
            },
            undefined,
            reject
        );
    });
}

async function refreshTexture(showErrors) {
    const payload = currentPayload();
    if (!payload) return;

    try {
        const next = await makeTextureFromDataUrl(window.customAvatar.dataUrl);
        const old = texture;
        texture = next;
        if (shaderMaterial) {
            shaderMaterial.uniforms.map.value = texture;
            shaderMaterial.needsUpdate = true;
        }
        if (mesh && mesh.material && mesh.material !== shaderMaterial) {
            mesh.material.map = texture;
            mesh.material.needsUpdate = true;
        }
        if (old) old.dispose();
        applyPayloadToTexture();
    } catch (error) {
        if (showErrors) setStatus(t('ca_texture_failed', 'Could not load that image for the 3D preview.'), 'error');
    }
}

/* -------------------------------------------------------------------- scene */

function bodyMaterial() {
    // Unity's Custom/AlbedoTiling vertex shader projects UVs as:
    //   uv = rotate(vUv.yx + offset.yx - .5, rotation) / Scale * Tiling + .5
    // Reproducing it keeps the 3D view and the in-game avatar identical.
    return new THREE.ShaderMaterial({
        uniforms: {
            map: { value: texture },
            tiling: { value: new THREE.Vector2(1, 1) },
            offset: { value: new THREE.Vector2(0, 0) },
            scale: { value: 1 },
            rotation: { value: 0 },
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform sampler2D map;
            uniform vec2 tiling;
            uniform vec2 offset;
            uniform float scale;
            uniform float rotation;
            varying vec2 vUv;

            void main() {
                vec2 uv = vec2(vUv.y + offset.y, vUv.x + offset.x) - 0.5;
                float s = sin(rotation);
                float c = cos(rotation);
                vec2 rotated = vec2(uv.y * c - uv.x * s, uv.x * c + uv.y * s);
                rotated /= max(scale, 0.01);
                vec4 col = texture2D(map, rotated * tiling + 0.5);
                if (col.a < 0.01) discard;
                gl_FragColor = col;
            }
        `,
        side: THREE.DoubleSide,
        transparent: true,
    });
}

function frameCamera() {
    if (!camera || !controls) return;
    const radius = modelBounds.radius || 0.02;
    const aspect = Math.max(0.4, (container && container.clientWidth ? container.clientWidth / Math.max(1, container.clientHeight) : 1));
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const fitHeight = (modelBounds.height * 0.5) / Math.tan(fov / 2);
    const fitWidth = (radius) / (Math.tan(fov / 2) * aspect);
    const distance = Math.max(0.02, Math.max(fitHeight, fitWidth) * 1.35);

    defaultCamera = { distance, targetY: 0 };
    camera.position.set(0, modelBounds.height * 0.06, distance);
    controls.target.set(0, modelBounds.height * 0.06, 0);
    controls.minDistance = distance * 0.45;
    controls.maxDistance = distance * 2.6;
    controls.update();
    requestFrame();
}

function normalizeModel(root) {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    root.position.sub(center);
    root.updateMatrixWorld(true);

    modelBounds = {
        radius: Math.max(size.x, size.z) * 0.5,
        height: size.y,
    };

    // One material for every sub-mesh, so a future Body.obj split into parts still
    // shares a single set of uniforms.
    shaderMaterial = bodyMaterial();
    if (texture) shaderMaterial.uniforms.map.value = texture;
    root.traverse((child) => {
        if (!child.isMesh) return;
        mesh = child;
        child.material = shaderMaterial;
        child.renderOrder = 0;
    });

    geometryRoot = root;
    scene.add(root);
    applyPayloadToTexture();
    frameCamera();
}

function placeholderModel() {
    // A torso-ish capsule, only used if Body.obj cannot be fetched.
    const group = new THREE.Group();
    const geometry = new THREE.CapsuleGeometry(modelBounds.radius || 0.012, (modelBounds.height || 0.03) * 0.55, 6, 16);
    const material = new THREE.MeshBasicMaterial({
        color: 0xb98cff,
        transparent: true,
        opacity: 0.35,
    });
    group.add(new THREE.Mesh(geometry, material));
    group.rotation.x = 0;
    return group;
}

async function loadModel() {
    if (!THREE) return;
    const loader = new OBJLoader();
    // Resolved against the page, not this module, so a sub-path deploy
    // (user.github.io/repo/…) keeps working.
    const url = new URL('../../assets/models/Body.obj', document.baseURI).toString();

    return new Promise((resolve) => {
        loader.load(
            url,
            (root) => {
                // Body.obj is Z-up; stand it upright for a Y-up scene.
                root.rotation.x = -Math.PI / 2;
                resolve(root);
            },
            undefined,
            (error) => {
                console.warn('[3D] Body.obj failed, using placeholder', error);
                setStatus(t('ca_model_failed', 'Body model unavailable — showing a placeholder.'), 'warn');
                resolve(placeholderModel());
            }
        );
    });
}

function buildScene() {
    if (!container) return;
    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(42, 1, 0.001, 10);
    camera.position.set(0, 0, 0.06);

    renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.className = 'ca-3d-canvas';
    renderer.domElement.setAttribute('aria-hidden', 'true');
    container.appendChild(renderer.domElement);

    renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
    renderer.domElement.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        setStatus(t('ca_context_lost', 'The 3D preview stopped. Reopen the avatar editor to try again.'), 'error');
    });

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.enablePan = false;
    controls.rotateSpeed = 0.85;
    controls.zoomSpeed = 0.8;
    controls.minPolarAngle = Math.PI * 0.18;
    controls.maxPolarAngle = Math.PI * 0.82;
    controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.ROTATE,
    };
    controls.touches = {
        ONE: THREE.TOUCH.ROTATE,
        TWO: THREE.TOUCH.DOLLY_PAN,
    };
    controls.addEventListener('change', requestFrame);

    if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(() => resize());
        resizeObserver.observe(container);
    } else {
        // Older webviews: the orientation/resize listeners below are the fallback.
        window.addEventListener('resize', resize, { passive: true });
    }
    window.addEventListener('orientationchange', () => setTimeout(resize, 180), { passive: true });
    resize();

    if (resetButton) {
        resetButton.hidden = false;
        resetButton.addEventListener('click', () => {
            camera.position.set(0, modelBounds.height * 0.06, defaultCamera.distance);
            controls.target.set(0, modelBounds.height * 0.06, 0);
            controls.update();
            requestFrame();
        });
    }

    requestFrame();
}

function resize() {
    if (!renderer || !camera || !container) return;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.setSize(width, height, false);
    requestFrame();
}

let frameQueued = false;

function requestFrame() {
    if (!visible || frameQueued || !renderer || !scene || !camera) return;
    frameQueued = true;
    requestAnimationFrame(() => {
        frameQueued = false;
        if (!visible || !renderer || !scene || !camera) return;
        try { renderer.render(scene, camera); } catch (e) { /* context lost */ }
    });
}

/* ------------------------------------------------------------------ lifecycle */

async function init3d() {
    if (initialized || !container) return;
    initialized = true;
    setLoading(true);
    setStatus('');

    if (!hasWebGL()) {
        setLoading(false);
        setStatus(t('ca_unavailable', '3D preview is not available in this browser.'), 'error');
        return;
    }

    try {
        await loadThree();
    } catch (error) {
        console.warn('[3D] Three.js failed to load', error);
        setLoading(false);
        setStatus(t('ca_library_failed', 'Could not load the 3D engine. Reload the page to try again.'), 'error');
        return;
    }

    buildScene();
    const model = await loadModel();
    normalizeModel(model);
    setLoading(false);
    if (currentPayload()) await refreshTexture(true);
    requestFrame();
    setStatus('');
}

function start3d() {
    visible = true;
    if (!initialized) init3d();
    else {
        resize();
        requestFrame();
    }
}

function stop3d() {
    visible = false;
}

/* ---------------------------------------------------------------------- tabs */

function setView(view, options) {
    const next = view === '3d' ? '3d' : 'flat';
    const tabFlat = document.getElementById('ca_tab_flat');
    const tab3d = document.getElementById('ca_tab_3d');
    const flat = document.getElementById('ca_flat_view');
    const three = document.getElementById('ca_3d_view');
    if (!tabFlat || !tab3d || !flat || !three) return;

    const is3d = next === '3d';
    tabFlat.classList.toggle('ca-tab--active', !is3d);
    tab3d.classList.toggle('ca-tab--active', is3d);
    tabFlat.setAttribute('aria-selected', String(!is3d));
    tab3d.setAttribute('aria-selected', String(is3d));
    tabFlat.tabIndex = is3d ? -1 : 0;
    tab3d.tabIndex = is3d ? 0 : -1;

    flat.hidden = is3d;
    three.hidden = !is3d;
    const hint = document.getElementById('ca_3d_hint');
    if (hint) hint.hidden = !is3d;

    if (is3d) start3d();
    else stop3d();

    try { localStorage.setItem('pq_ca_view', next); } catch (e) { /* ignore */ }
    if (!options || !options.silent) {
        window.dispatchEvent(new CustomEvent('pq:customAvatarView', { detail: { view: next } }));
    }
}

function savedView() {
    try {
        const value = localStorage.getItem('pq_ca_view');
        return value === '3d' ? '3d' : 'flat';
    } catch (e) { return 'flat'; }
}

function installTabs() {
    const tabFlat = document.getElementById('ca_tab_flat');
    const tab3d = document.getElementById('ca_tab_3d');
    if (!tabFlat || !tab3d) return;

    tabFlat.addEventListener('click', () => setView('flat'));
    tab3d.addEventListener('click', () => setView('3d'));

    const tablist = document.getElementById('custom_avatar_view_tabs');
    if (tablist) {
        tablist.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            const next = document.activeElement === tabFlat ? tab3d : tabFlat;
            event.preventDefault();
            next.focus();
            next.click();
        });
    }
}

function installModalHooks() {
    const modal = document.getElementById('custom_avatar_modal');
    if (!modal) return;

    const onOpen = () => {
        const view = savedView();
        setView(view, { silent: true });
        if (view === '3d') start3d();
    };
    const onClose = () => stop3d();

    // hidden is toggled by main.js; observe instead of monkey-patching its globals.
    if (typeof MutationObserver === 'function') {
        const observer = new MutationObserver(() => {
            if (modal.hidden) onClose();
            else onOpen();
        });
        observer.observe(modal, { attributes: true, attributeFilter: ['hidden'] });
    }

    if (!modal.hidden) onOpen();
}

function installPayloadHooks() {
    const originalPreview = window.renderCustomAvatarPreview;
    if (typeof originalPreview === 'function' && !originalPreview.__pq3d) {
        const wrapped = function () {
            const result = originalPreview.apply(this, arguments);
            if (texture) applyPayloadToTexture();
            else if (visible && currentPayload()) refreshTexture(false);
            return result;
        };
        wrapped.__pq3d = true;
        window.renderCustomAvatarPreview = wrapped;
    }

    const originalSet = window.setCustomAvatarPayload;
    if (typeof originalSet === 'function' && !originalSet.__pq3d) {
        const wrapped = function () {
            const result = originalSet.apply(this, arguments);
            if (initialized) refreshTexture(true);
            return result;
        };
        wrapped.__pq3d = true;
        window.setCustomAvatarPayload = wrapped;
    }

    const originalClear = window.clearCustomAvatarPayload;
    if (typeof originalClear === 'function' && !originalClear.__pq3d) {
        const wrapped = function () {
            const result = originalClear.apply(this, arguments);
            if (texture) { texture.dispose(); texture = null; }
            if (shaderMaterial) shaderMaterial.uniforms.map.value = null;
            requestFrame();
            return result;
        };
        wrapped.__pq3d = true;
        window.clearCustomAvatarPayload = wrapped;
    }
}

function boot() {
    container = document.getElementById('ca_3d_container');
    statusEl = document.getElementById('ca_3d_status');
    loadingEl = document.getElementById('ca_3d_loading');
    resetButton = document.getElementById('ca_3d_reset');
    if (!container) return;

    // The tab stays visible without WebGL: opening it explains why there is no preview
    // instead of quietly removing a control the player has already seen.
    installTabs();
    installModalHooks();
    installPayloadHooks();

    window.__pqCustomAvatar3D = {
        switchView: setView,
        get ready() { return initialized; },
        resetCamera() {
            if (resetButton) resetButton.click();
        },
    };
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
    boot();
}
