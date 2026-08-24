var avatars = (window.PQ_AVATARS && Array.isArray(window.PQ_AVATARS)) ? window.PQ_AVATARS : [];

const fadeMs = 250;
let currentAvatarIndex = 0;

// Must match Host/Assets/Scripts/Studio/Gameplay/Players/Player/CustomAvatarConstants.cs
const CUSTOM_AVATAR_ID = 'custom_avatar';

// Must match Host/Assets/Scripts/Studio/Gameplay/Players/Player/CustomAvatarConstants.cs
const CUSTOM_AVATAR_LIMITS = {
    MAX_TEXTURE_DIMENSION: 512,
    MAX_PAYLOAD_BYTES: 256 * 1024, // 256 KB (PNG bytes)
    MIN_TEXTURE_DIMENSION: 96
};

const CUSTOM_AVATAR_DEFAULTS = {
    TilingX: 1.0,
    TilingY: 1.0,
    OffsetX: 0.0,
    OffsetY: 0.0,
    Scale: 1.0,
    Rotation: 0.0
};

// Web preview shows the texture on a flat canvas while Unity applies it to a
// 3D face whose UVs occupy only a portion of the texture. Multiply the visual
// preview scale by this factor to approximate the Unity crop — tune until
// the web preview matches the in-game look.
const CUSTOM_AVATAR_PREVIEW_BASE_ZOOM = 1.5;

