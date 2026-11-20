-- CIRCArt 029: the Gallery matches cards by cards.source_id (the deck's id), but my_collection()
-- (025) returned the database's random cards.id, so nothing ever unlocked from daily, run or friends games.
create or replace function public.my_collection() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me uuid := _me(); seen text[]; won text[];
begin
  select coalesce(array_agg(distinct cd.source_id), '{}') into seen from (
    select gc.card_id id from solo_game_cards gc join solo_games g on g.id = gc.game_id where g.player_id = me
    union
    select c.card_id from answers a join game_cards c on c.game_id = a.game_id and c.position = a.position
     where a.player_id = me and (a.answered_at is not null or a.timed_out)
    union
    select c.card_id from game_cards c join game_players p on p.game_id = c.game_id
      join games g on g.id = c.game_id
     where p.player_id = me and c.position = 0 and g.status in ('playing','finished')
  ) s join cards cd on cd.id = s.id;
  select coalesce(array_agg(distinct cd.source_id), '{}') into won from (
    select gc.card_id id from solo_game_cards gc join solo_games g on g.id = gc.game_id
     where g.player_id = me and gc.correct
    union
    select c.card_id from answers a join game_cards c on c.game_id = a.game_id and c.position = a.position
     where a.player_id = me and a.correct and (a.answered_at is not null or a.timed_out)
  ) w join cards cd on cd.id = w.id;
  return jsonb_build_object('seen', to_jsonb(seen), 'correct', to_jsonb(won));
end $$;
