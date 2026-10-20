// Loads translations from ../../localized/<lang>/lang.json
// Exposes:
// - window.i18n.ready (Promise)
// - window.i18n.t(key) / window.t(key)
// - window.i18n.apply(root?) — replaces {{key}} templates and data-i18n* attributes
// - window.i18n.setLanguage(lang) — switches language IN PLACE, without a reload
//
// PQRevamped change: upstream reloaded the whole page on a language switch. Mid-game
// that drops the WebSocket and the host counts the round as a pass / no-bid. Here the
// new dictionary is fetched, swapped in, every template is re-rendered from its saved
// source, and a `pq:languageChanged` event lets main.js repaint the current screen.
(() => {
    const STORAGE_KEY = 'pq_lang';
    const DEFAULT_LANG = 'english';

    const BR_SPLIT_RE = /<br\s*\/?>/ig;
    const BR_DETECT_RE = /<br\s*\/?>/i;
    const TEMPLATE_RE = /\{\{([^{}\r\n]+)\}\}/g;

    const LANG_TAGS = {
        arabic: 'ar', czech: 'cs', english: 'en', french: 'fr', german: 'de', italian: 'it',
        japanese: 'ja', kazakh: 'kk', korean: 'ko', polish: 'pl', portuguese: 'pt', russian: 'ru',
        simplifiedchinese: 'zh-Hans', spanish: 'es', spanishlatinamerica: 'es-419', swedish: 'sv',
        turkish: 'tr', ukrainian: 'uk'
    };

    const RTL_LANGS = new Set(['arabic']);

    // Original (pre-translation) text/attribute values, so a later language switch has
    // something to translate. Upstream replaced {{key}} once and then lost the source.
    const sourceText = new WeakMap();
    const sourceAttr = new WeakMap(); // el -> { attrName: sourceString }
    const sourceKeyed = new WeakMap(); // el -> { dataI18nAttr: sourceString }

    function safeGetStoredLang() {
        try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
    }

    function safeStoreLang(lang) {
        try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* private mode */ }
    }

    function getLangFromQuery() {
        try {
            const lang = new URL(window.location.href).searchParams.get('lang');
            return lang ? lang.trim().toLowerCase() : null;
        } catch (e) { return null; }
    }

    function buildLangUrl(lang) {
        const url = new URL(`../../localized/${encodeURIComponent(lang)}/lang.json`, window.location.href);
        // Light cache-bust: keeps a long-lived static host from pinning an old dictionary.
        url.searchParams.set('v', String(Date.now()));
        return url.toString();
    }

    async function fetchJson(url) {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`Failed to load i18n json: ${res.status} ${res.statusText}`);
        return await res.json();
    }

    function makeTranslator(dict) {
        return function t(key) {
            const k = String(key ?? '').trim();
            if (!k) return '';
            if (dict && Object.prototype.hasOwnProperty.call(dict, k)) {
                const v = dict[k];
                return (v === null || v === undefined) ? k : String(v);
            }
            return k;
        };
    }

    // Renders "<BR>" / "<br/>" as real line breaks without innerHTML.
    function setTextWithBr(targetNode, text) {
        if (!targetNode) return;
        const s = String(text ?? '');

        if (!BR_DETECT_RE.test(s)) {
            if (targetNode.nodeType === Node.TEXT_NODE) targetNode.nodeValue = s;
            else targetNode.textContent = s;
            return;
        }

        const parent = (targetNode.nodeType === Node.TEXT_NODE) ? targetNode.parentNode : targetNode;
        if (!parent) return;

        const frag = document.createDocumentFragment();
        const parts = s.split(BR_SPLIT_RE);
        for (let i = 0; i < parts.length; i++) {
            frag.appendChild(document.createTextNode(parts[i]));
            if (i !== parts.length - 1) frag.appendChild(document.createElement('br'));
        }

        if (targetNode.nodeType === Node.TEXT_NODE) parent.replaceChild(frag, targetNode);
        else {
            while (parent.firstChild) parent.removeChild(parent.firstChild);
            parent.appendChild(frag);
        }
    }

    function renderTemplates(container, t) {
        const root = container || document;

        // 1) {{key}} inside text nodes.
        const textNodes = [];
        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    if (!node || !node.parentNode) return NodeFilter.FILTER_REJECT;
                    const tag = node.parentNode.nodeName;
                    if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
                    if (node.nodeValue.indexOf('{{') !== -1 || sourceText.has(node)) {
                        return NodeFilter.FILTER_ACCEPT;
                    }
                    return NodeFilter.FILTER_REJECT;
                }
            }
        );
        while (walker.nextNode()) textNodes.push(walker.currentNode);

        for (const node of textNodes) {
            if (!node.parentNode) continue;
            if (!sourceText.has(node) && node.nodeValue.indexOf('{{') !== -1) {
                sourceText.set(node, node.nodeValue);
            }
            const src = sourceText.get(node);
            if (src != null) setTextWithBr(node, src.replace(TEMPLATE_RE, (_, key) => t(key)));
        }

        // 2) {{key}} inside common attributes.
        const attrNames = ['placeholder', 'title', 'aria-label', 'value'];
        const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (const el of nodes) {
            for (const attr of attrNames) {
                const raw = el.getAttribute && el.getAttribute(attr);
                if (raw == null) continue;
                let store = sourceAttr.get(el);
                if (!store) { store = {}; sourceAttr.set(el, store); }
                if (raw.indexOf('{{') !== -1 && store[attr] == null) store[attr] = raw;
                const src = store[attr];
                if (src != null) {
                    const replaced = src.replace(TEMPLATE_RE, (_, key) => t(key));
                    el.setAttribute(attr, replaced.replace(BR_SPLIT_RE, '\n'));
                }
            }
        }

        // 3) Explicit data-i18n hooks. Useful for markup we add ourselves and for
        //    labels that upstream fills with JS rather than templates.
        const keyed = root.querySelectorAll
            ? root.querySelectorAll('[data-i18n],[data-i18n-placeholder],[data-i18n-title],[data-i18n-aria-label],[data-i18n-value]')
            : [];
        const KEY_ATTRS = {
            'data-i18n': null,
            'data-i18n-placeholder': 'placeholder',
            'data-i18n-title': 'title',
            'data-i18n-aria-label': 'aria-label',
            'data-i18n-value': 'value'
        };
        for (const el of keyed) {
            let store = sourceKeyed.get(el);
            if (!store) { store = {}; sourceKeyed.set(el, store); }
            for (const [dataAttr, targetAttr] of Object.entries(KEY_ATTRS)) {
                const key = el.getAttribute(dataAttr);
                if (!key) continue;
                if (targetAttr === null) {
                    setTextWithBr(el, t(key));
                } else {
                    if (store[targetAttr] == null) store[targetAttr] = el.getAttribute(targetAttr) || '';
                    el.setAttribute(targetAttr, String(t(key)).replace(BR_SPLIT_RE, '\n'));
                }
            }
        }
    }

    function applyDocumentLanguage(lang) {
        try {
            document.documentElement.dir = RTL_LANGS.has(lang) ? 'rtl' : 'ltr';
            document.documentElement.lang = LANG_TAGS[lang] || 'en';
        } catch (e) { /* ignore */ }
    }

    function whenDomReady(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn, { once: true });
        } else {
            fn();
        }
    }

    let lang = (getLangFromQuery() || safeGetStoredLang() || DEFAULT_LANG).toLowerCase();
    safeStoreLang(lang);

    let dict = null;
    let t = makeTranslator(dict);
    let switchToken = 0;

    const ready = (async () => {
        // English is merged underneath the active language: a key that a translation
        // has not caught up with yet renders in English instead of as a raw `key`.
        const [baseResult, currentResult] = await Promise.allSettled([
            lang === DEFAULT_LANG ? Promise.resolve(null) : fetchJson(buildLangUrl(DEFAULT_LANG)),
            fetchJson(buildLangUrl(lang))
        ]);

        const base = baseResult.status === 'fulfilled' ? baseResult.value : null;
        if (baseResult.status === 'rejected') console.warn('[i18n] English dictionary is unavailable', baseResult.reason);

        if (currentResult.status === 'fulfilled') {
            const current = currentResult.value;
            dict = base ? Object.assign({}, base, current) : current;
        } else {
            console.warn('[i18n] Falling back to English', currentResult.reason);
            dict = base;
            if (!base) {
                try { dict = await fetchJson(buildLangUrl(DEFAULT_LANG)); } catch (e) { dict = null; }
            }
            lang = DEFAULT_LANG;
        }

        t = makeTranslator(dict);
        applyDocumentLanguage(lang);

        whenDomReady(() => {
            try { renderTemplates(document, t); } catch (e) { console.error('[i18n.render]', e); }
            // main.js may render its first screen before/after this promise; either way a
            // second pass once everything is parsed keeps templates and attributes in sync.
            requestAnimationFrame(() => {
                try { renderTemplates(document, t); } catch (e) { /* ignore */ }
            });
        });
    })();

    async function setLanguage(nextLang) {
        const next = String(nextLang || '').trim().toLowerCase();
        if (!next || next === lang) return lang;

        const token = ++switchToken;
        const url = buildLangUrl(next);
        const nextDictRaw = await fetchJson(url);
        if (token !== switchToken) return lang; // a newer switch won the race

        const basePromise = lang === DEFAULT_LANG && dict ? Promise.resolve(dict) : fetchJson(buildLangUrl(DEFAULT_LANG)).catch(() => null);
        const base = await basePromise;
        if (token !== switchToken) return lang;

        dict = base ? Object.assign({}, base, nextDictRaw) : nextDictRaw;
        t = makeTranslator(dict);
        lang = next;

        safeStoreLang(lang);
        applyDocumentLanguage(lang);
        try {
            const pageUrl = new URL(window.location.href);
            pageUrl.searchParams.set('lang', lang);
            window.history.replaceState(null, '', pageUrl.toString());
        } catch (e) { /* ignore */ }

        try { renderTemplates(document, t); } catch (e) { console.error('[i18n.render]', e); }

        try {
            document.dispatchEvent(new CustomEvent('pq:languageChanged', { detail: { lang, dict } }));
        } catch (e) { /* ignore */ }

        return lang;
    }

    window.i18n = {
        get lang() { return lang; },
        get dict() { return dict; },
        ready,
        t(key) { return t(key); },
        setTextWithBr(el, text) { setTextWithBr(el, text); },
        apply(root) { renderTemplates(root || document, t); },
        setLanguage
    };

    window.t = window.i18n.t;
})();
