import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://cgpjtwqhefxrymgjseft.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNncGp0d3FoZWZ4cnltZ2pzZWZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzOTIzNzcsImV4cCI6MjA5Njk2ODM3N30.4W1XrCbVsTIHEXLAXruSN6P2Z41EO0dEhuBBb0PKyM0";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export async function validarOficinista(pass) {
  const { data, error } = await supabase.rpc("verify_officer_password", { pwd_attempt: pass });
  if (error) throw error;
  return data === true;
}

export async function cambiarPassOficinista(actualPass, newPass) {
  const { data, error } = await supabase.rpc("change_officer_password", { old_pwd: actualPass, new_pwd: newPass });
  if (error) throw error;
  return data === true;
}
