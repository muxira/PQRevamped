(function () {
    const CARD_STEP_PX = 92;
    const CARD_PX = 84;
    const LEAD_PX = 8;
    const SPIN_SPEED_PX = 2000;
    const SPIN_RAMP_MS = 500;
    const DECEL_SEC = 2.3;
    const OVERSHOOT = 0.3;
    const SETTLE_MS = 450;
    const REWARD_DELAY_MS = 800;
    const CARD_COUNT = 420;
    const CLIENT_STOP_GRACE_SEC = 3;
    const TICK_MIN_GAP_MS = 28;
    const DEFAULT_AUTOSTOP_SEC = 10;
    const COIN_COUNTS = [18, 30, 45, 80];
    const SPARK_COUNTS = [10, 16, 26, 40];
    const GEM_COUNTS = [0, 10, 18, 30];
    const RARITY_COLORS = ['var(--bonus-r0)', 'var(--bonus-r1)', 'var(--bonus-r2)', 'var(--bonus-r3)'];

    const TYPES = [
        { key: 'hint', icon: '💡', rarity: 0 },
        { key: 'shield', icon: '🛡️', rarity: 0 },
        { key: 'xray', icon: '👁️', rarity: 1 },
        { key: 'joker', icon: '🃏', rarity: 1 },
        { key: 'not_done', icon: '🔁', rarity: 2 },
        { key: 'victim', icon: '🎯', rarity: 3 }
    ];

    let root = null, strip = null, reel = null, stopButton = null, autoBar = null, autoFill = null;
    let rewardEl = null, fxEl = null, flashEl = null;
    let state = 'idle'; // idle | spinning | stopping | settle | landed
    let lootbox = null, onStopPressed = null;
    let pos = 0, vel = 0, spinStart = 0, lastT = 0, lastIdx = -1, lastTickAt = 0;
    let stopFrom = 0, stopDist = 0, stopDur = 0, stopT0 = 0, settleFrom = 0, settleTo = 0, settleT0 = 0;
    let winIndex = -1, raf = 0, safetyTimer = 0, rewardTimer = 0, extraTimer = 0;
    let ac = null;

    function tr(key) {
        return typeof window.t === 'function' ? window.t(key) : key;
    }

    function clampInt(v, max) {
        v = Number(v);
        return Number.isInteger(v) && v >= 0 && v <= max ? v : 0;
    }

    function typeOf(id) {
        return TYPES[clampInt(id, TYPES.length - 1)];
    }

    function reducedMotion() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function bind() {
        root = document.getElementById('bonus_lootbox');
        if (!root) return false;
        strip = root.querySelector('.bonus-strip');
        reel = root.querySelector('.bonus-reel');
        stopButton = document.getElementById('bonus_stop_button');
        autoBar = root.querySelector('.bonus-autobar');
        autoFill = root.querySelector('.bonus-autofill');
        rewardEl = root.querySelector('.bonus-reward');
        fxEl = root.querySelector('.bonus-fx');
        flashEl = root.querySelector('.bonus-flash');
        return true;
    }

    // audio
    function audio() {
        try {
            if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
            if (ac.state === 'suspended') ac.resume();
            return ac;
        } catch (e) {
            return null;
        }
    }

    function beep(freq, dur, type, gain, delay, slideTo) {
        const a = audio();
        if (!a) return;
        try {
            const t0 = a.currentTime + (delay || 0), o = a.createOscillator(), g = a.createGain();
            o.type = type || 'square';
            o.frequency.setValueAtTime(freq, t0);
            if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
            g.gain.setValueAtTime(gain || .08, t0);
            g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
            o.connect(g).connect(a.destination);
            o.start(t0);
            o.stop(t0 + dur + .02);
        } catch (e) { /* audio unavailable */ }
    }

    function jingle(r) {
        const base = [523, 659, 784, 1047, 1319, 1568, 2093];
        const len = [4, 5, 6, 7][r];
        for (let i = 0; i < len; i++) beep(base[i], .14, 'square', .06, i * .075);
        beep(base[len - 1], .5, 'square', .05, len * .075);
        if (r >= 2) for (let i = 0; i < 10; i++) beep(2000 + Math.random() * 1500, .05, 'sine', .03, .6 + i * .05);
        if (r === 3) {
            beep(130, .6, 'sawtooth', .07, 0, 65);
            for (let i = 0; i < 4; i++) beep([1047, 1319, 1568, 2093][i], .3, 'triangle', .05, .9 + i * .1);
        }
    }

    // geometry
    function viewHalf() { return reel.clientHeight / 2; }
    function setPos(p) { strip.style.transform = 'translate3d(0,' + (-p) + 'px,0)'; }
    function idxAtMarker(p) { return Math.floor((p + viewHalf() - LEAD_PX) / CARD_STEP_PX); }

    function buildCard(typeId) {
        const type = typeOf(typeId);
        const card = document.createElement('div');
        card.className = 'bonus-card';
        card.style.setProperty('--rc', RARITY_COLORS[type.rarity]);
        const icon = document.createElement('div');
        icon.className = 'bonus-card-icon';
        icon.textContent = type.icon;
        const name = document.createElement('div');
        name.className = 'bonus-card-name';
        name.textContent = tr('bonus_name_' + type.key);
        card.append(icon, name);
        return card;
    }

    function buildStrip(src) {
        const ids = Array.isArray(src) && src.length > 0 ? src : TYPES.map((_, i) => i);
        strip.textContent = '';
        const frag = document.createDocumentFragment();
        for (let i = 0; i < CARD_COUNT; i++) frag.appendChild(buildCard(ids[i % ids.length]));
        strip.appendChild(frag);
    }

    function clearTimers() {
        cancelAnimationFrame(raf);
        clearTimeout(safetyTimer);
        clearTimeout(rewardTimer);
        clearTimeout(extraTimer);
        raf = safetyTimer = rewardTimer = extraTimer = 0;
    }

    function Play(box, stopCallback) {
        if (!root && !bind()) return;
        clearTimers();
        lootbox = box || {};
        onStopPressed = stopCallback;
        const autoSec = Number(lootbox.AutoStopSec) > 0 ? Number(lootbox.AutoStopSec) : DEFAULT_AUTOSTOP_SEC;

        root.classList.remove('shake');
        rewardEl.classList.remove('bonus-show', 'bonus-legend');
        fxEl.textContent = '';
        document.getElementById('bonus_title').textContent = lootbox.IsYou ? '' : String(lootbox.PlayerName || '');
        document.getElementById('bonus_sub').textContent = '';

        buildStrip(lootbox.Strip);
        pos = CARD_STEP_PX * 2;
        vel = 0;
        lastIdx = -1;
        winIndex = -1;
        root.hidden = false;
        setPos(pos);

        stopButton.hidden = !lootbox.IsYou;
        stopButton.disabled = false;
        stopButton.textContent = tr('bonus_stop');
        stopButton.onclick = function () {
            if (state !== 'spinning') return;
            stopButton.disabled = true;
            if (typeof onStopPressed === 'function') onStopPressed(lootbox.Seq);
        };

        autoBar.hidden = false;
        autoFill.style.transition = 'none';
        autoFill.style.transform = 'scaleX(1)';
        void autoFill.offsetWidth;
        autoFill.style.transition = 'transform ' + autoSec + 's linear';
        autoFill.style.transform = 'scaleX(0)';

        audio();
        state = 'spinning';
        spinStart = lastT = performance.now();
        raf = requestAnimationFrame(loop);
        safetyTimer = setTimeout(function () {
            Stop({ Seq: lootbox.Seq, Auto: true });
        }, (autoSec + CLIENT_STOP_GRACE_SEC) * 1000);
    }

    function Stop(msg) {
        if (state !== 'spinning' || !lootbox || !msg || msg.Seq !== lootbox.Seq) return;
        clearTimeout(safetyTimer);
        autoBar.hidden = true;
        stopButton.disabled = true;

        const v = Math.max(vel, 300);
        const roughEnd = pos + v * DECEL_SEC / 3;
        winIndex = Math.min(Math.max(idxAtMarker(roughEnd), 0), CARD_COUNT - 1);
        const landing = buildCard(lootbox.Type);
        strip.replaceChild(landing, strip.children[winIndex]);

        const center = LEAD_PX + winIndex * CARD_STEP_PX + CARD_PX / 2 - viewHalf();
        settleTo = center;
        stopFrom = pos;
        stopDist = center + OVERSHOOT * CARD_STEP_PX - pos;
        stopDur = 3 * stopDist / v;
        stopT0 = performance.now();
        state = 'stopping';
    }

    function loop(now) {
        const dt = Math.min(.05, (now - lastT) / 1000);
        lastT = now;
        if (state === 'spinning') {
            vel = SPIN_SPEED_PX * Math.min(1, (now - spinStart) / SPIN_RAMP_MS);
            pos += vel * dt;
        } else if (state === 'stopping') {
            const t = Math.min(1, (now - stopT0) / 1000 / stopDur), k = 1 - t;
            const prev = pos;
            pos = stopFrom + stopDist * (1 - k * k * k);
            vel = (pos - prev) / Math.max(dt, .001);
            if (t >= 1) { state = 'settle'; settleFrom = pos; settleT0 = now; }
        } else if (state === 'settle') {
            const t = Math.min(1, (now - settleT0) / SETTLE_MS);
            const e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            pos = settleFrom + (settleTo - settleFrom) * e;
            vel = 200;
            if (t >= 1) { state = 'landed'; landed(); }
        }
        setPos(pos);
        const idx = idxAtMarker(pos);
        if (idx !== lastIdx) {
            if (now - lastTickAt > TICK_MIN_GAP_MS) {
                beep(1500 + Math.min(vel, 3000) * .15, .03, 'triangle', .12);
                lastTickAt = now;
            }
            lastIdx = idx;
        }
        if (state !== 'landed') raf = requestAnimationFrame(loop);
    }

    function landed() {
        const card = strip.children[winIndex];
        if (card) card.classList.add('bonus-win');
        beep(660, .12, 'square', .07);
        beep(990, .2, 'square', .06, .1);
        rewardTimer = setTimeout(showReward, REWARD_DELAY_MS);
    }

    function flash() {
        flashEl.classList.remove('bonus-go');
        void flashEl.offsetHeight;
        flashEl.classList.add('bonus-go');
    }

    function burst(delaySec, n, kind) {
        if (n <= 0 || reducedMotion()) return;
        setTimeout(function () {
            if (state === 'idle' || !fxEl) return;
            const W = fxEl.clientWidth, H = fxEl.clientHeight, parts = [];
            for (let i = 0; i < n; i++) {
                const el = document.createElement('div');
                el.className = 'bonus-' + kind;
                fxEl.appendChild(el);
                const a = -Math.PI / 2 + (Math.random() - .5) * Math.PI * 1.3, sp = 380 + Math.random() * 620;
                parts.push({ el: el, x: W / 2, y: H * .4, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, rot: Math.random() * 360, vr: (Math.random() - .5) * 900, life: 0, max: 1.6 + Math.random() * .8, s: kind === 'spark' ? .6 + Math.random() * 1.6 : 1 });
                if (kind === 'coin') setTimeout(function () { beep(2400 + Math.random() * 1600, .05, 'sine', .025); }, i * 25);
            }
            let last = performance.now();
            (function step(now) {
                const dt = Math.min(.04, (now - last) / 1000);
                last = now;
                let alive = false;
                for (const p of parts) {
                    if (!p.el.isConnected) continue;
                    p.life += dt;
                    if (p.life > p.max) { p.el.remove(); continue; }
                    alive = true;
                    p.vy += 1500 * dt; p.vx *= .99; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
                    const sx = kind === 'coin' ? Math.cos(p.rot / 40) : 1;
                    p.el.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px) rotate(' + p.rot + 'deg) scale(' + (sx * p.s) + ',' + p.s + ')';
                    p.el.style.opacity = Math.min(1, (p.max - p.life) * 3);
                }
                if (alive) requestAnimationFrame(step);
            })(last);
        }, delaySec * 1000);
    }

    function showReward() {
        if (state !== 'landed') return;
        const type = typeOf(lootbox.Type);
        const r = type.rarity;
        const color = RARITY_COLORS[r];
        rewardEl.style.setProperty('--rc', color);
        fxEl.style.setProperty('--rc', color);
        rewardEl.classList.toggle('bonus-legend', r === 3);

        rewardEl.querySelector('.bonus-bigicon').textContent = type.icon;
        const nameEl = rewardEl.querySelector('.bonus-name');
        nameEl.textContent = '';
        Array.from(tr('bonus_name_' + type.key).toUpperCase()).forEach(function (ch, i) {
            const span = document.createElement('span');
            span.textContent = ch === ' ' ? ' ' : ch;
            if (ch === ' ') span.style.whiteSpace = 'pre';
            span.style.animationDelay = (.35 + i * .045) + 's';
            nameEl.appendChild(span);
        });
        rewardEl.querySelector('.bonus-desc').textContent = tr('bonus_desc_' + type.key);

        rewardEl.querySelectorAll('.bonus-rays,.bonus-bigcard,.bonus-desc').forEach(function (el) {
            el.style.animation = 'none';
            void el.offsetHeight;
            el.style.animation = '';
        });
        rewardEl.classList.add('bonus-show');
        flash();
        jingle(r);
        if (r === 3 && !reducedMotion()) {
            root.classList.remove('shake');
            void root.offsetHeight;
            root.classList.add('shake');
        }
        burst(.1, COIN_COUNTS[r], 'coin');
        burst(.15, SPARK_COUNTS[r], 'spark');
        if (r >= 1) burst(.25, GEM_COUNTS[r], 'gem');
        if (r >= 2) extraTimer = setTimeout(function () { burst(0, 30, 'coin'); }, 900);

        if (typeof api.OnRewardShown === 'function') api.OnRewardShown(lootbox);
    }

    function Hide() {
        clearTimers();
        state = 'idle';
        lootbox = null;
        if (!root) return;
        root.hidden = true;
        root.classList.remove('shake');
        rewardEl.classList.remove('bonus-show', 'bonus-legend');
        fxEl.textContent = '';
        strip.textContent = '';
        stopButton.onclick = null;
    }

    function IsActive() {
        return !!root && !root.hidden;
    }

    const api = {
        Play: Play,
        Stop: Stop,
        Hide: Hide,
        IsActive: IsActive,
        TYPES: TYPES,
        OnRewardShown: null
    };
    window.pqBonusLootbox = api;
})();
