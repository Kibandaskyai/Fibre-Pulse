import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 3 browser flows against the local demo data (npm run db:seed):
 * record payments, reconcile them against an uploaded M-Pesa statement,
 * then see them in revenue, reports and the downloads.
 */
const PASSWORD = "FibrePulse-Demo-2026";
const stamp = Date.now().toString().slice(-7);
const refA = `PA${stamp}X`;
const refB = `PB${stamp}X`;
const refUnknown = `PU${stamp}X`;

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

async function recordPayment(page: Page, reference: string, amount: string) {
  await page.goto("/customers?q=Grace%20Wambui");
  await page.getByRole("link", { name: "Grace Wambui" }).first().click();
  await page.getByRole("link", { name: "Record payment" }).click();
  await page.getByLabel("M-Pesa receipt or bank reference").fill(reference);
  await page.getByLabel("Amount (Ksh)").fill(amount);
  await page.getByRole("button", { name: "Record payment" }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/payments/new"));
}

const paymentRow = (page: Page, reference: string) => page.getByRole("row", { name: new RegExp(reference) });

function statementCsv() {
  const now = new Date().toLocaleString("sv-SE", { timeZone: "Africa/Nairobi" }).slice(0, 19);
  return [
    "Mwangaza Fibre Networks - Paybill statement,,,,,,,",
    "",
    "Receipt No.,Completion Time,Initiation Time,Details,Transaction Status,Paid In,Withdrawn,Balance",
    `${refA},${now},${now},Pay Bill from 2547****678 - Grace W,Completed,"2,000.00",,`,
    `${refB},${now},${now},Pay Bill from 2547****678 - Grace W,Completed,"1,000.00",,`,
    `${refUnknown},${now},${now},Pay Bill from 2547****999 - Unknown payer,Completed,"2,500.00",,`,
    `CHG${stamp},${now},${now},Business charge,Completed,,30.00,`,
  ].join("\r\n");
}

test.describe.serial("finance reconciles a statement and reports on it", () => {
  test("record two payments awaiting verification", async ({ page }) => {
    await signIn(page, "finance@mwangaza.test");
    await recordPayment(page, refA, "2000");
    await recordPayment(page, refB, "1500");
    await page.goto(`/payments?q=${refA}`);
    await expect(paymentRow(page, refA).getByText("Awaiting verification")).toBeVisible();
  });

  test("check the statement, then verify only the exact match", async ({ page }) => {
    await signIn(page, "finance@mwangaza.test");
    await page.goto("/payments");
    await page.getByRole("link", { name: "Reconcile statement" }).click();
    await page.getByLabel("Statement CSV").setInputFiles({ name: "mpesa-statement.csv", mimeType: "text/csv", buffer: Buffer.from(statementCsv()) });
    await page.getByRole("button", { name: "Check statement" }).click();

    await expect(page.getByText("read as M-Pesa statement")).toBeVisible();
    await expect(page.getByText(/1 line skipped/)).toBeVisible();
    const ready = page.getByRole("row", { name: new RegExp(refA) });
    await expect(ready.getByText("Ready to verify")).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(refB) }).getByText("Amount differs")).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(refUnknown) }).getByText("Not in FibrePulse")).toBeVisible();

    // Nothing has changed yet.
    await page.goto(`/payments?q=${refA}`);
    await expect(paymentRow(page, refA).getByText("Awaiting verification")).toBeVisible();

    await page.goto("/payments/reconcile");
    await page.getByLabel("Statement CSV").setInputFiles({ name: "mpesa-statement.csv", mimeType: "text/csv", buffer: Buffer.from(statementCsv()) });
    await page.getByRole("button", { name: "Check statement" }).click();
    await page.getByRole("button", { name: "Verify 1 payment" }).click();
    await expect(page.getByText(/1 payment \(Ksh.2,000\.00\) verified/)).toBeVisible();
    await expect(page.getByText(/1 statement line with no payment recorded/)).toBeVisible();

    await page.goto(`/payments?q=${refA}`);
    await expect(paymentRow(page, refA).getByText("Verified", { exact: true })).toBeVisible();
    await page.goto(`/payments?q=${refB}`);
    await expect(paymentRow(page, refB).getByText("Awaiting verification")).toBeVisible();

    await page.goto("/payments/reconcile");
    await expect(page.getByRole("cell", { name: new RegExp(refUnknown) })).toBeVisible();
  });

  test("the verified payment appears in revenue and today's report", async ({ page }) => {
    await signIn(page, "finance@mwangaza.test");
    await page.goto("/revenue?range=today");
    await expect(page.getByText("Collected (verified)")).toBeVisible();
    await expect(page.getByText("cash is not accepted")).toBeVisible();
    await expect(page.locator("#outstanding")).toBeVisible();

    await page.goto("/reports");
    await expect(page.getByRole("heading", { name: "Daily collections report" })).toBeVisible();
    await expect(page.getByRole("link", { name: refA })).toBeVisible();
    await expect(page.getByRole("link", { name: refB })).toHaveCount(0);
  });

  test("CSV and PDF downloads carry the same report", async ({ page }) => {
    await signIn(page, "finance@mwangaza.test");
    const csv = await page.request.get("/reports/export?kind=daily&format=csv");
    expect(csv.status()).toBe(200);
    expect(csv.headers()["content-disposition"]).toMatch(/fibrepulse-daily-collections-report-\d{4}-\d{2}-\d{2}\.csv/);
    const text = await csv.text();
    expect(text).toContain("Collected (verified)");
    expect(text).toContain(refA);
    expect(text).not.toContain(refB);

    const pdf = await page.request.get("/reports/export?kind=monthly&format=pdf");
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");

    const range = await page.request.get("/reports/export?kind=range&range=7d&format=csv");
    expect(await range.text()).toContain("Outstanding by age");
  });
});

test("support agents cannot see revenue, reconcile or download reports", async ({ page }) => {
  await signIn(page, "support@mwangaza.test");
  await expect(page.getByRole("link", { name: "Revenue" })).toHaveCount(0);
  await page.goto("/revenue");
  await expect(page).toHaveURL(/not-allowed/);
  await page.goto("/payments/reconcile");
  await expect(page).toHaveURL(/not-allowed/);
  await page.goto("/reports");
  await expect(page.getByText("Financial reports are available to the owner and the finance manager.")).toBeVisible();
  expect((await page.request.get("/reports/export?kind=daily&format=csv")).status()).toBe(403);
});

test("the dashboard fits a phone screen @mobile", async ({ page }) => {
  await signIn(page, "owner@mwangaza.test");
  await page.goto("/overview");
  await expect(page.getByText("Collections (verified)")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.goto("/revenue");
  await expect(page.getByText("How customers paid")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});
