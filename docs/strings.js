// CIRCArt — every piece of text in the new screens, in one place.
//
// To add a language later: copy the `en` block, translate the values, add it
// under its code (e.g. `de`) and it appears in Profile → Language.
// {name}-style placeholders are filled in by t('key', { name: 'Ana' }).
// HTML in markup is filled from data-i18n="key" attributes on load.

(function () {
    'use strict';

    const STRINGS = {
        en: {
            'tab.play': 'Play',
            'tab.ranks': 'Ranks',
            'tab.gallery': 'Gallery',
            'tab.profile': 'Profile',

            'home.tagline': 'Place masterpieces of art history in the right order on the timeline.',
            'home.solo.eyebrow': 'SOLO',
            'home.solo.title': 'One timeline, your pace',
            'home.solo.rounds': 'Cards',
            'home.solo.start': 'Start a game',
            'home.daily.eyebrow': 'DAILY CHALLENGE · NO. {no}',
            'home.daily.title': 'Ten works, one timeline',
            'home.daily.sub': 'The same cards for everyone today. One try.',
            'home.daily.play': "Play today's challenge",
            'home.daily.continue': 'Continue',
            'home.daily.done': 'You scored {score} · rank {rank}',
            'home.daily.doneUnranked': 'You scored {score}',
            'home.daily.resets': 'Next challenge in {time}',
            'home.daily.hardest': "Yesterday's hardest card",
            'home.daily.hardestPct': '{title} · {pct}% placed it',
            'home.yourTurn': 'YOUR TURN',
            'home.yourGames': 'YOUR GAMES',
            'home.turnInfo': 'Turn {turn} of {turns} · {left} left',
            'home.friends': 'With friends',
            'home.code.label': 'Have a code?',
            'home.code.join': 'Join',
            'home.month.eyebrow': '{month} CHALLENGE',
            'home.month.rank': "You're #{rank} · {days} days left",
            'home.month.norank': '{days} days left',
            'home.streak': '{n} days',

            'ranks.title': 'Ranks',
            'ranks.yourStats': 'YOUR STATS',
            'ranks.solo': 'SOLO GAMES',
            'ranks.games': 'games played',
            'ranks.accuracy': 'placed right',
            'ranks.bestScore': 'best score',
            'ranks.bestStreak': 'best streak',
            'ranks.cards': 'cards placed',
            'ranks.points': 'total points',
            'ranks.signIn': 'Save your account in Profile to keep your stats and see the leaderboards.',
            'ranks.offline': 'Your stats appear here once you are online.',
            'ranks.empty': 'Play a game and your stats show up here.',

            'profile.guestTitle': 'Keep your progress',
            'profile.guestText': 'Save your account to keep your games if you switch phones, and to appear on the leaderboards.',
            'profile.signedOutTitle': 'Sign in',
            'profile.signedOutText': 'Sign in to save your games, play with friends and appear on the leaderboards. Or just play: solo works without an account.',
            'profile.google': 'Continue with Google',
            'profile.email': 'Use email instead',
            'profile.emailPlaceholder': 'you@example.com',
            'profile.emailSend': 'Send link',
            'profile.emailSent': 'Check your inbox and tap the link to finish.',
            'profile.guestName': 'Guest account on this phone',
            'profile.signedInAs': 'Signed in',
            'profile.name': 'Name in games',
            'profile.username': 'Username',
            'profile.usernameNeeded': 'needed for leaderboards',
            'profile.usernameHint': '3–20 letters, numbers, dots or underscores.',
            'profile.save': 'Save',
            'profile.saved': 'Saved',
            'profile.appearance': 'Appearance',
            'profile.theme.system': 'System',
            'profile.theme.light': 'Light',
            'profile.theme.dark': 'Dark',
            'profile.language': 'Language',
            'profile.feedback': 'Send feedback or report a card',
            'profile.about': 'About & image credits',
            'profile.signOut': 'Sign out',
            'profile.delete': 'Delete account',
            'profile.deleteConfirm': 'Tap again to delete your account and all your games for good.',
            'profile.offline': 'Online features are not available right now. Solo play works as always.',

            'about.title': 'About CIRCArt',
            'about.text': 'CIRCArt is a game about art history by Julian Langschwert. Every card credits its artist, title, year and collection. The images are reproductions used for a non-commercial educational game, mostly from Wikimedia Commons and museum open-access collections. If you hold rights in a work shown here and would like it removed or credited differently, write to julian@langschwerts.de.',
            'about.close': 'Close',

            'feedback.sent': 'Thanks! Your feedback has been sent.',
            'feedback.hint': 'This goes straight to the CIRCArt team. If sending fails, your email app opens with everything filled in.',
            'feedback.flag': 'Report this card',

            'friends.title': 'Play with friends',
            'friends.text': 'Everyone gets the same cards on one shared timeline. Faster right answers score more.',
            'friends.live': 'Live game',
            'friends.liveText': 'Everyone plays at the same moment. 20 seconds per card, about 10 minutes.',
            'friends.async': 'Over a few days',
            'friends.asyncText': 'Play your turn whenever you like. 4 turns of 3 cards, 24 hours each.',
            'friends.name': 'Your name in the game',
            'home.lobbyInfo': 'Waiting to start · code {code}',
            'home.liveNow': 'Live now',
            'home.finished': 'Finished · you placed #{rank}',
            'home.waitingOthers': 'Turn {turn} of {turns} · waiting for the others',

            'game.live': 'Live game',
            'game.async': 'Game with friends',
            'game.points': '{n} pts',
            'game.hoursMin': '{h} h {m} min',
            'game.minutes': '{m} min',
            'game.dropped': 'You missed two turns in a row, so the game carries on without you.',
            'game.cancelled': 'This game was cancelled.',
            'game.home': 'Back home',
            'game.you': '(you)',
            'game.out': 'out',
            'game.played': '✓ played',
            'game.notYet': 'not yet',
            'game.joinWith': 'Join with code',
            'game.share': 'Share invite',
            'game.shareText': 'Play CIRCArt with me! Code {code}',
            'game.copied': 'Invite link copied',
            'game.players': 'Players',
            'game.host': 'host',
            'game.liveRules': '{n} cards · 20 s per card',
            'game.asyncRules': '{turns} turns of {cards} cards · 24 h per turn',
            'game.waitPlayers': 'Waiting for players…',
            'game.start': 'Start game',
            'game.waitHost': 'Waiting for the host to start…',
            'game.leave': 'Leave game',
            'game.before': 'before {y}',
            'game.after': 'after {y}',
            'game.between': 'between {a} and {b}',
            'game.timeline': 'Shared timeline',
            'game.card': 'Card {n} / {total}',
            'game.artAlt': 'Artwork to place',
            'game.tap': 'Tap where it belongs',
            'game.answered': '{n} of {total} answered',
            'game.whoPainted': 'Who made it?',
            'game.skip': 'Skip',
            'game.tooSlow': 'Too slow',
            'game.locked': 'Locked in!',
            'game.correct': 'Correct!',
            'game.wrong': 'Not quite',
            'game.streak': '{n} in a row · streak bonus',
            'game.next': 'Next',
            'game.whereEveryone': 'Where everyone placed it',
            'game.afterCard': 'After card {n}',
            'game.nextIn': 'Next card in',
            'game.finalIn': 'Final results in',
            'game.turnOf': 'Turn {n} of {total}',
            'game.closesIn': 'closes in {time}',
            'game.turnDone': 'Turn done',
            'game.turnDoneText': 'The turn closes when everyone has played, or when the time runs out. Then the next one opens.',
            'game.standings': 'Standings',
            'game.over': 'Game over · {n} cards',
            'game.wins': '{name} wins',
            'game.youWin': 'You win!',
            'game.placedRight': 'placed right',
            'game.pointsLabel': 'points',
            'game.yourTurn': 'Your turn',
            'game.readyText': '{n} cards in a row. Each one gives you 20 seconds once it appears, so start when you have two minutes.',
            'game.startTurn': 'Start turn {n}',

            'common.close': 'Close',
            'common.error': 'Something went wrong. Please try again.',
        },
    };

    const LANG_KEY = 'circart-lang';

    function current() {
        let lang = null;
        try { lang = localStorage.getItem(LANG_KEY); } catch (e) { /* ignore */ }
        if (lang && STRINGS[lang]) return lang;
        const nav = (navigator.language || 'en').slice(0, 2);
        return STRINGS[nav] ? nav : 'en';
    }

    let lang = current();

    function t(key, vars) {
        const s = (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key;
        return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s;
    }

    function apply(root) {
        (root || document).querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
        (root || document).querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
        (root || document).querySelectorAll('[data-i18n-label]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nLabel)); });
        document.documentElement.lang = lang;
    }

    function setLanguage(code) {
        if (!STRINGS[code]) return;
        lang = code;
        try { localStorage.setItem(LANG_KEY, code); } catch (e) { /* ignore */ }
        apply();
    }

    const NAMES = { en: 'English', de: 'Deutsch' };
    const languages = () => Object.keys(STRINGS).map(code => ({ code, name: NAMES[code] || code }));

    window.CircI18n = { t, apply, setLanguage, languages, get lang() { return lang; } };
})();
