import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against a running app and local Supabase with demo data:
 *   npm run db:start && npm run db:reset && npm run db:seed
 *   npm run build && npm run start   (in another terminal)
 *   npm run test:e2e
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000", trace: "off" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, grepInvert: /@mobile/ },
    { name: "phone", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
});
