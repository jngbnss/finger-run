import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Served from https://jngbnss.github.io/finger-run/ on GitHub Pages.
export default defineConfig({
  base: "/finger-run/",
  plugins: [react()],
  // three.js and Supabase are most of the ~1.6MB bundle; one chunk is fine for this demo.
  build: { chunkSizeWarningLimit: 2000 },
  test: {
    include: ["src/**/*.test.ts", "supabase/**/*.test.ts"],
    environment: "node",
  },
});
