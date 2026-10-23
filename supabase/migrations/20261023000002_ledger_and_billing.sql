-- Shield AI — Shield ledger + Polar billing (PLAN_V2 §3, §5, §11).
-- Append-only: entries are never updated or deleted. The balance is
-- derived. Idempotency is enforced by a UNIQUE key, so webhook replays and
-- client retries can never double-grant or double-charge.

create table if not exists public.shield_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('grant_subscription', 'grant_trial', 'grant_pack', 'debit_action')),
  amount int not null, -- positive for grants, negative for debits
  idempotency_key text not null unique,
  expires_at timestamptz, -- null = never expires (pack grants, debits)
  reference text,
  created_at timestamptz not null default now(),
  check ((kind = 'debit_action' and amount < 0) or (kind <> 'debit_action' and amount > 0))
);
create index if not exists shield_ledger_user_idx on public.shield_ledger (user_id, created_at);

alter table public.shield_ledger enable row level security;
create policy "ledger: owner reads own" on public.shield_ledger
  for select using (auth.uid() = user_id);
-- Writes happen only through the backend service role after entitlement
-- checks; there is deliberately no client insert policy.

-- Derived balance: unexpired grants minus all debits.
create or replace function public.shield_balance(p_user_id uuid)
returns int
language sql
stable
as $$
  select coalesce(sum(amount), 0)::int
  from public.shield_ledger
  where user_id = p_user_id
    and (kind = 'debit_action' or expires_at is null or expires_at > now());
$$;

-- Processed Polar webhook event ids (deduplication, PLAN_V2 §11).
create table if not exists public.polar_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);
alter table public.polar_events enable row level security;
-- No client policies: backend service role only.
