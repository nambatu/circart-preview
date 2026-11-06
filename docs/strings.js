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

            'home.tagline': 'Put art history in the right order, one masterpiece at a time.',
            'home.solo.eyebrow': 'SOLO',
            'home.solo.title': 'One timeline, your pace',
            'home.solo.rounds': 'Cards',
            'home.solo.start': 'Start a game',
            'home.daily.eyebrow': 'DAILY CHALLENGE · NO. {no}',
            'home.daily.title': 'Ten works, one timeline',
            'home.daily.sub': 'Everyone gets the same cards today, and you only get one shot.',
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
            'ranks.empty': 'Play a game and your stats will show up here. For now it\'s a blank canvas.',

            'profile.guestTitle': 'Keep your progress',
            'profile.guestText': 'Save your account and your games will follow you to a new phone. It also puts you on the leaderboards.',
            'profile.signedOutTitle': 'Sign in',
            'profile.signedOutText': 'With an account your games are saved and you can play with friends. Just want to play? Solo works without one.',
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
            'profile.usernameHint': 'Between 3 and 20 characters. Use letters and numbers, plus dots or underscores if you like.',
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
            'about.text': 'CIRCArt is a game about art history, made by Julian Langschwert. Every card tells you who made the work and where you can see it today. The images are reproductions, mostly from Wikimedia Commons and the open collections of museums, and they are used in a free game that makes no money. If a work shown here is yours and you would like it removed or credited differently, write to julian@langschwerts.de.',
            'about.close': 'Close',

            'feedback.sent': 'Thanks! Your feedback has been sent.',
            'feedback.hint': 'This goes straight to the CIRCArt team. If sending fails, your email app opens with everything filled in.',
            'feedback.flag': 'Report this card',

            'friends.title': 'Play with friends',
            'friends.text': 'Everyone plays the same cards on one shared timeline. The faster you\'re right, the more points you get.',
            'friends.live': 'Live game',
            'friends.liveText': 'Everyone plays at the same time, with 20 seconds per card. A game takes about ten minutes.',
            'friends.async': 'Over a few days',
            'friends.asyncText': 'Play your turn whenever it suits you. A game has four turns of three cards, and each turn stays open for a day.',
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
            'game.asyncRules': '{turns} turns with {cards} cards each. Every turn stays open for a day.',
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
            'game.readyText': 'Up next are {n} cards in a row, with 20 seconds for each. Start when you have two minutes to spare.',
            'game.startTurn': 'Start turn {n}',

            'game.daily': 'Daily challenge · No. {no}',
            'game.dailyShort': 'Daily challenge',
            'game.dailyStartText': 'Everyone gets the same ten cards today, and you only get one shot. Each card gives you twenty seconds, so there\'s no time to let the paint dry.',
            'game.dailyStart': 'Start',
            'game.results': 'See results',
            'game.dailyDone': 'Daily done',
            'game.dailyScore': '{correct} of {total} placed right',
            'game.dailyRank': 'Rank {rank} of {players}',
            'game.dailyUnranked': 'Save your account and pick a username in Profile to appear on the leaderboard.',
            'game.dailyShare': 'Share result',
            'game.dailyShareText': 'CIRCArt daily No. {no}: {correct}/{total} · {score} pts',
            'game.copiedResult': 'Result copied',
            'solo.bonusTitle': 'Bonus (optional)',
            'solo.bonusHint': 'Answer before you place the card. Every right answer adds a point.',
            'solo.movementRight': 'Movement right: {name} (+1 point)',
            'solo.movementWrong': 'Wrong movement (was: {name})',
            'game.replayTest': 'Play again (test version only)',
            'run.eyebrow': '{month} RUN',
            'run.short': 'Monthly Run',
            'run.title': '{title}',
            'run.rules': 'Play as often as you like. You get three lives per run, and only your masterpiece makes the leaderboard.',
            'run.play': 'Start a run',
            'run.continue': 'Continue your run',
            'run.best': 'Your best: {score} · #{rank} of {players}',
            'run.bestUnranked': 'Your best: {score}',
            'run.none': 'No run yet this month. You still have {days} days to make your mark.',
            'run.above': 'Beat {name}: {score} pts',
            'run.daysLeft': '{days} days left',
            'run.startText': 'Cards keep coming until your third mistake. You get 20 seconds per card, and the faster you are, the more you score. Play as often as you like, because only your best run counts.',
            'run.go': 'Go',
            'run.lives': 'Lives',
            'run.lifeLost': 'One life lost',
            'run.over': 'Run over',
            'run.cards': '{n} cards placed',
            'run.newBest': 'New personal best!',
            'run.again': 'Again',
            'run.share': 'CIRCArt {month} Run: {score} pts · {n} cards',
            'run.board': 'This month',
            'back.again': 'Swipe back once more to close CIRCArt.',
            'back.leaveTitle': 'Leave this game?',
            'back.leaveSolo': "If you go back now, this game is gone for good. Your timeline will stay unfinished, like a sketch nobody completes.",
            'back.stay': 'Keep playing',
            'back.leave': 'Leave the game',
            'onb.s1Note': 'Speed pays off. In multiplayer a right answer is worth up to 1000 points, and a streak of right answers adds a bonus.',
            'onb.s3Body': 'Everyone gets the same ten cards, and you have one try. Climb the leaderboard and keep your streak alive.',
            'onb.s4LiveBody': 'Everyone plays at once, with 20 seconds per card.',
            'onb.s4AsyncBody': 'Each turn stays open for a day, and we\'ll let you know when it\'s your move.',
            'packs.eyebrow': 'CARD PACKS',
            'packs.cards': '{n} cards',
            'packs.play': 'Play this pack',
            'packs.inSolo': 'Mixed into your solo games',
            'packs.mix': 'Mix my packs into solo games',
            'packs.locked': '🔒 {task}',
            'packs.progress': '{n} of {total}',
            'packs.new': '🎉 New pack unlocked: {name}!',
            'packs.signIn': 'Play the daily or a Monthly Run to start earning packs.',
            'onb.s3Note': 'There\'s also the Monthly Run. Play it as often as you like, because only your best run counts.',
            'profile.howTo': 'How to play',
            'profile.export': 'Download my data',
            'profile.privacy': 'Privacy policy',
            'ranks.winnersTitle': "{month}'s winners",
            'profile.badges': 'Your badges',
            'profile.badgeLine': 'Monthly Run · place {rank} · {score} pts',
            'profile.testPush': 'Send me a test notification',
            'profile.testPushSent': 'Sent! It should arrive within a minute.',
            'profile.testPushOff': 'Turn notifications on first.',
            'game.artistBonus': 'Artist bonus',
            'game.artistBonusText': 'After you place a card, guess who made it. Pick the right name out of four and you get +200.',
            'game.artistOff': 'No artist question. Just you and the timeline.',
            'game.artistWas': 'Artist: {name}',
            'game.movementWas': 'Movement: {name}',
            'game.whichMovement': 'Which movement?',
            'game.movementBonus': 'Movement bonus',
            'game.movementBonusText': 'Then guess the art movement. One of four is right, and it\'s worth +100.',
            'game.bonusBoth': 'After each card you can guess the artist for +200 and the movement for +100.',
            'game.bonusArtist': 'After each card you can guess the artist for +200.',
            'game.bonusMovement': 'After each card you can guess the movement for +100.',
            'game.bonusNone': 'No bonus questions. Just you and the timeline.',
            'push.title': 'Get told when it\'s your turn?',
            'push.text': 'We\'ll tell you when it\'s your turn and remind you three hours before it closes. That\'s all, promise.',
            'push.on': 'Turn on',
            'push.later': 'Not now',
            'push.done': 'Notifications are on',
            'push.iphone': 'On iPhone: add CIRCArt to your home screen first (Share → Add to Home Screen), then open it from there.',
            'profile.notifications': 'Turn notifications',
            'profile.notifOn': 'On',
            'profile.notifOff': 'Off',
            'game.shareGame': 'CIRCArt: I came {rank} of {players} · {correct}/{total} · {score} pts',
            'game.playAgain': 'Play again',
            'game.rematchBy': '{name} wants a rematch',
            'game.rematchJoin': 'Join the rematch',
            'game.rematchOpen': 'Open the rematch',
            'game.leaveTitle': 'Leave this game?',
            'game.leaveLive': 'The others play on without you. You can\'t come back to this game.',
            'game.leaveYes': 'Leave game',
            'game.leaveNo': 'Keep playing',
            'game.notFound': 'That game doesn\'t exist any more.',
            'game.dailyTomorrow': 'A fresh canvas arrives at midnight, when the next daily starts.',

            'ranks.today': 'Today',
            'ranks.month': 'Month',
            'ranks.allTime': 'All time',
            'ranks.players': '{n} players today',
            'ranks.players1': '1 player today',
            'home.streak1': '1 day',
            'game.yourTimeline': 'Your timeline',
            'ranks.nobody': 'Nobody on the board yet. Paint yourself in first!',
            'ranks.you': 'You',
            'ranks.youRank': 'You: #{rank} · {value}',
            'ranks.notRanked': 'Pick a username in Profile to appear here.',
            'ranks.daysLeft': '{n} days left',
            'ranks.online': 'ONLINE GAMES',
            'ranks.wins': 'wins',
            'ranks.dailyStreak': 'daily streak',
            'ranks.artists': 'artists named',
            'ranks.pts': '{n} pts',

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

    // more languages register themselves: strings-de.js calls extend('de', {...}, 'Deutsch')
    function extend(code, dict, name) {
        STRINGS[code] = Object.assign(STRINGS[code] || {}, dict);
        if (name) NAMES[code] = name;
        lang = current();
    }

    window.CircI18n = { t, apply, setLanguage, languages, extend, get lang() { return lang; } };
    (window.CIRC_PENDING_LANGS || []).forEach(a => extend.apply(null, a));
})();
