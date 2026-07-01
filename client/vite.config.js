import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api":         { target: "http://localhost:7086", changeOrigin: true },
      "/powerdraw":   { target: "http://localhost:7086", changeOrigin: true },
      "/thermal":     { target: "http://localhost:7086", changeOrigin: true },
      "/temperature": { target: "http://localhost:7086", changeOrigin: true },
      "/config.json": { target: "http://localhost:7086", changeOrigin: true },
    },
  },
});
