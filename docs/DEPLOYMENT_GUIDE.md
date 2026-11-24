# Deployment guide

FibrePulse is not deployed yet. This is the order to deploy it in for the pilot ISP. Every step is reversible except creating the production database: do not run the demo seed there.

## What runs where

| Part | Where | Notes |
|---|---|---|
| Web app (Next.js) | Vercel (or any Node 20+ host) | Public. Holds `ROUTER_CREDENTIALS_KEY`. |
| Database, auth, scheduled jobs | Supabase (Pro plan, Frankfurt or nearest EU region) | `pg_cron` runs expiry every 5 minutes and billing on the 1st. |
| SMS worker | Railway, Fly.io or Render (small always-on Node process) | Holds the service role key and Safaricom keys. Not public. |
| FibrePulse Connector | A small Linux machine or VM inside the ISP network | Talks to the MikroTik routers and to the ISP's FreeRADIUS. |
| M-Pesa (Daraja) | Callback route on the web app | Not built: see MPESA_INTEGRATION_HANDOVER.md. |

## 1. Supabase

1. Create the project, then enable **Point-in-time recovery** (Pro plan) and daily backups.
2. `npx supabase link --project-ref <ref>` and `npx supabase db push`. This applies every migration, including the `pg_cron` schedules (check them under *Database → Cron jobs*: `fibrepulse-expire-subscriptions` and `fibrepulse-monthly-billing`).
3. **Auth:** site URL = production domain; redirect URLs = `https://<domain>/**`; email confirmation on; a custom SMTP provider; leaked-password protection, rate limits and CAPTCHA on.
4. **API settings:** keep only the `public` schema exposed (never `private`).
5. Never run `npm run db:seed` against production. It refuses non-local URLs anyway.

## 2. Web app

1. Import the GitHub repository in Vercel (framework: Next.js).
2. Environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `NEXT_PUBLIC_SITE_URL=https://<domain>`
   - `ROUTER_CREDENTIALS_KEY`, generated once with `openssl rand -base64 32` and stored in a password manager. Losing it means re-entering every router password.
   - M-Pesa variables only once Daraja is built.
3. Point the domain, check `https://<domain>/login`, then sign up the first FibrePulse administrator and promote them in the SQL editor:
   `update public.profiles set platform_role = 'super_admin' where email = '<email>';`

## 3. Pilot ISP onboarding (in the app)

1. The ISP owner registers. The super admin activates the ISP under *ISP Tenants*.
2. The super admin edits the ISP's draft agreement (2.75% of gross collections), and marks it signed once the paper or e-signature is done.
3. The owner adds packages, staff and customers. Every PPPoE customer needs their PPPoE username on their profile.
4. The owner sets *Settings → Organisation → Access control* to **RADIUS** and, when ready, turns on disconnects.

## 4. Connector (inside the ISP network)

See [MIKROTIK_INTEGRATION.md](MIKROTIK_INTEGRATION.md).

1. Register the connector in FibrePulse, then copy its token once.
2. Install it with Docker or the systemd unit in `connector/mikrotik-agent/`, with `FIBREPULSE_URL=https://<domain>` and the token.
3. Create a read-only API user on each router first. Add the `write` policy and `ALLOW_ROUTER_WRITES=true` only when disconnects go live.
4. RADIUS: set `RADIUS_POLICY_*` on the connector and the `rest` module in FreeRADIUS. Test with one customer first.

## 5. SMS worker

1. Deploy the repository to the worker host with the command `npm run worker:sms`.
2. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SMS_PROVIDER=safaricom` and the `SAFARICOM_SMS_*` values. Until `src/lib/sms/safaricom.ts` is finished, keep `SMS_PROVIDER=log`.
3. Staff choose SMS per notification type under *Notifications → Preferences*. SMS goes to the phone number on the staff profile.

## 6. Monthly operations

- **1st of each month, 06:00 Kenyan time:** fees for last month are calculated and invoices issued automatically. Check *Platform Invoices → Recent runs* that morning.
- Record ISP payments to FibrePulse on each invoice (M-Pesa or bank reference).
- Watch the platform overview for unpaid and overdue invoices.

## 7. Before go-live checklist

- [ ] All tests green in CI on the release commit.
- [ ] Super admin account uses a strong password, and 2FA once Supabase MFA is turned on.
- [ ] `ROUTER_CREDENTIALS_KEY` and the service role key are stored in a secret manager, not in chat or email.
- [ ] FibrePulse legal name, KRA PIN, VAT status and paybill are added to the invoice (see the TODO in `invoice-document.tsx`).
- [ ] One customer tested end to end with RADIUS: connect, expire, renew, suspend, restore.
- [ ] Data processing agreement with the pilot ISP (Kenya Data Protection Act; see SECURITY_GUIDE.md).
- [ ] Backups restored once into a scratch project to prove they work.

## CI

`.github/workflows` runs typecheck, lint, unit tests and the database tests on every pull request. Browser tests run locally (`npm run test:e2e`) against a seeded local stack.
