import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://cgpjtwqhefxrymgjseft.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNncGp0d3FoZWZ4cnltZ2pzZWZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzOTIzNzcsImV4cCI6MjA5Njk2ODM3N30.4W1XrCbVsTIHEXLAXruSN6P2Z41EO0dEhuBBb0PKyM0";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
