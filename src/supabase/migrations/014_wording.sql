-- CIRCArt 014 — friendlier wording for texts that live in the database.
-- The run rules are shown on the Monthly Run card already, so each month's
-- description only tells its theme.

update public.monthly_challenges set description = d.txt
  from (values
    ('2026-11-01'::date, 'The whole of art history in one long marathon. Pace yourself!'),
    ('2026-12-01'::date, 'Caravaggio to Canaletto, from 1580 to 1800. Expect drama in every frame.'),
    ('2027-01-01'::date, 'From Impressionism to Surrealism, the years when art broke all the rules.'),
    ('2027-02-01'::date, 'Giotto to the late Renaissance, when painters discovered perspective.'),
    ('2027-03-01'::date, 'From Pollock to Banksy. After 1945, art splashes outside the lines.')
  ) as d(m, txt)
 where month = d.m and description like '%Unlimited runs, 3 lives, your best run counts.%';

update public.packs set
  description    = '25 works from Rubens to Vermeer, painted when candlelight was the star.',
  description_de = '25 Werke von Rubens bis Vermeer, aus der Zeit, als Kerzenlicht der Star war.'
 where id = 'baroque-masters' and description like 'Drama, candlelight and gold%';
