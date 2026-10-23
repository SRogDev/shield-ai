-- Shield AI — core schema (PLAN_V2 §5).
-- Canonical data lives in Supabase Postgres. Source code is NEVER stored:
-- scans keep only a manifest (path, size, sha256) of what was analyzed.
-- The TypeScript service layer (packages/shared/src/services.ts) is the
-- reference semantics for these shapes.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  plan text not null default 'trial' check (plan in ('trial', 'indie', 'builder')),
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);
create index if not exists projects_owner_idx on public.projects (owner_id);

create table if not exists public.repo_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  repo_name text not null,
  remote_url_hash text,
  created_at timestamptz not null default now(),
  unique (owner_id, repo_name, remote_url_hash)
);

-- CLI device authorization sessions (PLAN_V2 §7.2). The device code and the
-- issued CLI token are stored HASHED only.
create table if not exists public.device_codes (
  id uuid primary key default gen_random_uuid(),
  device_code_hash text not null unique,
  user_code text not null unique,
  user_id uuid references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  cli_token_hash text,
  interval_sec int not null default 2,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.cli_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  token_hash text not null unique,
  scope text not null default 'cli',
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists cli_tokens_user_idx on public.cli_tokens (user_id);

create table if not exists public.scans (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  action text not null check (action in ('quick', 'verify', 'incremental', 'full')),
  status text not null default 'uploading'
    check (status in ('pending', 'uploading', 'analyzing', 'completed', 'failed')),
  cost_shields int not null check (cost_shields >= 0),
  idempotency_key text not null,
  verify_finding_id uuid,
  error text,
  created_at timestamptz not null default now(),
  unique (owner_id, idempotency_key)
);
create index if not exists scans_project_idx on public.scans (project_id, created_at desc);

-- Upload manifest + acknowledgments. Paths/sizes/hashes ONLY — no contents.
create table if not exists public.scan_files (
  scan_id uuid not null references public.scans (id) on delete cascade,
  path text not null,
  sha256 text not null,
  size int not null check (size >= 0),
  acked_at timestamptz,
  primary key (scan_id, path)
);

create table if not exists public.findings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  scan_id uuid not null references public.scans (id) on delete cascade,
  fingerprint text not null,
  title text not null,
  description text not null,
  severity text not null check (severity in ('Critical', 'High', 'Medium', 'Low', 'Info')),
  confidence text not null check (confidence in ('High', 'Medium', 'Low')),
  cwe text not null,
  owasp text[] not null default '{}',
  file_path text not null,
  line_start int not null,
  line_end int not null,
  evidence text not null,
  impact text not null,
  verification_status text not null default 'open'
    check (verification_status in ('open', 'fixed_verified', 'still_present', 'not_rechecked')),
  created_at timestamptz not null default now()
);
create index if not exists findings_project_idx on public.findings (project_id, created_at desc);
create index if not exists findings_fingerprint_idx on public.findings (project_id, fingerprint);

create table if not exists public.remediation_tasks (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.findings (id) on delete cascade,
  title text not null,
  guidance text not null,
  status text not null default 'open' check (status in ('open', 'done')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security: owner isolation as defense in depth (PLAN_V2 §5).
-- The backend ALSO checks ownership server-side on every path; RLS is the
-- second wall, not the only one. Backend service-role access is used only
-- after identity + ownership are established in server code.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.repo_links enable row level security;
alter table public.device_codes enable row level security;
alter table public.cli_tokens enable row level security;
alter table public.scans enable row level security;
alter table public.scan_files enable row level security;
alter table public.findings enable row level security;
alter table public.remediation_tasks enable row level security;

create policy "profiles: own row" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

create policy "projects: owner only" on public.projects
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create policy "repo_links: owner only" on public.repo_links
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- Device codes are manipulated by the backend (service role) during the
-- device flow; a signed-in user may read/approve their own pending codes.
create policy "device_codes: own approvals" on public.device_codes
  for select using (auth.uid() = user_id);

create policy "cli_tokens: owner reads own" on public.cli_tokens
  for select using (auth.uid() = user_id);

create policy "scans: owner only" on public.scans
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create policy "scan_files: via owned scan" on public.scan_files
  for all using (exists (select 1 from public.scans s where s.id = scan_id and s.owner_id = auth.uid()));

create policy "findings: via owned project" on public.findings
  for all using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));

create policy "tasks: via owned finding" on public.remediation_tasks
  for all using (exists (
    select 1 from public.findings f
    join public.projects p on p.id = f.project_id
    where f.id = finding_id and p.owner_id = auth.uid()
  ));
