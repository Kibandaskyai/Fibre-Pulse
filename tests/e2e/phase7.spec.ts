import { expect, test, type Page } from "@playwright/test";

/** Phase 7: access control (RADIUS) setting and automatic monthly billing. */
const PASSWORD = "FibrePulse-Demo-2026";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

test("the owner switches access control to RADIUS and back", async ({ page }) => {
  await signIn(page, "owner@mwangaza.test");
  await page.goto("/settings/organisation");
  await expect(page.getByText("Disconnect customers who are suspended or whose package has ended")).toBeVisible();
  await page.getByLabel("Customers sign in with").selectOption("radius");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Saved: RADIUS/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Customers sign in with")).toHaveValue("radius");
  await page.getByLabel("Customers sign in with").selectOption("router_secrets");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Saved: router PPPoE secrets/)).toBeVisible();
});

test("finance cannot change access control", async ({ page }) => {
  await signIn(page, "finance@mwangaza.test");
  await page.goto("/settings/organisation");
  await expect(page).toHaveURL(/\/not-allowed/);
});

test("super admin sees that monthly invoicing is automatic", async ({ page }) => {
  await signIn(page, "admin@fibrepulse.test");
  await page.goto("/admin/invoices");
  await expect(page.getByText(/on the 1st of every month at 6:00 AM/)).toBeVisible();
  await expect(page.getByTestId("billing-runs")).toBeVisible();
});
