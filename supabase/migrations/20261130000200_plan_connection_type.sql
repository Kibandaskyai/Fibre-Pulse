-- =============================================================================
-- Client update (24 Nov 2026): monthly plans are PPPoE plans for households
-- with their own router. Static IP plans stay available for future ISPs; the
-- pilot has none. Router enforcement for static customers (address lists) is
-- not built yet, so static plans are billed but not disconnected.
-- =============================================================================
alter table public.service_packages
  add column connection_type text not null default 'pppoe'
  check (connection_type in ('pppoe', 'static'));

comment on column public.service_packages.connection_type is
  'pppoe: household PPPoE (router dial-in, RADIUS). static: fixed IP, no automatic disconnect yet.';
