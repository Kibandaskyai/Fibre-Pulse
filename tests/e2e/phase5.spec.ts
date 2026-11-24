import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 5 browser flows against the local demo data (npm run db:seed):
 * a ticket from first call to resolution, a field job from that ticket to
 * completion by the technician, notifications, map privacy by role, BI
 * reports with downloads, and the phone layout.
 */
const PASSWORD = "FibrePulse-Demo-2026";
const stamp = Date.now().toString().slice(-6);
const subject = `E2E router keeps rebooting ${stamp}`;
let ticketUrl = "";
let jobUrl = "";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

async function selectByText(page: Page, selector: string, text: string) {
  const value = await page.locator(`${selector} option`, { hasText: text }).first().getAttribute("value");
  expect(value, `option "${text}" in ${selector}`).toBeTruthy();
  await page.locator(selector).selectOption(value!);
}

test.describe.serial("support desk and field operations", () => {
  test("support agent opens, assigns and comments on a ticket", async ({ page }) => {
    await signIn(page, "support@mwangaza.test");
    await page.goto("/support/new");
    await selectByText(page, "#t-customer", "Collins Wekesa");
    await page.locator("#t-category").selectOption("equipment_fault");
    await page.getByLabel("Subject").fill(subject);
    await page.locator("#t-priority").selectOption("high");
    await page.getByRole("button", { name: "Create ticket" }).click();
    await page.waitForURL(/\/support\/[0-9a-f-]{36}/);
    ticketUrl = new URL(page.url()).pathname;
    await expect(page.getByRole("heading", { name: subject })).toBeVisible();

    await selectByText(page, "#u-assign", "Achieng Atieno");
    await page.getByRole("button", { name: "Save ticket" }).click();
    await expect(page.locator("#u-status")).toHaveValue("assigned");

    await page.getByLabel("Note").fill("Customer power-cycled the ONT; still rebooting.");
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(page.getByText("Customer power-cycled the ONT; still rebooting.")).toBeVisible();
  });

  test("resolving needs a resolution", async ({ page }) => {
    await signIn(page, "support@mwangaza.test");
    await page.goto(ticketUrl);
    await page.locator("#u-status").selectOption("resolved");
    await page.getByRole("button", { name: "Save ticket" }).click();
    await expect(page.getByText("Say how the issue was resolved before resolving or closing the ticket.")).toBeVisible();
    await page.reload();
    await expect(page.locator("#u-status")).toHaveValue("assigned");
  });

  test("owner sends a technician from the ticket", async ({ page }) => {
    await signIn(page, "owner@mwangaza.test");
    await page.goto(ticketUrl);
    await page.getByRole("link", { name: "Create job" }).click();
    await page.waitForURL(/\/field-operations\/new/);
    await expect(page.locator("#j-customer option:checked")).toContainText("Collins Wekesa");
    await selectByText(page, "#j-tech", "Mutua Musyoka");
    await page.getByLabel("Where (optional)").fill("Seasons, blue gate (fictional)");
    await page.getByRole("button", { name: "Create job" }).click();
    await page.waitForURL(/\/field-operations\/[0-9a-f-]{36}/);
    jobUrl = new URL(page.url()).pathname;
    await expect(page.getByText("Seasons, blue gate (fictional)")).toBeVisible();
  });

  test("technician sees the job, cannot complete without notes, then completes it", async ({ page }) => {
    await signIn(page, "tech@mwangaza.test");
    await page.goto("/notifications");
    await expect(page.getByTestId("notification").filter({ hasText: "New job" }).first()).toBeVisible();
    await page.goto("/field-operations");
    await page.getByTestId("my-jobs").getByText("Seasons, blue gate (fictional)").click();
    await page.waitForURL(jobUrl);

    await page.locator("#js-status").selectOption("completed");
    await page.getByRole("button", { name: "Update job" }).click();
    await expect(page.getByText("Record what was done before completing the job.")).toBeVisible();

    await page.getByLabel("Work done").fill("Replaced the faulty ONT power adapter. Tested 40 Mbps.");
    await page.getByRole("button", { name: "Update job" }).click();
    await expect(page.locator("#js-status")).toHaveCount(0, { timeout: 10_000 }).catch(() => undefined);
    await page.reload();
    await expect(page.getByText("Completed").first()).toBeVisible();
  });

  test("owner is told the job is done, the ticket shows it, and opening a notification marks it read", async ({ page }) => {
    await signIn(page, "owner@mwangaza.test");
    await page.goto("/notifications?unread=1");
    const done = page.getByTestId("notification").filter({ hasText: "completed" }).first();
    await expect(done).toBeVisible();
    await done.getByRole("link").first().click();
    await page.waitForURL(/\/field-operations\//);
    await page.goto("/notifications?unread=1");
    await expect(page.getByTestId("notification").filter({ hasText: "completed" })).toHaveCount(0);

    await page.goto(ticketUrl);
    await page.locator("#u-status").selectOption("resolved");
    await page.getByLabel("Resolution").fill("Power adapter replaced on site.");
    await page.getByRole("button", { name: "Save ticket" }).click();
    await expect(page.locator("#u-status")).toHaveValue("resolved");
    await page.reload();
    await expect(page.locator("#u-status")).toHaveValue("resolved");
  });

  test("customer profile links to the customer's tickets", async ({ page }) => {
    await signIn(page, "support@mwangaza.test");
    await page.goto("/customers?q=Collins");
    await page.locator("tbody a").first().click();
    await page.getByRole("link", { name: "Support" }).click();
    await expect(page.getByRole("link", { name: "New ticket" })).toBeVisible();
    await expect(page.getByRole("cell", { name: /TKT-/ }).first()).toBeVisible();
  });
});

test.describe("map privacy and reports", () => {
  test("the owner sees customer points; a support agent sees areas only", async ({ page }) => {
    await signIn(page, "owner@mwangaza.test");
    await page.goto("/network-map");
    await expect(page.getByText("Exact customer locations are hidden")).toHaveCount(0);
    await signIn(page, "support@mwangaza.test");
    await page.goto("/network-map");
    await expect(page.getByText("Exact customer locations are hidden")).toBeVisible();
    await expect(page.getByRole("heading", { name: "By area" }).or(page.getByText("By area"))).toBeVisible();
  });

  test("owner opens every BI report and downloads CSV and PDF", async ({ page }) => {
    await signIn(page, "owner@mwangaza.test");
    await page.goto("/reports");
    const list = page.getByTestId("bi-reports");
    await expect(list.getByRole("link")).toHaveCount(6);
    for (const key of ["customers", "subscriptions", "payments", "network", "support", "areas"]) {
      const res = await page.goto(`/reports/bi/${key}`);
      expect(res?.status()).toBe(200);
      await expect(page.getByTestId("bi-figures")).toBeVisible();
      await expect(page.locator("main p[role=alert]")).toHaveCount(0);
    }
    const csv = await page.request.get("/reports/bi/support/export?range=this_month&format=csv");
    expect(csv.status()).toBe(200);
    expect(csv.headers()["content-type"]).toContain("text/csv");
    const body = await csv.text();
    expect(body).toContain("Tickets by category");
    expect(body).toContain("Technician performance");
    const pdf = await page.request.get("/reports/bi/areas/export?range=this_month&format=pdf");
    expect(pdf.status()).toBe(200);
    expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("a support agent sees only the support report", async ({ page }) => {
    await signIn(page, "support@mwangaza.test");
    await page.goto("/reports");
    await expect(page.getByTestId("bi-reports").getByRole("link")).toHaveCount(1);
    await expect(page.getByTestId("bi-reports")).toContainText("Support and field operations");
    await page.goto("/reports/bi/payments");
    await page.waitForURL(/not-allowed/);
    const res = await page.request.get("/reports/bi/payments/export?format=csv");
    expect(res.status()).toBe(403);
  });
});

test("@mobile support desk and a report fit a phone screen", async ({ page }) => {
  await signIn(page, "owner@mwangaza.test");
  for (const url of ["/support", "/field-operations", "/notifications", "/reports/bi/subscriptions", "/network-map"]) {
    await page.goto(url);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, url).toBeLessThanOrEqual(1);
  }
});
