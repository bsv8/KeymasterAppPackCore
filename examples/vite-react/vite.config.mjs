import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import keymasterVite from "@keymaster-app-pack/vite-plugin";
import identity from "./keymaster.identity.json" with { type: "json" };

export default defineConfig({
  plugins: [react(), keymasterVite({ identity, replaceExisting: true })],
  build: { outDir: "dist", sourcemap: false, assetsInlineLimit: 0 },
});
