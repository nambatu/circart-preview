// CIRCArt — daily streak badge and Painting of the Week conservation studio (task 45).
(function () {
    'use strict';

    const { t, esc, de } = window.CircI18n;
    const $ = id => document.getElementById(id);

    function safeImg(u) {
        const s = String(u || '').trim().replace(/\\/g, '/');
        if (!s || /^javascript:/i.test(s) || /^data:text/i.test(s)) return '';
        if (/^https?:/i.test(s)) {
            try {
                if (typeof location !== 'undefined' && location.origin && location.origin !== 'null') {
                    return new URL(s).origin === location.origin ? s : '';
                }
            } catch (e) { /* ignore */ }
            return '';
        }
        return s;
    }

    function openModal(html) {
        const m = document.createElement('div');
        m.className = 'modal';
        m.innerHTML = `<div class="modal-content" role="dialog" aria-modal="true" style="display:flex;flex-direction:column;gap:12px">${html}
            <button class="btn link" data-close>${esc(t('common.close'))}</button></div>`;
        m.addEventListener('click', e => {
            if (e.target === m || e.target.closest('[data-close]')) m.remove();
        });
        document.body.appendChild(m);
        const closeBtn = m.querySelector('[data-close]');
        if (closeBtn) closeBtn.focus();
        return m;
    }

    function openStreakPopover(data) {
        if (!data) return;
        const n = Number(data.streak ?? data.current ?? data.days ?? 0);
        if (n <= 0) return;
        const freeUsed = data.free_day_available !== undefined
            ? !data.free_day_available
            : Boolean(data.free_day_used ?? data.grace_used ?? data.used_free_day ?? data.free_used);
        const playedToday = Boolean(data.played_today ?? data.today_done ?? data.today);
        const title = n === 1 ? t('streak.modalTitle1') : t('streak.modalTitle', { n });

        openModal(`
          <div class="wk-streak-pop">
            <div class="wk-streak-flame" aria-hidden="true">🔥 ${n}</div>
            <h2 class="serif" style="font-size:24px;margin:0">${esc(title)}</h2>
            <p class="muted" style="font-size:14px;margin:0">${esc(t('streak.modalRule'))}</p>
            <div class="wk-streak-facts">
              <div class="note">${playedToday ? '✓ ' : ''}${esc(t(playedToday ? 'streak.todayDone' : 'streak.todayOpen'))}</div>
              <div class="note">${esc(t(freeUsed ? 'streak.freeUsed' : 'streak.freeAvailable'))}</div>
            </div>
          </div>`);
    }

    function renderHeaderStreak(streakData) {
        const btn = $('home-streak');
        if (!btn) return;
        const n = streakData ? Number(streakData.streak ?? streakData.current ?? streakData.days ?? 0) : 0;
        if (!streakData || n <= 0) {
            btn.classList.add('hidden');
            btn.textContent = '';
            btn._streakData = null;
            return;
        }
        btn._streakData = streakData;
        btn.textContent = '🔥 ' + n;
        btn.setAttribute('aria-label', t('streak.aria', { n }));
        btn.classList.remove('hidden');
        if (!btn.dataset.wired) {
            btn.dataset.wired = '1';
            btn.addEventListener('click', () => openStreakPopover(btn._streakData));
        }
    }

    function weekdayEyebrow(paintingData) {
        if (paintingData.revealed) return t('wk.sundayReveal');
        const lang = (window.CircI18n && window.CircI18n.lang) || 'en';
        let dayName = paintingData.weekday || '';
        if (!dayName) {
            try {
                dayName = new Date().toLocaleDateString(lang, { weekday: 'long' }).toUpperCase();
            } catch (e) {
                dayName = '';
            }
        } else {
            dayName = String(dayName).toUpperCase();
        }
        return dayName ? t('wk.eyebrowDay', { day: dayName }) : t('wk.eyebrow');
    }

    function openGuessModal(paintingData, o, onUpdated) {
        const choices = paintingData.artist_options || paintingData.choices || paintingData.options || [];
        if (!choices.length || !o || !o.guessPainting) return;
        const m = openModal(`
          <h2 class="serif" style="font-size:22px;margin:0">${esc(t('wk.guessTitle'))}</h2>
          <p class="muted" style="font-size:14px;margin:0">${esc(t('wk.guessIntro'))}</p>
          <div class="wk-guess-opts">
            ${choices.map(c => `<button class="go-pick" type="button" data-wk-choice="${esc(c)}">${esc(c)}</button>`).join('')}
          </div>
          <div id="wk-guess-res" class="hidden"></div>`);

        let busy = false;
        m.querySelectorAll('[data-wk-choice]').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (busy) return;
                busy = true;
                const choice = btn.dataset.wkChoice;
                m.querySelectorAll('[data-wk-choice]').forEach(b => {
                    b.disabled = true;
                    b.classList.toggle('chosen', b === btn);
                });
                try {
                    const res = await o.guessPainting(choice);
                    const ok = !!(res && (res.correct || res.ok));
                    const artist = (res && res.artist) || choice;
                    btn.classList.remove('chosen');
                    btn.classList.add(ok ? 'right' : 'wrong');
                    const out = m.querySelector('#wk-guess-res');
                    if (out) {
                        out.className = 'wk-guess-res ' + (ok ? 'ok' : 'bad');
                        out.textContent = ok ? t('wk.guessRight', { artist }) : t('wk.guessWrong');
                    }
                    if (typeof onUpdated === 'function') onUpdated();
                } catch (err) {
                    const msg = (window.CircI18n && err && err.code && t('err.' + err.code) !== 'err.' + err.code)
                        ? t('err.' + err.code)
                        : ((err && err.message) || t('common.error'));
                    if (window.CircShell && window.CircShell.toast) window.CircShell.toast(msg);
                    m.remove();
                }
            });
        });
    }

    function renderCanvasHtml(varnishUrl, fullUrl, days, earnedIndices, justCleanedIndices, showClean, title) {
        if (showClean && fullUrl) {
            return `<img class="wk-base wk-revealed-img zoomable-img" src="${esc(fullUrl)}" alt="${esc(title || '')}">`;
        }
        const patchesHtml = earnedIndices.map(i => {
            const d = days[i];
            const pUrl = safeImg(d && d.patch_url);
            if (!pUrl) return '';
            const wipeCls = justCleanedIndices.has(i) ? ' wk-wipe' : '';
            return `<img class="wk-patch${wipeCls}" src="${esc(pUrl)}" alt="">`;
        }).join('');
        return (varnishUrl ? `<img class="wk-base" src="${esc(varnishUrl)}" alt="${esc(title || '')}">` : '') + patchesHtml;
    }

    function renderWeeklyCard(box, paintingData, o, onUpdated) {
        if (!box) return;
        if (!paintingData || (!safeImg(paintingData.varnish_url) && !paintingData.revealed)) {
            box.innerHTML = '';
            return;
        }

        const weekKey = String(paintingData.week || paintingData.week_start || 'cur');
        const rawDays = Array.isArray(paintingData.days) ? paintingData.days : [];
        const days = Array.from({ length: 7 }, (_, i) => rawDays[i] || { day: i + 1, earned: false });
        const earnedIndices = days.map((d, i) => (d && d.earned && safeImg(d.patch_url) ? i : -1)).filter(i => i >= 0);
        const earnedCount = paintingData.earned_count != null ? Number(paintingData.earned_count) : days.filter(d => d && d.earned).length;

        const ssKey = 'circart-wk-seen-' + weekKey;
        let prevSeen = null;
        try { prevSeen = sessionStorage.getItem(ssKey); } catch (e) { /* ignore */ }
        const prevNum = prevSeen === null ? null : Number(prevSeen);
        const justCleanedIndices = new Set();
        if (prevNum !== null && Number.isFinite(prevNum) && earnedCount > prevNum) {
            const delta = Math.max(1, earnedCount - prevNum);
            earnedIndices.slice(-delta).forEach(i => justCleanedIndices.add(i));
        } else {
            days.forEach((d, i) => { if (d && d.just_cleaned && d.earned) justCleanedIndices.add(i); });
        }
        try { sessionStorage.setItem(ssKey, String(earnedCount)); } catch (e) { /* ignore */ }

        const varnishUrl = safeImg(paintingData.varnish_url);
        const rev = paintingData.revealed || null;
        const fullUrl = rev ? safeImg(rev.full_url || rev.image_url || rev.image_local) : '';
        const hasMissed = earnedCount < 7;
        const canToggle = !!(rev && fullUrl && varnishUrl && hasMissed);
        let viewClean = !!(rev && (!hasMissed || !varnishUrl));

        const dayLabels = t('wk.dayLabels').split(' ');
        const latestEarnedIdx = earnedIndices.length ? earnedIndices[earnedIndices.length - 1] : -1;
        const ti = paintingData.today_index != null ? Number(paintingData.today_index) : -1;
        const stripHtml = days.map((d, i) => {
            const earned = !!(d && d.earned);
            const perfect = !!(d && d.perfect);
            const isToday = Boolean((d && d.today) || (ti >= 0 && i === ti));
            const missed = Boolean(!earned && ((d && (d.missed || d.status === 'missed')) || (ti >= 0 && i < ti)));
            const cls = [
                'wk-day',
                earned ? 'earned' : missed ? 'missed' : 'pending',
                perfect ? 'perfect' : '',
                i === latestEarnedIdx ? 'latest' : '',
                isToday ? 'today' : '',
            ].filter(Boolean).join(' ');
            return `<div class="${cls}">
                <span class="wk-dot" aria-hidden="true">${earned ? '✓' : ''}</span>
                <span class="wk-dlbl">${esc(dayLabels[i] || '')}</span>
            </div>`;
        }).join('');

        const choices = paintingData.artist_options || paintingData.choices || paintingData.options || [];
        const rightGuess = Array.isArray(paintingData.guesses) ? paintingData.guesses.find(g => g && g.correct) : null;
        const guessCorrect = Boolean(paintingData.guessed_right || paintingData.guess_correct || rightGuess || (paintingData.last_guess && paintingData.last_guess.correct));
        const guessedArtist = paintingData.guessed_artist || (rightGuess && rightGuess.choice) || (paintingData.last_guess && paintingData.last_guess.artist) || '';
        const showGuessBtn = !rev && !guessCorrect && earnedCount >= 3 && !!paintingData.can_guess && choices.length >= 2;

        const progressLine = justCleanedIndices.size > 0
            ? t('wk.progressJustCleaned', { n: earnedCount })
            : earnedCount === 0
                ? t('wk.progressNone')
                : t('wk.progress', { n: earnedCount });

        const revTitle = rev ? (de(rev, 'title') || rev.title || '') : '';
        const revStory = rev ? (de(rev, 'story') || rev.story || '') : '';

        function paint() {
            const canvasHtml = renderCanvasHtml(
                varnishUrl,
                rev ? fullUrl : '',
                days,
                earnedIndices,
                justCleanedIndices,
                viewClean,
                revTitle
            );
            box.innerHTML = `
              <section class="panel hcard wk-card">
                <div class="hcard-body">
                  <div class="hcard-top">
                    <span class="eyebrow">${esc(weekdayEyebrow(paintingData))}</span>
                    ${rev && canToggle ? `<button class="btn link wk-view-toggle" type="button" data-wk-toggle>${esc(t(viewClean ? 'wk.viewYours' : 'wk.viewClean'))}</button>` : ''}
                  </div>
                  <div class="wk-mat">
                    <div class="wk-canvas">${canvasHtml}</div>
                  </div>
                  ${rev ? `
                    <div class="wk-placard">
                      <h3 class="hcard-title">${esc(revTitle)}</h3>
                      <div class="muted wk-meta">${esc([rev.artist, rev.year].filter(Boolean).join(' · '))}</div>
                      ${revStory ? `<p class="hcard-text">${esc(revStory)}</p>` : ''}
                      <button class="btn quiet block" type="button" data-wk-restorations>${esc(t('wk.savedBtn'))}</button>
                    </div>
                  ` : `
                    <div class="wk-strip" aria-label="${esc(progressLine)}">${stripHtml}</div>
                    <p class="hcard-text">${esc(progressLine)}</p>
                    ${guessCorrect && guessedArtist ? `<p class="note wk-spotted">${esc(t('wk.guessedBadge', { artist: guessedArtist }))}</p>` : ''}
                    ${showGuessBtn ? `<button class="btn outline block" type="button" data-wk-guess>${esc(t('wk.guessBtn'))}</button>` : ''}
                  `}
                </div>
              </section>`;

            const toggleBtn = box.querySelector('[data-wk-toggle]');
            if (toggleBtn) {
                toggleBtn.addEventListener('click', () => {
                    viewClean = !viewClean;
                    justCleanedIndices.clear();
                    paint();
                });
            }
            const restBtn = box.querySelector('[data-wk-restorations]');
            if (restBtn) {
                restBtn.addEventListener('click', () => {
                    if (window.CircShell && window.CircShell.openRestorations) {
                        window.CircShell.openRestorations();
                    } else if (window.CircShell && window.CircShell.showTab) {
                        window.CircShell.showTab('gallery');
                        const tab = document.querySelector('#gallery-seg [data-gview="restorations"]');
                        if (tab) tab.click();
                    }
                });
            }
            const guessBtn = box.querySelector('[data-wk-guess]');
            if (guessBtn) {
                guessBtn.addEventListener('click', () => openGuessModal(paintingData, o, onUpdated));
            }
        }

        paint();
    }

    let restSeq = 0;
    async function renderRestorations(box, o) {
        if (!box) return;
        const seq = ++restSeq;
        box.innerHTML = `<p class="muted gp-empty">…</p>`;
        let user = null;
        if (o && o.user) {
            try { user = await o.user(); } catch (e) { user = null; }
        }
        if (seq !== restSeq) return;
        if (!o || !user || !o.myRestorations) {
            box.innerHTML = `<p class="note gp-empty">${esc(t('restorations.signIn'))}</p>`;
            return;
        }
        let raw = null;
        try {
            raw = await o.myRestorations();
        } catch (e) {
            if (seq !== restSeq) return;
            box.innerHTML = `<p class="note gp-empty">${esc(t('gallery.failed'))}</p>`;
            return;
        }
        if (seq !== restSeq) return;
        const list = Array.isArray(raw) ? raw : ((raw && (raw.items || raw.restorations)) || []);
        if (!list.length) {
            box.innerHTML = `<p class="note gp-empty">${esc(t('restorations.empty'))}</p>`;
            return;
        }

        const state = list.map(() => ({ clean: false }));
        const emptySet = new Set();
        function drawList() {
            box.innerHTML = `<div class="wk-rest-list">${list.map((item, idx) => {
                const title = de(item, 'title') || item.title || '';
                const story = de(item, 'story') || item.story || '';
                const fullUrl = safeImg(item.full_url || item.image_url || item.image_local);
                const varnishUrl = safeImg(item.varnish_url);
                const days = Array.isArray(item.days) ? item.days : [];
                const earnedIdx = days.map((d, i) => (d && d.earned && safeImg(d.patch_url) ? i : -1)).filter(i => i >= 0);
                const earned = item.earned_count != null ? Number(item.earned_count) : (days.length ? days.filter(d => d && d.earned).length : 7);
                const hasOverlay = !!(varnishUrl && earnedIdx.length && earned < 7);
                const canToggle = !!(hasOverlay && fullUrl);
                const showClean = !hasOverlay || state[idx].clean || !fullUrl;
                const canvas = hasOverlay
                    ? renderCanvasHtml(varnishUrl, fullUrl, days, earnedIdx, emptySet, state[idx].clean && !!fullUrl, title)
                    : (fullUrl || varnishUrl ? `<img class="wk-base zoomable-img" src="${esc(fullUrl || varnishUrl)}" alt="${esc(title)}" loading="lazy">` : '');
                const weekStr = item.week_start || item.week || '';
                return `<article class="panel wk-rest-card" data-rest-idx="${idx}">
                  ${canvas ? `<div class="wk-mat"><div class="wk-canvas">${canvas}</div></div>` : ''}
                  <div class="wk-placard">
                    <div class="hcard-top">
                      <span class="eyebrow">${esc(weekStr ? t('restorations.weekOf', { date: weekStr }) : t('wk.eyebrow'))}</span>
                      ${canToggle ? `<button class="btn link wk-view-toggle" type="button" data-rest-toggle="${idx}">${esc(t(state[idx].clean ? 'wk.viewYours' : 'wk.viewClean'))}</button>` : `<span class="note">${esc(t('restorations.patches', { n: earned }))}</span>`}
                    </div>
                    ${canToggle ? `<div class="note">${esc(t('restorations.patches', { n: earned }))}</div>` : ''}
                    <h3 class="hcard-title">${esc(title)}</h3>
                    <div class="muted wk-meta">${esc([item.artist, item.year].filter(Boolean).join(' · '))}</div>
                    ${story ? `<p class="hcard-text">${esc(story)}</p>` : ''}
                  </div>
                </article>`;
            }).join('')}</div>`;
            box.querySelectorAll('[data-rest-toggle]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const i = Number(btn.dataset.restToggle);
                    if (state[i]) { state[i].clean = !state[i].clean; drawList(); }
                });
            });
        }
        drawList();
    }

    window.CircStreak = { renderHeaderStreak, renderWeeklyCard, renderRestorations };
})();
