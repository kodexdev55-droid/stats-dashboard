-- =============================================================
-- Deligatr Dashboard — Supabase setup
-- Run once in Supabase → SQL Editor → New query
-- =============================================================


-- ── 1. Safe view (exposes only non-secret columns from subaccounts) ──

-- The view runs as its owner (security definer is the default in
-- Postgres for views), so the anon role can read subaccount_name
-- through the view without having direct access to the subaccounts
-- table (which holds API keys and tokens).

create or replace view public.client_public as
  select location_id, subaccount_name
  from public.subaccounts;

-- Grant SELECT on the view to anon (and authenticated for good measure)
grant select on public.client_public to anon, authenticated;


-- ── 2. Lock down subaccounts ──────────────────────────────────────────

-- Enable RLS — with no anon policy, the anon role is blocked entirely.
alter table public.subaccounts enable row level security;

-- Belt-and-suspenders: revoke any previously granted direct access.
revoke select, insert, update, delete on public.subaccounts from anon;

-- Only the service_role (used by n8n / backend) can write to subaccounts.
-- No policy needed here — service_role bypasses RLS by default.


-- ── 3. Expose client_stats to anon ───────────────────────────────────

alter table public.client_stats enable row level security;

-- Drop if re-running
drop policy if exists "anon_select_client_stats" on public.client_stats;

-- Allow anon to read all rows (location_id is the discriminator;
-- the client receives their own id via the GHL menu link).
create policy "anon_select_client_stats"
  on public.client_stats
  for select
  to anon
  using (true);


-- ── 4. Expose client_email_stats to anon ─────────────────────────────

alter table public.client_email_stats enable row level security;

drop policy if exists "anon_select_client_email_stats" on public.client_email_stats;

create policy "anon_select_client_email_stats"
  on public.client_email_stats
  for select
  to anon
  using (true);


-- ── 5. Smoke-test queries (run as anon to verify) ────────────────────

-- These should succeed:
--   select * from public.client_public limit 5;
--   select * from public.client_stats limit 5;
--   select * from public.client_email_stats limit 5;

-- This should fail with "permission denied" or return 0 rows:
--   select * from public.subaccounts limit 1;
