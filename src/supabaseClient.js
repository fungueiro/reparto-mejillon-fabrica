import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://cfqlattwvyvtakkyznpb.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmcWxhdHR3dnl2dGFra3l6bnBiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0MTg3MDcsImV4cCI6MjA5NTk5NDcwN30.NJqmlSTVTSKLpROk-IZQd4Q7hpbPQ4KxHRWPNgtdIGw";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export async function cargarEstadoRemoto() {
  const { data, error } = await supabase
    .from("estado")
    .select("data")
    .eq("id", "principal")
    .single();
  if (error) throw error;
  return data?.data ?? null;
}

export async function guardarEstadoRemoto(estado) {
  const { error } = await supabase.from("estado").upsert({
    id: "principal",
    data: estado,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export async function validarOficinista(pass) {
  const { data, error } = await supabase
    .from("config_privada")
    .select("valor")
    .eq("clave", "oficinista_pass")
    .single();
  if (error) throw error;
  return data?.valor === pass;
}

export async function cambiarPassOficinista(actualPass, newPass) {
  const ok = await validarOficinista(actualPass);
  if (!ok) throw new Error("Contraseña actual incorrecta");
  const { error } = await supabase
    .from("config_privada")
    .update({ valor: newPass })
    .eq("clave", "oficinista_pass");
  if (error) throw error;
}
