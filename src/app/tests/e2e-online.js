(function(){
  const who = new URLSearchParams(location.search).get('as') || sessionStorage.getItem('as');
  if (who) sessionStorage.setItem('as', who);
  let offset = 0; const sync = r => { if (r && r.server_now) offset = new Date(r.server_now).getTime() - Date.now(); return r; };
  async function rpc(fn, args) {
    const r = await fetch('/rpc', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ who, fn, args: args||{} }) });
    const j = await r.json(); if (j.error) { const e = new Error(j.error); e.code = (String(j.error).match(/[a-z_]+_(invalid|taken)/) || [])[0]; throw e; } return sync(j.result);
  }
  window.CircOnline = {
    available: () => true,
    user: async () => (await rpc('_test_user')) ? { id: who } : null,
    ensureGuest: async () => rpc('_test_signup'),
    getProfile: () => rpc('get_my_profile'), updateProfile: ({displayName=null,username=null}={}) => rpc('update_profile',{p_display_name:displayName,p_username:username}),
    soloStats: () => rpc('my_solo_stats'), recentlySeen: async () => [], saveSoloGame: () => {}, sendFeedback: () => rpc('submit_feedback',{p_topic:'x',p_message:'y'}),
    serverNow: () => Date.now() + offset,
    createGame: async (kind,{cardCount=null,cardsPerTurn=null,displayName=null}={}) => { await rpc('_test_signup'); return rpc('create_game',{p_kind:kind,p_card_count:cardCount,p_cards_per_turn:cardsPerTurn,p_display_name:displayName}); },
    joinGame: async (code,name) => { await rpc('_test_signup'); return rpc('join_game',{p_code:code,p_display_name:name||null}); },
    startGame: id => rpc('start_game',{p_game:id}), leaveGame: id => rpc('leave_game',{p_game:id}),
    getGame: id => rpc('get_game',{p_game:id}), nextCard: id => rpc('next_card',{p_game:id}),
    answer: (id,p,s) => rpc('answer',{p_game:id,p_position:p,p_slot:s}), pickArtist: (id,p,c) => rpc('pick_artist',{p_game:id,p_position:p,p_choice:c}),
    reveal: (id,p) => rpc('reveal',{p_game:id,p_position:p}), myGames: () => rpc('my_games'), watchGame: () => () => {},
    playDaily: async (name) => { await rpc('_test_signup'); return rpc('play_daily',{p_display_name:name||null}); },
    dailySummary: () => rpc('daily_summary'), dailyLeaderboard: d => rpc('daily_leaderboard',{p_date:d||null}),
    monthlyLeaderboard: m => rpc('monthly_leaderboard',{p_month:m||null}), alltimeLeaderboard: () => rpc('alltime_leaderboard'),
    myStats: () => rpc('my_stats'), pushSupported: () => true, pushPermission: () => window.__perm || 'default', enablePush: async () => { window.__perm = 'granted'; return true; }, pushOn: async () => window.__perm === 'granted', disablePush: async () => { window.__perm = 'default'; }, myResults: id => rpc('my_results',{p_game:id}), rematch: id => rpc('rematch',{p_game:id}), rematchInfo: id => rpc('rematch_info',{p_game:id}), gameOptions: id => rpc('game_options',{p_game:id}), dailyStory: (date=null) => rpc('daily_story',{p_date:date}),
    setGameOptions: (id,{artistBonus=null,movementBonus=null,timer=null,seconds=null}={}) => rpc('set_game_options',{p_game:id,p_artist_bonus:artistBonus,p_movement_bonus:movementBonus,p_timer:timer,p_seconds:seconds}), previewResetDaily: () => rpc('preview_reset_daily'), startRun: async (n) => { await rpc('_test_signup'); return rpc('start_run',{p_display_name:n||null}); }, runSummary: () => rpc('run_summary'), monthlyWinners: m => rpc('monthly_winners',{p_month:m||null}), myBadges: () => rpc('my_badges'), myPacks: () => rpc('my_packs'), markPacksSeen: () => rpc('mark_packs_seen'), pickBonus: (id,p,a,m) => rpc('pick_bonus',{p_game:id,p_position:p,p_artist:a,p_movement:m}),
  };
})();
