import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://cgpjtwqhefxrymgjseft.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNncGp0d3FoZWZ4cnltZ2pzZWZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE2NzE2MzI2NTAsImV4cCI6MTk4NzIwODY1MH0.x_w4hC7z8vQ5p8K6J9L2M3N4O5P6Q7R8S9T0U1V2W3X";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
