(function () {
    'use strict';

    const LOOTBOX_HIDE_AFTER_STOP_MS = 6500;
    const TOAST_MS = 3000;
    const ANNOUNCE_MS = 3000;
    const HINT_MAX_MS = 90000;
    const XRAY_GLYPHS = { CatInPoke: '🐱', Auction: '💰', MultipleChoice: '🔤', NumberGuess: '🔢', RevealingClues: '🧩' };
    const ACTIVATABLE = [0, 2, 3, 4, 5];
    const TYPE_KEYS = ['hint', 'shield', 'xray', 'joker', 'not_done', 'victim'];
    const TYPE_ICONS = ['💡', '🛡️', '🔍', '🃏', '🔁', '🎯'];
    const RARITY = [0, 0, 1, 1, 2, 3];
    const TYPE_SHIELD = 1;
    const TYPE_VICTIM = 5;
    const BADGES = [['Joker', 3], ['Hint', 0], ['Xray', 2], ['NotFinished', 4]];

    const state = {
        seq: -1, mine: null, selectionOpen: false, activateSent: false,
        panelOpen: false, panelKind: null, hint: null, xray: null,
        timers: { toast: 0, announce: 0, hint: 0, lootboxHide: 0, panel: 0 }
    };

    function el(id) { return document.getElementById(id); }
    function tr(key) { return window.t(key); }
    function trf(key, vars) { return window.tf(key, vars); }
    function isHost() { return typeof window.pqIsHost === 'function' && window.pqIsHost(); }
    function typeIndex(id) { return Number.isInteger(id) && id >= 0 && id < TYPE_KEYS.length ? id : 0; }
    function typeName(id) { return tr('bonus_name_' + TYPE_KEYS[typeIndex(id)]); }
    function typeIcon(id) { return TYPE_ICONS[typeIndex(id)]; }

    function div(cls, text) {
        const d = document.createElement('div');
        if (cls) d.className = cls;
        if (text != null) d.textContent = text;
        return d;
    }

    function toast(text, ms, id) {
        const box = el(id || 'bonus_toast');
        if (!box) return;
        box.textContent = text;
        box.hidden = false;
        const slot = id === 'bonus_announce' ? 'announce' : 'toast';
        clearTimeout(state.timers[slot]);
        state.timers[slot] = setTimeout(() => { box.hidden = true; box.textContent = ''; }, ms);
    }

    function announce(type, name) {
        const box = el('bonus_announce');
        if (!box) return;
        box.textContent = '';
        box.appendChild(div('bonus-announce-icon', typeIcon(type)));
        box.appendChild(div('bonus-announce-name', typeName(type)));
        if (name) box.appendChild(div('bonus-announce-who', name));
        box.hidden = false;
        clearTimeout(state.timers.announce);
        state.timers.announce = setTimeout(() => { box.hidden = true; box.textContent = ''; }, ANNOUNCE_MS);
    }

    // ---- panel ----

    function panelParts() {
        const p = el('bonus_panel');
        return {
            panel: p,
            title: p.querySelector('.bonus-panel-title'),
            timer: p.querySelector('.bonus-panel-timer'),
            body: p.querySelector('.bonus-panel-body'),
            confirm: el('bonus_confirm_button')
        };
    }

    function closePanel() {
        clearInterval(state.timers.panel);
        state.panelOpen = false;
        state.panelKind = null;
        const p = panelParts();
        p.panel.hidden = true;
        p.body.textContent = '';
        p.confirm.disabled = true;
        p.confirm.onclick = null;
        renderTray();
    }

    function openPanel(kind, titleKey, sec, onTimeout) {
        closePanel();
        const p = panelParts();
        state.panelOpen = true;
        state.panelKind = kind;
        p.title.textContent = tr(titleKey);
        p.body.textContent = '';
        p.confirm.disabled = true;
        p.panel.hidden = false;
        const deadline = Date.now() + Math.max(0, Number(sec) || 0) * 1000;
        const tick = () => {
            const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
            p.timer.textContent = trf('bonus_seconds', { n: left });
            p.timer.classList.toggle('is-urgent', left <= 5);
            if (left <= 0) {
                clearInterval(state.timers.panel);
                if (state.panelKind === kind) {
                    if (onTimeout) onTimeout();
                    closePanel();
                }
            }
        };
        tick();
        state.timers.panel = setInterval(tick, 250);
        renderTray();
        return p;
    }

    function choiceCard(typeId, extra, disabledText) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'bonus-choice';
        card.style.setProperty('--rc', 'var(--bonus-r' + RARITY[typeIndex(typeId)] + ', var(--pq-gold))');
        card.appendChild(div('bonus-choice-icon', typeIcon(typeId)));
        const info = div('bonus-choice-info');
        info.appendChild(div('bonus-choice-name', typeName(typeId)));
        info.appendChild(div('bonus-choice-desc', disabledText || tr('bonus_desc_' + TYPE_KEYS[typeIndex(typeId)])));
        if (extra) info.appendChild(div('bonus-choice-tag', extra));
        card.appendChild(info);
        if (disabledText) { card.disabled = true; card.classList.add('is-disabled'); }
        return card;
    }

    // picks one of the cards; confirm sends exactly once
    function wireSelect(p, cards, onConfirm) {
        let selected = -1;
        let sent = false;
        cards.forEach((card, i) => {
            if (card.disabled) return;
            card.addEventListener('click', () => {
                if (sent) return;
                selected = i;
                cards.forEach((c, j) => c.classList.toggle('is-selected', j === i));
                p.confirm.disabled = false;
            });
        });
        p.confirm.onclick = () => {
            if (sent || selected < 0) return;
            sent = true;
            p.confirm.disabled = true;
            onConfirm(selected);
        };
    }

    function showDiscard(m) {
        pqBonusLootboxHide();
        const p = openPanel('discard', 'bonus_discard_title', m.Sec, null);
        const items = m.Items || [];
        const cards = items.map((id, i) => choiceCard(id, i === items.length - 1 ? tr('bonus_new') : null));
        cards.forEach(c => p.body.appendChild(c));
        wireSelect(p, cards, i => { BonusDiscardChoice(m.Seq, i); closePanel(); });
    }

    function showChoose(m) {
        const p = openPanel('choose', 'bonus_choose', Math.max(0, (m.MaxSec || 0) - (m.ElapsedSec || 0)), null);
        const items = m.Items || [];
        const cards = items.map(id => {
            let off = null;
            if (id === TYPE_SHIELD) off = tr('bonus_desc_shield');
            else if (id === TYPE_VICTIM && !m.VictimAllowed) off = tr('bonus_no_victims');
            return choiceCard(id, null, id === TYPE_SHIELD || off ? off : null);
        });
        cards.forEach(c => p.body.appendChild(c));
        state.activation = m;
        wireSelect(p, cards, slot => { BonusChoose(m.ActivationId, slot); p.confirm.disabled = true; });
    }

    function showVictimPick(m) {
        const act = state.activation;
        const ids = (act && act.CandidateIds) || [];
        const names = (act && act.CandidateNames) || [];
        const p = openPanel('victim', 'bonus_pick_question', m.MaxSec, null);
        const pick = { theme: -1, question: -1, victim: null };
        let sent = false;
        const update = () => { p.confirm.disabled = sent || pick.theme < 0 || pick.victim == null; };

        const grid = div('bonus-pick-grid');
        (m.Themes || []).forEach(theme => {
            const row = div('bonus-pick-row');
            row.appendChild(div('bonus-pick-theme', theme.theme));
            const cells = div('bonus-pick-cells');
            (theme.questions || []).forEach(q => {
                const c = document.createElement('button');
                c.type = 'button';
                c.className = 'bonus-pick-cell';
                c.textContent = q.price;
                if (q.wasAnswered) {
                    c.disabled = true;
                    c.classList.add('is-answered');
                } else {
                    c.addEventListener('click', () => {
                        if (sent) return;
                        pick.theme = theme.id;
                        pick.question = q.id;
                        grid.querySelectorAll('.bonus-pick-cell').forEach(x => x.classList.remove('is-selected'));
                        c.classList.add('is-selected');
                        update();
                    });
                }
                cells.appendChild(c);
            });
            row.appendChild(cells);
            grid.appendChild(row);
        });
        p.body.appendChild(grid);

        p.body.appendChild(div('bonus-panel-subtitle', tr('bonus_pick_player')));
        const list = div('bonus-pick-players');
        ids.forEach((id, i) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'bonus-pick-player';
            b.textContent = names[i] != null ? names[i] : '?';
            b.addEventListener('click', () => {
                if (sent) return;
                pick.victim = id;
                list.querySelectorAll('.bonus-pick-player').forEach(x => x.classList.remove('is-selected'));
                b.classList.add('is-selected');
                update();
            });
            list.appendChild(b);
        });
        p.body.appendChild(list);

        p.confirm.onclick = () => {
            if (sent || p.confirm.disabled) return;
            sent = true;
            p.confirm.disabled = true;
            BonusVictimPick(m.ActivationId, pick.theme, pick.question, pick.victim);
        };
    }

    function pqBonusLootboxHide() {
        clearTimeout(state.timers.lootboxHide);
        if (window.pqBonusLootbox) window.pqBonusLootbox.Hide();
    }

    // ---- tray ----

    function renderTray() {
        const tray = el('bonus_tray');
        if (!tray) return;
        const mine = state.mine;
        const items = (mine && mine.Items) || [];
        const active = BADGES.filter(([flag]) => mine && mine[flag]);
        const visible = !isHost() && !(window.teamMode && !window.amCaptain) && (items.length > 0 || active.length > 0);
        tray.hidden = !visible;
        if (!visible) return;

        for (let i = 0; i < 2; i++) {
            const slot = el('bonus_slot_' + i);
            if (i < items.length) {
                slot.textContent = typeIcon(items[i]);
                slot.title = typeName(items[i]);
                slot.style.setProperty('--rc', 'var(--bonus-r' + RARITY[typeIndex(items[i])] + ', var(--pq-gold))');
                slot.classList.remove('is-empty');
            } else {
                slot.textContent = '';
                slot.title = tr('bonus_slot_empty');
                slot.classList.add('is-empty');
            }
        }

        const badges = el('bonus_badges');
        badges.textContent = '';
        active.forEach(([, type]) => {
            const b = document.createElement('span');
            b.className = 'bonus-badge';
            b.textContent = typeIcon(type);
            b.title = typeName(type);
            badges.appendChild(b);
        });

        const canActivate = state.selectionOpen && !mine.Blocked && !state.panelOpen && !state.activateSent
            && items.some(id => ACTIVATABLE.indexOf(id) !== -1);
        const activate = el('bonus_activate_button');
        activate.hidden = !state.selectionOpen;
        activate.disabled = !canActivate;
    }

    // ---- board ----

    function hideHint() {
        clearTimeout(state.timers.hint);
        state.hint = null;
        const h = el('bonus_hint');
        if (h) { h.hidden = true; h.textContent = ''; }
    }

    function DecorateBoard() {
        document.querySelectorAll('.bonus-xray-mark').forEach(n => n.remove());
        const x = state.xray;
        if (!x) return;
        const marks = {};
        const add = (t, q, text) => { const k = t + ':' + q; marks[k] = (marks[k] || '') + text; };
        (x.BonusThemes || []).forEach((t, i) => add(t, (x.BonusQuestions || [])[i], '🎁'));
        (x.Themes || []).forEach((t, i) => add(t, x.Questions[i], XRAY_GLYPHS[x.Types && x.Types[i]] || ''));
        Object.keys(marks).forEach(k => {
            const [t, q] = k.split(':');
            const cell = document.querySelector('.questions-row-item[data-theme="' + t + '"][data-question="' + q + '"]');
            if (!cell || !marks[k] || cell.classList.contains('is-answered')) return;
            const mark = document.createElement('span');
            mark.className = 'bonus-xray-mark';
            mark.textContent = marks[k];
            cell.insertBefore(mark, cell.firstChild);
        });
    }

    // ---- messages ----

    function Handle(command, m) {
        m = m || {};
        switch (command) {
            case 'BonusState': {
                if (m.Seq <= state.seq) return;
                state.seq = m.Seq;
                const me = m.YourId || (window.pqMyRosterId && window.pqMyRosterId());
                state.mine = (m.Players || []).find(p => p.PlayerId === me) || null;
                state.selectionOpen = !!m.SelectionOpen;
                state.activateSent = false;
                if (!state.selectionOpen) state.xray = null;
                renderTray();
                break;
            }
            case 'BonusLootbox':
                if (m.IsYou && window.pqBonusLootbox) {
                    clearTimeout(state.timers.lootboxHide);
                    window.pqBonusLootbox.Play(m, s => BonusStopRequest(s));
                } else {
                    toast(trf('bonus_gets', { name: m.PlayerName }), TOAST_MS);
                }
                break;
            case 'BonusLootboxStop':
                if (window.pqBonusLootbox && window.pqBonusLootbox.IsActive()) {
                    window.pqBonusLootbox.Stop(m);
                    clearTimeout(state.timers.lootboxHide);
                    state.timers.lootboxHide = setTimeout(pqBonusLootboxHide, LOOTBOX_HIDE_AFTER_STOP_MS);
                }
                break;
            case 'BonusDiscardOffer':
                if (m.IsYou) showDiscard(m);
                break;
            case 'BonusActivationStarted':
                if (m.IsYou) showChoose(m);
                break;
            case 'BonusChosen':
                announce(m.Type, m.PlayerName);
                if (m.IsYou && m.Type === TYPE_VICTIM) showVictimPick(m);
                else if (state.panelKind === 'choose') closePanel();
                break;
            case 'BonusApplied':
                closePanel();
                state.activation = null;
                break;
            case 'BonusCancelled':
                closePanel();
                state.activation = null;
                toast(trf('bonus_cancelled', { name: m.PlayerName }), TOAST_MS);
                break;
            case 'BonusHint': {
                state.hint = m;
                const h = el('bonus_hint');
                h.textContent = trf('bonus_hint', { mask: m.Mask });
                h.hidden = false;
                clearTimeout(state.timers.hint);
                state.timers.hint = setTimeout(hideHint, HINT_MAX_MS);
                break;
            }
            case 'BonusXray':
                state.xray = m;
                DecorateBoard();
                break;
            case 'BonusBurned':
                toast(tr(m.Reason === 'final' ? 'bonus_burned' : 'bonus_burned_nobody'), TOAST_MS);
                if (m.Reason === 'final') { state.mine = null; renderTray(); }
                break;
        }
    }

    const activateButton = el('bonus_activate_button');
    if (activateButton) {
        activateButton.addEventListener('click', () => {
            if (activateButton.disabled) return;
            state.activateSent = true;
            activateButton.disabled = true;
            BonusActivate();
        });
    }

    window.pqBonus = { Handle: Handle, DecorateBoard: DecorateBoard, HideHint: hideHint };
})();
