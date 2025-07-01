import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/videochat/" : "/",  // 👈 base only in build
  plugins: [tailwindcss(), react()],
  build: {
    target: "esnext",
  },
  worker: {
    format: "es",
  },
  resolve: {
    dedupe: ["@huggingface/transformers"],
  },
}));