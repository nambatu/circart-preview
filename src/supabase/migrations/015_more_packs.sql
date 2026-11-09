-- CIRCArt 015 — two more card packs, earned by playing.
--
-- "Impressionists" (c. 1865–1905) unlocks after 5 daily challenges,
-- "Renaissance Masters" (c. 1420–1580) after 5 saved solo games.
-- Both rule types already exist in _pack_progress (012), so this is data only.
-- The cards live in docs/packs/impressionists.json and docs/packs/renaissance.json;
-- the texts below match the "pack" block of those files.

insert into public.packs (id, title, title_de, description, description_de, unlock_rule, unlock_text, unlock_text_de, sort) values
  ('impressionists', 'Impressionists', 'Impressionisten',
   '25 works from Monet to van Gogh, painted when artists took their easels outside.',
   '25 Werke von Monet bis van Gogh, aus der Zeit, als die Maler mit der Staffelei ins Freie zogen.',
   '{"type": "dailies_played", "n": 5}', 'Play 5 daily challenges to unlock.', 'Spiel 5 Tageschallenges, um das Pack freizuschalten.', 30),
  ('renaissance', 'Renaissance Masters', 'Meister der Renaissance',
   '25 works from van Eyck to El Greco, painted when perspective was the latest thing.',
   '25 Werke von van Eyck bis El Greco, aus der Zeit, als die Perspektive der letzte Schrei war.',
   '{"type": "solo_games", "n": 5}', 'Play 5 solo games to unlock.', 'Spiel 5 Solo-Partien, um das Pack freizuschalten.', 40)
on conflict (id) do nothing;
