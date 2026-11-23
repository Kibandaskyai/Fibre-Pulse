import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 4 browser flows against the local demo data (npm run db:seed) and a
 * running app with ROUTER_CREDENTIALS_KEY set:
 * register a connector, run the real connector agent against the app (once in
 * SIMULATE mode for the demo routers, then for a real router that cannot be
 * reached), and follow the readings, alerts and roles through the UI.
 */
const PASSWORD = "FibrePulse-Demo-2026";
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const stamp = Date.now().toString().slice(-6);
const connectorName = `E2E connector ${stamp}`;
const routerName = `E2E unreachable ${stamp}`;
let token = "";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

/** Runs the connector agent for one cycle, exactly as an ISP would run it. */
function runAgent(simulate: boolean) {
  execFileSync("npx", ["tsx", "connector/mikrotik-agent/src/index.ts", "--once"], {
    env: { ...process.env, FIBREPULSE_URL: BASE, FIBREPULSE_TOKEN: token, SIMULATE: String(simulate), ALLOW_ROUTER_WRITES: "false", REQUEST_TIMEOUT_SECONDS: "3" },
    stdio: "pipe",
    timeout: 60_000,
  });
}

test.describe.serial("network monitoring", () => {
  test("register a connector and see its token once", async ({ page }) => {
    await signIn(page, "network@mwangaza.test");
    await page.goto("/network/connectors");
    await page.getByLabel("Connector name").fill(connectorName);
    await page.getByRole("button", { name: "Register connector" }).click();
    const field = page.getByTestId("connector-token");
    await expect(field).toBeVisible();
    token = await field.inputValue();
    expect(token).toMatch(/^fpc_[0-9A-Za-z]{40}$/);
    await expect(page.getByRole("row", { name: new RegExp(connectorName) })).toContainText("Not installed yet");
    await page.reload();
    await expect(page.getByTestId("connector-token")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(token);
  });

  test("simulated routers report through the new connector", async ({ page }) => {
    await signIn(page, "network@mwangaza.test");
    await page.goto("/network");
    await page.getByRole("link", { name: "Kasarani Core (simulated)" }).click();
    await page.getByLabel("Connector", { exact: true }).selectOption({ label: connectorName });
    await page.getByRole("button", { name: "Save router" }).click();
    await expect(page.getByText("Router saved.")).toBeVisible();

    runAgent(true);
    await page.reload();
    await expect(page.getByText(`${connectorName} · just now`)).toBeVisible();
    await expect(page.getByText("Online", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: /sim-kasarani-cor-01/ })).toBeVisible();
    await page.goto("/network/connectors");
    await expect(page.getByRole("row", { name: new RegExp(connectorName) })).toContainText("Reporting");
  });

  test("add a real router, store its password encrypted, and get an alert when it cannot be reached", async ({ page }) => {
    await signIn(page, "network@mwangaza.test");
    await page.goto("/network/routers/new");
    await page.getByLabel("Name", { exact: true }).fill(routerName);
    await page.getByLabel("Management IP address").fill("not-an-ip");
    await page.getByRole("button", { name: "Add router" }).click();
    await expect(page.getByText("Enter the router's IP address")).toBeVisible();
    await page.getByLabel("Management IP address").fill("127.0.0.1");
    await page.getByLabel("REST API").selectOption("http");
    await page.getByLabel("Port", { exact: true }).fill("1");
    await page.getByLabel("Connector", { exact: true }).selectOption({ label: connectorName });
    await page.getByRole("button", { name: "Add router" }).click();
    await page.waitForURL(/\/network\/routers\/[0-9a-f-]{36}\?created=1/);
    await expect(page.getByText("Router added.")).toBeVisible();

    await page.getByLabel("API username").fill("fibrepulse");
    await page.getByLabel("API password").fill("e2e-secret-password");
    await page.getByRole("button", { name: "Save credentials" }).click();
    await expect(page.getByText("Credentials saved and encrypted.")).toBeVisible();
    await page.reload();
    await expect(page.getByText("Saved for user fibrepulse.")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("e2e-secret-password");

    runAgent(false);
    runAgent(false);
    await page.reload();
    await expect(page.getByText("Offline", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Last read failed:")).toBeVisible();
  });

  test("acknowledge and resolve the alert", async ({ page }) => {
    await signIn(page, "network@mwangaza.test");
    await page.goto("/alerts");
    const row = page.getByTestId("alert-row").filter({ hasText: routerName }).filter({ hasText: "Critical" }).first();
    await expect(row).toContainText("Open");
    await row.getByLabel("Note").fill("Checking the power at the cabinet");
    await row.getByRole("button", { name: "Acknowledge" }).click();
    await expect(page.getByText("Alert acknowledged.")).toBeVisible();
    await page.reload();
    const acked = page.getByTestId("alert-row").filter({ hasText: routerName }).filter({ hasText: "Critical" }).first();
    await expect(acked).toContainText("Acknowledged");
    await acked.getByRole("button", { name: "Resolve" }).click();
    // Resolved alerts leave the default "not resolved" list.
    await expect(page.getByTestId("alert-row").filter({ hasText: routerName }).filter({ hasText: "Critical" })).toHaveCount(0);
    await page.goto("/alerts?status=resolved");
    await expect(page.getByTestId("alert-row").filter({ hasText: routerName }).first()).toContainText("Resolved");
  });

  test("roles: support sees the network but cannot change it, finance cannot see it", async ({ page }) => {
    await signIn(page, "support@mwangaza.test");
    await page.goto("/network");
    await expect(page.getByRole("heading", { name: "Network monitoring" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Add router" })).toHaveCount(0);
    await page.goto("/network/routers/new");
    await expect(page).toHaveURL(/\/not-allowed/);
    await page.goto("/network/connectors");
    await expect(page.getByRole("button", { name: "Register connector" })).toHaveCount(0);
    await page.goto("/settings/organisation");
    await expect(page).toHaveURL(/\/not-allowed/);

    await signIn(page, "finance@mwangaza.test");
    await page.goto("/network");
    await expect(page).toHaveURL(/\/not-allowed/);
  });

  test("the owner turns router disconnect on, and suspending queues a disconnect", async ({ page }) => {
    await signIn(page, "owner@mwangaza.test");
    await page.goto("/settings/organisation");
    const card = page.locator("form").filter({ hasText: "Status:" });
    if (await card.getByRole("button", { name: "Turn on" }).count()) {
      await card.getByRole("button", { name: "Turn on" }).click();
      await expect(card.getByRole("button", { name: "Turn off" })).toBeVisible();
    }
    await page.goto("/customers?q=sim-kasarani-cor-02");
    await page.locator('tbody a[href^="/customers/"]').first().click();
    await expect(page.getByText("Suspending disconnects this customer on the router")).toBeVisible();
    {
      await page.getByLabel("Reason for suspending").fill("E2E: unpaid invoice");
      await page.getByRole("button", { name: "Suspend" }).click();
      // The status card swaps to the Restore form, and the connection card shows the queued disconnect.
      await expect(page.getByText("Waiting for connector").first()).toBeVisible();
      await page.getByLabel("Note (optional)").fill("E2E restore");
      await page.getByRole("button", { name: "Restore" }).click();
      // The disconnect had not been sent yet, so restoring cancels it instead of queuing a reconnect.
      await expect(page.getByText("Cancelled").first()).toBeVisible();
      await expect(page.getByText("Waiting for connector")).toHaveCount(0);
    }
    // Leave the demo as seeded.
    await page.goto("/settings/organisation");
    const toggle = page.locator("form").filter({ hasText: "Status:" });
    await toggle.getByRole("button", { name: "Turn off" }).click();
    await expect(toggle.getByRole("button", { name: "Turn on" })).toBeVisible();
  });
});

test("network pages fit a phone screen @mobile", async ({ page }) => {
  await signIn(page, "owner@mwangaza.test");
  for (const path of ["/network", "/network/connectors", "/alerts", "/settings/organisation"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(1);
  }
  await page.goto("/network");
  await page.getByRole("link", { name: "Kasarani Core (simulated)" }).click();
  await expect(page.getByRole("heading", { name: "CPU load" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});
