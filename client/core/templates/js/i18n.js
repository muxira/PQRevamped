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

        // Collect text nodes first, then process. This avoids TreeWalker issues
        // when setTextWithBr replaces a node (which breaks iteration).
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
                    if (!v || v.indexOf('{{') === -1) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );
        while (walker.nextNode()) textNodes.push(walker.currentNode);

        // Now process collected nodes.
        for (let i = 0; i < textNodes.length; i++) {
            const node = textNodes[i];
            if (!node.parentNode) continue; // may have been removed
            const replaced = node.nodeValue.replace(templateRe, (_, key) => t(key));
            setTextWithBr(node, replaced);
        }

        // Replace {{key}} inside common attributes.
        const attrNames = ['placeholder', 'title', 'aria-label', 'value'];
        const nodes = container.querySelectorAll ? container.querySelectorAll('*') : [];
        for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            for (let j = 0; j < attrNames.length; j++) {
                const attr = attrNames[j];
                const raw = el.getAttribute && el.getAttribute(attr);
                if (!raw || raw.indexOf('{{') === -1) continue;
                const replaced = raw.replace(templateRe, (_, key) => t(key));
                // Attributes cannot contain <br>; convert to newlines to avoid showing raw tags.
                el.setAttribute(attr, replaced.replace(BR_SPLIT_RE, '\n'));
            }
        }
    }

    function applyDataI18n(t) {
        const els = document.querySelectorAll('[data-i18n]');
        for (let i = 0; i < els.length; i++) {
            const el = els[i];
            const key = el.getAttribute('data-i18n');
            if (!key) continue;
            const txt = t(key);
            // Use setTextWithBr for proper <br> handling; it will replace content
            // For elements that originally had only text, we replace textContent
            // For spans wrapping text inside buttons, this correctly updates just the span
            setTextWithBr(el, txt);
        }
        const phEls = document.querySelectorAll('[data-i18n-placeholder]');
        for (let i = 0; i < phEls.length; i++) {
            const el = phEls[i];
            const key = el.getAttribute('data-i18n-placeholder');
            if (!key) continue;
            const txt = t(key);
            el.setAttribute('placeholder', txt.replace(BR_SPLIT_RE, '\n'));
        }
    }

    const langFromQuery = getLangFromQuery();
    let currentLang = (langFromQuery || safeGetStoredLang() || DEFAULT_LANG).toLowerCase();
    safeStoreLang(currentLang);

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
            dict = await fetchJson(buildLangUrl(currentLang));
        } catch (e) {
            // Fallback to english (best-effort).
            try {
                if (currentLang !== DEFAULT_LANG) dict = await fetchJson(buildLangUrl(DEFAULT_LANG));
            } catch (e2) {
                dict = null;
            }
        }

        t = makeTranslator(dict);

        // Set direction early (mostly for Arabic).
        try {
            document.documentElement.dir = isRtlLang(currentLang) ? 'rtl' : 'ltr';
        } catch (e) {
            // ignore
        }

        // Apply templates only when DOM is ready.
        whenDomReady(() => {
            try {
                applyTemplates(document, t);
                applyDataI18n(t);
            } catch (e) {
                // ignore
            }
        });
    })();

    window.i18n = {
        get lang() {
            return currentLang;
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
        async setLanguage(nextLang) {
            const next = String(nextLang || '').trim().toLowerCase();
            if (!next || next === currentLang) return;
            safeStoreLang(next);
            try {
                const url = new URL(window.location.href);
                url.searchParams.set('lang', next);
                window.history.replaceState({}, '', url.toString());
            } catch (e) {
                // ignore - URL update is non-critical
            }
            try {
                let newDict = null;
                try {
                    newDict = await fetchJson(buildLangUrl(next));
                } catch (e) {
                    if (next !== DEFAULT_LANG) {
                        try { newDict = await fetchJson(buildLangUrl(DEFAULT_LANG)); } catch (e2) { newDict = null; }
                    }
                }
                dict = newDict;
                t = makeTranslator(dict);
                currentLang = next;
                try { document.documentElement.dir = isRtlLang(next) ? 'rtl' : 'ltr'; } catch (e) { /* ignore */ }
                applyTemplates(document, t);
                applyDataI18n(t);
                try { window.dispatchEvent(new CustomEvent('pq:languageChanged', {detail: {lang: next}})); } catch (e) { /* ignore */ }
            } catch (e) {
                console.error('Failed to switch language', e);
            }
        }
    };

    // Convenience alias for the rest of the codebase.
    window.t = window.i18n.t;
})();