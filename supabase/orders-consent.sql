-- Выполнить один раз в Supabase Dashboard → SQL Editor (проект fzcswoywkwdkdpsowiqz).
-- Фиксация согласий в базе: по ст. 5 Закона № 99-З доказывать наличие согласия
-- обязан оператор. Переписка в Telegram таким доказательством быть не может — сообщение удаляется.

alter table public.orders
  add column if not exists consent_data boolean not null default false,
  add column if not exists consent_transfer boolean not null default false,
  add column if not exists consent_at timestamptz;
