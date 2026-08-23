-- SOLO EN CASO DE EMERGENCIA. Deshace la migración 02 y devuelve el acceso
-- abierto, para que la versión antigua de la app vuelva a funcionar.
-- No recupera la columna `pin` en claro: los PIN siguen en pin_hash.

create policy app_all on public.poligonos   for all to anon, authenticated using (true) with check (true);
create policy app_all on public.barcos      for all to anon, authenticated using (true) with check (true);
create policy app_all on public.bateas      for all to anon, authenticated using (true) with check (true);
create policy app_all on public.cierres     for all to anon, authenticated using (true) with check (true);
create policy app_all on public.exclusiones for all to anon, authenticated using (true) with check (true);
create policy app_all on public.historial   for all to anon, authenticated using (true) with check (true);

grant select, insert, update, delete on public.poligonos, public.barcos, public.bateas,
      public.cierres, public.exclusiones, public.historial to anon, authenticated;
