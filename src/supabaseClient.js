import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://cgpjtwqhefxrymgjseft.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNncGp0d3FoZWZ4cnltZ2pzZWZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzOTIzNzcsImV4cCI6MjA5Njk2ODM3N30.4W1XrCbVsTIHEXLAXruSN6P2Z41EO0dEhuBBb0PKyM0";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ════════════════════════════════════════════════════════════════
   SESIÓN
   La credencial vive SOLO en esta variable, en memoria. No se guarda
   en localStorage ni en el estado de React ni en la copia de
   seguridad: al recargar la página hay que volver a identificarse.
   Sin credencial no se descarga ni un dato.
   ════════════════════════════════════════════════════════════════ */
let sesion = null;   // { rol:"oficinista", pass } | { rol:"patron", barcoId, pin }

export const rolActual   = () => (sesion ? sesion.rol : null);
export const barcoSesion = () => (sesion && sesion.rol === "patron" ? sesion.barcoId : null);
export const cerrarSesion = () => { sesion = null; };

/* ── ACCESO ─────────────────────────────────────────────────── */

// Pública a propósito: la pantalla de acceso necesita el desplegable de
// barcos antes de que nadie se identifique. Solo devuelve id y nombre.
export async function listarBarcos() {
  const { data, error } = await supabase.rpc("listar_barcos");
  if (error) throw error;
  return data || [];
}

export async function entrarOficinista(pass) {
  const { data, error } = await supabase.rpc("iniciar_sesion", { p_pass: pass });
  if (error) throw error;
  if (data !== "oficinista") return false;
  sesion = { rol: "oficinista", pass };
  return true;
}

export async function entrarPatron(barcoId, pin) {
  const { data, error } = await supabase.rpc("iniciar_sesion_patron", {
    p_barco_id: barcoId, p_pin: pin,
  });
  if (error) throw error;
  if (!data) return null;
  sesion = { rol: "patron", barcoId, pin };
  return data;                       // { id, nombre }
}

/* ── DATOS ──────────────────────────────────────────────────── */

export async function cargarEstado() {
  if (!sesion) return null;
  const { data, error } =
    sesion.rol === "oficinista"
      ? await supabase.rpc("cargar_estado", { p_pass: sesion.pass })
      : await supabase.rpc("cargar_estado_patron", { p_barco_id: sesion.barcoId, p_pin: sesion.pin });
  if (error) throw error;
  return data;
}

// Reemplazo completo, en una sola transacción del lado del servidor.
export async function guardarEstado(estado) {
  if (!sesion || sesion.rol !== "oficinista") return false;
  const { error } = await supabase.rpc("guardar_estado", {
    p_pass: sesion.pass, p_data: estado,
  });
  if (error) throw error;
  return true;
}

/* ── CONTRASEÑA Y PINS ──────────────────────────────────────── */

export async function cambiarPassOficinista(actual, nueva) {
  const { data, error } = await supabase.rpc("cambiar_pass", {
    p_actual: actual, p_nueva: nueva,
  });
  if (error) throw error;
  // Si la que acaba de cambiar es la de la sesión en curso, se actualiza
  // para no perder el acceso hasta la siguiente recarga.
  if (data === true && sesion && sesion.rol === "oficinista" && sesion.pass === actual) {
    sesion = { ...sesion, pass: nueva };
  }
  return data === true;
}

export async function cambiarPinBarco(barcoId, pin) {
  if (!sesion || sesion.rol !== "oficinista") return false;
  const { data, error } = await supabase.rpc("cambiar_pin", {
    p_pass_oficinista: sesion.pass, p_barco_id: barcoId, p_pin: pin,
  });
  if (error) throw error;
  return data === true;
}

export async function contarBarcosSinPin() {
  const { data, error } = await supabase.rpc("barcos_sin_pin");
  if (error) throw error;
  return data ?? 0;
}
