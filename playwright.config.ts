import { defineConfig } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}/finger-run/`,
    browserName: "chromium",
    trace: "retain-on-failure",
    launchOptions: {
      // A fake camera device exists, but no permission is granted unless a test asks for it.
      args: ["--use-fake-device-for-media-stream", "--ignore-gpu-blocklist"],
    },
  },
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/finger-run/`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
