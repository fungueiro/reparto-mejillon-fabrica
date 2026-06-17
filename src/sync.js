import { supabase } from "./supabaseClient";

/* ── SINCRONIZACIÓN DE POLÍGONOS ─────────────────────────────────── */
export async function loadPoligonos() {
  try {
    const { data, error } = await supabase
      .from("poligonos")
      .select("id, nombre")
      .order("nombre");

    if (error) {
      console.warn("Error cargando polígonos:", error);
      return null;
    }

    return data || [];
  } catch (err) {
    console.warn("Error en loadPoligonos:", err);
    return null;
  }
}

export async function syncPoligonos(poligonos) {
  try {
    const { data: existing } = await supabase
      .from("poligonos")
      .select("id, nombre");

    const existingIds = new Set(existing?.map(p => p.id) || []);
    const newPoligonos = poligonos.filter(p => !existingIds.has(p.id));

    if (newPoligonos.length > 0) {
      const { error } = await supabase
        .from("poligonos")
        .insert(newPoligonos.map(p => ({ id: p.id, nombre: p.nombre })));

      if (error) {
        console.warn("Error guardando polígonos:", error);
        return false;
      }
    }

    return true;
  } catch (err) {
    console.warn("Error en syncPoligonos:", err);
    return false;
  }
}

/* ── SINCRONIZACIÓN DE BARCOS ─────────────────────────────────────── */
export async function loadBarcos() {
  try {
    const { data, error } = await supabase
      .from("barcos")
      .select("id, nombre, pin, activo")
      .order("nombre");

    if (error) {
      console.warn("Error cargando barcos:", error);
      return null;
    }

    return data || [];
  } catch (err) {
    console.warn("Error en loadBarcos:", err);
    return null;
  }
}

export async function syncBarcos(barcos) {
  try {
    const { data: existing } = await supabase
      .from("barcos")
      .select("id");

    const existingIds = new Set(existing?.map(b => b.id) || []);
    const newBarcos = barcos.filter(b => !existingIds.has(b.id));

    if (newBarcos.length > 0) {
      const { error } = await supabase
        .from("barcos")
        .insert(newBarcos.map(b => ({
          id: b.id,
          nombre: b.nombre,
          pin: b.pin,
          activo: b.activo
        })));

      if (error) {
        console.warn("Error guardando barcos:", error);
        return false;
      }
    }

    // Actualizar barcos existentes (activo)
    for (const barco of barcos.filter(b => existingIds.has(b.id))) {
      const { error } = await supabase
        .from("barcos")
        .update({ activo: barco.activo })
        .eq("id", barco.id);

      if (error) console.warn("Error actualizando barco:", error);
    }

    return true;
  } catch (err) {
    console.warn("Error en syncBarcos:", err);
    return false;
  }
}

/* ── SINCRONIZACIÓN DE BATEAS ─────────────────────────────────────── */
export async function loadBateas() {
  try {
    const { data, error } = await supabase
      .from("bateas")
      .select("id, barco_id, poligono_id, posicion, viajes_acum, rechazos_acum")
      .order("posicion");

    if (error) {
      console.warn("Error cargando bateas:", error);
      return null;
    }

    // Convertir nombres de columnas (snake_case a camelCase)
    return (data || []).map(b => ({
      id: b.id,
      barcoId: b.barco_id,
      poligonoId: b.poligono_id,
      posicion: b.posicion,
      viajesAcum: b.viajes_acum,
      rechazosAcum: b.rechazos_acum
    }));
  } catch (err) {
    console.warn("Error en loadBateas:", err);
    return null;
  }
}

export async function syncBateas(bateas) {
  try {
    const { data: existing } = await supabase
      .from("bateas")
      .select("id");

    const existingIds = new Set(existing?.map(b => b.id) || []);
    const newBateas = bateas.filter(b => !existingIds.has(b.id));

    if (newBateas.length > 0) {
      const { error } = await supabase
        .from("bateas")
        .insert(newBateas.map(b => ({
          id: b.id,
          barco_id: b.barcoId,
          poligono_id: b.poligonoId,
          posicion: b.posicion,
          viajes_acum: b.viajesAcum,
          rechazos_acum: b.rechazosAcum
        })));

      if (error) {
        console.warn("Error guardando bateas:", error);
        return false;
      }
    }

    // Actualizar bateas existentes
    for (const batea of bateas.filter(b => existingIds.has(b.id))) {
      const { error } = await supabase
        .from("bateas")
        .update({
          posicion: batea.posicion,
          viajes_acum: batea.viajesAcum,
          rechazos_acum: batea.rechazosAcum
        })
        .eq("id", batea.id);

      if (error) console.warn("Error actualizando batea:", error);
    }

    return true;
  } catch (err) {
    console.warn("Error en syncBateas:", err);
    return false;
  }
}

/* ── SINCRONIZACIÓN DE CIERRES ────────────────────────────────────── */
export async function loadCierres() {
  try {
    const { data, error } = await supabase
      .from("cierres")
      .select("id, poligono_id, fecha_inicio, fecha_fin, created_ts")
      .order("created_ts", { ascending: false });

    if (error) {
      console.warn("Error cargando cierres:", error);
      return null;
    }

    return (data || []).map(c => ({
      id: c.id,
      poligonoId: c.poligono_id,
      fechaInicio: c.fecha_inicio,
      fechaFin: c.fecha_fin,
      createdTs: c.created_ts
    }));
  } catch (err) {
    console.warn("Error en loadCierres:", err);
    return null;
  }
}

