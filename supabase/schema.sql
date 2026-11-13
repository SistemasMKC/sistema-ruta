-- =====================================================================
--  Sistema de Rutas · esquema de base de datos (Supabase / PostgreSQL)
--  Ejecutar completo en: Supabase > SQL Editor > New query > Run
-- =====================================================================
--  Modelo de acceso
--   * Despachador: usuario de Supabase Auth (email + clave). Acceso total por RLS.
--   * Domiciliario: NO es usuario de Auth. Entra con un PIN y solo habla con
--     funciones RPC (SECURITY DEFINER) que validan un token de sesión.
--   * Cliente: enlace con token aleatorio -> función track_order (solo lectura,
--     sin teléfono ni datos de otros pedidos).
--   * El rol "anon" NO tiene acceso directo a ninguna tabla.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- Tablas ---------------------------------------------------
create table if not exists public.drivers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  pin_hash      text not null,
  session_token uuid,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists public.orders (
  id            uuid primary key default gen_random_uuid(),
  order_no      bigint generated always as identity,
  customer_name text not null,
  phone         text,
  address       text not null,
  lat           double precision not null,
  lng           double precision not null,
  notes         text,
  status        text not null default 'pending'
                check (status in ('pending','assigned','delivered','failed')),
  driver_id     uuid references public.drivers(id) on delete set null,
  seq           int,
  track_token   text not null unique default encode(extensions.gen_random_bytes(9), 'hex'),
  fail_reason   text,
  has_proof     boolean not null default false,
  finished_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists orders_status_idx on public.orders(status);
create index if not exists orders_driver_idx on public.orders(driver_id);

-- La evidencia (foto) va aparte para no inflar las consultas ni el realtime.
create table if not exists public.order_proofs (
  order_id uuid primary key references public.orders(id) on delete cascade,
  photo    text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.driver_locations (
  driver_id  uuid primary key references public.drivers(id) on delete cascade,
  lat        double precision not null,
  lng        double precision not null,
  speed      double precision,
  heading    double precision,
  updated_at timestamptz not null default now()
);

-- ---------- RLS: solo personal autenticado ---------------------------
alter table public.drivers          enable row level security;
alter table public.orders           enable row level security;
alter table public.order_proofs     enable row level security;
alter table public.driver_locations enable row level security;

drop policy if exists staff_all on public.drivers;
drop policy if exists staff_all on public.orders;
drop policy if exists staff_all on public.order_proofs;
drop policy if exists staff_all on public.driver_locations;
create policy staff_all on public.drivers          for all to authenticated using (true) with check (true);
create policy staff_all on public.orders           for all to authenticated using (true) with check (true);
create policy staff_all on public.order_proofs     for all to authenticated using (true) with check (true);
create policy staff_all on public.driver_locations for all to authenticated using (true) with check (true);

revoke all on public.drivers, public.orders, public.order_proofs, public.driver_locations from anon;

-- ---------- Realtime para el panel del despachador -------------------
do $$ begin
  alter publication supabase_realtime add table public.orders;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.driver_locations;
exception when duplicate_object then null; end $$;

-- ---------- Funciones internas ---------------------------------------
create or replace function public._driver_by_token(p_token uuid)
returns public.drivers
language sql stable security definer set search_path = public as $$
  select * from public.drivers where session_token = p_token and active limit 1;
$$;
revoke all on function public._driver_by_token(uuid) from public, anon, authenticated;

-- ---------- RPC del domiciliario (acceso con PIN / token) -------------
create or replace function public.driver_login(p_pin text)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare d public.drivers; tok uuid;
begin
  select * into d from public.drivers
   where active and pin_hash = crypt(p_pin, pin_hash) limit 1;
  if d.id is null then
    perform pg_sleep(1);          -- frena fuerza bruta
    return null;
  end if;
  tok := gen_random_uuid();
  update public.drivers set session_token = tok where id = d.id;
  return json_build_object('token', tok, 'name', d.name);
end $$;

create or replace function public.driver_orders(p_token uuid)
returns json
language plpgsql security definer set search_path = public as $$
declare d public.drivers;
begin
  d := public._driver_by_token(p_token);
  if d.id is null then return null; end if;
  return json_build_object(
    'driver', json_build_object('name', d.name),
    'orders', coalesce((
      select json_agg(o order by o.fin, o.seq nulls last, o.order_no)
      from (
        select id, order_no, customer_name, phone, address, lat, lng, notes,
               status, seq, fail_reason, finished_at,
               (status in ('delivered','failed')) as fin
          from public.orders
         where driver_id = d.id
           and (status = 'assigned'
                or finished_at >= (date_trunc('day', now() at time zone 'America/Bogota') at time zone 'America/Bogota'))
      ) o
    ), '[]'::json)
  );
end $$;

create or replace function public.driver_ping(
  p_token uuid, p_lat double precision, p_lng double precision,
  p_speed double precision default null, p_heading double precision default null)
returns boolean
language plpgsql security definer set search_path = public as $$
declare d public.drivers;
begin
  d := public._driver_by_token(p_token);
  if d.id is null then return false; end if;
  insert into public.driver_locations(driver_id, lat, lng, speed, heading, updated_at)
  values (d.id, p_lat, p_lng, p_speed, p_heading, now())
  on conflict (driver_id) do update
    set lat = excluded.lat, lng = excluded.lng, speed = excluded.speed,
        heading = excluded.heading, updated_at = now();
  return true;
end $$;

-- El domiciliario puede reordenar sus propias paradas pendientes.
create or replace function public.driver_set_route(p_token uuid, p_ids uuid[])
returns boolean
language plpgsql security definer set search_path = public as $$
declare d public.drivers;
begin
  d := public._driver_by_token(p_token);
  if d.id is null then return false; end if;
  update public.orders o set seq = t.ord
    from unnest(p_ids) with ordinality as t(id, ord)
   where o.id = t.id and o.driver_id = d.id and o.status = 'assigned';
  return true;
end $$;

create or replace function public.driver_update_order(
  p_token uuid, p_order_id uuid, p_status text,
  p_reason text default null, p_photo text default null)
returns boolean
language plpgsql security definer set search_path = public as $$
declare d public.drivers; n int;
begin
  d := public._driver_by_token(p_token);
  if d.id is null then return false; end if;
  if p_status not in ('delivered','failed') then raise exception 'estado inválido'; end if;
  if p_photo is not null and length(p_photo) > 400000 then raise exception 'foto demasiado grande'; end if;

  update public.orders
     set status = p_status,
         fail_reason = case when p_status = 'failed' then left(p_reason, 300) else null end,
         finished_at = now(),
         has_proof = (p_photo is not null)
   where id = p_order_id and driver_id = d.id and status = 'assigned';
  get diagnostics n = row_count;
  if n = 0 then return false; end if;

  if p_photo is not null then
    insert into public.order_proofs(order_id, photo) values (p_order_id, p_photo)
    on conflict (order_id) do update set photo = excluded.photo, created_at = now();
  end if;
  return true;
end $$;

-- ---------- RPC del cliente (enlace de seguimiento) --------------------
create or replace function public.track_order(p_track text)
returns json
language plpgsql security definer set search_path = public as $$
declare o public.orders; dn text; loc public.driver_locations; ahead int := 0;
begin
  select * into o from public.orders where track_token = p_track;
  if o.id is null then return null; end if;

  select name into dn from public.drivers where id = o.driver_id;
  select * into loc from public.driver_locations
   where driver_id = o.driver_id and updated_at > now() - interval '10 minutes';

  if o.status = 'assigned' and o.seq is not null then
    select count(*) into ahead from public.orders x
     where x.driver_id = o.driver_id and x.status = 'assigned' and x.seq < o.seq;
  end if;

  return json_build_object(
    'status', o.status,
    'first_name', split_part(o.customer_name, ' ', 1),
    'address', o.address,
    'lat', o.lat, 'lng', o.lng,
    'driver_name', split_part(coalesce(dn, ''), ' ', 1),
    'stops_ahead', ahead,
    'finished_at', o.finished_at,
    'driver', case when o.status = 'assigned' and loc.driver_id is not null
                   then json_build_object('lat', loc.lat, 'lng', loc.lng, 'updated_at', loc.updated_at)
                   else null end
  );
end $$;

-- ---------- RPC del despachador (requieren sesión autenticada) ---------
create or replace function public.create_driver(p_name text, p_pin text)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare new_id uuid;
begin
  if auth.role() <> 'authenticated' then raise exception 'no autorizado'; end if;
  if length(coalesce(p_pin, '')) < 6 then raise exception 'El PIN debe tener mínimo 6 caracteres'; end if;
  if exists (select 1 from public.drivers where pin_hash = crypt(p_pin, pin_hash)) then
    raise exception 'Ese PIN ya está en uso, elige otro';
  end if;
  insert into public.drivers(name, pin_hash) values (trim(p_name), crypt(p_pin, gen_salt('bf')))
  returning id into new_id;
  return new_id;
end $$;

create or replace function public.reset_driver_pin(p_id uuid, p_pin text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.role() <> 'authenticated' then raise exception 'no autorizado'; end if;
  if length(coalesce(p_pin, '')) < 6 then raise exception 'El PIN debe tener mínimo 6 caracteres'; end if;
  if exists (select 1 from public.drivers where id <> p_id and pin_hash = crypt(p_pin, pin_hash)) then
    raise exception 'Ese PIN ya está en uso, elige otro';
  end if;
  update public.drivers set pin_hash = crypt(p_pin, gen_salt('bf')), session_token = null where id = p_id;
  return true;
end $$;

-- Borra fotos de evidencia viejas para no llenar el plan gratuito (500 MB).
create or replace function public.purge_old_proofs(p_days int default 60)
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.role() <> 'authenticated' then raise exception 'no autorizado'; end if;
  delete from public.order_proofs
   where order_id in (select id from public.orders where finished_at < now() - make_interval(days => p_days));
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- Permisos de ejecución --------------------------------------
revoke execute on function public.create_driver(text, text)      from public, anon;
revoke execute on function public.reset_driver_pin(uuid, text)   from public, anon;
revoke execute on function public.purge_old_proofs(int)          from public, anon;
grant  execute on function public.create_driver(text, text)      to authenticated;
grant  execute on function public.reset_driver_pin(uuid, text)   to authenticated;
grant  execute on function public.purge_old_proofs(int)          to authenticated;

grant execute on function public.driver_login(text)                                         to anon, authenticated;
grant execute on function public.driver_orders(uuid)                                        to anon, authenticated;
grant execute on function public.driver_ping(uuid, double precision, double precision, double precision, double precision) to anon, authenticated;
grant execute on function public.driver_set_route(uuid, uuid[])                             to anon, authenticated;
grant execute on function public.driver_update_order(uuid, uuid, text, text, text)          to anon, authenticated;
grant execute on function public.track_order(text)                                          to anon, authenticated;
