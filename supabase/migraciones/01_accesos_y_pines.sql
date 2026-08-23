-- PENDIENTE DE APLICAR. Paso 1 de 2: añade el control de acceso sin quitar nada.
--
-- Es seguro ejecutarla con la app antigua en producción: solo AÑADE tablas,
-- columnas y funciones. Las políticas abiertas siguen ahí, así que la versión
-- que hay desplegada sigue funcionando igual mientras se despliega la nueva.
-- La que cierra la puerta de verdad es la 02.

/* ── 1) Contraseña de oficina ──────────────────────────────────────────── */

create table if not exists public.accesos (
  rol           text primary key check (rol in ('oficinista')),
  password_hash text not null,
  algoritmo     text not null default 'bcrypt' check (algoritmo in ('bcrypt','sha256')),
  updated_at    timestamptz not null default now()
);
alter table public.accesos enable row level security;
revoke all on public.accesos from anon, authenticated;

-- Hereda la contraseña que ya está en uso (hash sha256 en `officers`), para no
-- dejar a nadie fuera el día del cambio. Se reescribe a bcrypt sola en el
-- primer acceso correcto.
insert into public.accesos (rol, password_hash, algoritmo)
select 'oficinista', o.password_hash, 'sha256' from public.officers o limit 1
on conflict (rol) do nothing;

/* ── 2) PIN propio por barco, cifrado ──────────────────────────────────── */

alter table public.barcos add column if not exists pin_hash text;

-- `pin` es NOT NULL. Se relaja para poder dar de alta barcos sin escribir
-- nada en claro; la columna se elimina entera en la migración 02. Los valores
-- que ya están NO se tocan, para que la versión antigua de la app siga
-- funcionando mientras se despliega la nueva.
alter table public.barcos alter column pin drop not null;

-- Backfill: cifra los PIN que ya existen para que nadie se quede fuera hoy.
-- La columna `pin` en claro se elimina en la migración 02.
update public.barcos
   set pin_hash = extensions.crypt(pin, extensions.gen_salt('bf'))
 where pin_hash is null and pin is not null and length(pin) > 0;

/* ── 3) Historial de versiones: red de seguridad en el servidor ────────── */

create table if not exists public.estado_historial (
  id          bigserial primary key,
  data        jsonb not null,
  guardado_en timestamptz not null default now()
);
alter table public.estado_historial enable row level security;
revoke all on public.estado_historial from anon, authenticated;

/* ── 4) Funciones de acceso ────────────────────────────────────────────── */

-- Privada: nunca se expone al cliente.
create or replace function public.rol_de_pass(p_pass text)
returns text language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare a record; ok boolean;
begin
  if p_pass is null or length(p_pass) = 0 then return null; end if;
  select * into a from public.accesos where rol = 'oficinista';
  if not found then return null; end if;
  if a.algoritmo = 'bcrypt' then
    ok := (a.password_hash = crypt(p_pass, a.password_hash));
  else
    ok := (a.password_hash = encode(digest(p_pass, 'sha256'), 'hex'));
    if ok then
      update public.accesos
         set password_hash = crypt(p_pass, gen_salt('bf')),
             algoritmo = 'bcrypt', updated_at = now()
       where rol = 'oficinista';
    end if;
  end if;
  if ok then return 'oficinista'; end if;
  return null;
end; $$;

create or replace function public.iniciar_sesion(p_pass text)
returns text language sql security definer set search_path to 'public'
as $$ select public.rol_de_pass(p_pass); $$;

-- Privada: comprueba el PIN de un barco.
create or replace function public.pin_valido(p_barco_id text, p_pin text)
returns boolean language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare h text; act boolean;
begin
  if p_barco_id is null or p_pin is null or length(p_pin) = 0 then return false; end if;
  select pin_hash, activo into h, act from public.barcos where id = p_barco_id;
  if h is null or act is not true then return false; end if;
  return h = crypt(p_pin, h);
end; $$;

-- Pública a propósito: la pantalla de acceso necesita la lista de barcos para
-- el desplegable. Devuelve SOLO id y nombre; ningún PIN sale de aquí.
create or replace function public.listar_barcos()
returns table (id text, nombre text)
language sql security definer set search_path to 'public'
as $$ select b.id, b.nombre from public.barcos b where b.activo is true order by b.nombre; $$;

