-- A coller dans Supabase > SQL Editor > New query > Run (une seule fois).
-- Modele : un "carnet" = une famille. Chaque appareil envoie l'en-tete x-carnet (identifiant secret du carnet) ;
-- les regles RLS ne laissent voir/modifier que les lignes de ce carnet.

create table if not exists recettes (
  id text primary key,
  carnet uuid not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists planning (
  id text primary key,          -- <carnet>_<AAAA-MM-JJ>
  carnet uuid not null,
  date date not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists courses (
  carnet uuid primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists recettes_carnet on recettes(carnet);
create index if not exists planning_carnet on planning(carnet, date);

create or replace function carnet_courant() returns uuid language sql stable as $$
  select nullif(current_setting('request.headers', true)::json->>'x-carnet', '')::uuid
$$;

alter table recettes enable row level security;
alter table planning enable row level security;
alter table courses enable row level security;

drop policy if exists recettes_carnet on recettes;
create policy recettes_carnet on recettes for all using (carnet = carnet_courant()) with check (carnet = carnet_courant());
drop policy if exists planning_carnet on planning;
create policy planning_carnet on planning for all using (carnet = carnet_courant()) with check (carnet = carnet_courant());
drop policy if exists courses_carnet on courses;
create policy courses_carnet on courses for all using (carnet = carnet_courant()) with check (carnet = carnet_courant());

-- Photos : bucket public en lecture (les URLs contiennent l'identifiant du carnet, impossible a deviner),
-- ecriture/suppression seulement dans le dossier de son carnet.
insert into storage.buckets (id, name, public) values ('photos', 'photos', true) on conflict (id) do nothing;
drop policy if exists photos_lecture on storage.objects;
create policy photos_lecture on storage.objects for select using (bucket_id = 'photos');
drop policy if exists photos_ecriture on storage.objects;
create policy photos_ecriture on storage.objects for insert with check (bucket_id = 'photos' and (storage.foldername(name))[1] = carnet_courant()::text);
drop policy if exists photos_maj on storage.objects;
create policy photos_maj on storage.objects for update using (bucket_id = 'photos' and (storage.foldername(name))[1] = carnet_courant()::text);
drop policy if exists photos_suppression on storage.objects;
create policy photos_suppression on storage.objects for delete using (bucket_id = 'photos' and (storage.foldername(name))[1] = carnet_courant()::text);
