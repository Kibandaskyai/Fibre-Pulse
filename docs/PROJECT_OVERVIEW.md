# Project overview

FibrePulse is a cloud ISP operations and business intelligence platform for small and medium fibre ISPs, starting in Kenya.

- **Product:** one workspace for customers, subscriptions, payments, revenue, MikroTik network monitoring, support, field operations and reports.
- **Business model:** FibrePulse charges each ISP a percentage of eligible verified subscription collections. Pilot rate: **2.75% of gross** (the pilot ISP currently pays another provider 3%). Rates are configurable per ISP agreement and historical calculations never change.
- **First customer:** one established pilot ISP. The platform is multi-tenant from day one so further ISPs can join without rework.
- **Delivery approach:** built incrementally in seven phases (see [PROJECT_STATUS.md](../PROJECT_STATUS.md)). A professional software engineer takes over for production engineering and the live Safaricom Daraja integration.

Ground rules that apply to all code:

1. Never fabricate live network data or successful payments. Simulated data is labelled everywhere it appears.
2. Tenant isolation is enforced by Postgres Row Level Security, not by the frontend.
3. No secrets in the browser or in the repository.
4. Every incomplete integration is documented and marked `TODO: SOFTWARE ENGINEER`.
