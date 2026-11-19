-- CIRCArt 027 — style "Late Gothic" (task 37d, story-card style check, 19 Nov).
--
-- Martin Schongauer's engraving of Saint Martin (story daily of 11 Nov) was
-- labelled "Northern Renaissance". Britannica and Wikipedia both call his work
-- late Gothic, so the card now says "Late Gothic". The player-facing group is
-- "Gothic", like the other medieval styles. (solo.js has the same mapping.)

insert into public.movement_groups (movement, grp, ord)
values ('Late Gothic', 'Gothic', 1)
on conflict (movement) do nothing;