const CUSTOM_AVATAR_STORAGE_KEY = 'custom_avatar_payload_v1';
const CUSTOM_AVATAR_THUMBNAIL_STORAGE_KEY = 'custom_avatar_thumbnail_v1';
const CUSTOM_AVATAR_PLACEHOLDER_SRC =
    'data:image/svg+xml;utf8,' + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
            <rect width="256" height="256" rx="32" fill="#7EAFEC"/>
            <path d="M128 52c-26.5 0-48 21.5-48 48s21.5 48 48 48 48-21.5 48-48-21.5-48-48-48zm0 112c-39.8 0-72 22.4-72 50v20h144v-20c0-27.6-32.2-50-72-50z"
                  fill="white" opacity=".9"/>
            <text x="128" y="236" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="white" opacity=".95">CUSTOM</text>
        </svg>`
    );

// Expose state for other scripts (commands.js).
if (!window.customAvatar) {
    window.customAvatar = {
        id: CUSTOM_AVATAR_ID,
        payload: null,
        dataUrl: null,
        thumbnailDataUrl: null,
        _previewImg: null,
        _previewImgSrc: null
    };
}

let customAvatarUiInitialized = false;
let customAvatarPreviewRenderToken = 0;

let customAvatarMaskImg = null;


function loadCustomAvatarMask() {
    if (customAvatarMaskImg) return;
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = '../../assets/custom_avatar_background.png';
    img.onload = function () {
        customAvatarMaskImg = img;
        renderCustomAvatarPreview().catch(function (err) { console.error(err); });
    };
}

function InitAvatars() {
    ensureCustomAvatarInList();
    initCustomAvatarUIOnce();
    currentAvatarIndex = 0;
    updateCarousel(false);
}

// navigate
function PrevAvatar() {
    currentAvatarIndex = (currentAvatarIndex - 1 + avatars.length) % avatars.length;
    updateCarousel(true);
}

function NextAvatar() {
    currentAvatarIndex = (currentAvatarIndex + 1) % avatars.length;
    updateCarousel(true);
}

// core renderer
function updateCarousel(withFade) {
    const prev = (currentAvatarIndex - 1 + avatars.length) % avatars.length;
    const next = (currentAvatarIndex + 1) % avatars.length;

    // set sources
    setImg('avatar_prev_img', avatars[prev]);
    setImg('avatar_current_img', avatars[currentAvatarIndex]);
    setImg('avatar_next_img', avatars[next]);

    // sync hidden input for legacy code
    document.getElementById('img_no').value = currentAvatarIndex;

    updateCustomAvatarPanelVisibility();

    // Notify that info may have changed (for Set Info button state)
    if (typeof updateSetInfoButtonState === 'function') updateSetInfoButtonState();

    if (withFade) {
        // small, pleasant fade
        const imgs = document.querySelectorAll('#avatar_group img');
        imgs.forEach(img => {
            img.classList.add('avatar-fade');
            // remove class after animation so next change can trigger again
            setTimeout(() => img.classList.remove('avatar-fade'), fadeMs);
        });
    }
}

// helper
function setImg(id, file) {
    const img = document.getElementById(id);
    if (!img) return;

    if (file === CUSTOM_AVATAR_ID) {
        const thumb = window.customAvatar && window.customAvatar.thumbnailDataUrl;
        const raw = window.customAvatar && window.customAvatar.dataUrl;
        img.src = thumb || raw || CUSTOM_AVATAR_PLACEHOLDER_SRC;
        return;
    }

    img.src = (window.PQ_ORIGIN || PQ_ORIGIN) + "/avatars/" + file;
}

// Update only the carousel slots that show the custom avatar, without re-triggering updateCarousel
function syncCustomAvatarCarouselImages() {
    if (!Array.isArray(avatars) || avatars.length === 0) return;
    const prev = (currentAvatarIndex - 1 + avatars.length) % avatars.length;
    const next = (currentAvatarIndex + 1) % avatars.length;
    if (avatars[currentAvatarIndex] === CUSTOM_AVATAR_ID) setImg('avatar_current_img', CUSTOM_AVATAR_ID);
    if (avatars[prev] === CUSTOM_AVATAR_ID) setImg('avatar_prev_img', CUSTOM_AVATAR_ID);
    if (avatars[next] === CUSTOM_AVATAR_ID) setImg('avatar_next_img', CUSTOM_AVATAR_ID);
}

// Snapshot the current preview canvas (user image + mask) as the carousel thumbnail.
// Persists to localStorage so it survives reloads.
function captureCustomAvatarThumbnail() {
    if (!window.customAvatar) return;
    const canvas = document.getElementById('custom_avatar_preview');
    const payload = window.customAvatar.payload;
    if (!canvas || !payload || !payload.Data) {
        window.customAvatar.thumbnailDataUrl = null;
        try { localStorage.removeItem(CUSTOM_AVATAR_THUMBNAIL_STORAGE_KEY); } catch (e) { /* ignore */ }
        syncCustomAvatarCarouselImages();
        return;
    }
    try {
        const dataUrl = canvas.toDataURL('image/png');
        window.customAvatar.thumbnailDataUrl = dataUrl;
        try { localStorage.setItem(CUSTOM_AVATAR_THUMBNAIL_STORAGE_KEY, dataUrl); } catch (e) { /* storage full */ }
    } catch (e) {
        console.error(e);
    }
    syncCustomAvatarCarouselImages();
}

function restoreCustomAvatarThumbnail() {
    if (!window.customAvatar) return;
    try {
        const dataUrl = localStorage.getItem(CUSTOM_AVATAR_THUMBNAIL_STORAGE_KEY);
        if (dataUrl) window.customAvatar.thumbnailDataUrl = dataUrl;
    } catch (e) { /* ignore */ }
}

function ensureCustomAvatarInList() {
    if (!Array.isArray(avatars)) avatars = [];

    const allowed = (window.allowCustomAvatars !== false);

    // If host disallowed custom avatars, hide the option entirely in UI.
    if (!allowed) {
        avatars = avatars.filter(x => x !== CUSTOM_AVATAR_ID);
        if (currentAvatarIndex >= avatars.length) currentAvatarIndex = 0;

        const openBtn = document.getElementById('custom_avatar_open_btn');
        if (openBtn) openBtn.hidden = true;
        return;
    }

    if (!avatars.includes(CUSTOM_AVATAR_ID)) avatars.push(CUSTOM_AVATAR_ID);
}

function isCustomAvatarSelected() {
    return avatars[currentAvatarIndex] === CUSTOM_AVATAR_ID;
}

function updateCustomAvatarPanelVisibility() {
    const openBtn = document.getElementById('custom_avatar_open_btn');
    if (openBtn) openBtn.hidden = !isCustomAvatarSelected();
    if (isCustomAvatarSelected()) refreshCustomAvatarPanel();
}

function initCustomAvatarUIOnce() {
    if (customAvatarUiInitialized) return;
    customAvatarUiInitialized = true;
    loadCustomAvatarMask();

    const panel = document.getElementById('custom_avatar_panel');
    const fileInput = document.getElementById('custom_avatar_file');
    const uploadBig = document.getElementById('custom_avatar_upload_button_big');
    const upload = document.getElementById('custom_avatar_upload_button');
    const resetBtn = document.getElementById('custom_avatar_reset_button');

    if (!panel || !fileInput || !uploadBig || !upload || !resetBtn) {
        // Template might be outdated; keep carousel working.
        return;
    }

    const pickFile = () => {
        clearCustomAvatarError();
        fileInput.value = '';
        fileInput.click();
    };

    uploadBig.addEventListener('click', pickFile);
    upload.addEventListener('click', pickFile);

    fileInput.addEventListener('change', async function () {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;

        setCustomAvatarError(t('processing_image'));

        try {
            const payload = await prepareCustomAvatarPayloadFromFile(file);
            setCustomAvatarPayload(payload);
            clearCustomAvatarError();
        } catch (err) {
            console.error(err);
            if (err && err.code === 'CUSTOM_AVATAR_TOO_LARGE') {
                const msg = t('custom_avatar_too_large');
                setCustomAvatarError(msg);
                if (typeof window.reportError === 'function') window.reportError(msg);
            } else {
                const msg = t('custom_avatar_invalid_image');
                setCustomAvatarError(msg);
                if (typeof window.reportError === 'function') window.reportError(msg);
            }
        } finally {
            refreshCustomAvatarPanel();
            // Update carousel images so the "custom" slot shows the uploaded preview immediately.
            updateCarousel(false);
        }
    });

    resetBtn.addEventListener('click', function () {
        clearCustomAvatarError();
        resetCustomAvatarParamsToDefaults();
        if (typeof updateSetInfoButtonState === 'function') updateSetInfoButtonState();
        refreshCustomAvatarPanel();
    });

    // --- Interactive canvas: drag to pan, scroll/pinch to zoom ---
    // Gestures captured on the whole modal panel so user can drag from anywhere,
    // not only over the preview canvas itself.
    var previewCanvas = document.getElementById('custom_avatar_preview');
    var flatView = document.getElementById('ca_flat_view');
    var flatPreviewCenter = document.querySelector('#ca_flat_view .ca-preview-center');
    // Only flat preview gestures: scoped to flat view container, not whole modal
    var gestureSurface = flatPreviewCenter || previewCanvas;
    if (previewCanvas && gestureSurface) {
        var isDragging = false;
        var lastX = 0;
        var lastY = 0;
        var lastPinchDist = 0;
        var lastPinchAngle = 0;
        var ctrlDown = false;
        var ROTATION_SPEED = 0.01;

        var ZOOM_STEP = 1.1;
        var MIN_SCALE = 0.1;
        var MAX_SCALE = 5.0;
        var PAN_SPEED = 0.5; // multiplier on drag delta — lower = slower pan

        function applyInteraction() {
            renderCustomAvatarPreview().catch(function (err) { console.error(err); });
            if (typeof updateSetInfoButtonState === 'function') updateSetInfoButtonState();
        }

        function getCanvasDisplaySize() {
            var rect = previewCanvas.getBoundingClientRect();
            return { w: rect.width || 200, h: rect.height || 200 };
        }

        // Skip gesture capture when user interacts with controls (buttons, file input, etc.).
        function isInteractiveTarget(target) {
            if (!target || !target.closest) return false;
            return !!target.closest('button, input, select, textarea, a, label, [role="button"]');
        }

        // Mouse: drag to pan
        gestureSurface.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return; // only left button
            if (window.currentView === '3d') return;
            var flatEl = document.getElementById('ca_flat_view');
            if (flatEl && flatEl.hidden) return;
            if (flatView && !flatView.contains(e.target)) return;
            if (isInteractiveTarget(e.target)) return;
            var payload = window.customAvatar && window.customAvatar.payload;
            if (!payload || !payload.Data) return;
            isDragging = true;
            ctrlDown = e.ctrlKey;
            lastX = e.clientX;
            lastY = e.clientY;
            previewCanvas.style.cursor = 'grabbing';
            e.preventDefault();
        });

        window.addEventListener('mousemove', function (e) {
            if (!isDragging) return;
            if (window.currentView === '3d') return;
            var payload = window.customAvatar && window.customAvatar.payload;
            if (!payload) return;

            if (ctrlDown) {
                var rotDx = e.clientX - lastX;
                payload.Rotation = normalizeAngle(payload.Rotation + rotDx * ROTATION_SPEED);
                lastX = e.clientX;
                lastY = e.clientY;
            } else {
                var size = getCanvasDisplaySize();
                var dx = (e.clientX - lastX) / size.w;
                var dy = (e.clientY - lastY) / size.h;
                lastX = e.clientX;
                lastY = e.clientY;

                payload.OffsetX -= dx * PAN_SPEED / payload.Scale;
                payload.OffsetY += dy * PAN_SPEED / payload.Scale;
            }

            applyInteraction();
        });

        window.addEventListener('mouseup', function () {
            if (isDragging) {
                isDragging = false;
                ctrlDown = false;
                previewCanvas.style.cursor = 'grab';
            }
        });

        // Mouse: scroll to zoom
        gestureSurface.addEventListener('wheel', function (e) {
            if (window.currentView === '3d') return;
            var flatEl = document.getElementById('ca_flat_view');
            if (flatEl && flatEl.hidden) return;
            if (flatView && !flatView.contains(e.target)) return;
            if (isInteractiveTarget(e.target)) return;
            var payload = window.customAvatar && window.customAvatar.payload;
            if (!payload || !payload.Data) return;

            e.preventDefault();
            var factor = e.deltaY < 0 ? ZOOM_STEP : (1 / ZOOM_STEP);
            payload.Scale = clamp(payload.Scale * factor, MIN_SCALE, MAX_SCALE);
            applyInteraction();
        }, { passive: false });

        // Touch: 1-finger drag to pan, 2-finger pinch to zoom
        gestureSurface.addEventListener('touchstart', function (e) {
            if (window.currentView === '3d') return;
            var flatEl = document.getElementById('ca_flat_view');
            if (flatEl && flatEl.hidden) return;
            if (flatView && !flatView.contains(e.target)) return;
            if (isInteractiveTarget(e.target)) return;
            var payload = window.customAvatar && window.customAvatar.payload;
            if (!payload || !payload.Data) return;

            if (e.touches.length === 1) {
                isDragging = true;
                lastX = e.touches[0].clientX;
                lastY = e.touches[0].clientY;
            } else if (e.touches.length === 2) {
                isDragging = false;
                var dx = e.touches[0].clientX - e.touches[1].clientX;
                var dy = e.touches[0].clientY - e.touches[1].clientY;
                lastPinchDist = Math.sqrt(dx * dx + dy * dy);
                lastPinchAngle = Math.atan2(dy, dx);
            }
            e.preventDefault();
        }, { passive: false });

        gestureSurface.addEventListener('touchmove', function (e) {
            if (window.currentView === '3d') return;
            var flatEl = document.getElementById('ca_flat_view');
            if (flatEl && flatEl.hidden) return;
            var payload = window.customAvatar && window.customAvatar.payload;
            if (!payload) return;

            if (e.touches.length === 1 && isDragging) {
                var size = getCanvasDisplaySize();
                var dx = (e.touches[0].clientX - lastX) / size.w;
                var dy = (e.touches[0].clientY - lastY) / size.h;
                lastX = e.touches[0].clientX;
                lastY = e.touches[0].clientY;

                payload.OffsetX -= dx * PAN_SPEED / payload.Scale;
                payload.OffsetY += dy * PAN_SPEED / payload.Scale;
                applyInteraction();
            } else if (e.touches.length === 2 && lastPinchDist > 0) {
                var pdx = e.touches[0].clientX - e.touches[1].clientX;
                var pdy = e.touches[0].clientY - e.touches[1].clientY;
                var dist = Math.sqrt(pdx * pdx + pdy * pdy);
                var angle = Math.atan2(pdy, pdx);

                // Zoom
                var factor = dist / lastPinchDist;
                payload.Scale = clamp(payload.Scale * factor, MIN_SCALE, MAX_SCALE);

                // Rotation
                var angleDelta = angle - lastPinchAngle;
                if (angleDelta > Math.PI) angleDelta -= 2 * Math.PI;
                if (angleDelta < -Math.PI) angleDelta += 2 * Math.PI;
                payload.Rotation = normalizeAngle(payload.Rotation + angleDelta);

                lastPinchDist = dist;
                lastPinchAngle = angle;
                applyInteraction();
            }
            e.preventDefault();
        }, { passive: false });

        gestureSurface.addEventListener('touchend', function (e) {
            if (e.touches.length === 0) {
                isDragging = false;
                lastPinchDist = 0;
                lastPinchAngle = 0;
            } else if (e.touches.length === 1) {
                // Went from 2 fingers to 1 — start panning from current finger
                isDragging = true;
                lastX = e.touches[0].clientX;
                lastY = e.touches[0].clientY;
                lastPinchDist = 0;
                lastPinchAngle = 0;
            }
        });
    }

    // Restore cached payload (if any) so Host won't clear it on next SetInfo.
    restoreCustomAvatarFromStorage();
    restoreCustomAvatarThumbnail();
    syncCustomAvatarCarouselImages();
    refreshCustomAvatarPanel();
}

function refreshCustomAvatarPanel() {
    const payload = window.customAvatar && window.customAvatar.payload;
    const hasPayload = payload && payload.Data;

    const uploadBig = document.getElementById('custom_avatar_upload_button_big');
    const actionsRow = document.getElementById('custom_avatar_actions_row');

    if (uploadBig) uploadBig.hidden = !!hasPayload;
    if (actionsRow) actionsRow.hidden = !hasPayload;

    renderCustomAvatarPreview().catch(err => console.error(err));
}

function resetCustomAvatarParamsToDefaults() {
    const payload = window.customAvatar && window.customAvatar.payload;
    if (!payload) return;

    payload.TilingX = CUSTOM_AVATAR_DEFAULTS.TilingX;
    payload.TilingY = CUSTOM_AVATAR_DEFAULTS.TilingY;
    payload.OffsetX = CUSTOM_AVATAR_DEFAULTS.OffsetX;
    payload.OffsetY = CUSTOM_AVATAR_DEFAULTS.OffsetY;
    payload.Scale = CUSTOM_AVATAR_DEFAULTS.Scale;
    payload.Rotation = CUSTOM_AVATAR_DEFAULTS.Rotation;

    persistCustomAvatarToStorage();
}

function setCustomAvatarPayload(payload) {
    if (!payload || !payload.Data) return;

    sanitizeCustomAvatarParamsInPlace(payload);

    window.customAvatar.payload = payload;
    window.customAvatar.dataUrl = 'data:image/png;base64,' + payload.Data;

    // Reset cached preview image to avoid using an old one.
    window.customAvatar._previewImg = null;
    window.customAvatar._previewImgSrc = null;
    window.customAvatar._uploadedHash = null;

    // Invalidate thumbnail (stale for new image); regenerate on next Confirm.
    window.customAvatar.thumbnailDataUrl = null;
    try { localStorage.removeItem(CUSTOM_AVATAR_THUMBNAIL_STORAGE_KEY); } catch (e) { /* ignore */ }

    persistCustomAvatarToStorage();

    // Notify that info changed
    if (typeof updateSetInfoButtonState === 'function') updateSetInfoButtonState();
}

function clearCustomAvatarPayload() {
    if (window.customAvatar) {
        window.customAvatar.payload = null;
        window.customAvatar.dataUrl = null;
        window.customAvatar.thumbnailDataUrl = null;
        window.customAvatar._previewImg = null;
        window.customAvatar._previewImgSrc = null;
        window.customAvatar._uploadedHash = null;
    }

    try { localStorage.removeItem(CUSTOM_AVATAR_THUMBNAIL_STORAGE_KEY); } catch (e) { /* ignore */ }

    try {
        localStorage.removeItem(CUSTOM_AVATAR_STORAGE_KEY);
    } catch (e) {
        // ignore
    }

    // Notify that info changed
    if (typeof updateSetInfoButtonState === 'function') updateSetInfoButtonState();
}

function persistCustomAvatarToStorage() {
    const payload = window.customAvatar && window.customAvatar.payload;
    if (!payload || !payload.Data) return;

    try {
        localStorage.setItem(CUSTOM_AVATAR_STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
        // ignore (storage full / disabled)
    }
}

function restoreCustomAvatarFromStorage() {
    try {
        const raw = localStorage.getItem(CUSTOM_AVATAR_STORAGE_KEY);
        if (!raw) return;

        const payload = JSON.parse(raw);
        if (!payload || !payload.Data) return;

        // Minimal sanity checks (Host validates the payload size too).
        if (typeof payload.Width !== 'number' || typeof payload.Height !== 'number') return;

        sanitizeCustomAvatarParamsInPlace(payload);

        window.customAvatar.payload = payload;
        window.customAvatar.dataUrl = 'data:image/png;base64,' + payload.Data;
    } catch (e) {
        // ignore
    }
}

function clearCustomAvatarError() {
    const el = document.getElementById('custom_avatar_error');
    if (!el) return;
    el.textContent = '';
}

function setCustomAvatarError(message) {
    const el = document.getElementById('custom_avatar_error');
    if (!el) return;
    el.textContent = message || '';
}

async function renderCustomAvatarPreview() {
    var canvas = document.getElementById('custom_avatar_preview');
    if (!canvas) return;

    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;

    var token = ++customAvatarPreviewRenderToken;
    var payload = window.customAvatar && window.customAvatar.payload;
    var hasPayload = payload && payload.Data && window.customAvatar.dataUrl;

    // Placeholder preview.
    if (!hasPayload) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#7EAFEC';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.font = '700 20px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('CUSTOM', canvas.width / 2, canvas.height / 2 - 10);
        ctx.font = '600 14px Arial, sans-serif';
        ctx.fillText(t('upload_custom_avatar'), canvas.width / 2, canvas.height / 2 + 18);
        return;
    }

    var img = await ensurePreviewImageLoaded(window.customAvatar.dataUrl);
    if (!img) return;
    if (token !== customAvatarPreviewRenderToken) return;

    var scale = safeNumber(payload.Scale, CUSTOM_AVATAR_DEFAULTS.Scale);
    var offsetX = safeNumber(payload.OffsetX, CUSTOM_AVATAR_DEFAULTS.OffsetX);
    var offsetY = safeNumber(payload.OffsetY, CUSTOM_AVATAR_DEFAULTS.OffsetY);

    var cw = canvas.width;
    var ch = canvas.height;

    // Draw user image scaled — offset applied post-rotation (screen space) to match shader.
    // PREVIEW_BASE_ZOOM compensates for Unity's model UV crop so the 2D preview reflects
    // what the 3D avatar actually shows.
    var effectiveScale = scale * CUSTOM_AVATAR_PREVIEW_BASE_ZOOM;
    var drawW = cw * effectiveScale;
    var drawH = ch * effectiveScale;
    var baseDrawX = (cw - drawW) / 2;
    var baseDrawY = (ch - drawH) / 2;

    var rotation = safeNumber(payload.Rotation, CUSTOM_AVATAR_DEFAULTS.Rotation);

    ctx.clearRect(0, 0, cw, ch);

    ctx.save();
    // Screen-space offset — applied AFTER rotation so pan always moves image in screen direction
    ctx.translate(-offsetX * cw, offsetY * ch);
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate(rotation);
    ctx.translate(-cw / 2, -ch / 2);
    ctx.drawImage(img, baseDrawX, baseDrawY, drawW, drawH);
    ctx.restore();

    // Draw mask overlay on top (un-rotated) — transparent area shows user image
    if (customAvatarMaskImg) {
        ctx.drawImage(customAvatarMaskImg, 0, 0, cw, ch);
    }
}

async function ensurePreviewImageLoaded(src) {
    if (!src) return null;

    if (window.customAvatar && window.customAvatar._previewImgSrc === src && window.customAvatar._previewImg) {
        return window.customAvatar._previewImg;
    }

    const img = new Image();
    img.src = src;

    try {
        if (img.decode) await img.decode();
        else await new Promise(resolve => (img.onload = resolve));
    } catch (e) {
        // ignore
    }

    if (!window.customAvatar) window.customAvatar = {};
    window.customAvatar._previewImg = img;
    window.customAvatar._previewImgSrc = src;
    return img;
}

async function prepareCustomAvatarPayloadFromFile(file) {
    const bitmap = await decodeFileToBitmap(file);

    // Start from decoded image size.
    let width = bitmap.naturalWidth || bitmap.width;
    let height = bitmap.naturalHeight || bitmap.height;

    // Fit within MAX_TEXTURE_DIMENSION.
    const maxDim = Math.max(width, height);
    if (maxDim > CUSTOM_AVATAR_LIMITS.MAX_TEXTURE_DIMENSION) {
        const scale = CUSTOM_AVATAR_LIMITS.MAX_TEXTURE_DIMENSION / maxDim;
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
    }

    let canvas = document.createElement('canvas');
    let ctx = canvas.getContext('2d', {alpha: true});
    canvas.width = width;
    canvas.height = height;

    if (!ctx) throw new Error('Canvas2D not available');
    ctx.imageSmoothingEnabled = true;
    if (typeof ctx.imageSmoothingQuality === 'string') ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);

    if (bitmap.close) bitmap.close();

    let blob = await canvasToPngBlob(canvas);

    // Downscale until the PNG fits the payload limit or we reach MIN_TEXTURE_DIMENSION.
    while (
        blob.size > CUSTOM_AVATAR_LIMITS.MAX_PAYLOAD_BYTES &&
        (canvas.width > CUSTOM_AVATAR_LIMITS.MIN_TEXTURE_DIMENSION || canvas.height > CUSTOM_AVATAR_LIMITS.MIN_TEXTURE_DIMENSION)
        ) {
        const nextWidth = Math.max(CUSTOM_AVATAR_LIMITS.MIN_TEXTURE_DIMENSION, Math.round(canvas.width * 0.8));
        const nextHeight = Math.max(CUSTOM_AVATAR_LIMITS.MIN_TEXTURE_DIMENSION, Math.round(canvas.height * 0.8));

        const nextCanvas = document.createElement('canvas');
        const nextCtx = nextCanvas.getContext('2d', {alpha: true});
        nextCanvas.width = nextWidth;
        nextCanvas.height = nextHeight;
        if (!nextCtx) throw new Error('Canvas2D not available');

        nextCtx.imageSmoothingEnabled = true;
        if (typeof nextCtx.imageSmoothingQuality === 'string') nextCtx.imageSmoothingQuality = 'high';
        nextCtx.drawImage(canvas, 0, 0, nextWidth, nextHeight);
        canvas = nextCanvas;

        blob = await canvasToPngBlob(canvas);
    }

    if (blob.size > CUSTOM_AVATAR_LIMITS.MAX_PAYLOAD_BYTES) {
        const e = new Error('Custom avatar is too large');
        e.code = 'CUSTOM_AVATAR_TOO_LARGE';
        throw e;
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const hash = await hashBytesHex(bytes);
    const data = bytesToBase64(bytes);

    return {
        Data: data,
        Width: canvas.width,
        Height: canvas.height,
        Hash: hash,
        PayloadSize: bytes.length,
        TilingX: CUSTOM_AVATAR_DEFAULTS.TilingX,
        TilingY: CUSTOM_AVATAR_DEFAULTS.TilingY,
        OffsetX: CUSTOM_AVATAR_DEFAULTS.OffsetX,
        OffsetY: CUSTOM_AVATAR_DEFAULTS.OffsetY,
        Scale: CUSTOM_AVATAR_DEFAULTS.Scale,
        Rotation: CUSTOM_AVATAR_DEFAULTS.Rotation
    };
}

async function decodeFileToBitmap(file) {
    // Prefer createImageBitmap (fast + reliable).
    if (window.createImageBitmap) {
        return await createImageBitmap(file);
    }

    // Fallback: <img> decode
    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        img.src = url;
        if (img.decode) await img.decode();
        else await new Promise(resolve => (img.onload = resolve));

        // Convert to an ImageBitmap-like object for drawImage() with width/height.
        return img;
    } finally {
        URL.revokeObjectURL(url);
    }
}

function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (!blob) reject(new Error('Failed to encode PNG'));
            else resolve(blob);
        }, 'image/png');
    });
}

async function hashBytesHex(bytes) {
    // Best-effort SHA-256 (matches Unity client); fallback to a stable non-crypto hash.
    try {
        if (window.crypto && crypto.subtle && crypto.subtle.digest) {
            const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
            return bufferToHex(hashBuffer);
        }
    } catch (e) {
        // ignore
    }

    return fnv1a32Hex(bytes);
}

function bufferToHex(buffer) {
    const arr = new Uint8Array(buffer);
    let s = '';
    for (let i = 0; i < arr.length; i++) {
        s += arr[i].toString(16).padStart(2, '0');
    }
    return s;
}

function fnv1a32Hex(bytes) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        hash ^= bytes[i];
        // Math.imul for 32-bit multiplication.
        hash = Math.imul(hash, 0x01000193);
    }
    // >>> 0 forces unsigned.
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function bytesToBase64(bytes) {
    // btoa expects binary string; chunk to avoid call stack limits.
    let binary = '';
    const chunkSize = 0x2000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
}

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

function sanitizeCustomAvatarParamsInPlace(payload) {
    if (!payload) return;

    payload.TilingX = clamp(safeNumber(payload.TilingX, CUSTOM_AVATAR_DEFAULTS.TilingX), -3, 3);
    payload.TilingY = clamp(safeNumber(payload.TilingY, CUSTOM_AVATAR_DEFAULTS.TilingY), -3, 3);
    payload.OffsetX = clamp(safeNumber(payload.OffsetX, CUSTOM_AVATAR_DEFAULTS.OffsetX), -2, 2);
    payload.OffsetY = clamp(safeNumber(payload.OffsetY, CUSTOM_AVATAR_DEFAULTS.OffsetY), -2, 2);
    payload.Scale = clamp(safeNumber(payload.Scale, CUSTOM_AVATAR_DEFAULTS.Scale), 0.1, 5);
    payload.Rotation = safeNumber(payload.Rotation, CUSTOM_AVATAR_DEFAULTS.Rotation);
}

function safeNumber(v, fallback) {
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
}

function formatFloat(v) {
    const n = safeNumber(v, 0);
    return n.toFixed(2);
}

function normalizeAngle(a) {
    return Math.atan2(Math.sin(a), Math.cos(a));
}

