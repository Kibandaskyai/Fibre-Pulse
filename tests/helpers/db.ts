/**
 * Database test helpers.
 *
 * Tests connect to the local Supabase Postgres (started with
 * `npx supabase start`) as the `postgres` role to build fixtures, then run
 * each assertion inside a transaction that switches to the `authenticated`
 * role with a forged JWT claim, exactly as PostgREST does for a real
 * request. The transaction is always rolled back.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";

export const TEST_DB_URL =
  process.env.TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export const pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 4 });

export type TestUser = { id: string; email: string };

/** Short random suffix so repeated test runs never collide. */
export const runId = randomUUID().slice(0, 8);

export async function createUser(
  label: string,
  opts: { platformRole?: "super_admin" | "support_admin"; confirmed?: boolean } = {},
): Promise<TestUser> {
  const id = randomUUID();
  const email = `${label}.${runId}@example.test`;
  await pool.query(
    `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                             raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, '',
             $3, '{"provider":"email","providers":["email"]}', $4, now(), now())`,
    [id, email, opts.confirmed === false ? null : new Date(), JSON.stringify({ full_name: label })],
  );
  if (opts.platformRole) {
    await pool.query(`update public.profiles set platform_role = $2 where id = $1`, [id, opts.platformRole]);
  }
  return { id, email };
}

/**
 * Run `fn` as a signed-in user inside a transaction that is rolled back.
 * Pass `null` to run as an anonymous visitor.
 */
export async function asUser<T>(user: TestUser | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (user) {
      await client.query("set local role authenticated");
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: user.id, role: "authenticated", email: user.email }),
      ]);
    } else {
      await client.query("set local role anon");
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: "anon" })]);
    }
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

/** Like asUser, but commits. Use only for fixture setup. */
export async function asUserCommit<T>(user: TestUser, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: user.id, role: "authenticated", email: user.email }),
    ]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Run a statement inside a savepoint and return the Postgres error, if any. */
export async function tryQuery(
  c: pg.PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<{ ok: true; rows: Record<string, unknown>[]; rowCount: number } | { ok: false; error: string; code?: string }> {
  await c.query("savepoint t");
  try {
    const r = await c.query(sql, params);
    await c.query("release savepoint t");
    return { ok: true, rows: r.rows, rowCount: r.rowCount ?? 0 };
  } catch (e) {
    await c.query("rollback to savepoint t");
    const err = e as { message: string; code?: string };
    return { ok: false, error: err.message, code: err.code };
  }
}

export async function count(c: pg.PoolClient, sql: string, params: unknown[] = []): Promise<number> {
  const r = await c.query(sql, params);
  return Number(Object.values(r.rows[0] ?? { n: 0 })[0]);
}
