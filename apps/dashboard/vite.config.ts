import { defineConfig } from "vite";

export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/v1": { target: "http://localhost:3000", changeOrigin: false },
    },
  },
});
