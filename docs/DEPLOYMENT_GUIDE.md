# Deployment guide

Not deployed yet. Target setup:

1. **Supabase** (Pro plan for backups/PITR): create a project in a region close to Kenya (e.g. eu-west / Frankfurt), then `npx supabase link --project-ref <ref>` and `npx supabase db push`. Never run `npm run db:seed` against it.
2. **Auth settings:** site URL = production domain, email confirmation on, SMTP provider configured, rate limits and CAPTCHA on.
3. **Vercel:** import the GitHub repo, framework Next.js, set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SITE_URL`. Add server-only secrets only when their phase needs them.
4. **First platform admin:** sign up normally, then in the Supabase SQL editor: `update public.profiles set platform_role = 'super_admin' where email = '<email>';`
5. **Worker and connector hosting** (Phase 4+): Railway, Fly.io or Render for the worker; the connector runs on a small machine inside each ISP network.
6. **CI** (recommended): GitHub Actions running typecheck, lint, unit tests, `supabase start` + `db reset` + DB tests on every pull request.
