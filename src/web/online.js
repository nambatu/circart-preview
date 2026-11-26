// CIRCArt online — accounts, saved games and feedback.
//
// Load after the Supabase library and before app.js:
//
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>
//   <script src="online.js"></script>
//   <script src="app.js"></script>
//
// Everything here fails soft: if the player is offline, the library didn't
// load, or the server is down, the solo game carries on exactly as before.
// Finished games wait in a local queue and are sent the next time it works.

(function () {
    'use strict';

    // Supabase → Project settings → API. The anon key is meant to be public;
    // all protection lives in the database rules.
    const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
    const SUPABASE_ANON_KEY = 'YOUR-ANON-KEY';
    // Web Push "application server" key (public). Empty = notifications off.
    const VAPID_PUBLIC_KEY = '';

    const QUEUE_KEY = 'circart-pending-games';
    const QUEUE_MAX = 30;
    const TRANSFER_KEY = 'circart-guest-transfer';

    let sb = null;

    const MESSAGES = {
        not_signed_in: 'Please sign in first.',
        username_taken: 'That username is taken.',
        username_invalid: 'Usernames are 3–20 letters, numbers, dots or underscores.',
        display_name_invalid: 'Names are 1–24 characters.',
        too_much_feedback: 'Thanks! That is a lot of feedback in one go. Please try again later.',
        bad_game: 'This game could not be saved.',
        game_not_found: 'No game with that code.',
        game_started: 'That game has already started.',
        game_full: 'That game is full.',
        too_many_tries: 'Too many wrong codes. Please wait ten minutes and try again.',
        too_many_games: 'That is a lot of games at once. Please finish or close some first.',
        not_host: 'Only the host can do that.',
        need_two_players: 'You need at least two players.',
        bad_settings: 'Those game settings don\'t work.',
        too_many_runs: 'Easy there! Wait a moment before the next run.',
        push_unsupported: 'This browser can\'t show notifications. On iPhone, add CIRCArt to your home screen first.',
        push_denied: 'Notifications are blocked. You can allow them in your browser or phone settings.',
        card_not_open: 'That card isn\'t open.',
        already_answered: 'You already placed this card.',
        not_playing: 'This game isn\'t running.',
        artist_closed: 'Too late to pick the artist.',
        not_yet: 'Wait for the round to finish.',
        not_answered: 'Place the card first.',
        bad_slot: 'Pick a spot on the timeline.',
        deck_too_small: 'Not enough cards in the deck.',
        over_email_send_rate_limit: 'Too many emails in a short time. Please wait a few minutes and try again.',
        otp_expired: 'That code is wrong or has expired. Ask for a new one.',
        email_address_invalid: 'That email address doesn\'t look right.',
        validation_failed: 'That email address doesn\'t look right.',
        already_guessed_today: 'You already used today\'s guess. Try again tomorrow.',
        already_guessed: 'You already guessed today. Try again tomorrow.',
        already_revealed: 'This painting is already revealed.',
        not_enough_patches: 'Clean at least three patches first before guessing.',
        no_painting: 'There is no weekly painting active right now.',
        too_early: 'Clean at least three patches first before guessing.',
        friend_needs_account: 'Sign in and pick a username before adding friends.',
        user_not_found: 'No player with that username was found.',
        not_friends: 'You can only do that with accepted friends.',
        blocked: 'That request could not be sent.',
        friend_not_found: 'That friend request is no longer active.',
        friend_cooldown: 'This person said no to your request a few days ago. You can ask again in a week.',
        too_many_requests: 'You sent a lot of requests just now. Please wait a bit before sending more.',
        too_many_reactions: 'Easy with the reactions. Give it a moment before sending another.',
        target_already_locked: 'That player already locked in their answer.',
        not_locked: 'Lock in your own answer first.',
        invite_not_found: 'That invitation is no longer active.',
    };

    function fail(error) {
        const msg = ((error && error.code) ? error.code + ' ' : '') + ((error && error.message) || String(error));
        const code = Object.keys(MESSAGES).find(k => msg.includes(k)) || 'unknown';
        const e = new Error(MESSAGES[code] || 'Something went wrong. Please try again.');
        e.code = code;
        e.raw = error;
        return e;
    }

    async function rpc(fn, args) {
        if (!sb) throw fail('offline');
        const { data, error } = await sb.rpc(fn, args || {});
        if (error) throw fail(error);
        return data;
    }

    function storage(fn, fallback) {
        try { return fn(); } catch (e) { return fallback; }
    }

    function uuid() {
        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    // ─── setup ────────────────────────────────────────────────────────────

    function emitAuth(event) {
        document.dispatchEvent(new CustomEvent('circart:auth', { detail: { event } }));
    }

    function isIdentityExistsErr(err) {
        if (!err) return false;
        const msg = [err.code, err.error_code, err.error, err.message, err.error_description]
            .filter(Boolean).join(' ').toLowerCase();
        return msg.includes('identity_already_exists')
            || msg.includes('already linked')
            || msg.includes('already exists')
            || msg.includes('already registered');
    }

    function readOAuthCallbackError() {
        try {
            const raw = location.href
                || ((location.origin || '') + (location.pathname || '') + (location.search || '') + (location.hash || ''));
            if (!raw) return null;
            const url = new URL(raw);
            const qp = url.searchParams;
            const hashBody = url.hash && url.hash.length > 1 ? url.hash.slice(1) : '';
            const hp = hashBody && hashBody.includes('=')
                ? new URL('https://x.invalid/?' + hashBody).searchParams
                : null;
            const pick = k => qp.get(k) || (hp && hp.get(k)) || '';
            const error = pick('error');
            const error_code = pick('error_code');
            const error_description = pick('error_description');
            if (!error && !error_code && !error_description) return null;
            return { url, hp, error, error_code, error_description };
        } catch (e) {
            return null;
        }
    }

    function cleanOAuthErrorUrl(cb) {
        if (!cb || !cb.url) return;
        try {
            ['error', 'error_code', 'error_description'].forEach(k => {
                cb.url.searchParams.delete(k);
                if (cb.hp) cb.hp.delete(k);
            });
            const qs = cb.url.searchParams.toString();
            const hs = cb.hp ? cb.hp.toString() : (cb.url.hash ? cb.url.hash.slice(1) : '');
            const clean = cb.url.pathname + (qs ? '?' + qs : '') + (hs ? '#' + hs : '');
            if (typeof history !== 'undefined' && history && typeof history.replaceState === 'function') {
                history.replaceState(history.state, '', clean);
            }
        } catch (e) { /* ignore */ }
    }

    async function handleGoogleLinkFallback() {
        if (!sb) return;
        const u = await user();
        if (u && u.is_anonymous) await saveTransferTicket();
        const options = { redirectTo: location.origin + location.pathname };
        await sb.auth.signInWithOAuth({ provider: 'google', options });
    }

    function init() {
        if (sb) return true;
        if (!window.supabase || !window.supabase.createClient || SUPABASE_URL.includes('YOUR-PROJECT')) {
            return false;
        }
        const cbErr = readOAuthCallbackError();
        if (cbErr) cleanOAuthErrorUrl(cbErr);
        sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        });
        sb.auth.onAuthStateChange((event) => {
            if (event === 'SIGNED_IN') { flushQueue(); setTimeout(() => { finishGuestTransfer().catch(() => {}); reportTimeZone(); }, 0); }
            emitAuth(event);
        });
        window.addEventListener('online', flushQueue);
        if (cbErr && isIdentityExistsErr(cbErr)) {
            handleGoogleLinkFallback().catch(() => {});
        }
        flushQueue();
        return true;
    }

    const available = () => !!sb;

    async function user() {
        if (!sb) return null;
        const { data } = await sb.auth.getSession();
        return data.session ? data.session.user : null;
    }

    // ─── accounts ─────────────────────────────────────────────────────────

    // A silent guest account. Used when someone joins a multiplayer game or
    // wants their solo games saved without signing up.
    async function ensureGuest() {
        const u = await user();
        if (u) { reportTimeZone(); return u; }
        const { data, error } = await sb.auth.signInAnonymously();
        if (error) throw fail(error);
        reportTimeZone();
        return data.user;
    }

    // The device's time zone (e.g. "Europe/Vienna"), for the rough country
    // count on the usage dashboard (migration 034). Never the IP address or a
    // city. Sent once per account and again only if it changes.
    const TZ_KEY = 'circart-tz-sent';
    function reportTimeZone() {
        try {
            const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            if (!tz || !sb) return;
            user().then(u => {
                if (!u) return;
                const mark = u.id + '|' + tz;
                if (storage(() => localStorage.getItem(TZ_KEY), null) === mark) return;
                rpc('set_my_time_zone', { p_tz: tz })
                    .then(() => storage(() => localStorage.setItem(TZ_KEY, mark)))
                    .catch(() => {});
            }).catch(() => {});
        } catch (e) { /* never get in the way of playing */ }
    }

    async function saveTransferTicket() {
        try {
            const tok = await rpc('start_guest_transfer');
            if (tok) storage(() => localStorage.setItem(TRANSFER_KEY, JSON.stringify({ tok, at: Date.now() })));
        } catch (e) { /* no ticket: sign-in still works, the games just stay behind */ }
    }

    // Google. A guest keeps the same account (history, running games),
    // which needs "Manual linking" switched on in Supabase.
    async function signInWithGoogle() {
        if (!sb) throw fail('offline');
        const u = await user();
        const options = { redirectTo: location.origin + location.pathname };
        if (u && u.is_anonymous) {
            const { error } = await sb.auth.linkIdentity({ provider: 'google', options });
            if (!error) return;
            if (!isIdentityExistsErr(error)) throw fail(error);
            await saveTransferTicket();
        }
        const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options });
        if (error) throw fail(error);
    }

    // Email: a message with a 6-digit code (and a link) is sent.
    // · A guest with a NEW email: the email is attached to the guest account,
    //   so games played so far stay ('attach').
    // · A guest whose email already has an account: we sign in to that account
    //   instead ('existing'). Guest games on this device don't carry over.
    //   (Before 19 Nov this case failed with "email already registered" and
    //   locked people out on any device that had played as a guest.)
    // · Signed out: normal sign-in ('signin'); a new email creates an account.
    // Returns the mode; verifyEmailCode() needs it.
    async function signInWithEmail(email) {
        if (!sb) throw fail('offline');
        email = String(email || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('email_address_invalid');
        const back = { emailRedirectTo: location.origin + location.pathname };
        const u = await user();
        if (u && u.is_anonymous) {
            const { error } = await sb.auth.updateUser({ email }, back);
            if (!error) return 'attach';
            if (error.code !== 'email_exists' && !/already been registered/i.test(error.message || '')) throw fail(error);
        }
        // signing in to an existing account: get a ticket first, so the guest's
        // games on this device can follow (migration 026)
        if (u && u.is_anonymous) await saveTransferTicket();
        const { error } = await sb.auth.signInWithOtp({ email, options: back });
        if (error) throw fail(error);
        return u && u.is_anonymous ? 'existing' : 'signin';
    }

    // After signing in to a real account: hand in the guest ticket, if any.
    // Called after the code, and on any sign-in (the email link reloads the page).
    let transferPromise = null;
    function finishGuestTransfer() {
        if (transferPromise) return transferPromise;
        transferPromise = (async () => {
            try {
                const t = storage(() => JSON.parse(localStorage.getItem(TRANSFER_KEY) || 'null'), null);
                if (!t || !t.tok) return null;
                if (Date.now() - (t.at || 0) > 15 * 60 * 1000) {
                    storage(() => localStorage.removeItem(TRANSFER_KEY));
                    return null;
                }
                const u = await user();
                if (!u || u.is_anonymous) return null;
                try {
                    const res = await rpc('finish_guest_transfer', { p_token: t.tok });
                    storage(() => localStorage.removeItem(TRANSFER_KEY));
                    if (res && res.moved) emitAuth('GUEST_TRANSFER');
                    return res;
                } catch (e) {
                    const raw = e && e.raw;
                    const msg = [e && e.code, e && e.message, raw && raw.code, raw && raw.message]
                        .filter(Boolean).join(' ');
                    if (/expired|used|invalid/i.test(msg)) {
                        storage(() => localStorage.removeItem(TRANSFER_KEY));
                    }
                    return null;
                }
            } finally {
                transferPromise = null;
            }
        })();
        return transferPromise;
    }

    // The code from the email. Works on any device, unlike the link, which
    // only works in the browser that asked for it.
    async function verifyEmailCode(email, code, mode) {
        if (!sb) throw fail('offline');
        email = String(email || '').trim().toLowerCase();
        const token = String(code || '').replace(/\D/g, '');
        if (token.length < 6) throw fail('otp_expired');
        const { error } = await sb.auth.verifyOtp({ email, token, type: mode === 'attach' ? 'email_change' : 'email' });
        if (error) throw fail(error);
        const moved = await finishGuestTransfer();
        return { user: await user(), moved };
    }

    async function signOut() {
        try {
            if (sb) {
                try { await disablePush(); } catch (e) { /* best-effort */ }
                await sb.auth.signOut();
            }
        } finally {
            storage(() => localStorage.removeItem(QUEUE_KEY));
            storage(() => localStorage.removeItem(TRANSFER_KEY));
        }
    }

    const getProfile = () => rpc('get_my_profile');
    const updateProfile = ({ displayName = null, username = null } = {}) =>
        rpc('update_profile', { p_display_name: displayName, p_username: username });
    const usernameAvailable = name => rpc('username_available', { p_username: name });
    async function deleteAccount() {
        try { await disablePush(); } catch (e) {}   // don't leave the browser's push subscription behind
        await rpc('delete_my_account');
        storage(() => localStorage.removeItem(QUEUE_KEY));
        storage(() => localStorage.removeItem(TRANSFER_KEY));
        storage(() => localStorage.removeItem('circart-collection'));
        storage(() => localStorage.removeItem('circart-local-history'));
        try { await sb.auth.signOut(); } catch (e) { /* account already deleted */ }
    }

    // ─── solo games ───────────────────────────────────────────────────────

    // Give it the finished game; it's queued locally and sent when possible.
    // game = { startedAt, score, bonusPoints, bestStreak,
    //          cards: [ {id}, {id, correct, artist, title, year}, ... ] }
    function saveSoloGame(game) {
        const entry = {
            client_id: uuid(),
            mode: game.mode || 'classic',
            started_at: game.startedAt || null,
            finished_at: new Date().toISOString(),
            score: game.score,
            bonus_points: game.bonusPoints || 0,
            best_streak: game.bestStreak || 0,
            cards: game.cards,
        };
        const queue = storage(() => JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'), []);
        queue.push(entry);
        storage(() => localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-QUEUE_MAX))));
        flushQueue();
    }

    let flushPromise = null;
    function flushQueue() {
        if (!sb || (navigator.onLine === false)) return Promise.resolve();
        if (flushPromise) return flushPromise;
        flushPromise = (async () => {
            try {
                if (!(await user())) return;          // kept until the player signs in
                const done = new Set();
                while (true) {
                    const queue = storage(() => JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'), [])
                        .filter(item => item && !done.has(item.client_id));
                    if (!queue.length) break;
                    const head = queue[0];
                    try {
                        await rpc('submit_solo_game', { p: head });
                    } catch (e) {
                        if (e.code !== 'bad_game') break;   // network trouble: try again later
                    }
                    if (head.client_id != null) done.add(head.client_id);
                    const raw = storage(() => JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'), []);
                    let dropped = head.client_id != null;
                    const fresh = raw.filter(item => {
                        if (!item) return false;
                        if (item.client_id != null) return !done.has(item.client_id);
                        if (!dropped) { dropped = true; return false; }
                        return true;
                    });
                    if (storage(() => localStorage.getItem(QUEUE_KEY), null) !== null) {
                        storage(() => localStorage.setItem(QUEUE_KEY, JSON.stringify(fresh)));
                    }
                }
            } finally {
                flushPromise = null;
            }
        })();
        return flushPromise;
    }

    // Cards dealt to this player recently on any device (artline.json ids).
    // Returns null when offline so the caller can fall back to local memory.
    async function recentlySeen(hours) {
        try {
            if (!(await user())) return null;
            return await rpc('recently_seen_cards', { p_hours: hours || 168 });
        } catch (e) {
            return null;
        }
    }

    const soloStats = () => rpc('my_solo_stats');

    // ─── feedback ─────────────────────────────────────────────────────────

    // Works signed in or not. Throws if it couldn't be sent, so the caller
    // can fall back to the email link.
    const sendFeedback = (topic, message, cardId, context) =>
        rpc('submit_feedback', {
            p_topic: topic, p_message: message,
            p_card_source_id: cardId || null, p_context: context || {},
        });

    // ─── games: live, async, daily ────────────────────────────────────────
    // The server is the clock. serverOffset turns its timestamps into local
    // time for countdowns: Date.now() + serverOffset ≈ server time.
    let serverOffset = 0;
    function syncClock(res) {
        if (res && res.server_now) serverOffset = new Date(res.server_now).getTime() - Date.now();
        return res;
    }
    const serverNow = () => Date.now() + serverOffset;
    const g = async (fn, args) => syncClock(await rpc(fn, args));

    async function createGame(kind, { cardCount = null, cardsPerTurn = null, displayName = null } = {}) {
        await ensureGuest();
        return rpc('create_game', { p_kind: kind, p_card_count: cardCount, p_cards_per_turn: cardsPerTurn, p_display_name: displayName });
    }
    async function joinGame(code, displayName) {
        await ensureGuest();
        const id = await rpc('join_game', { p_code: code, p_display_name: displayName || null });
        if (id == null) throw fail('game_not_found');   // the server answers null for an unknown code
        return id;
    }
    const startGame  = id => rpc('start_game', { p_game: id });
    const leaveGame  = id => rpc('leave_game', { p_game: id });
    const getGame    = id => g('get_game', { p_game: id });
    const nextCard   = id => g('next_card', { p_game: id });
    // slot: the gap tapped, 0 = before the first card, timeline.length = after the last
    const answer     = (id, position, slot) => rpc('answer', { p_game: id, p_position: position, p_slot: slot });
    const reveal     = (id, position) => rpc('reveal', { p_game: id, p_position: position });
    const myGames    = () => rpc('my_games');

    async function playDaily(displayName) {
        await ensureGuest();
        return g('play_daily', { p_display_name: displayName || null });
    }
    const dailySummary       = () => g('daily_summary');
    const dailyLeaderboard   = date => rpc('daily_leaderboard', { p_date: date || null });
    const monthlyLeaderboard = month => rpc('monthly_leaderboard', { p_month: month || null });
    const alltimeLeaderboard = () => rpc('alltime_leaderboard');
    const myStats            = () => rpc('my_stats');
    // Monthly Run: unlimited tries, 3 lives, best run counts
    async function startRun(displayName) {
        await ensureGuest();
        return g('start_run', { p_display_name: displayName || null });
    }
    const runSummary         = () => g('run_summary');
    // finished months only: top 3 of a month's best runs (default last month; null while it's running)
    const monthlyWinners     = month => rpc('monthly_winners', { p_month: month || null });
    // months where I made the top 3: [{month, title, rank, value}], newest first
    const myBadges           = () => rpc('my_badges');
    const myAchievements     = () => rpc('my_achievements');
    const priceSummary       = () => rpc('price_summary');
    const priceLeaderboard   = () => rpc('price_leaderboard');
    const myStreak           = () => rpc('my_streak');
    const myPainting         = (week = null) => rpc('my_painting', { p_week: week });
    const guessPainting      = choice => rpc('guess_painting', { p_choice: choice });
    const myRestorations     = () => rpc('my_restorations');
    const myHistory          = ({ kind = null, limit = 30, offset = 0 } = {}) =>
        rpc('my_history', { p_kind: kind, p_limit: limit, p_offset: offset });
    // card packs: [{id, title, title_de, description(_de), unlock_text(_de), progress, needed, unlocked, new, cards}]
    const myPacks            = () => rpc('my_packs');
    // Gallery: {seen: [card ids met], correct: [card ids placed right at least once]}
    const myCollection       = () => rpc('my_collection');
    const markPacksSeen      = () => rpc('mark_packs_seen');
    // GDPR: everything stored about me, as one JSON document
    const exportMyData       = () => rpc('export_my_data');
    const myResults          = id => rpc('my_results', { p_game: id });
    const rematch            = id => rpc('rematch', { p_game: id });
    const rematchInfo        = id => rpc('rematch_info', { p_game: id });
    const gameOptions        = id => rpc('game_options', { p_game: id });
    // story dailies (019): title, intro, my chapters so far, outro when done; null on normal days
    const dailyStory         = (date = null) => rpc('daily_story', { p_date: date });
    const setGameOptions     = (id, { artistBonus = null, movementBonus = null, timer = null, seconds = null } = {}) =>
        rpc('set_game_options', { p_game: id, p_artist_bonus: artistBonus, p_movement_bonus: movementBonus, p_timer: timer, p_seconds: seconds });
    // both bonus answers in one go (null = skipped)
    const pickBonus          = (id, position, artist, movement) =>
        rpc('pick_bonus', { p_game: id, p_position: position, p_artist: artist, p_movement: movement });

    // ─── live waiting studio + friends + direct invites (032) ───────────────
    const roundLive          = gameId => rpc('round_live', { p_game: gameId });
    const callIt             = (gameId, position, targetSeat, predictOk) =>
        rpc('call_it', { p_game: gameId, p_position: position, p_target_seat: targetSeat, p_predict_ok: predictOk });
    const sendReaction       = (gameId, emoji, targetSeat = null) =>
        rpc('send_reaction', { p_game: gameId, p_emoji: emoji, p_target_seat: targetSeat });
    const roundResults       = (gameId, turn = null) => rpc('round_results', { p_game: gameId, p_turn: turn });
    const sendFriendRequest  = username => rpc('send_friend_request', { p_username: username });
    const respondFriendRequest = (username, accept) => rpc('respond_friend_request', { p_username: username, p_accept: accept });
    const removeFriend       = (username, block = false) => rpc('remove_friend', { p_username: username, p_block: block });
    const myFriends          = () => rpc('my_friends');
    const friendProfile      = username => rpc('friend_profile', { p_username: username });
    const friendsLeaderboard = (board, date = null) => rpc('friends_leaderboard', { p_board: board, p_date: date });
    const inviteFriendsToGame = (usernames, { kind = 'async', cardCount = 12, cardsPerTurn = 3 } = {}) =>
        rpc('invite_friends_to_game', { p_usernames: usernames, p_kind: kind, p_card_count: cardCount, p_cards_per_turn: cardsPerTurn });
    const sendScoreChallenge = (username, mode, score) => rpc('send_score_challenge', { p_username: username, p_mode: mode, p_score: score });
    const myGameInvites      = () => rpc('my_game_invites');
    const respondGameInvite  = (inviteId, accept) => rpc('respond_game_invite', { p_invite_id: inviteId, p_accept: accept });

    // ─── push notifications (async games) ─────────────────────────────────
    // iPhone: only once the app is added to the home screen (iOS 16.4+).
    // Firefox on Android supports web push but may not offer window.Notification;
    // there, subscribe() asks for permission itself.
    const pushSupported = () => !!(VAPID_PUBLIC_KEY && 'serviceWorker' in navigator && 'PushManager' in window);
    const pushPermission = () => ('Notification' in window ? Notification.permission : 'default');
    function urlB64(b64) {
        const pad = '='.repeat((4 - b64.length % 4) % 4);
        const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
        return Uint8Array.from(raw, c => c.charCodeAt(0));
    }
    async function pushSubscription() {
        if (!pushSupported()) return null;
        const reg = navigator.serviceWorker.getRegistration
            ? await navigator.serviceWorker.getRegistration()
            : await navigator.serviceWorker.ready;
        return reg && reg.pushManager ? reg.pushManager.getSubscription() : null;
    }
    // Asks for permission (must follow a tap), subscribes this device, saves it.
    async function enablePush() {
        if (!pushSupported()) throw fail('push_unsupported');
        await ensureGuest();
        if ('Notification' in window) {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') throw fail('push_denied');
        }
        const reg = await navigator.serviceWorker.ready;
        let sub;
        try {
            sub = (await reg.pushManager.getSubscription())
                || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(VAPID_PUBLIC_KEY) });
        } catch (e) {
            throw fail(e && e.name === 'NotAllowedError' ? 'push_denied' : 'push_unsupported');
        }
        const j = sub.toJSON();
        await rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth,
                                              p_user_agent: navigator.userAgent.slice(0, 200) });
        return true;
    }
    async function disablePush() {
        const sub = await pushSubscription();
        if (!sub) return;
        try { await rpc('remove_push_subscription', { p_endpoint: sub.endpoint }); } catch (e) { /* ignore */ }
        await sub.unsubscribe();
    }
    // On this device: subscribed and permission still granted?
    async function pushOn() {
        if (!pushSupported() || pushPermission() === 'denied') return false;
        const sub = await pushSubscription();
        if (sub && await user()) {                // keep the server's copy fresh (it may have been removed)
            const j = sub.toJSON();
            rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth,
                                            p_user_agent: navigator.userAgent.slice(0, 200) }).catch(() => {});
        }
        return !!sub;
    }

    // Live updates for one game: every join, answer and round change touches
    // the games row. Calls onChange; re-fetch with getGame(). Returns unsubscribe.
    function watchGame(id, onChange) {
        if (!sb) return () => {};
        const ch = sb.channel('game-' + id)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: 'id=eq.' + id }, onChange)
            .subscribe();
        return () => sb.removeChannel(ch);
    }

    window.CircOnline = {
        init, available, user, ensureGuest,
        signInWithGoogle, signInWithEmail, verifyEmailCode, finishGuestTransfer, signOut,
        getProfile, updateProfile, usernameAvailable, deleteAccount,
        saveSoloGame, flushQueue, recentlySeen, soloStats,
        sendFeedback,
        serverNow, createGame, joinGame, startGame, leaveGame, getGame, nextCard,
        answer, reveal, myGames, watchGame,
        playDaily, dailySummary, dailyLeaderboard, monthlyLeaderboard, alltimeLeaderboard, myStats,
        myResults, rematch, rematchInfo, gameOptions, setGameOptions, pickBonus, startRun, runSummary,
        monthlyWinners, myBadges, myAchievements, myPacks, myCollection, markPacksSeen, exportMyData,
        priceSummary, priceLeaderboard, myStreak, myPainting, guessPainting, myRestorations, myHistory,
        roundLive, callIt, sendReaction, roundResults,
        sendFriendRequest, respondFriendRequest, removeFriend, myFriends, friendProfile, friendsLeaderboard,
        inviteFriendsToGame, sendScoreChallenge, myGameInvites, respondGameInvite,
        previewResetDaily: () => rpc('preview_reset_daily'),   // preview builds only
        pushSettings: () => rpc('my_push_settings'),
        // turns/invites: true/false, or null to keep; dailyHour: 0–23 or null (no reminder)
        setPushSettings: (turns, invites, dailyHour, lang) => rpc('set_push_settings',
            { p_turns: turns, p_invites: invites, p_daily_hour: dailyHour, p_lang: lang === 'de' ? 'de' : 'en' }),
        dailyStory,
        pushSupported, pushPermission, pushOn, enablePush, disablePush,
    };

    init();
})();
