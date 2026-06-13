import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" → rutas relativas en el build (sirve igual desde raíz o subcarpeta)
export default defineConfig({
  base: "./",
  plugins: [react()],
});
