import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import keymasterVite from "@keymaster-app-pack/vite-plugin";

export default defineConfig({
  plugins: [react(), keymasterVite({ replaceExisting: true })],
  build: { outDir: "dist", sourcemap: false, assetsInlineLimit: 0 },
});
