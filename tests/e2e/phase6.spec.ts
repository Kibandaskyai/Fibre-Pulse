import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 6 browser flows against the local demo data (npm run db:seed):
 * a real verified manual payment from last month becomes a platform fee, an
 * invoice the ISP's finance manager can see, and a recorded payment; draft
 * agreements; owner-approved support access; role limits; the audit log;
 * and the phone layout. Payments created here are fictional test data.
 */
const PASSWORD = "FibrePulse-Demo-2026";
const stamp = Date.now().toString().slice(-6);
const reference = `E2EFEE${stamp}`;
const reason = `E2E check Kasarani router sync errors ${stamp}`;
let invoiceNumber = "";
let mwangazaUrl = "";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

/** 15th of last month in Kenyan time, as a datetime-local value. */
function lastMonthMidday() {
  const now = new Date(Date.now() + 3 * 3_600_000);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  return `${d.toISOString().slice(0, 10)}T10:00`;
}

async function openTenant(page: Page, name: string) {
  await page.goto("/admin/tenants");
  await page.getByRole("link", { name, exact: true }).first().click();
  await page.waitForURL(/\/admin\/tenants\/[0-9a-f-]{36}/);
  return new URL(page.url()).pathname;
}

test.describe.serial("platform fees, invoices and ISP billing", () => {
  test("finance records and verifies a bank payment made last month", async ({ page }) => {
    await signIn(page, "finance@mwangaza.test");
    await page.goto("/payments/new");
    await page.locator("#pay-method").selectOption("bank_transfer");
    await page.getByLabel("M-Pesa receipt or bank reference").fill(reference);
    await page.getByLabel("Amount (Ksh)").fill("4000");
    await page.locator("#pay-time").fill(lastMonthMidday());
    await page.getByRole("button", { name: "Record payment" }).click();
    await page.waitForURL(/\/payments\/[0-9a-f-]{36}\?recorded=1/);
    await page.getByRole("button", { name: "Mark as verified" }).click();
    await expect(page.getByText("Verified", { exact: true }).first()).toBeVisible();
  });

  test("super admin calculates last month's fee and issues an invoice", async ({ page }) => {
    await signIn(page, "admin@fibrepulse.test");
    mwangazaUrl = await openTenant(page, "Mwangaza Fibre Networks");
    await expect(page.getByText("In force").first()).toBeVisible();
    await page.getByRole("button", { name: "Calculate fees" }).click();
    // First run calculates the month; later runs add the new payment as an adjustment.
    await expect(page.getByText(/^(Calculated:|Adjustment of)/)).toBeVisible();

    await page.getByRole("button", { name: "Issue invoice" }).click();
    await expect(page.getByText("Every calculated fee is on an invoice.")).toBeVisible();
    const link = page.getByRole("link", { name: /^FP-\d{4}-\d{5}$/ }).first();
    invoiceNumber = (await link.textContent())!.trim();
    expect(invoiceNumber).toMatch(/^FP-\d{4}-\d{5}$/);
  });

  test("the ISP's finance manager sees the invoice; network staff cannot", async ({ page }) => {
    await signIn(page, "finance@mwangaza.test");
    await page.goto("/settings");
    await page.getByRole("link", { name: /FibrePulse billing/ }).click();
    await expect(page.getByTestId("isp-agreement")).toContainText("2.75%");
    const row = page.getByRole("row").filter({ hasText: invoiceNumber });
    await expect(row).toContainText("Unpaid");
    await row.getByRole("link", { name: invoiceNumber }).click();
    await expect(page.getByRole("heading", { name: invoiceNumber })).toBeVisible();
    await expect(page.getByTestId("invoice-total")).toBeVisible();

    await signIn(page, "network@mwangaza.test");
    await page.goto("/settings/billing");
    await expect(page).toHaveURL(/\/not-allowed/);
  });

  test("super admin records the ISP's payment and the invoice shows as paid", async ({ page }) => {
    await signIn(page, "admin@fibrepulse.test");
    await page.goto(mwangazaUrl);
    await page.getByRole("link", { name: invoiceNumber }).click();
    await page.getByLabel("M-Pesa or bank reference").fill(`QK${stamp}`);
    await page.getByRole("button", { name: "Record payment" }).click();
    // The payment form closes once the invoice is paid.
    await expect(page.getByRole("button", { name: "Record payment" })).toHaveCount(0);
    await expect(page.locator("main").getByText("Paid", { exact: true }).first()).toBeVisible();

    await signIn(page, "owner@mwangaza.test");
    await page.goto("/settings/billing");
    await expect(page.getByRole("row").filter({ hasText: invoiceNumber })).toContainText("Paid");
  });

  test("drafts can be edited, and signing needs the signer's name", async ({ page }) => {
    await signIn(page, "admin@fibrepulse.test");
    await openTenant(page, "Pwani Connect");
    const draft = page.getByTestId("agreement-draft");
    await draft.getByLabel("Fee (%)").fill("2.5");
    await draft.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Draft saved.")).toBeVisible();
    await page.getByLabel("Signed for the ISP by").fill("ab");
    await page.getByRole("button", { name: "Mark as signed" }).click();
    await expect(page.getByText("Enter who signed for the ISP.")).toBeVisible();

    await page.goto("/admin/agreements");
    await expect(page.getByRole("row").filter({ hasText: "Mwangaza Fibre Networks" }).first()).toContainText("In force");
  });
});