create or replace function public.iniciar_sesion_patron(p_barco_id text, p_pin text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.pin_valido(p_barco_id, p_pin) then return null; end if;
  return (select jsonb_build_object('id', id, 'nombre', nombre)
            from public.barcos where id = p_barco_id);
end; $$;

-- Monta el estado completo. `pin` y `pin_hash` NUNCA se incluyen.
create or replace function public.estado_json()
returns jsonb language sql security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'poligonos', coalesce((select jsonb_agg(jsonb_build_object('id',id,'nombre',nombre) order by nombre)
                             from public.poligonos), '[]'::jsonb),
    'barcos',    coalesce((select jsonb_agg(jsonb_build_object(
                             'id',id,'nombre',nombre,'activo',activo,
                             'tienePin',(pin_hash is not null)) order by nombre)
                             from public.barcos), '[]'::jsonb),
    'bateas',    coalesce((select jsonb_agg(jsonb_build_object(
                             'id',id,'barcoId',barco_id,'poligonoId',poligono_id,
                             'posicion',posicion,'viajesAcum',viajes_acum,
                             'rechazosAcum',rechazos_acum,'media',coalesce(media,false),
                             'mediaSalta',coalesce(media_salta,false)) order by posicion)
                             from public.bateas), '[]'::jsonb),
    'cierres',   coalesce((select jsonb_agg(jsonb_build_object(
                             'id',id,'poligonoId',poligono_id,'fechaInicio',fecha_inicio,
                             'fechaFin',fecha_fin,'createdTs',created_ts,'porBatea',0)
                             order by created_ts desc) from public.cierres), '[]'::jsonb),
    'exclusiones',coalesce((select jsonb_agg(jsonb_build_object(
                             'id',id,'barcoId',barco_id,'fechaInicio',fecha_inicio,
                             'fechaFin',fecha_fin) order by fecha_inicio)
                             from public.exclusiones), '[]'::jsonb),
    'historial', coalesce((select jsonb_agg(jsonb_build_object(
                             'id',id,'fecha',fecha,'desc',descripcion,'ts',ts,
                             'lineas',coalesce(lineas,'[]'::jsonb)) order by ts desc)
                             from public.historial), '[]'::jsonb)
  );
$$;
revoke all on function public.estado_json() from anon, authenticated;

