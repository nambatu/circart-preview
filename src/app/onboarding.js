/* ============================================================
   CIRCArt — first-time tutorial ("How to play").
   window.CircOnboarding.show()       open it any time (Profile row)
   window.CircOnboarding.maybeShow()  open once per device, home only
   All text lives in TEXT below (English fallback). If strings.js
   has a key 'onb.<name>', that translation wins.
   ============================================================ */
(function () {
    'use strict';

    const STORE_KEY = 'circart-onboarded';

    const TEXT = {
        dialogLabel: 'How to play CIRCArt',
        skip: 'Skip',
        back: 'Back',
        next: 'Next',
        done: "Let's play",
        stepOf: 'Step {n} of {total}',

        s1Eyebrow: 'How to play',
        s1Title: 'Put art in its place',
        s1Body: 'You get an artwork. Drop it where it belongs on your timeline: earlier works go before, later ones after.',
        s1Note: 'Be quick: in multiplayer a right answer is worth 1000 to 500 points by speed, plus a streak bonus.',
        s1Earlier: 'earlier',
        s1Later: 'later',

        s2Eyebrow: 'Bonus round',
        s2Title: 'Know a little more?',
        s2Body: 'After you place a card, two quick bonus questions earn extra points.',
        s2Q1: 'Who made it?',
        s2Q2: 'Which movement?',
        s2Note: 'The host can switch the bonus questions off.',

        s3Eyebrow: 'Every day',
        s3Title: 'The daily challenge',
        s3Body: 'Same 10 cards for everyone. One try. Climb the leaderboard and keep your streak alive.',
        s3Note: 'There is a bigger monthly challenge too.',
        s3Streak: 'day streak',

        s4Eyebrow: 'Together',
        s4Title: 'Play with friends',
        s4Live: 'Live',
        s4LiveBody: 'Everyone at once, 20 seconds per card.',
        s4Async: 'Your own pace',
        s4AsyncBody: '24 hours per turn. We notify you when it is your move.',
        s4Note: 'Ready? Your first artwork is waiting.'
    };

    function t(name, vars) {
        let s = TEXT[name];
        try {
            if (window.CircI18n && typeof window.CircI18n.t === 'function') {
                const key = 'onb.' + name;
                const tr = window.CircI18n.t(key, vars);
                if (tr && tr !== key) return tr;
            }
        } catch (e) { /* fall back */ }
        if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
        return s;
    }

    function esc(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    /* ---------- illustrations (pure HTML/CSS, aria-hidden) ---------- */
    const ART = {
        timeline: () => `
            <div class="onb-art onb-tl" aria-hidden="true">
                <div class="onb-tl-drop"><span class="onb-tl-frame"></span><span>?</span></div>
                <div class="onb-tl-row">
                    <span class="onb-chip">1503</span>
                    <span class="onb-dot"></span>
                    <span class="onb-gap">+</span>
                    <span class="onb-dot"></span>
                    <span class="onb-chip">1889</span>
                </div>
                <div class="onb-tl-axis"><span>&larr; ${esc(t('s1Earlier'))}</span><span>${esc(t('s1Later'))} &rarr;</span></div>
            </div>`,
        bonus: () => `
            <div class="onb-art onb-bonus" aria-hidden="true">
                <div class="onb-q"><span>${esc(t('s2Q1'))}</span><b>+200</b></div>
                <div class="onb-q"><span>${esc(t('s2Q2'))}</span><b>+100</b></div>
            </div>`,
        daily: () => {
            let cells = '';
            for (let i = 0; i < 10; i++) cells += `<span class="onb-cell${i < 7 ? ' on' : ''}"></span>`;
            return `
            <div class="onb-art onb-daily" aria-hidden="true">
                <div class="onb-cells">${cells}</div>
                <div class="onb-streak"><b class="serif">12</b><span>${esc(t('s3Streak'))}</span></div>
            </div>`;
        },
        friends: () => `
            <div class="onb-art onb-friends" aria-hidden="true">
                <div class="onb-avatars"><span>A</span><span>M</span><span>J</span><span>+</span></div>
            </div>`
    };

    function steps() {
        return [
            { art: 'timeline', eyebrow: t('s1Eyebrow'), title: t('s1Title'), body: `<p>${esc(t('s1Body'))}</p><p class="note">${esc(t('s1Note'))}</p>` },
            { art: 'bonus', eyebrow: t('s2Eyebrow'), title: t('s2Title'), body: `<p>${esc(t('s2Body'))}</p><p class="note">${esc(t('s2Note'))}</p>` },
            { art: 'daily', eyebrow: t('s3Eyebrow'), title: t('s3Title'), body: `<p>${esc(t('s3Body'))}</p><p class="note">${esc(t('s3Note'))}</p>` },
            {
                art: 'friends', eyebrow: t('s4Eyebrow'), title: t('s4Title'),
                body: `<ul class="onb-modes">
                        <li><b>${esc(t('s4Live'))}</b><span>${esc(t('s4LiveBody'))}</span></li>
                        <li><b>${esc(t('s4Async'))}</b><span>${esc(t('s4AsyncBody'))}</span></li>
                       </ul><p class="note">${esc(t('s4Note'))}</p>`
            }
        ];
    }

    /* ---------- state ---------- */
    let root = null, idx = 0, prevFocus = null, list = [];

    function markSeen() { try { localStorage.setItem(STORE_KEY, '1'); } catch (e) { /* ignore */ } }
    function seen() { try { return localStorage.getItem(STORE_KEY) === '1'; } catch (e) { return false; } }

    function build() {
        list = steps();
        root = document.createElement('div');
        root.className = 'onb-overlay';
        root.innerHTML = `
            <div class="onb-sheet" role="dialog" aria-modal="true" aria-labelledby="onb-title" aria-describedby="onb-body">
                <div class="onb-top">
                    <span class="onb-count" aria-live="polite"></span>
                    <button type="button" class="btn link onb-skip">${esc(t('skip'))}</button>
                </div>
                <div class="onb-stage"></div>
                <div class="onb-dots" aria-hidden="true">${list.map(() => '<span></span>').join('')}</div>
                <div class="onb-nav">
                    <button type="button" class="btn quiet onb-back">${esc(t('back'))}</button>
                    <button type="button" class="btn primary onb-next">${esc(t('next'))}</button>
                </div>
            </div>`;
        document.body.appendChild(root);

        root.querySelector('.onb-skip').addEventListener('click', close);
        root.querySelector('.onb-back').addEventListener('click', () => go(idx - 1));
        root.querySelector('.onb-next').addEventListener('click', () => (idx === list.length - 1 ? close() : go(idx + 1)));
        root.addEventListener('keydown', onKey);
        root.addEventListener('click', e => { if (e.target === root) close(); });

        // swipe
        const stage = root.querySelector('.onb-stage');
        let x0 = null, y0 = null;
        stage.addEventListener('touchstart', e => { const p = e.touches[0]; x0 = p.clientX; y0 = p.clientY; }, { passive: true });
        stage.addEventListener('touchend', e => {
            if (x0 === null) return;
            const p = e.changedTouches[0], dx = p.clientX - x0, dy = p.clientY - y0;
            x0 = null;
            if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) go(idx + (dx < 0 ? 1 : -1));
        }, { passive: true });
    }

    function render(dir) {
        const s = list[idx];
        const stage = root.querySelector('.onb-stage');
        stage.innerHTML = `
            <div class="onb-step${dir ? (dir > 0 ? ' in-next' : ' in-prev') : ''}">
                ${ART[s.art]()}
                <div class="eyebrow">${esc(s.eyebrow)}</div>
                <h2 id="onb-title" class="serif">${esc(s.title)}</h2>
                <div id="onb-body" class="onb-body">${s.body}</div>
            </div>`;
        root.querySelector('.onb-count').textContent = t('stepOf', { n: idx + 1, total: list.length });
        root.querySelectorAll('.onb-dots span').forEach((d, i) => d.classList.toggle('on', i === idx));
        const back = root.querySelector('.onb-back');
        back.style.visibility = idx === 0 ? 'hidden' : 'visible';
        back.disabled = idx === 0;
        const last = idx === list.length - 1;
        root.querySelector('.onb-next').textContent = last ? t('done') : t('next');
        root.querySelector('.onb-skip').style.visibility = last ? 'hidden' : 'visible';
    }

    function go(i) {
        if (!root || i < 0 || i >= list.length || i === idx) return;
        const dir = i > idx ? 1 : -1;
        const hadFocus = root.contains(document.activeElement) ? document.activeElement : null;
        idx = i;
        render(dir);
        // keep focus on a visible control
        const next = root.querySelector('.onb-next');
        if (!hadFocus || hadFocus.disabled || hadFocus.style.visibility === 'hidden') next.focus();
    }

    function focusables() {
        return Array.from(root.querySelectorAll('button')).filter(b => !b.disabled && b.style.visibility !== 'hidden');
    }

    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(); return; }
        if (e.key === 'ArrowRight') { go(idx + 1); return; }
        if (e.key === 'ArrowLeft') { go(idx - 1); return; }
        if (e.key === 'Tab') {
            const f = focusables();
            if (!f.length) return;
            const first = f[0], last = f[f.length - 1];
            if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
        }
    }

    function show() {
        if (root) return;
        prevFocus = document.activeElement;
        idx = 0;
        build();
        render(0);
        document.documentElement.classList.add('onb-open');
        requestAnimationFrame(() => root && root.classList.add('open'));
        root.querySelector('.onb-next').focus();
        markSeen();
    }

    function close() {
        if (!root) return;
        markSeen();
        const el = root;
        root = null;
        document.documentElement.classList.remove('onb-open');
        el.remove();
        if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) {
            try { prevFocus.focus(); } catch (e) { /* ignore */ }
        }
    }

    function maybeShow() {
        if (seen()) return false;
        try {
            const q = new URLSearchParams(location.search);
            if (q.has('join') || q.has('game')) return false;
        } catch (e) { /* ignore */ }
        const home = document.getElementById('start-screen');
        if (!home || !home.classList.contains('active')) return false;
        show();
        return true;
    }

    window.CircOnboarding = { show, maybeShow, close, TEXT };
})();
