// Loads translations from: ../../localized/<lang>/lang.json
// Exposes:
// - window.i18n.ready (Promise)
// - window.i18n.t(key)
// - window.t(key) alias
// - window.i18n.apply(root?) to replace {{key}} templates in the DOM
(() => {
    const STORAGE_KEY = 'pq_lang';
    const DEFAULT_LANG = 'english';

     const BR_SPLIT_RE = /<br\s*\/?>/ig;
     const BR_DETECT_RE = /<br\s*\/?>/i;

    function safeGetStoredLang() {
        try {
            return localStorage.getItem(STORAGE_KEY);
        } catch (e) {
            return null;
        }
    }

    function safeStoreLang(lang) {
        try {
            localStorage.setItem(STORAGE_KEY, lang);
        } catch (e) {
            // ignore
        }
    }

    function getLangFromQuery() {
        try {
            const url = new URL(window.location.href);
            const lang = url.searchParams.get('lang');
            return lang ? lang.trim() : null;
        } catch (e) {
            return null;
        }
    }

    function isRtlLang(lang) {
        // Add more if needed.
        return String(lang).toLowerCase() === 'arabic';
    }

    function buildLangUrl(lang) {
        // game.html is served from Client/core/templates/game.html
        // so ../../localized/... points to Client/localized/...
        const u = new URL(`../../localized/${encodeURIComponent(lang)}/lang.json`, window.location.href);
        // Very lightweight cache-bust (allows Unity to overwrite the file).
        u.searchParams.set('v', String(Date.now()));
        return u.toString();
    }

    async function fetchJson(url) {
        const res = await fetch(url, {cache: 'no-store'});
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

     // Safely renders "<BR>" / "<br/>" as actual line breaks without using innerHTML.
     function setTextWithBr(targetNode, text) {
         if (!targetNode) return;

         const s = String(text ?? '');

         // Fast path: no <br> tag present.
         if (!BR_DETECT_RE.test(s)) {
             // For Elements, prefer textContent; for Text nodes, use nodeValue.
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

         if (targetNode.nodeType === Node.TEXT_NODE) {
             parent.replaceChild(frag, targetNode);
         } else {
             while (parent.firstChild) parent.removeChild(parent.firstChild);
             parent.appendChild(frag);
         }
     }

    function applyTemplates(root, t) {
        const container = root || document;
        const templateRe = /\{\{([^{}\r\n]+)\}\}/g;

        // PQRevamped: replay strategy for {{key}} text nodes.
        // Upstream replaces `{{join_game}}` once during DOMContentLoaded; the original
        // template is then gone, so a later setLanguage() has nothing to translate.
        // We remember each text node's pre-translation source in a side data structure
        // (Map keyed by a synthetic id, kept on the text node itself) so subsequent
        // calls re-translate from the source. Same for attributes.
        if (!applyTemplates._srcText) applyTemplates._srcText = new WeakMap();

        // ----- 1) {{key}} in text nodes (upstream behaviour, with replay) -----
        const textNodes = [];
        const walker = document.createTreeWalker(
            container,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    if (!node || !node.parentNode) return NodeFilter.FILTER_REJECT;
                    const tag = node.parentNode.nodeName;
                    if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
                    const v = node.nodeValue;
                    if (!v) return NodeFilter.FILTER_REJECT;
                    // Pick up nodes that still have templates, OR nodes whose source we
                    // recorded earlier (so we can re-translate on language change).
                    if (v.indexOf('{{') !== -1) return NodeFilter.FILTER_ACCEPT;
                    if (applyTemplates._srcText.has(node)) return NodeFilter.FILTER_ACCEPT;
                    return NodeFilter.FILTER_REJECT;
                }
            }
        );
        while (walker.nextNode()) textNodes.push(walker.currentNode);

        for (let i = 0; i < textNodes.length; i++) {
            const node = textNodes[i];
            if (!node.parentNode) continue;
            const v = node.nodeValue;
            if (v.indexOf('{{') !== -1) {
                // First pass: save source, translate.
                applyTemplates._srcText.set(node, v);
                const replaced = v.replace(templateRe, (_, key) => t(key));
                setTextWithBr(node, replaced);
            } else {
                // Replay: read source, re-translate.
                const src = applyTemplates._srcText.get(node);
                if (src) {
                    const replaced = src.replace(templateRe, (_, key) => t(key));
                    setTextWithBr(node, replaced);
                }
            }
        }

        // ----- 2) {{key}} in common attributes (upstream behaviour, with replay) -----
        const attrNames = ['placeholder', 'title', 'aria-label', 'value'];
        const nodes = container.querySelectorAll ? container.querySelectorAll('*') : [];
        for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            for (let j = 0; j < attrNames.length; j++) {
                const attr = attrNames[j];
                const raw = el.getAttribute && el.getAttribute(attr);
                if (!raw) continue;
                // If the attribute still has {{}}, translate; otherwise skip (already done).
                if (raw.indexOf('{{') !== -1) {
                    el.setAttribute('data-pq-i18n-attr-src-' + attr, raw);
                    const r = raw.replace(templateRe, (_, key) => t(key));
                    el.setAttribute(attr, r.replace(BR_SPLIT_RE, '\n'));
                } else {
                    // Replay from saved source if any.
                    const src = el.getAttribute('data-pq-i18n-attr-src-' + attr);
                    if (src) {
                        const r = src.replace(templateRe, (_, key) => t(key));
                        el.setAttribute(attr, r.replace(BR_SPLIT_RE, '\n'));
                    }
                }
            }
        }

        // ----- 3) PQRevamped: data-i18n* attributes (replay-safe) -----
        //   data-i18n="key"            -> textContent of the element
        //   data-i18n-placeholder="key" -> placeholder attribute
        //   data-i18n-title="key"       -> title attribute
        //   data-i18n-aria-label="key"  -> aria-label attribute
        //   data-i18n-value="key"       -> value attribute (for input/button)
        // Original text/attrs are saved on first pass as data-i18n-*_src.
        const i18nEls = container.querySelectorAll
            ? container.querySelectorAll('[data-i18n],[data-i18n-placeholder],[data-i18n-title],[data-i18n-aria-label],[data-i18n-value]')
            : [];
        for (let i = 0; i < i18nEls.length; i++) {
            const el = i18nEls[i];
            const tk = el.getAttribute('data-i18n');
            if (tk) {
                let src = el.getAttribute('data-i18n-src');
                if (src == null) {
                    src = el.textContent;
                    el.setAttribute('data-i18n-src', src);
                }
                setTextWithBr(el, t(tk));
            }
            const pk = el.getAttribute('data-i18n-placeholder');
            if (pk) {
                let src = el.getAttribute('data-i18n-placeholder-src');
                if (src == null) {
                    src = el.getAttribute('placeholder') || '';
                    el.setAttribute('data-i18n-placeholder-src', src);
                }
                el.setAttribute('placeholder', t(pk));
            }
            const tt = el.getAttribute('data-i18n-title');
            if (tt) {
                let src = el.getAttribute('data-i18n-title-src');
                if (src == null) {
                    src = el.getAttribute('title') || '';
                    el.setAttribute('data-i18n-title-src', src);
                }
                el.setAttribute('title', t(tt));
            }
            const al = el.getAttribute('data-i18n-aria-label');
            if (al) {
                let src = el.getAttribute('data-i18n-aria-label-src');
                if (src == null) {
                    src = el.getAttribute('aria-label') || '';
                    el.setAttribute('data-i18n-aria-label-src', src);
                }
                el.setAttribute('aria-label', t(al));
            }
            const va = el.getAttribute('data-i18n-value');
            if (va) {
                let src = el.getAttribute('data-i18n-value-src');
                if (src == null) {
                    src = el.getAttribute('value') || '';
                    el.setAttribute('data-i18n-value-src', src);
                }
                el.setAttribute('value', t(va));
            }
        }
    }

    const langFromQuery = getLangFromQuery();
    // PQRevamped: module-mutable lang so setLanguage() can update it after a no-reload switch.
    let lang = (langFromQuery || safeGetStoredLang() || DEFAULT_LANG).toLowerCase();
    safeStoreLang(lang);

    let dict = null;
    let t = makeTranslator(dict);

    // Wait for DOM to be ready before applying templates.
    function whenDomReady(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn, {once: true});
        } else {
            fn();
        }
    }

    const ready = (async () => {
        try {
            dict = await fetchJson(buildLangUrl(lang));
        } catch (e) {
            // Fallback to english (best-effort).
            try {
                if (lang !== DEFAULT_LANG) dict = await fetchJson(buildLangUrl(DEFAULT_LANG));
            } catch (e2) {
                dict = null;
            }
        }

        t = makeTranslator(dict);

        // Set direction early (mostly for Arabic).
        try {
            document.documentElement.dir = isRtlLang(lang) ? 'rtl' : 'ltr';
        } catch (e) {
            // ignore
        }

        // Apply templates only when DOM is ready.
        whenDomReady(() => {
            try {
                applyTemplates(document, t);
            } catch (e) {
                // ignore
            }
        });
    })();

    window.i18n = {
        get lang() {
            return lang;
        },
        set lang(v) {
            lang = String(v || '').toLowerCase();
        },
        get dict() {
            return dict;
        },
        ready,
        t(key) {
            return t(key);
        },
        setTextWithBr(el, text) {
            setTextWithBr(el, text);
        },
        apply(root) {
            applyTemplates(root || document, t);
        },
        setLanguage(nextLang) {
            // PQRevamped: NO-RELOAD language switch.
            // The upstream implementation reloads the page, which trips WebSocket
            // mid-game and the server counts the round as PASS / exit / no-bid.
            // We fetch the new dict, swap it in, re-apply {{key}} / data-i18n,
            // and dispatch pq:languageChanged so main.js can re-render
            // titles/undertitles from its lastStateData.
            const next = String(nextLang || '').trim().toLowerCase();
            if (!next || next === lang) return;
            safeStoreLang(next);
            // Reflect in URL bar without reload.
            try {
                const url = new URL(window.location.href);
                url.searchParams.set('lang', next);
                window.history.replaceState(null, '', url.toString());
            } catch (e) { /* ignore */ }
            // Load + swap dict synchronously-ish.
            (async () => {
                try {
                    const newDict = await fetchJson(buildLangUrl(next));
                    dict = newDict;
                    t = makeTranslator(dict);
                    // PQRevamped: update the module-mutable lang after the new dict lands,
                    // otherwise subsequent switch-back to the original language is a no-op
                    // because next === lang still holds the initial value.
                    lang = next;
                    try { document.documentElement.dir = isRtlLang(next) ? 'rtl' : 'ltr'; } catch (e) { /* ignore */ }
                    try { applyTemplates(document, t); } catch (e) { console.error('[i18n.apply]', e); }
                    // Notify main.js / anyone else (lastStateData re-render, select update, etc.)
                    try {
                        document.dispatchEvent(new CustomEvent('pq:languageChanged', { detail: { lang: next }}));
                    } catch (e) { /* ignore */ }
                } catch (e) {
                    console.error('[i18n.setLanguage] failed to load', next, e);
                }
            })();
        }
    };

    // Convenience alias for the rest of the codebase.
    window.t = window.i18n.t;
})();