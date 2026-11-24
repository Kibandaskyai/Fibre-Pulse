import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 2 browser flows against the local demo data (npm run db:seed).
 * Each run creates its own uniquely named package and customers.
 */
const PASSWORD = "FibrePulse-Demo-2026";
const stamp = Date.now().toString().slice(-7);
const phoneFor = (n: number) => `07${String(Number(stamp) + n).padStart(8, "0").slice(-8)}`;

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

test.describe.serial("owner sells a package and collects a payment", () => {
  const pkgName = `E2E Home ${stamp}`;
  const customerName = `E2E Customer ${stamp}`;
  const reference = `E2E${stamp}`;
  let customerUrl = "";

  test("create a package", async ({ page }) => {
    await signIn(page, "owner@mwangaza.test");
    await page.goto("/packages/new");
    await page.getByLabel("Package name").fill(pkgName);
    await page.getByLabel("Download speed (Mbps)").fill("15");
    await page.getByLabel("Upload speed (Mbps)").fill("15");
    await page.getByLabel("Price (Ksh)").fill("3,000");
    await page.getByRole("button", { name: "Create package" }).click();
    await page.waitForURL(/\/packages\?created=1/);
    await expect(page.getByRole("link", { name: pkgName })).toBeVisible();
  });

  test("invalid customer input shows field errors; a valid one is saved", async ({ page }) => {
    await signIn(page, "owner@mwangaza.test");
    await page.goto("/customers/new");
    await page.getByLabel("Full name").fill(customerName);
    await page.getByLabel("Phone").fill("12345");
    await page.getByRole("button", { name: "Add customer" }).click();
    await expect(page.getByText("Enter a Kenyan mobile number")).toBeVisible();

    await page.getByLabel("Phone").fill(phoneFor(1));
    await page.getByLabel("Estate").fill("Kahawa West");
    await page.getByLabel("Status").selectOption("active");
    await page.getByRole("button", { name: "Add customer" }).click();
    await page.waitForURL(/\/customers\/[0-9a-f-]{36}\?created=1/);
    customerUrl = new URL(page.url()).pathname;
    await expect(page.getByRole("heading", { name: customerName })).toBeVisible();
  });

  test("a duplicate phone number is refused", async ({ page }) => {
    await signIn(page, "owner@mwangaza.test");
    await page.goto("/customers/new");
    await page.getByLabel("Full name").fill(`${customerName} Copy`);
    await page.getByLabel("Phone").fill(phoneFor(1));
    await page.getByRole("button", { name: "Add customer" }).click();
    await expect(page.getByText("Another customer already has that phone number.")).toBeVisible();
  });

  test("activate the package: an invoice is issued and the balance is due", async ({ page }) => {
    await signIn(page, "owner@mwangaza.test");
    await page.goto(customerUrl);
    const value = await page.locator("#buy-package option", { hasText: pkgName }).getAttribute("value");
    await page.getByLabel("Package").selectOption(value!);
    await page.getByRole("button", { name: "Activate" }).click();
    await expect(page.getByText("Package activated and invoice issued.")).toBeVisible();
    await page.goto(`${customerUrl}?tab=invoices`);
    await expect(page.getByText("Unpaid")).toBeVisible();
    await expect(page.getByText("Ksh 3,000.00").first()).toBeVisible();
  });

  test("record a payment, verify it, and the invoice is paid", async ({ page }) => {
    await signIn(page, "finance@mwangaza.test");
    await page.goto(customerUrl);
    await page.getByRole("link", { name: "Record payment" }).click();
    await page.getByLabel(/^M-Pesa receipt/).fill(reference);
    await page.getByLabel("Amount (Ksh)").fill("3000");
    await page.getByRole("button", { name: "Record payment" }).click();
    await page.waitForURL(/\/payments\/[0-9a-f-]{36}\?recorded=1/);
    await expect(page.getByText("Awaiting verification").first()).toBeVisible();

    await page.getByRole("button", { name: "Mark as verified" }).click();
    await expect(page.getByText("Verified", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: "Paid" })).toBeVisible();

    await page.goto(customerUrl);
    await expect(page.getByText("Outstanding").locator("..").locator("..")).toContainText("Ksh 0.00");
  });

  test("the same reference cannot be recorded twice", async ({ page }) => {
    await signIn(page, "finance@mwangaza.test");
    await page.goto("/payments/new");
    await page.getByLabel(/^M-Pesa receipt/).fill(reference);
    await page.getByLabel("Amount (Ksh)").fill("3000");
    await page.getByRole("button", { name: "Record payment" }).click();
    await expect(page.getByText(/has already been recorded/)).toBeVisible();
  });

  test("finance cannot sell packages; reversing a payment reopens the invoice", async ({ page }) => {
    await signIn(page, "finance@mwangaza.test");
    await page.goto(customerUrl);
    await expect(page.getByText("Activate a package")).toHaveCount(0);
    await expect(page.getByText("Renew or change package")).toHaveCount(0);

    await page.goto(`/payments?q=${reference}`);
    await page.getByRole("link", { name: reference }).click();
    await page.getByLabel("Reason").last().fill("Bank recalled the transfer");
    await page.getByRole("button", { name: "Reverse payment" }).click();
    await expect(page.getByText("Reversed").first()).toBeVisible();
    await page.goto(`${customerUrl}?tab=invoices`);
    await expect(page.getByText("Unpaid")).toBeVisible();
  });

  test("owner suspends with a reason, then restores", async ({ page }) => {
    await signIn(page, "owner@mwangaza.test");
    await page.goto(customerUrl);
    await page.getByRole("button", { name: "Suspend" }).click();
    await expect(page.getByText("Give a reason of at least 5 characters.")).toBeVisible();
    await page.getByLabel("Reason for suspending").fill("Payment reversed by bank");
    await page.getByRole("button", { name: "Suspend" }).click();
    // The page refreshes: the subscription shows as suspended with its reason
    // and the Suspend form is replaced by Restore.
    await expect(page.getByText("Suspended: Payment reversed by bank")).toBeVisible();
    await page.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByRole("button", { name: "Suspend" })).toBeVisible();
    await expect(page.getByText("Suspended: Payment reversed by bank")).toHaveCount(0);
  });

  test("customer search finds the customer by phone in local format", async ({ page }) => {
    await signIn(page, "support@mwangaza.test");
    await page.goto(`/customers?q=${phoneFor(1)}`);
    await expect(page.getByRole("link", { name: customerName })).toBeVisible();
    // Support agents do not see balances.
    await expect(page.getByRole("columnheader", { name: "Balance" })).toHaveCount(0);
  });
});