export async function syncCierres(cierres) {
  try {
    const { data: existing } = await supabase
      .from("cierres")
      .select("id");

    const existingIds = new Set(existing?.map(c => c.id) || []);
    const newCierres = cierres.filter(c => !existingIds.has(c.id));

    if (newCierres.length > 0) {
      const { error } = await supabase
        .from("cierres")
        .insert(newCierres.map(c => ({
          id: c.id,
          poligono_id: c.poligonoId,
          fecha_inicio: c.fechaInicio,
          fecha_fin: c.fechaFin,
          created_ts: c.createdTs
        })));

      if (error) {
        console.warn("Error guardando cierres:", error);
        return false;
      }
    }

    // Actualizar cierres existentes (fecha_fin)
    for (const cierre of cierres.filter(c => existingIds.has(c.id))) {
      const { error } = await supabase
        .from("cierres")
        .update({ fecha_fin: cierre.fechaFin })
        .eq("id", cierre.id);

      if (error) console.warn("Error actualizando cierre:", error);
    }

    return true;
  } catch (err) {
    console.warn("Error en syncCierres:", err);
    return false;
  }
}

/* ── SINCRONIZACIÓN DE EXCLUSIONES ────────────────────────────────── */
export async function loadExclusiones() {
  try {
    const { data, error } = await supabase
      .from("exclusiones")
      .select("id, barco_id, fecha_inicio, fecha_fin")
      .order("fecha_inicio");

    if (error) {
      console.warn("Error cargando exclusiones:", error);
      return null;
    }

    return (data || []).map(e => ({
      id: e.id,
      barcoId: e.barco_id,
      fechaInicio: e.fecha_inicio,
      fechaFin: e.fecha_fin
    }));
  } catch (err) {
    console.warn("Error en loadExclusiones:", err);
    return null;
  }
}

export async function syncExclusiones(exclusiones) {
  try {
    const { data: existing } = await supabase
      .from("exclusiones")
      .select("id");

    const existingIds = new Set(existing?.map(e => e.id) || []);
    const newExclusiones = exclusiones.filter(e => !existingIds.has(e.id));

    if (newExclusiones.length > 0) {
      const { error } = await supabase
        .from("exclusiones")
        .insert(newExclusiones.map(e => ({
          id: e.id,
          barco_id: e.barcoId,
          fecha_inicio: e.fechaInicio,
          fecha_fin: e.fechaFin
        })));

      if (error) {
        console.warn("Error guardando exclusiones:", error);
        return false;
      }
    }

    // Actualizar exclusiones existentes
    for (const excl of exclusiones.filter(e => existingIds.has(e.id))) {
      const { error } = await supabase
        .from("exclusiones")
        .update({ fecha_fin: excl.fechaFin })
        .eq("id", excl.id);

      if (error) console.warn("Error actualizando exclusión:", error);
    }

    return true;
  } catch (err) {
    console.warn("Error en syncExclusiones:", err);
    return false;
  }
}

/* ── SINCRONIZACIÓN DE HISTORIAL ──────────────────────────────────── */
export async function loadHistorial() {
  try {
    const { data, error } = await supabase
      .from("historial")
      .select("id, fecha, descripcion, ts, lineas")
      .order("ts", { ascending: false });

    if (error) {
      console.warn("Error cargando historial:", error);
      return null;
    }

    return (data || []).map(h => ({
      id: h.id,
      fecha: h.fecha,
      descripcion: h.descripcion,
      ts: h.ts,
      lineas: h.lineas || []
    }));
  } catch (err) {
    console.warn("Error en loadHistorial:", err);
    return null;
  }
}

export async function syncHistorial(historial) {
  try {
    const { data: existing } = await supabase
      .from("historial")
      .select("id");

    const existingIds = new Set(existing?.map(h => h.id) || []);
    const newHistorial = historial.filter(h => !existingIds.has(h.id));

    if (newHistorial.length > 0) {
      const { error } = await supabase
        .from("historial")
        .insert(newHistorial.map(h => ({
          id: h.id,
          fecha: h.fecha,
          descripcion: h.descripcion,
          ts: h.ts,
          lineas: h.lineas
        })));

      if (error) {
        console.warn("Error guardando historial:", error);
        return false;
      }
    }

    return true;
  } catch (err) {
    console.warn("Error en syncHistorial:", err);
    return false;
  }
}

/* ── SINCRONIZACIÓN COMPLETA ──────────────────────────────────────── */
export async function syncAllData(poligonos, barcos, bateas, cierres, exclusiones, historial) {
  try {
    const results = await Promise.all([
      syncPoligonos(poligonos),
      syncBarcos(barcos),
      syncBateas(bateas),
      syncCierres(cierres),
      syncExclusiones(exclusiones),
      syncHistorial(historial)
    ]);

    return results.every(r => r === true);
  } catch (err) {
    console.warn("Error en syncAllData:", err);
    return false;
  }
}
