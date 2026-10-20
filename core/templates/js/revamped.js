// revamped.js — PQRevamped quality-of-life layer.
//
// Loaded after main.js on purpose: everything here is additive. It owns the settings
// sheet (language / theme / haptics / wake lock), the no-reload language switch glue,
// the friendly leave confirmation and a few mobile niceties. It never patches the
// game protocol and never replaces an upstream screen.
(() => {
    'use strict';

    const VERSION = '2.0.0';
    const SETTINGS_KEY = 'pq_settings_v1';
    const THEME_KEY = 'pq_theme';
    const LAST_GAME_KEY = 'pq_last_game';

    const LANGS = [
        ['english', 'English'],
        ['russian', 'Русский'],
        ['ukrainian', 'Українська'],
        ['spanish', 'Español'],
        ['spanishlatinamerica', 'Español (LatAm)'],
        ['german', 'Deutsch'],
        ['portuguese', 'Português'],
        ['french', 'Français'],
        ['polish', 'Polski'],
        ['italian', 'Italiano'],
        ['turkish', 'Türkçe'],
        ['czech', 'Čeština'],
        ['swedish', 'Svenska'],
        ['kazakh', 'Қазақша'],
        ['simplifiedchinese', '简体中文'],
        ['japanese', '日本語'],
        ['korean', '한국어'],
        ['arabic', 'العربية'],
    ];

    const DEFAULTS = {
        theme: 'auto',      // auto | studio | night
        haptics: true,
        keepAwake: false,
    };

    const settings = loadSettings();
    let wakeLock = null;
    let sheet = null;
    let sheetOverlay = null;
    let lastFocus = null;

    /* ------------------------------------------------------------------ storage */

    function loadSettings() {
        let raw = null;
        try { raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { raw = null; }
        const settings = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
        // A theme picked with the upstream header toggle (or before this sheet existed)
        // lives in pq_theme only; adopt it instead of silently resetting to "auto".
        if (!raw || !('theme' in raw)) {
            try {
                const stored = localStorage.getItem(THEME_KEY);
                if (stored === 'studio' || stored === 'night') settings.theme = stored;
            } catch (e) { /* private mode */ }
        }
        return settings;
    }

    function saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ }
    }

    function readThemePreference() {
        try {
            const v = localStorage.getItem(THEME_KEY);
            return v === 'studio' || v === 'night' ? v : 'auto';
        } catch (e) { return 'auto'; }
    }

    // The upstream theme toggle writes pq_theme directly; keep our setting in sync.
    function mirrorStoredTheme() {
        settings.theme = readThemePreference();
        saveSettings();
        renderSheetState();
    }

    /* -------------------------------------------------------------------- theme */

    function systemPrefersDark() {
        try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
    }

    function resolvedTheme() {
        return settings.theme === 'auto' ? (systemPrefersDark() ? 'night' : 'studio') : settings.theme;
    }

    function applyTheme() {
        const root = document.documentElement;
        if (settings.theme === 'auto') root.removeAttribute('data-pq-theme');
        else root.setAttribute('data-pq-theme', settings.theme);

        try {
            if (settings.theme === 'auto') localStorage.removeItem(THEME_KEY);
            else localStorage.setItem(THEME_KEY, settings.theme);
        } catch (e) { /* ignore */ }

        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', resolvedTheme() === 'night' ? '#140f28' : '#7b3fe4');

        const toggle = document.getElementById('pq_theme_toggle');
        if (toggle) toggle.textContent = resolvedTheme() === 'night' ? '☀' : '☾';
        renderSheetState();
    }

    function setTheme(value) {
        settings.theme = ['auto', 'studio', 'night'].includes(value) ? value : 'auto';
        saveSettings();
        applyTheme();
    }

    /* ----------------------------------------------------------------- haptics */

    function installHapticGate() {
        // main.js calls pqHaptic() internally, so wrapping window.pqHaptic would miss
        // most buzzes. Gating navigator.vibrate covers every caller, including future
        // ones, and is a no-op on iOS (where the API does not exist).
        if (!navigator.vibrate || navigator.vibrate.__pqGated) return;
        const original = navigator.vibrate.bind(navigator);
        const gated = function (pattern) {
            if (!settings.haptics) return false;
            try { return original(pattern); } catch (e) { return false; }
        };
        gated.__pqGated = true;
        try { navigator.vibrate = gated; } catch (e) { /* frozen in some webviews */ }
    }

    /* --------------------------------------------------------------- wake lock */

    async function requestWakeLock() {
        if (!settings.keepAwake || document.visibilityState !== 'visible') return;
        if (!('wakeLock' in navigator) || wakeLock) return;
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        } catch (e) {
            // Battery saver, unsupported browser, or a non-secure origin.
            wakeLock = null;
        }
    }

    async function releaseWakeLock() {
        if (!wakeLock) return;
        try { await wakeLock.release(); } catch (e) { /* ignore */ }
        wakeLock = null;
    }

    function syncWakeLock() {
        if (settings.keepAwake) requestWakeLock();
        else releaseWakeLock();
    }

    /* ---------------------------------------------------------------- settings UI */

    function icon(name) {
        const paths = {
            close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
            auto: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M12 3a9 9 0 0 1 0 18"/>',
            sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
            moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
        };
        return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
    }

    function buildSheet() {
        if (sheet) return;

        sheetOverlay = document.createElement('div');
        sheetOverlay.className = 'pq-sheet-overlay';
        sheetOverlay.id = 'pq_settings_overlay';
        sheetOverlay.hidden = true;

        sheet = document.createElement('section');
        sheet.className = 'pq-sheet';
        sheet.id = 'pq_settings_sheet';
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        sheet.setAttribute('aria-labelledby', 'pq_settings_title');
        sheet.hidden = true;

        const langButtons = LANGS.map(([id, label]) =>
            `<button type="button" class="pq-lang" data-lang="${id}" lang="${id === 'simplifiedchinese' ? 'zh-Hans' : id}" aria-pressed="false">${label}</button>`
        ).join('');

        sheet.innerHTML = `
            <div class="pq-sheet__grip" id="pq_sheet_grip" aria-hidden="true"><span></span></div>
            <header class="pq-sheet__head">
                <div>
                    <p class="pq-sheet__eyebrow">PQREVAMPED</p>
                    <h2 class="pq-sheet__title" id="pq_settings_title" data-i18n="settings">Settings</h2>
                </div>
                <button type="button" class="pq-sheet__close" id="pq_settings_close"
                        aria-label="Close" data-i18n-aria-label="close">${icon('close')}</button>
            </header>
            <div class="pq-sheet__body">
                <section class="pq-sheet__section">
                    <h3 class="pq-sheet__label" data-i18n="language">Language</h3>
                    <div class="pq-lang-grid" id="pq_lang_grid">${langButtons}</div>
                </section>
                <section class="pq-sheet__section">
                    <h3 class="pq-sheet__label" data-i18n="appearance">Appearance</h3>
                    <div class="pq-segmented" id="pq_theme_seg" role="radiogroup" aria-labelledby="pq_theme_label">
                        <span id="pq_theme_label" hidden data-i18n="appearance">Appearance</span>
                        <button type="button" class="pq-segment" data-theme="auto" role="radio" aria-checked="false">${icon('auto')}<span data-i18n="theme_auto">Auto</span></button>
                        <button type="button" class="pq-segment" data-theme="studio" role="radio" aria-checked="false">${icon('sun')}<span data-i18n="theme_studio">Light</span></button>
                        <button type="button" class="pq-segment" data-theme="night" role="radio" aria-checked="false">${icon('moon')}<span data-i18n="theme_night">Dark</span></button>
                    </div>
                </section>
                <section class="pq-sheet__section">
                    <h3 class="pq-sheet__label" data-i18n="more">More</h3>
                    <div class="pq-actions">
                        <button type="button" class="pq-action" id="pq_share_button" hidden>
                            <span class="pq-action__label" data-i18n="share_game">Share game link</span>
                        </button>
                        <button type="button" class="pq-action" id="pq_install_button" hidden>
                            <span class="pq-action__label" data-i18n="install_app">Install app</span>
                        </button>
                        <a class="pq-action" id="pq_source_link"
                           href="https://github.com/muxira/PQRevamped" target="_blank" rel="noopener noreferrer">
                            <span class="pq-action__label">Source code</span>
                        </a>
                    </div>
                    <p class="pq-action__status" id="pq_action_status" role="status" aria-live="polite"></p>
                </section>
                <section class="pq-sheet__section pq-sheet__section--toggles">
                    <label class="pq-toggle" for="pq_setting_haptics">
                        <span class="pq-toggle__text" data-i18n="haptics">Haptic feedback</span>
                        <input type="checkbox" id="pq_setting_haptics" class="pq-toggle__input"/>
                        <span class="pq-toggle__switch" aria-hidden="true"></span>
                    </label>
                    <label class="pq-toggle" for="pq_setting_wake">
                        <span class="pq-toggle__text" data-i18n="keep_awake">Keep screen awake</span>
                        <input type="checkbox" id="pq_setting_wake" class="pq-toggle__input"/>
                        <span class="pq-toggle__switch" aria-hidden="true"></span>
                    </label>
                </section>
            </div>
            <footer class="pq-sheet__foot">
                <span>PQRevamped v${VERSION}</span>
                <a href="https://github.com/muxira/PQRevamped" target="_blank" rel="noopener noreferrer">GitHub</a>
            </footer>
        `;

        document.body.appendChild(sheetOverlay);
        document.body.appendChild(sheet);

        sheetOverlay.addEventListener('click', closeSettings);
        sheet.querySelector('#pq_settings_close').addEventListener('click', closeSettings);

        sheet.querySelector('#pq_lang_grid').addEventListener('click', async (event) => {
            const btn = event.target.closest('.pq-lang');
            if (!btn) return;
            const lang = btn.dataset.lang;
            if (lang === window.i18n.lang) return;
            setLanguage(lang);
        });

        sheet.querySelector('#pq_theme_seg').addEventListener('click', (event) => {
            const btn = event.target.closest('.pq-segment');
            if (!btn) return;
            setTheme(btn.dataset.theme);
        });

        sheet.querySelector('#pq_share_button').addEventListener('click', shareGame);
        sheet.querySelector('#pq_install_button').addEventListener('click', () => {
            if (!deferredInstall) return;
            deferredInstall.prompt();
            deferredInstall = null;
            sheet.querySelector('#pq_install_button').hidden = true;
        });

        sheet.querySelector('#pq_setting_haptics').addEventListener('change', (event) => {
            settings.haptics = event.target.checked;
            saveSettings();
            if (settings.haptics) window.pqHaptic && window.pqHaptic(10);
        });

        sheet.querySelector('#pq_setting_wake').addEventListener('change', (event) => {
            settings.keepAwake = event.target.checked;
            saveSettings();
            syncWakeLock();
        });

        // Always useful on a phone; the copy fallback covers desktop browsers.
        const share = sheet.querySelector('#pq_share_button');
        if (share) share.hidden = false;

        // Translate our own labels once the sheet exists.
        try { window.i18n && window.i18n.apply(sheet); } catch (e) { /* ignore */ }
        renderSheetState();
    }

    function renderSheetState() {
        if (!sheet) return;
        const current = (window.i18n && window.i18n.lang) || 'english';

        sheet.querySelectorAll('.pq-lang').forEach((btn) => {
            const active = btn.dataset.lang === current;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        });

        sheet.querySelectorAll('.pq-segment').forEach((btn) => {
            const active = btn.dataset.theme === settings.theme;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-checked', active ? 'true' : 'false');
            btn.tabIndex = active ? 0 : -1;
        });

        const haptics = sheet.querySelector('#pq_setting_haptics');
        if (haptics) haptics.checked = !!settings.haptics;
        const wake = sheet.querySelector('#pq_setting_wake');
        if (wake) {
            wake.checked = !!settings.keepAwake;
            wake.disabled = !('wakeLock' in navigator);
        }
    }

    let sheetHistoryEntry = false;

    function openSettings() {
        buildSheet();
        if (!sheet.hidden) return;
        lastFocus = document.activeElement;
        sheetOverlay.hidden = false;
        sheet.hidden = false;
        document.body.classList.add('pq-sheet-open');
        // Android's back gesture should close the sheet, not leave the game.
        try {
            history.pushState({ pqSheet: true }, '');
            sheetHistoryEntry = true;
        } catch (e) { /* ignore */ }
        installSheetGesture();
        requestAnimationFrame(() => {
            sheet.classList.add('is-open');
            sheetOverlay.classList.add('is-open');
            const close = sheet.querySelector('#pq_settings_close');
            if (close) close.focus({ preventScroll: true });
        });
    }

    function closeSettings(fromHistory) {
        if (!sheet || sheet.hidden) return;
        sheet.classList.remove('is-open');
        sheetOverlay.classList.remove('is-open');
        document.body.classList.remove('pq-sheet-open');
        const finish = () => {
            sheet.hidden = true;
            sheetOverlay.hidden = true;
        };
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
        else setTimeout(finish, 160);
        if (lastFocus && typeof lastFocus.focus === 'function') {
            try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        }
        lastFocus = null;
        if (sheetHistoryEntry && !fromHistory) {
            sheetHistoryEntry = false;
            try { history.back(); } catch (e) { /* ignore */ }
        } else {
            sheetHistoryEntry = false;
        }
    }

    // Swipe the grip (or the header) down to dismiss — the gesture every phone sheet has.
    function installSheetGesture() {
        const grip = sheet.querySelector('#pq_sheet_grip');
        const head = sheet.querySelector('.pq-sheet__head');
        if (!grip || grip.__pqBound) return;
        grip.__pqBound = true;

        let startY = null;
        let delta = 0;

        const onMove = (event) => {
            if (startY == null) return;
            delta = Math.max(0, event.clientY - startY);
            sheet.style.transform = `translateY(${delta}px)`;
            sheetOverlay.style.opacity = String(Math.max(0, 1 - delta / 320));
        };

        const onEnd = () => {
            if (startY == null) return;
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onEnd);
            window.removeEventListener('pointercancel', onEnd);
            sheet.style.transform = '';
            sheetOverlay.style.opacity = '';
            const shouldClose = delta > 96;
            startY = null;
            delta = 0;
            if (shouldClose) closeSettings();
        };

        const onStart = (event) => {
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            startY = event.clientY;
            sheet.style.transition = 'none';
            window.addEventListener('pointermove', onMove, { passive: true });
            window.addEventListener('pointerup', onEnd);
            window.addEventListener('pointercancel', onEnd);
        };

        const onDone = () => { sheet.style.transition = ''; };
        grip.addEventListener('pointerdown', onStart);
        if (head) head.addEventListener('pointerdown', (event) => {
            const el = event.target;
            if (el.closest('button, a, input, select, textarea')) return;
            onStart(event);
        });
        window.addEventListener('pointerup', onDone);
    }

    async function setLanguage(lang) {
        try {
            await window.i18n.setLanguage(lang);
        } catch (e) {
            console.error('[revamped] language switch failed', e);
            return;
        }
        settings.lang = lang;
        saveSettings();
        renderSheetState();
        try { window.i18n.apply(sheet); } catch (e) { /* ignore */ }
    }

    /* ------------------------------------------------------- language re-render */

    function preserveInputs(fn) {
        const fields = Array.from(document.querySelectorAll('input, textarea')).map((el) => ({
            el,
            value: el.value,
            start: typeof el.selectionStart === 'number' ? el.selectionStart : null,
            end: typeof el.selectionEnd === 'number' ? el.selectionEnd : null,
        }));
        const active = document.activeElement;
        fn();
        for (const field of fields) {
            if (!document.contains(field.el)) continue;
            if (field.el.value !== field.value) field.el.value = field.value;
        }
        if (active && document.contains(active) && typeof active.focus === 'function') {
            try {
                active.focus({ preventScroll: true });
                const field = fields.find((f) => f.el === active);
                if (field && field.start != null && active.setSelectionRange) {
                    active.setSelectionRange(field.start, field.end);
                }
            } catch (e) { /* ignore */ }
        }
    }

    function repaintCurrentScreen() {
        if (typeof window.pqGetScreenState !== 'function' || typeof window.goTo !== 'function') return;
        const snapshot = window.pqGetScreenState();
        if (!snapshot || !snapshot.state) return;

        // A modal owns the screen while it is open; re-running goTo would hide it.
        const modalOpen = ['custom_avatar_modal', 'qr_password_modal', 'system_notice_modal']
            .some((id) => {
                const el = document.getElementById(id);
                return el && !el.hidden;
            });
        if (modalOpen) return;

        preserveInputs(() => {
            try { window.goTo(snapshot.state, snapshot.data); } catch (e) { console.error('[revamped] repaint', e); }
        });
    }

    /* ------------------------------------------------------------- share / install */

    let deferredInstall = null;

    function gameIdFromScreen() {
        const input = document.getElementById('game_id');
        const fromInput = input && input.value ? input.value.trim().toUpperCase() : '';
        if (fromInput) return fromInput;
        try { return (localStorage.getItem(LAST_GAME_KEY) || '').toUpperCase(); } catch (e) { return ''; }
    }

    function shareUrl() {
        const url = new URL(location.href);
        url.search = '';
        const gameId = gameIdFromScreen();
        if (gameId) url.searchParams.set('game', gameId);
        return url.toString();
    }

    async function copyText(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (e) { /* fall through */ }
        try {
            const area = document.createElement('textarea');
            area.value = text;
            area.setAttribute('readonly', '');
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(area);
            return ok;
        } catch (e) { return false; }
    }

    async function shareGame() {
        const status = sheet && sheet.querySelector('#pq_action_status');
        const url = shareUrl();
        const title = document.title || 'Party Quiz';
        const gameId = gameIdFromScreen();
        const text = gameId
            ? `${window.i18n.t('game_id')}: ${gameId}`
            : window.i18n.t('join_game');

        if (navigator.share) {
            try {
                await navigator.share({ title, text, url });
                if (status) status.textContent = '';
                return;
            } catch (e) {
                if (e && e.name === 'AbortError') return;
            }
        }
        const ok = await copyText(url);
        if (status) status.textContent = ok ? window.i18n.t('link_copied') : url;
    }

    function installInstallEntry() {
        window.addEventListener('beforeinstallprompt', (event) => {
            event.preventDefault();
            deferredInstall = event;
            buildSheet();
            const button = sheet.querySelector('#pq_install_button');
            if (button) button.hidden = false;
            renderSheetState();
        });
    }

    /* ------------------------------------------------------------ leave confirm */

    function installLeaveConfirm() {
        const original = window.LeaveGame;
        if (typeof original !== 'function' || original.__pqConfirmed) return;
        const wrapped = function () {
            const message = (window.i18n && window.i18n.t('leave_confirm_text')) || 'Leave the game?';
            if (typeof window.pqConfirm === 'function') {
                window.pqConfirm(message, () => original.apply(this, arguments));
            } else if (window.confirm(message)) {
                original.apply(this, arguments);
            }
        };
        wrapped.__pqConfirmed = true;
        window.LeaveGame = wrapped;
    }

    /* -------------------------------------------------------------- last game id */

    function installLastGameId() {
        const input = document.getElementById('game_id');
        if (!input) return;
        try {
            const last = localStorage.getItem(LAST_GAME_KEY);
            const fromUrl = new URL(window.location.href).searchParams.get('game');
            if (!input.value && !fromUrl && last) input.value = last;
        } catch (e) { /* ignore */ }

        const remember = () => {
            const value = input.value.trim().toUpperCase();
            if (!value) return;
            try { localStorage.setItem(LAST_GAME_KEY, value); } catch (e) { /* ignore */ }
        };

        input.addEventListener('change', remember);
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') remember();
        });
        const join = document.getElementById('join_game_button');
        if (join) join.addEventListener('click', remember);
    }

    /* ------------------------------------------------------------ mobile helpers */

    function installViewportHelpers() {
        const vv = window.visualViewport;
        const setVar = () => {
            const h = vv ? vv.height : window.innerHeight;
            document.documentElement.style.setProperty('--pq-vvh', h + 'px');
            document.documentElement.style.setProperty('--pq-keyboard', vv ? Math.max(0, window.innerHeight - vv.height) + 'px' : '0px');
        };
        setVar();
        if (vv) {
            vv.addEventListener('resize', setVar, { passive: true });
            vv.addEventListener('scroll', setVar, { passive: true });
        }
        window.addEventListener('orientationchange', () => setTimeout(setVar, 150), { passive: true });

        // Flag the keyboard so the bottom bar can step out of its way (iOS keeps the
        // layout viewport at full height and only shrinks the visual viewport).
        if (vv) {
            const syncKeyboard = () => {
                const inset = Math.max(0, (window.innerHeight || vv.height) - vv.height - vv.offsetTop);
                const open = inset > 120;
                document.body.classList.toggle('pq-keyboard-open', open);
                document.documentElement.style.setProperty('--pq-keyboard', (open ? inset : 0) + 'px');
            };
            vv.addEventListener('resize', syncKeyboard, { passive: true });
            vv.addEventListener('scroll', syncKeyboard, { passive: true });
            syncKeyboard();
        }
    }

    /* --------------------------------------------------------------------- boot */

    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        if (!/^https?:$/.test(location.protocol)) return;
        try {
            if (new URL(location.href).searchParams.get('nosw') === '1') {
                navigator.serviceWorker.getRegistrations()
                    .then((list) => list.forEach((registration) => registration.unregister()))
                    .catch(() => { /* ignore */ });
                return;
            }
        } catch (e) { /* ignore */ }

        // Register after the first paint: the shell is already cached by then.
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('../../sw.js', { scope: '../../' }).then((registration) => {
                if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
            }).catch(() => {
                // A file:// preview or a host without HTTPS for the SW; nothing breaks.
            });
        }, { once: true });
    }

    function boot() {
        applyTheme();
        registerServiceWorker();
        installHapticGate();
        installLeaveConfirm();
        installLastGameId();
        installViewportHelpers();
        syncWakeLock();

        const button = document.getElementById('pq_settings_button');
        if (button) button.addEventListener('click', openSettings);

        installInstallEntry();

        const themeToggle = document.getElementById('pq_theme_toggle');
        if (themeToggle) {
            themeToggle.addEventListener('click', () => {
                // Upstream ToggleTheme already ran (inline onclick); mirror the result.
                setTimeout(mirrorStoredTheme, 0);
            });
        }

        window.addEventListener('popstate', () => {
            if (sheet && !sheet.hidden) closeSettings(true);
        });

        document.addEventListener('keydown', (event) => {
            if (!sheet || sheet.hidden) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                closeSettings();
                return;
            }
            if (event.key !== 'Tab') return;
            // Keep focus inside the sheet while it is modal.
            const focusable = sheet.querySelectorAll('button, a[href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])');
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        });

        document.addEventListener('pq:languageChanged', () => {
            repaintCurrentScreen();
            renderSheetState();
            try { if (sheet) window.i18n.apply(sheet); } catch (e) { /* ignore */ }
        });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') syncWakeLock();
            else releaseWakeLock();
        });

        // Respect live OS theme changes while on "auto".
        try {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
                if (settings.theme === 'auto') applyTheme();
            });
        } catch (e) { /* older Safari */ }

        // Deep link: ?settings=1 opens the sheet (handy for screenshots and support).
        try {
            if (new URL(window.location.href).searchParams.get('settings') === '1') openSettings();
        } catch (e) { /* ignore */ }

        window.pqRevamped = {
            version: VERSION,
            settings,
            openSettings,
            closeSettings,
            setTheme,
            setLanguage,
        };
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
