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
    };

    function fail(error) {
        const msg = (error && error.message) || String(error);
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
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    // ─── setup ────────────────────────────────────────────────────────────

    function init() {
        if (sb) return true;
        if (!window.supabase || !window.supabase.createClient || SUPABASE_URL.includes('YOUR-PROJECT')) {
            return false;
        }
        sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        });
        sb.auth.onAuthStateChange((event) => {
            if (event === 'SIGNED_IN') flushQueue();
            document.dispatchEvent(new CustomEvent('circart:auth', { detail: { event } }));
        });
        window.addEventListener('online', flushQueue);
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
        if (u) return u;
        const { data, error } = await sb.auth.signInAnonymously();
        if (error) throw fail(error);
        return data.user;
    }

    // Google. A guest keeps the same account (history, running games),
    // which needs "Manual linking" switched on in Supabase.
    async function signInWithGoogle() {
        if (!sb) throw fail('offline');
        const u = await user();
        const options = { redirectTo: location.origin + location.pathname };
        const { error } = u && u.is_anonymous
            ? await sb.auth.linkIdentity({ provider: 'google', options })
            : await sb.auth.signInWithOAuth({ provider: 'google', options });
        if (error) throw fail(error);
    }

    // Email: a sign-in link is sent. For a guest the email is attached to the
    // existing account instead, so nothing is lost.
    async function signInWithEmail(email) {
        if (!sb) throw fail('offline');
        const u = await user();
        const { error } = u && u.is_anonymous
            ? await sb.auth.updateUser({ email })
            : await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) throw fail(error);
    }

    async function signOut() {
        if (sb) await sb.auth.signOut();
    }

    const getProfile = () => rpc('get_my_profile');
    const updateProfile = ({ displayName = null, username = null } = {}) =>
        rpc('update_profile', { p_display_name: displayName, p_username: username });
    const usernameAvailable = name => rpc('username_available', { p_username: name });
    async function deleteAccount() {
        await rpc('delete_my_account');
        storage(() => localStorage.removeItem(QUEUE_KEY));
        await sb.auth.signOut();
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

    let flushing = false;
    async function flushQueue() {
        if (!sb || flushing || (navigator.onLine === false)) return;
        if (!(await user())) return;          // kept until the player signs in
        flushing = true;
        try {
            let queue = storage(() => JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'), []);
            while (queue.length) {
                try {
                    await rpc('submit_solo_game', { p: queue[0] });
                } catch (e) {
                    if (e.code !== 'bad_game') break;   // network trouble: try again later
                }
                queue = queue.slice(1);               // saved, or permanently invalid
                storage(() => localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)));
            }
        } finally {
            flushing = false;
        }
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
        return rpc('join_game', { p_code: code, p_display_name: displayName || null });
    }
    const startGame  = id => rpc('start_game', { p_game: id });
    const leaveGame  = id => rpc('leave_game', { p_game: id });
    const getGame    = id => g('get_game', { p_game: id });
    const nextCard   = id => g('next_card', { p_game: id });
    // slot: the gap tapped, 0 = before the first card, timeline.length = after the last
    const answer     = (id, position, slot) => rpc('answer', { p_game: id, p_position: position, p_slot: slot });
    const pickArtist = (id, position, choice) => rpc('pick_artist', { p_game: id, p_position: position, p_choice: choice });
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
    // card packs: [{id, title, title_de, description(_de), unlock_text(_de), progress, needed, unlocked, new, cards}]
    const myPacks            = () => rpc('my_packs');
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
        const reg = await navigator.serviceWorker.ready;
        return reg.pushManager.getSubscription();
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
        signInWithGoogle, signInWithEmail, signOut,
        getProfile, updateProfile, usernameAvailable, deleteAccount,
        saveSoloGame, flushQueue, recentlySeen, soloStats,
        sendFeedback,
        serverNow, createGame, joinGame, startGame, leaveGame, getGame, nextCard,
        answer, pickArtist, reveal, myGames, watchGame,
        playDaily, dailySummary, dailyLeaderboard, monthlyLeaderboard, alltimeLeaderboard, myStats,
        myResults, rematch, rematchInfo, gameOptions, setGameOptions, pickBonus, startRun, runSummary,
        monthlyWinners, myBadges, myPacks, markPacksSeen, exportMyData,
        previewResetDaily: () => rpc('preview_reset_daily'),   // preview builds only
        previewTestPush: () => rpc('preview_test_push'),       // preview builds only
        dailyStory,
        pushSupported, pushPermission, pushOn, enablePush, disablePush,
    };

    init();
})();
