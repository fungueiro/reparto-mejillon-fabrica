-- PENDIENTE DE APLICAR. Paso 2 de 2: este es el que cierra la puerta.
--
-- NO EJECUTAR hasta que se cumpla TODO lo siguiente, o la app deja de
-- funcionar para todo el mundo:
--
--   1. La migración 01 está aplicada.
--   2. La versión nueva de la app está desplegada en producción y probada.
--   3. El oficinista ha cambiado su contraseña (la heredada es `admin`).
--   4. Cada barco tiene su PIN propio fijado desde ⚙️ Config. Config avisa
--      de cuántos quedan sin PIN; mientras queden, esos socios no entran.
--   5. Los PIN nuevos están repartidos entre los socios.
--
-- Mientras esto no se ejecute, los datos siguen siendo legibles, escribibles
-- y BORRABLES por cualquiera que extraiga la clave anónima del JavaScript:
-- las funciones nuevas conviven con las políticas abiertas, no las sustituyen.

/* ── 1) Fuera las políticas abiertas de las seis tablas ────────────────── */

drop policy if exists app_all on public.poligonos;
drop policy if exists app_all on public.barcos;
drop policy if exists app_all on public.bateas;
drop policy if exists app_all on public.cierres;
drop policy if exists app_all on public.exclusiones;
drop policy if exists app_all on public.historial;

revoke all on public.poligonos    from anon, authenticated;
revoke all on public.barcos       from anon, authenticated;
revoke all on public.bateas       from anon, authenticated;
revoke all on public.cierres      from anon, authenticated;
revoke all on public.exclusiones  from anon, authenticated;
revoke all on public.historial    from anon, authenticated;

/* ── 2) Fuera la columna de PIN en claro ──────────────────────────────── */
-- A partir de aquí solo existe pin_hash. Comprueba antes que no queda
-- ninguno sin cifrar:
--   select count(*) from public.barcos where activo and pin_hash is null;

alter table public.barcos drop column if exists pin;

/* ── 3) Fuera las funciones viejas ────────────────────────────────────── */
-- change_boat_pin es la más grave: SECURITY DEFINER, ejecutable por anon y
-- sin pedir autenticación ninguna. Hoy solo toca la tabla `boats`, que ya no
-- se usa, pero es un arma cargada.

drop function if exists public.change_boat_pin(text, text);
drop function if exists public.verify_boat_pin(text, text);
drop function if exists public.change_officer_password(text, text);
drop function if exists public.verify_officer_password(text);

/* ── 4) Tablas muertas ────────────────────────────────────────────────── */
-- `boats` son 5 barcos de demostración con PIN 1111..5555 que la app no usa.
-- `officers` se conserva por si hay que volver atrás; bórrala cuando la
-- versión nueva lleve un tiempo funcionando.

drop table if exists public.boats;
-- drop table if exists public.officers;
