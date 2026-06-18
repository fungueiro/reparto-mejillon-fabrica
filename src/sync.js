import { supabase } from "./supabaseClient";

/* ════════════════════════════════════════════════════════════════
   SINCRONIZACIÓN MULTIDISPOSITIVO
   Supabase es la fuente de la verdad. La oficina (oficinista) escribe;
   todos los dispositivos leen al abrir y se refrescan periódicamente.
   - loadAll(): trae todo el estado desde Supabase.
   - saveAll(state): reemplazo completo (upsert + borra lo que ya no está).
   localStorage se usa solo como caché offline.
   ════════════════════════════════════════════════════════════════ */

async function safe(promise, label) {
  try {
    const { data, error } = await promise;
    if (error) {
      console.warn(`[sync] ${label}:`, error.message || error);
      return { ok: false, data: null };
    }
    return { ok: true, data };
  } catch (err) {
    console.warn(`[sync] ${label}:`, err);
    return { ok: false, data: null };
  }
}

/* ── CARGA ──────────────────────────────────────────────────── */
export async function loadAll() {
  const [pol, bar, bat, cie, exc, his] = await Promise.all([
    safe(supabase.from("poligonos").select("id,nombre").order("nombre"), "load poligonos"),
    safe(supabase.from("barcos").select("id,nombre,pin,activo").order("nombre"), "load barcos"),
    safe(supabase.from("bateas").select("id,barco_id,poligono_id,posicion,viajes_acum,rechazos_acum,media,media_salta").order("posicion"), "load bateas"),
    safe(supabase.from("cierres").select("id,poligono_id,fecha_inicio,fecha_fin,created_ts").order("created_ts", { ascending: false }), "load cierres"),
    safe(supabase.from("exclusiones").select("id,barco_id,fecha_inicio,fecha_fin").order("fecha_inicio"), "load exclusiones"),
    safe(supabase.from("historial").select("id,fecha,descripcion,ts,lineas").order("ts", { ascending: false }), "load historial"),
  ]);

  // Si ni siquiera las tablas base responden, asumimos sin conexión / sin permisos.
  if (!pol.ok && !bar.ok && !bat.ok) return null;

  return {
    poligonos: pol.data || [],
    barcos: bar.data || [],
    bateas: (bat.data || []).map((b) => ({
      id: b.id, barcoId: b.barco_id, poligonoId: b.poligono_id,
      posicion: b.posicion, viajesAcum: b.viajes_acum, rechazosAcum: b.rechazos_acum,
      media: !!b.media, mediaSalta: !!b.media_salta,
    })),
    cierres: (cie.data || []).map((c) => ({
      id: c.id, poligonoId: c.poligono_id, fechaInicio: c.fecha_inicio,
      fechaFin: c.fecha_fin, createdTs: c.created_ts, porBatea: 0,
    })),
    exclusiones: (exc.data || []).map((e) => ({
      id: e.id, barcoId: e.barco_id, fechaInicio: e.fecha_inicio, fechaFin: e.fecha_fin,
    })),
    historial: (his.data || []).map((h) => ({
      id: h.id, fecha: h.fecha, desc: h.descripcion, ts: h.ts, lineas: h.lineas || [],
    })),
  };
}

/* ── GUARDADO (reemplazo completo) ──────────────────────────── */
async function upsertTabla(tabla, filas) {
  if (filas.length) await safe(supabase.from(tabla).upsert(filas), `upsert ${tabla}`);
}
async function podarTabla(tabla, filas) {
  const ex = await safe(supabase.from(tabla).select("id"), `ids ${tabla}`);
  if (!ex.ok || !ex.data) return;
  const conservar = new Set(filas.map((f) => f.id));
  const borrar = ex.data.map((r) => r.id).filter((id) => !conservar.has(id));
  if (borrar.length) await safe(supabase.from(tabla).delete().in("id", borrar), `borrar ${tabla}`);
}

export async function saveAll(state) {
  const P = state.poligonos.map((p) => ({ id: p.id, nombre: p.nombre }));
  const B = state.barcos.map((b) => ({ id: b.id, nombre: b.nombre, pin: b.pin, activo: b.activo }));
  const BT = state.bateas.map((b) => ({
    id: b.id, barco_id: b.barcoId, poligono_id: b.poligonoId,
    posicion: b.posicion, viajes_acum: b.viajesAcum, rechazos_acum: b.rechazosAcum,
    media: !!b.media, media_salta: !!b.mediaSalta,
  }));
  const C = state.cierres.map((c) => ({
    id: c.id, poligono_id: c.poligonoId, fecha_inicio: c.fechaInicio,
    fecha_fin: c.fechaFin, created_ts: c.createdTs,
  }));
  const E = state.exclusiones.map((e) => ({
    id: e.id, barco_id: e.barcoId, fecha_inicio: e.fechaInicio, fecha_fin: e.fechaFin,
  }));
  const H = state.historial.map((h) => ({
    id: h.id, fecha: h.fecha, descripcion: h.desc || null, ts: h.ts, lineas: h.lineas,
  }));

  // Padres primero (por si hay claves foráneas), luego hijos.
  await upsertTabla("poligonos", P);
  await upsertTabla("barcos", B);
  await Promise.all([
    upsertTabla("bateas", BT),
    upsertTabla("cierres", C),
    upsertTabla("exclusiones", E),
    upsertTabla("historial", H),
  ]);
  // Podar hijos antes que padres.
  await Promise.all([
    podarTabla("bateas", BT),
    podarTabla("cierres", C),
    podarTabla("exclusiones", E),
    podarTabla("historial", H),
  ]);
  await podarTabla("barcos", B);
  await podarTabla("poligonos", P);
}
