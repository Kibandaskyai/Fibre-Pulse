# Product requirements (summary)

The authoritative specification is the "FibrePulse Complete Product Requirements, Technical Architecture and Development Blueprint" v1.0 supplied by the product owner. The approved architecture and plan is the Claude Doc "FibrePulse: Architecture and Development Plan". This file summarises what the code must satisfy, and records decisions made since.

## Users and roles

ISP roles: Owner, Finance Manager, Network Administrator, Customer Support Agent, Field Technician.
Platform roles: Super Administrator, Support Administrator.
The exact permission matrix is in `src/lib/auth/permissions.ts` (mirrored in SQL, checked by a test).

## Modules

1. Executive dashboard · 2. Customer management · 3. Packages and subscriptions · 4. Payments and billing · 5. Revenue analytics · 6. MikroTik network management · 7. Network operations centre · 8. Network map · 9. Support ticketing · 10. Field operations · 11. Notifications · 12. Reports and BI · plus the FibrePulse platform administration area (tenants, agreements, fee engine, platform invoices).

## Non-negotiable rules from the spec

- Pending or unverified transactions are never treated as collected revenue.
- Do not automatically suspend a customer's connection without a verified business rule and an authorised integration command.
- Do not fabricate signal readings (Wi-Fi needs CPE telemetry, optical needs OLT/ONT diagnostics).
- Exact customer locations only for permitted roles.
- FibrePulse admins do not get unrestricted access to ISP customer, payment or network data; support access is explicitly authorised and audited.
- Historical fee rates never change silently; duplicate platform charges are prevented.
- Follow the Kenya Data Protection Act, 2019.

## Decisions (23 Nov 2026)

| Question | Decision |
|---|---|
| Where to build | Build fully with Claude Code first, then hand over the code |
| Scope | One pilot client first, multi-tenant structure kept |
| Fee basis | 2.75% of **gross** verified subscription collections |
| Cash payments | **None.** Payment methods are M-Pesa, bank transfer, other |
| Pilot packages, prices, size | Not yet provided; fictional data until then |

## Assumptions (change if wrong)

- Customers do not log in during the pilot (no self-service portal).
- One person can belong to several ISPs and switch between them.
- Customer numbers look like `MFN-000123`, with a per-ISP prefix.
- One live subscription per customer; upgrades close the old one and open a new one.
- Platform fees are calculated per calendar month in Africa/Nairobi time.
- Support agents can view all customers of their ISP (needed for ticket intake) but not payments or exact GPS.
