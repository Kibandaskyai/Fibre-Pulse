import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 8 (client update, 24 Nov 2026): hotspot plans, per-device codes,
 * M-Pesa only, people online and the public WiFi buying page. Uses the demo
 * seed: Mwangaza has the 9 hotspot plans, simulated codes DEMO00..DEMO11 and
 * portal_demo on, so the WiFi page offers a simulated payment.
 */
const PASSWORD = "FibrePulse-Demo-2026";
const stamp = Date.now().toString(36).toUpperCase().slice(-6);

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

test("the overview shows people online and hotspot vs monthly money", async ({ page }) => {
  await signIn(page, "owner@mwangaza.test");
  await page.goto("/overview");
  await expect(page.getByTestId("network-status")).toBeVisible();
  await expect(page.getByTestId("people-online")).toBeVisible();
  await expect(page.getByText("Money per day, this month")).toBeVisible();
  await expect(page.getByText("Money per month")).toBeVisible();
});

test("the owner sees the client's nine hotspot plans", async ({ page }) => {
  await signIn(page, "owner@mwangaza.test");
  await page.goto("/hotspot/plans");
  await expect(page.getByRole("heading", { name: "Hotspot plans" })).toBeVisible();
  for (const name of ["1 Hour", "24 Hours", "7 Days", "Monthly"]) {
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  }
});

test("the owner sells a code after seeing the M-Pesa payment, then finds it", async ({ page }) => {
  await signIn(page, "owner@mwangaza.test");
  await page.goto("/hotspot");
  await expect(page.getByText("Running codes")).toBeVisible();
  await page.locator("#sell-plan").selectOption({ index: 5 });
  await page.getByLabel("M-Pesa transaction code").fill(`E2E${stamp}HS`);
  await page.getByRole("button", { name: "Issue code" }).click();
  const code = (await page.getByTestId("issued-code").textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9]{6,12}$/);

  await page.goto(`/hotspot/codes?q=${code}`);
  await expect(page.getByText(code).first()).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(code) }).getByText("Not used yet")).toBeVisible();
});

test("a support agent cannot sell hotspot codes", async ({ page }) => {
  await signIn(page, "support@mwangaza.test");
  await page.goto("/hotspot");
  await expect(page.getByRole("button", { name: "Issue code" })).toHaveCount(0);
});

test("a buyer pays on the WiFi page and gets a code for this device @mobile", async ({ page }) => {
  await page.goto("/wifi/mwangaza?link-login-only=http%3A%2F%2F10.5.50.1%2Flogin&mac=02%3A5D%3A00%3A00%3AE2%3AE2");
  await expect(page.getByText("Each phone or gadget needs its own code.")).toBeVisible();
  await page.getByRole("button", { name: /24 hours/ }).click();
  await page.getByLabel("2. Your M-Pesa number").fill("0712345678");
  await page.getByRole("button", { name: "Pay with M-Pesa" }).click();
  await page.getByRole("button", { name: "Simulate M-Pesa payment (demo)" }).click();
  await expect(page.getByTestId("wifi-code")).toHaveText(/^[A-Z0-9]{6,12}$/);
});

test("the WiFi page needs no sign-in and hides unknown ISPs", async ({ page }) => {
  const res = await page.goto("/wifi/no-such-isp");
  expect(res?.status()).toBe(404);
});

test("monthly plans are PPPoE household plans, with Static IP kept for later", async ({ page }) => {
  await signIn(page, "owner@mwangaza.test");
  await page.goto("/packages");
  await expect(page.getByRole("heading", { name: "PPPoE plans" })).toBeVisible();
  await page.goto("/packages/new");
  await expect(page.getByLabel("Connection type")).toHaveValue("pppoe");
  await expect(page.locator("#pkg-type option[value=static]")).toHaveText("Static IP");
});