create or replace function public.cargar_estado(p_pass text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  if public.rol_de_pass(p_pass) is null then
    raise exception 'acceso denegado' using errcode = '42501';
  end if;
  return public.estado_json();
end; $$;

create or replace function public.cargar_estado_patron(p_barco_id text, p_pin text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.pin_valido(p_barco_id, p_pin) then
    raise exception 'acceso denegado' using errcode = '42501';
  end if;
  return public.estado_json();
end; $$;

-- Reemplazo completo en UNA transacción. Hoy son seis upserts sueltos: si se
-- corta la conexión a mitad, la base de datos queda incoherente. Aquí no.
-- Conserva el pin_hash de cada barco; si el payload trae `pin` en claro (alta
-- de barco o importación desde Excel), lo cifra y no lo devuelve nunca.
create or replace function public.guardar_estado(p_pass text, p_data jsonb)
returns boolean language plpgsql security definer
set search_path to 'public', 'extensions' as $$
begin
  if public.rol_de_pass(p_pass) is distinct from 'oficinista' then
    raise exception 'acceso denegado' using errcode = '42501';
  end if;

  insert into public.estado_historial (data) values (public.estado_json());
  delete from public.estado_historial
   where id not in (select id from public.estado_historial order by id desc limit 50);

  -- Padres primero.
  insert into public.poligonos (id, nombre)
  select x->>'id', x->>'nombre' from jsonb_array_elements(p_data->'poligonos') x
  on conflict (id) do update set nombre = excluded.nombre;

  -- No se escribe nunca en la columna `pin`: los valores viejos se quedan
  -- como están hasta que la migración 02 elimine la columna.
  insert into public.barcos (id, nombre, activo, pin_hash)
  select x->>'id', x->>'nombre', coalesce((x->>'activo')::boolean, true),
         case when coalesce(x->>'pin','') <> '' then crypt(x->>'pin', gen_salt('bf')) else null end
    from jsonb_array_elements(p_data->'barcos') x
  on conflict (id) do update set
       nombre   = excluded.nombre,
       activo   = excluded.activo,
       pin_hash = coalesce(excluded.pin_hash, public.barcos.pin_hash);

  insert into public.bateas (id, barco_id, poligono_id, posicion, viajes_acum, rechazos_acum, media, media_salta)
  select x->>'id', x->>'barcoId', x->>'poligonoId', (x->>'posicion')::int,
         coalesce((x->>'viajesAcum')::int,0), coalesce((x->>'rechazosAcum')::int,0),
         coalesce((x->>'media')::boolean,false), coalesce((x->>'mediaSalta')::boolean,false)
    from jsonb_array_elements(p_data->'bateas') x
  on conflict (id) do update set
       barco_id = excluded.barco_id, poligono_id = excluded.poligono_id,
       posicion = excluded.posicion, viajes_acum = excluded.viajes_acum,
       rechazos_acum = excluded.rechazos_acum, media = excluded.media,
       media_salta = excluded.media_salta;

  insert into public.cierres (id, poligono_id, fecha_inicio, fecha_fin, created_ts)
  select x->>'id', x->>'poligonoId', (x->>'fechaInicio')::date,
         nullif(x->>'fechaFin','')::date, (x->>'createdTs')::bigint
    from jsonb_array_elements(p_data->'cierres') x
  on conflict (id) do update set
       poligono_id = excluded.poligono_id, fecha_inicio = excluded.fecha_inicio,
       fecha_fin = excluded.fecha_fin, created_ts = excluded.created_ts;

  insert into public.exclusiones (id, barco_id, fecha_inicio, fecha_fin)
  select x->>'id', x->>'barcoId', (x->>'fechaInicio')::date, nullif(x->>'fechaFin','')::date
    from jsonb_array_elements(p_data->'exclusiones') x
  on conflict (id) do update set
       barco_id = excluded.barco_id, fecha_inicio = excluded.fecha_inicio,
       fecha_fin = excluded.fecha_fin;

  insert into public.historial (id, fecha, descripcion, ts, lineas)
  select x->>'id', (x->>'fecha')::date, x->>'desc', (x->>'ts')::bigint,
         coalesce(x->'lineas','[]'::jsonb)
    from jsonb_array_elements(p_data->'historial') x
  on conflict (id) do update set
       fecha = excluded.fecha, descripcion = excluded.descripcion,
       ts = excluded.ts, lineas = excluded.lineas;

  -- Poda: hijos antes que padres.
  delete from public.bateas      where id not in (select x->>'id' from jsonb_array_elements(p_data->'bateas') x);
  delete from public.cierres     where id not in (select x->>'id' from jsonb_array_elements(p_data->'cierres') x);
  delete from public.exclusiones where id not in (select x->>'id' from jsonb_array_elements(p_data->'exclusiones') x);
  delete from public.historial   where id not in (select x->>'id' from jsonb_array_elements(p_data->'historial') x);
  delete from public.barcos      where id not in (select x->>'id' from jsonb_array_elements(p_data->'barcos') x);
  delete from public.poligonos   where id not in (select x->>'id' from jsonb_array_elements(p_data->'poligonos') x);

  return true;
end; $$;

create or replace function public.cambiar_pass(p_actual text, p_nueva text)
returns boolean language plpgsql security definer
set search_path to 'public', 'extensions' as $$
begin
  if public.rol_de_pass(p_actual) is distinct from 'oficinista' then
    raise exception 'acceso denegado' using errcode = '42501';
  end if;
  if p_nueva is null or length(p_nueva) < 6 then
    raise exception 'la contraseña debe tener al menos 6 caracteres';
  end if;
  update public.accesos
     set password_hash = crypt(p_nueva, gen_salt('bf')),
         algoritmo = 'bcrypt', updated_at = now()
   where rol = 'oficinista';
  return true;
end; $$;

create or replace function public.cambiar_pin(p_pass_oficinista text, p_barco_id text, p_pin text)
returns boolean language plpgsql security definer
set search_path to 'public', 'extensions' as $$
begin
  if public.rol_de_pass(p_pass_oficinista) is distinct from 'oficinista' then
    raise exception 'acceso denegado' using errcode = '42501';
  end if;
  if p_pin !~ '^\d{4}$' then
    raise exception 'el PIN debe ser exactamente 4 dígitos';
  end if;
  update public.barcos
     set pin_hash = crypt(p_pin, gen_salt('bf'))
   where id = p_barco_id;
  return found;
end; $$;

-- Cuántos barcos siguen sin PIN propio: lo usa Config para avisar.
create or replace function public.barcos_sin_pin()
returns integer language sql security definer set search_path to 'public'
as $$ select count(*)::int from public.barcos where activo is true and pin_hash is null; $$;

/* ── 5) Permisos ───────────────────────────────────────────────────────── */

revoke all on function public.rol_de_pass(text)          from anon, authenticated;
revoke all on function public.pin_valido(text, text)     from anon, authenticated;

grant execute on function public.iniciar_sesion(text)                    to anon, authenticated;
grant execute on function public.listar_barcos()                         to anon, authenticated;
grant execute on function public.iniciar_sesion_patron(text, text)       to anon, authenticated;
grant execute on function public.cargar_estado(text)                     to anon, authenticated;
grant execute on function public.cargar_estado_patron(text, text)        to anon, authenticated;
grant execute on function public.guardar_estado(text, jsonb)             to anon, authenticated;
grant execute on function public.cambiar_pass(text, text)                to anon, authenticated;
grant execute on function public.cambiar_pin(text, text, text)           to anon, authenticated;
grant execute on function public.barcos_sin_pin()                        to anon, authenticated;
