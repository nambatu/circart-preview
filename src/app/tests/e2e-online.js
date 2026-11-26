(function(){
  const who = new URLSearchParams(location.search).get('as') || sessionStorage.getItem('as');
  if (who) sessionStorage.setItem('as', who);
  let offset = 0; const sync = r => { if (r && r.server_now) offset = new Date(r.server_now).getTime() - Date.now(); return r; };
  async function rpc(fn, args) {
    const r = await fetch('/rpc', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ who, fn, args: args||{} }) });
    const j = await r.json(); if (j.error) { const e = new Error(j.error); e.code = (String(j.error).match(/\b(friend_needs_account|user_not_found|not_friends|blocked|friend_not_found|too_many_requests|too_many_reactions|target_already_locked|not_locked|invite_not_found|game_not_found|game_started|game_full|not_host|need_two_players|bad_settings|already_answered|not_playing|card_not_open|not_yet|not_answered|bad_slot|username_needs_account|already_guessed_today|already_guessed|already_revealed|not_enough_patches|no_painting|too_early|too_many_tries|too_many_games|too_many_runs|not_signed_in|[a-z_]+_(?:invalid|taken))\b/) || [])[0]; throw e; } return sync(j.result);
  }
  window.CircOnline = {
    available: () => true,
    user: async () => { try { return (await rpc('_test_user')) ? { id: who } : null; } catch (e) { return null; } },
    ensureGuest: async () => rpc('_test_signup'),
    getProfile: () => rpc('get_my_profile'), updateProfile: ({displayName=null,username=null}={}) => rpc('update_profile',{p_display_name:displayName,p_username:username}),
    soloStats: () => rpc('my_solo_stats'), recentlySeen: async () => [],
    saveSoloGame: game => rpc('submit_solo_game', { p: { client_id: crypto.randomUUID(), mode: game.mode || 'classic', started_at: game.startedAt || null, finished_at: new Date().toISOString(), score: game.score, bonus_points: game.bonusPoints || 0, best_streak: game.bestStreak || 0, cards: game.cards } }).catch(() => {}),
    myCollection: () => rpc('my_collection'),
    sendFeedback: (topic, msg, cardId, ctx) => rpc('submit_feedback', { p_topic: topic || 'x', p_message: msg || 'y', p_card_source_id: cardId || null, p_context: ctx || {} }),
    serverNow: () => Date.now() + offset,
    createGame: async (kind,{cardCount=null,cardsPerTurn=null,displayName=null}={}) => { await rpc('_test_signup'); return rpc('create_game',{p_kind:kind,p_card_count:cardCount,p_cards_per_turn:cardsPerTurn,p_display_name:displayName}); },
    joinGame: async (code,name) => { await rpc('_test_signup'); const id = await rpc('join_game',{p_code:code,p_display_name:name||null}); if (id == null) { const e = new Error('game_not_found'); e.code = 'game_not_found'; throw e; } return id; },
    startGame: id => rpc('start_game',{p_game:id}), leaveGame: id => rpc('leave_game',{p_game:id}),
    getGame: id => rpc('get_game',{p_game:id}), nextCard: id => rpc('next_card',{p_game:id}),
    answer: (id,p,s) => rpc('answer',{p_game:id,p_position:p,p_slot:s}),
    reveal: (id,p) => rpc('reveal',{p_game:id,p_position:p}), myGames: () => rpc('my_games'), watchGame: () => () => {},
    playDaily: async (name) => { await rpc('_test_signup'); return rpc('play_daily',{p_display_name:name||null}); },
    dailySummary: () => rpc('daily_summary'), dailyLeaderboard: d => rpc('daily_leaderboard',{p_date:d||null}),
    monthlyLeaderboard: m => rpc('monthly_leaderboard',{p_month:m||null}), alltimeLeaderboard: () => rpc('alltime_leaderboard'),
    myStats: () => rpc('my_stats'), pushSupported: () => true, pushPermission: () => window.__perm || 'default', enablePush: async () => { window.__perm = 'granted'; return true; }, pushOn: async () => window.__perm === 'granted', disablePush: async () => { window.__perm = 'default'; }, pushSettings: () => rpc('my_push_settings'), setPushSettings: (turns, invites, hour, lang) => rpc('set_push_settings',{p_turns:turns,p_invites:invites,p_daily_hour:hour,p_lang:lang}), myResults: id => rpc('my_results',{p_game:id}), rematch: id => rpc('rematch',{p_game:id}), rematchInfo: id => rpc('rematch_info',{p_game:id}), gameOptions: id => rpc('game_options',{p_game:id}), dailyStory: (date=null) => rpc('daily_story',{p_date:date}),
    setGameOptions: (id,{artistBonus=null,movementBonus=null,timer=null,seconds=null}={}) => rpc('set_game_options',{p_game:id,p_artist_bonus:artistBonus,p_movement_bonus:movementBonus,p_timer:timer,p_seconds:seconds}), previewResetDaily: () => rpc('preview_reset_daily'), startRun: async (n) => { await rpc('_test_signup'); return rpc('start_run',{p_display_name:n||null}); }, runSummary: () => rpc('run_summary'), monthlyWinners: m => rpc('monthly_winners',{p_month:m||null}), myBadges: () => rpc('my_badges'), myAchievements: () => rpc('my_achievements'), myPacks: () => rpc('my_packs'), markPacksSeen: () => rpc('mark_packs_seen'), pickBonus: (id,p,a,m) => rpc('pick_bonus',{p_game:id,p_position:p,p_artist:a,p_movement:m}),
    priceSummary: () => rpc('price_summary'), priceLeaderboard: () => rpc('price_leaderboard'),
    myStreak: () => rpc('my_streak'), myPainting: (week=null) => rpc('my_painting',{p_week:week}),
    guessPainting: choice => rpc('guess_painting',{p_choice:choice}), myRestorations: () => rpc('my_restorations'),
    myHistory: ({kind=null,limit=30,offset=0}={}) => rpc('my_history',{p_kind:kind,p_limit:limit,p_offset:offset}),
    roundLive: gameId => rpc('round_live', { p_game: gameId }),
    callIt: (gameId, position, targetSeat, predictOk) => rpc('call_it', { p_game: gameId, p_position: position, p_target_seat: targetSeat, p_predict_ok: predictOk }),
    sendReaction: (gameId, emoji, targetSeat = null) => rpc('send_reaction', { p_game: gameId, p_emoji: emoji, p_target_seat: targetSeat }),
    roundResults: (gameId, turn = null) => rpc('round_results', { p_game: gameId, p_turn: turn }),
    sendFriendRequest: username => rpc('send_friend_request', { p_username: username }),
    respondFriendRequest: (username, accept) => rpc('respond_friend_request', { p_username: username, p_accept: accept }),
    removeFriend: (username, block = false) => rpc('remove_friend', { p_username: username, p_block: block }),
    myFriends: () => rpc('my_friends'),
    friendProfile: username => rpc('friend_profile', { p_username: username }),
    friendsLeaderboard: (board, date = null) => rpc('friends_leaderboard', { p_board: board, p_date: date }),
    inviteFriendsToGame: (usernames, { kind = 'async', cardCount = 12, cardsPerTurn = 3 } = {}) => rpc('invite_friends_to_game', { p_usernames: usernames, p_kind: kind, p_card_count: cardCount, p_cards_per_turn: cardsPerTurn }),
    sendScoreChallenge: (username, mode, score) => rpc('send_score_challenge', { p_username: username, p_mode: mode, p_score: score }),
    myGameInvites: () => rpc('my_game_invites'),
    respondGameInvite: (inviteId, accept) => rpc('respond_game_invite', { p_invite_id: inviteId, p_accept: accept }),
  };
})();