test.describe.serial("owner-approved support access", () => {
  test("support admin asks; fees and agreements stay hidden", async ({ page }) => {
    // Close anything an earlier, interrupted run left open.
    await signIn(page, "owner@mwangaza.test");
    await page.goto("/settings/support-access");
    for (let open = page.getByTestId("grant-request"); (await open.count()) > 0; ) {
      const count = await open.count();
      await open.first().getByRole("button", { name: /^(Decline|Revoke now)$/ }).click();
      await expect(open).toHaveCount(count - 1);
    }

    await signIn(page, "support@fibrepulse.test");
    await expect(page.getByRole("link", { name: "Agreements" })).toHaveCount(0);
    await page.goto("/admin/agreements");
    await expect(page).toHaveURL(/\/not-allowed/);
    await page.goto("/admin/support-access");
    const value = await page.locator("#sa-tenant option", { hasText: "Mwangaza Fibre Networks" }).getAttribute("value");
    await page.locator("#sa-tenant").selectOption(value!);
    await page.getByLabel("What do you need to look at, and why?").fill(reason);
    await page.getByRole("button", { name: "Request access" }).click();
    await expect(page.getByText("Request sent.")).toBeVisible();
  });

  test("owner approves, support sees the network, owner revokes", async ({ page }) => {
    await signIn(page, "owner@mwangaza.test");
    await page.goto("/settings/support-access");
    const request = page.getByTestId("grant-request").filter({ hasText: reason });
    await request.getByRole("combobox").selectOption("4");
    await request.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Access approved.")).toBeVisible();

    await signIn(page, "support@fibrepulse.test");
    await openTenant(page, "Mwangaza Fibre Networks");
    await expect(page.getByText("Access active")).toBeVisible();
    await expect(page.getByText("Network (read-only, under support access)")).toBeVisible();
    await expect(page.getByText("Platform fees")).toHaveCount(0);

    await signIn(page, "owner@mwangaza.test");
    await page.goto("/settings/support-access");
    await page.getByTestId("grant-request").filter({ hasText: reason }).getByRole("button", { name: "Revoke now" }).click();
    // A revoked request moves to the earlier requests list.
    await expect(page.getByTestId("grant-request").filter({ hasText: reason })).toHaveCount(0);
    await expect(page.getByText(reason)).toBeVisible();

    await signIn(page, "support@fibrepulse.test");
    await openTenant(page, "Mwangaza Fibre Networks");
    await expect(page.getByText("Network (read-only, under support access)")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Request access" })).toBeVisible();
  });

  test("the audit log records the support access decisions", async ({ page }) => {
    await signIn(page, "admin@fibrepulse.test");
    await page.goto("/admin/audit?entity=support_access_grants");
    await expect(page.getByText("Support access revoked").first()).toBeVisible();
    await expect(page.getByText("Support access approved").first()).toBeVisible();
  });
});

test("@mobile platform admin and ISP billing fit a phone screen", async ({ page }) => {
  await signIn(page, "admin@fibrepulse.test");
  for (const url of ["/admin", "/admin/agreements", "/admin/invoices", "/admin/audit"]) {
    await page.goto(url);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, url).toBeLessThanOrEqual(1);
  }
  await signIn(page, "owner@mwangaza.test");
  for (const url of ["/settings/billing", "/settings/support-access"]) {
    await page.goto(url);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, url).toBeLessThanOrEqual(1);
  }
});
