-- TheBroThing masterclass sequencer — Supabase schema.
-- Tables are prefixed `webinar_` so they sit alongside the datingbot tables
-- in the same project without colliding.
-- Run once in the Supabase SQL editor.

create table if not exists webinar_contacts (
  phone             text primary key,
  first_name        text default '',
  full_name         text default '',
  email             text default '',
  registered_at     timestamptz,
  source            text default '',
  confirmed         boolean default false,
  tags              text[] default '{}',
  inbound_count     integer default 0,
  last_inbound_at   timestamptz,
  last_inbound_text text default '',
  opted_out         boolean default false,
  attended          boolean default false,
  booked            boolean default false,
  sent              jsonb default '{}'::jsonb,
  notes             text default '',
  updated_at        timestamptz default now()
);

create table if not exists webinar_messages (
  id         bigserial primary key,
  ts         timestamptz default now(),
  phone      text,
  first_name text default '',
  message_id text,
  status     text,
  error      text default '',
  text       text default ''
);

create table if not exists webinar_inbound (
  id         bigserial primary key,
  ts         timestamptz default now(),
  phone      text,
  first_name text default '',
  text       text default '',
  keyword    text default '',
  media_file text default ''
);

create table if not exists webinar_ops (
  id     bigserial primary key,
  ts     timestamptz default now(),
  event  text,
  detail text default ''
);

create index if not exists webinar_messages_ts_idx    on webinar_messages (ts desc);
create index if not exists webinar_messages_phone_idx on webinar_messages (phone);
create index if not exists webinar_inbound_ts_idx     on webinar_inbound (ts desc);
create index if not exists webinar_inbound_phone_idx  on webinar_inbound (phone);
create index if not exists webinar_contacts_flags_idx on webinar_contacts (attended, booked, opted_out);

-- The app connects with the service key, which bypasses RLS. RLS is enabled anyway
-- so that the anon key cannot read contact data if it is ever exposed.
alter table webinar_contacts enable row level security;
alter table webinar_messages enable row level security;
alter table webinar_inbound  enable row level security;
alter table webinar_ops      enable row level security;