test("CSV import reports duplicates and imports only valid rows", async ({ page }) => {
  await signIn(page, "owner@mwangaza.test");
  await page.goto("/customers/import");
  const csv = [
    "full_name,phone,estate,town,county,status",
    `Import One ${stamp},${phoneFor(11)},Ruaka,Ruaka,Kiambu,active`,
    `Import Two ${stamp},${phoneFor(12)},Ruaka,Ruaka,Kiambu,pending`,
    `Import Dup ${stamp},${phoneFor(11)},Ruaka,Ruaka,Kiambu,active`,
    `Bad Phone ${stamp},12345,,,,`,
  ].join("\n");
  await page.getByLabel("CSV file").setInputFiles({ name: "customers.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Check file" }).click();
  await expect(page.getByText("2 ready to import")).toBeVisible();
  await expect(page.getByText("2 with problems")).toBeVisible();
  await expect(page.getByText(/is repeated \(first on line 2\)/)).toBeVisible();
  await page.getByRole("button", { name: "Import 2 customers" }).click();
  await expect(page.getByText("2 customers imported.")).toBeVisible();
});

test("customer and payment exports download CSV", async ({ page }) => {
  await signIn(page, "owner@mwangaza.test");
  const customers = await page.request.get("/customers/export");
  expect(customers.status()).toBe(200);
  expect(customers.headers()["content-type"]).toContain("text/csv");
  expect((await customers.text()).split("\r\n")[0]).toContain("customer_number,full_name,phone");
  const payments = await page.request.get("/payments/export");
  expect(payments.status()).toBe(200);
  expect((await payments.text()).split("\r\n")[0]).toContain("counts_as_revenue");
});

test("support agents cannot export payments or open the payments screen", async ({ page }) => {
  await signIn(page, "support@mwangaza.test");
  expect((await page.request.get("/payments/export")).status()).toBe(403);
  await page.goto("/payments");
  await expect(page).toHaveURL(/\/not-allowed/);
});

test("the M-Pesa placeholder routes answer 501", async ({ request }) => {
  expect((await request.post("/api/payments/mpesa/callback", { data: {} })).status()).toBe(501);
});

test("customers list works on a phone @mobile", async ({ page }) => {
  await signIn(page, "owner@mwangaza.test");
  await page.goto("/customers");
  await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
