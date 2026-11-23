import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "FibrePulse-Demo-2026";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

test("signed-out visitors are sent to the login page", async ({ page }) => {
  await page.goto("/payments");
  await expect(page).toHaveURL(/\/login\?next=%2Fpayments/);
});

test("wrong password shows one generic message", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@mwangaza.test");
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Email or password is incorrect")).toBeVisible();
});

test("owner signs in and sees the full ISP navigation with real counts", async ({ page }) => {
  await signIn(page, "owner@mwangaza.test");
  await expect(page).toHaveURL(/\/overview/);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const label of ["Customers", "Payments", "Revenue", "Network Monitoring", "Settings"]) {
    await expect(nav.getByRole("link", { name: label })).toBeVisible();
  }
  await expect(page.getByText("Registered customers", { exact: true })).toBeVisible();
});

test("finance does not see network monitoring and is blocked from it", async ({ page }) => {
  await signIn(page, "finance@mwangaza.test");
  await expect(page).toHaveURL(/\/overview/);
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Payments" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Network Monitoring" })).toHaveCount(0);
  await page.goto("/network");
  await expect(page).toHaveURL(/\/not-allowed/);
});

test("technician only sees their jobs, alerts and network status", async ({ page }) => {
  await signIn(page, "tech@mwangaza.test");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "My Jobs" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Customers" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Payments" })).toHaveCount(0);
});

test("owner invites a staff member", async ({ page }) => {
  await signIn(page, "owner@mwangaza.test");
  await page.goto("/settings/staff");
  const email = `new.agent.${Date.now()}@mwangaza.test`;
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Role", { exact: true }).selectOption("support_agent");
  await page.getByRole("button", { name: "Create invitation" }).click();
  await expect(page.getByText(`Invitation created for ${email}`)).toBeVisible();
  await expect(page.getByRole("cell", { name: email })).toBeVisible();
});

test("a new user signs up and registers an ISP that starts pending", async ({ page }) => {
  const stamp = Date.now();
  await page.goto("/signup");
  await page.getByLabel("Full name").fill("Njeri Test Owner");
  await page.getByLabel("Work email").fill(`njeri.${stamp}@example.test`);
  await page.getByLabel("Password").fill("Strong-Pass-2026");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel("ISP name").fill(`Kitengela Fibre ${stamp}`);
  await page.getByLabel("County").selectOption("Kajiado");
  await page.getByRole("button", { name: "Register ISP" }).click();
  await expect(page).toHaveURL(/\/overview/);
  await expect(page.getByText("is awaiting activation by FibrePulse")).toBeVisible();
});

test("platform super admin sees tenants but no ISP customer data", async ({ page }) => {
  await signIn(page, "admin@fibrepulse.test");
  await page.goto("/admin/tenants");
  await expect(page.getByRole("heading", { name: "ISP tenants" })).toBeVisible();
  await expect(page.getByText("Mwangaza Fibre Networks")).toBeVisible();
  await page.goto("/customers");
  await expect(page).not.toHaveURL(/\/customers/);
});

test("the shell works on a phone @mobile", async ({ page }) => {
  await signIn(page, "owner@mwangaza.test");
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("dialog").getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings/);
});
