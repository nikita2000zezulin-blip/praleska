-- Выполнить один раз в Supabase Dashboard → SQL Editor (проект fzcswoywkwdkdpsowiqz).
-- Таблица истории заявок с сайта. RLS включён и без единой policy для anon/authenticated,
-- поэтому publishable-ключ (используемый в браузере) не может ни читать, ни писать сюда —
-- доступ есть только у service_role (используется исключительно в Netlify-функциях).

create table public.orders (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name text not null,
  phone text not null,
  occasion text,
  comment text
);

alter table public.orders enable row level security;
