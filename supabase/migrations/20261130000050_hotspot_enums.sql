-- =============================================================================
-- Pilot client update (24 Nov 2026): hotspot customers.
-- Enum values live in their own migration so the next one can use them.
-- =============================================================================

-- Hotspot users are cut off at the router when their time ends or the owner
-- cancels their code (the active hotspot session is removed).
alter type public.router_command_type add value if not exists 'disconnect_hotspot';

create type public.hotspot_voucher_status as enum (
  'awaiting_payment', -- bought on the portal, M-Pesa prompt sent, not paid yet
  'unused',           -- paid (or given free), not used on a device yet
  'active',           -- in use on one device; the clock is running
  'expired',          -- time used up
  'cancelled',        -- cancelled by the owner, with a reason
  'payment_failed'    -- M-Pesa prompt declined, failed or timed out
);

create type public.hotspot_voucher_source as enum (
  'portal',        -- bought on the hotspot login page (M-Pesa STK prompt)
  'paybill',       -- paid to the paybill directly (M-Pesa C2B)
  'staff',         -- sold by the owner after seeing the M-Pesa payment
  'complimentary'  -- free time from the owner (for example after an outage)
);
