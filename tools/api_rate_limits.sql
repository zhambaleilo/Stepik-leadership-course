-- Счётчики запросов для api/_guard.js. Выполнить ОДИН РАЗ в Supabase → SQL Editor
-- ДО выкладки кода: без функции api_rate_hit суточный потолок блокирует платные вызовы (fail-closed).
-- Фиксированное окно: счётчик на (ключ, окно); увеличение и проверка одним атомарным upsert.
create table if not exists api_rate_counters (
  key          text        not null,
  window_start timestamptz not null,
  n            int         not null default 0,
  primary key (key, window_start)
);
alter table api_rate_counters enable row level security;  -- без политик: доступ только у service_role

create or replace function api_rate_hit(p_key text, p_window_sec int, p_limit int)
returns boolean language plpgsql security definer set search_path = public as $$
declare w timestamptz; c int;
begin
  w := to_timestamp(floor(extract(epoch from now()) / p_window_sec) * p_window_sec);
  insert into api_rate_counters as t (key, window_start, n) values (p_key, w, 1)
  on conflict (key, window_start) do update set n = t.n + 1
  returning t.n into c;
  if random() < 0.02 then
    delete from api_rate_counters where window_start < now() - interval '2 days';
  end if;
  return c <= p_limit;
end $$;

revoke all on function api_rate_hit(text, int, int) from public, anon, authenticated;
grant execute on function api_rate_hit(text, int, int) to service_role;
