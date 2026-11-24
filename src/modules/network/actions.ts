"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { assertPermission, AuthorizationError } from "@/lib/auth/guards";
import type { Permission } from "@/lib/auth/permissions";
import { credentialKeyConfigured } from "@/lib/connector/credentials";
import { createClient } from "@/lib/supabase/server";
import { fieldErrorsOf, type ActionResult } from "@/lib/validation/common";
import { alertActionSchema, connectorSchema, credentialsSchema, customerRouterSchema, routerSchema } from "@/lib/validation/network";
import * as network from "./service";

async function guarded<T = undefined>(permission: Permission, run: (tenantId: string, userId: string) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    const ctx = await assertPermission(permission);
    return await run(ctx.active.tenantId, ctx.userId);
  } catch (e) {
    if (e instanceof AuthorizationError) return { ok: false, message: e.message };
    throw e;
  }
}

export async function createRouterAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  let id = "";
  const r = await guarded("network:edit", async (tenantId) => {
    const parsed = routerSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };
    const res = await network.createRouter(await createClient(), tenantId, parsed.data);
    if (!res.ok) return res;
    id = res.data.id;
    return { ok: true };
  });
  if (!r.ok) return r;
  revalidatePath("/network");
  redirect(`/network/routers/${id}?created=1`);
}

export async function updateRouterAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded("network:edit", async (tenantId) => {
    const id = z.uuid().safeParse(formData.get("id"));
    if (!id.success) return { ok: false, message: "Router not found." };
    const parsed = routerSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };
    const res = await network.updateRouter(await createClient(), tenantId, id.data, parsed.data);
    if (!res.ok) return res;
    revalidatePath(`/network/routers/${id.data}`);
    revalidatePath("/network");
    return { ok: true, message: "Router saved." };
  });
}

export async function setRouterCredentialsAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded("network:credentials", async () => {
    const parsed = credentialsSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the form." };
    if (!credentialKeyConfigured()) return { ok: false, message: "The server has no ROUTER_CREDENTIALS_KEY, so passwords cannot be stored safely. Ask your administrator to set it." };
    const res = await network.setRouterCredentials(await createClient(), parsed.data.routerId, parsed.data.username, parsed.data.password);
    if (!res.ok) return res;
    revalidatePath(`/network/routers/${parsed.data.routerId}`);
    return { ok: true, message: "Credentials saved and encrypted. They cannot be shown again." };
  });
}

export async function createConnectorAction(_prev: ActionResult<{ token: string; name: string }> | null, formData: FormData): Promise<ActionResult<{ token: string; name: string }>> {
  return guarded<{ token: string; name: string }>("network:edit", async (tenantId, userId) => {
    const parsed = connectorSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the form." };
    const res = await network.createConnector(await createClient(), tenantId, userId, parsed.data.name);
    if (!res.ok) return res;
    revalidatePath("/network/connectors");
    return { ok: true, message: "Connector registered.", data: { token: res.data.token, name: parsed.data.name } };
  });
}

export async function revokeConnectorAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded("network:edit", async (tenantId) => {
    const id = z.uuid().safeParse(formData.get("id"));
    if (!id.success) return { ok: false, message: "Connector not found." };
    const res = await network.revokeConnector(await createClient(), tenantId, id.data);
    if (!res.ok) return res;
    revalidatePath("/network/connectors");
    return { ok: true, message: "Connector revoked. Its token no longer works." };
  });
}

export async function updateAlertAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded("alerts:manage", async () => {
    const parsed = alertActionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the form." };
    const res = await network.updateAlert(await createClient(), parsed.data.alertId, parsed.data.action, parsed.data.note);
    if (!res.ok) return res;
    revalidatePath("/alerts");
    revalidatePath("/network");
    return { ok: true, message: parsed.data.action === "acknowledge" ? "Alert acknowledged." : "Alert resolved." };
  });
}

export async function assignCustomerRouterAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded("network:edit", async () => {
    const parsed = customerRouterSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the form." };
    const res = await network.assignCustomerRouter(await createClient(), parsed.data.customerId, parsed.data.routerId);
    if (!res.ok) return res;
    revalidatePath(`/customers/${parsed.data.customerId}`);
    return { ok: true, message: "Router saved." };
  });
}

export async function retryRouterCommandAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded("subscriptions:suspend", async () => {
    const id = z.uuid().safeParse(formData.get("id"));
    const customerId = z.uuid().safeParse(formData.get("customerId"));
    if (!id.success) return { ok: false, message: "Command not found." };
    const res = await network.retryRouterCommand(await createClient(), id.data);
    if (!res.ok) return res;
    if (customerId.success) revalidatePath(`/customers/${customerId.data}`);
    return { ok: true, message: "Queued again. The connector picks it up within a minute." };
  });
}

export async function setRouterEnforcementAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded("settings:manage", async (tenantId) => {
    const enabled = formData.get("enabled") === "true";
    const res = await network.setRouterEnforcement(await createClient(), tenantId, enabled);
    if (!res.ok) return res;
    revalidatePath("/settings/organisation");
    return {
      ok: true,
      message: enabled
        ? "On. Suspending a customer now disconnects them on the router (once the connector allows router writes)."
        : "Off. Suspending no longer changes the router.",
    };
  });
}

export async function setAccessControlAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded("settings:manage", async (tenantId) => {
    const mode = formData.get("mode") === "radius" ? "radius" : "router_secrets";
    const res = await network.setAccessControl(await createClient(), tenantId, mode);
    if (!res.ok) return res;
    revalidatePath("/settings/organisation");
    return {
      ok: true,
      message:
        mode === "radius"
          ? "Saved: RADIUS. The connector now tells your RADIUS server who may connect; a disconnect drops the live session."
          : "Saved: router PPPoE secrets. A disconnect disables the customer's secret on the router.",
    };
  });
}
