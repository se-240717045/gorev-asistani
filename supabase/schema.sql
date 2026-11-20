-- =====================================================================
-- Görev Asistanı — Supabase veritabanı şeması
-- Supabase panelinde: SQL Editor → New query → bu dosyanın tamamını
-- yapıştır → Run. Birden fazla kez çalıştırmak güvenlidir.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Görevler
-- ---------------------------------------------------------------------
create table if not exists public.tasks (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid not null default auth.uid()
                      references auth.users (id) on delete cascade,
    title             text not null check (length(trim(title)) > 0),
    notes             text,
    due_date          date,
    due_time          time,
    importance        smallint not null default 2
                      check (importance between 1 and 3),   -- 1 düşük, 2 normal, 3 yüksek
    estimate_minutes  integer check (estimate_minutes is null or estimate_minutes > 0),
    category          text not null default 'kişisel'
                      check (category in ('iş', 'kişisel')),
    status            text not null default 'acik'
                      check (status in ('acik', 'tamam')),
    done_at           timestamptz,
    last_notified_at  timestamptz,
    created_at        timestamptz not null default now()
);

create index if not exists tasks_user_status_idx on public.tasks (user_id, status);
create index if not exists tasks_user_due_idx    on public.tasks (user_id, due_date);

-- ---------------------------------------------------------------------
-- 2) Push bildirim abonelikleri (her cihaz/tarayıcı için bir satır)
-- ---------------------------------------------------------------------
create table if not exists public.push_subscriptions (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null default auth.uid()
                references auth.users (id) on delete cascade,
    endpoint    text not null unique,
    p256dh      text not null,
    auth        text not null,
    user_agent  text,
    created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3) Ayarlar (kullanıcı başına bir satır)
-- ---------------------------------------------------------------------
create table if not exists public.settings (
    user_id                    uuid primary key default auth.uid()
                               references auth.users (id) on delete cascade,
    quiet_start                time    not null default '22:00',
    quiet_end                  time    not null default '08:00',
    brief_time                 time    not null default '08:00',
    high_slots                 text    not null default '09:00,15:00',
    critical_interval_minutes  integer not null default 150
                               check (critical_interval_minutes >= 30),
    daily_cap                  integer not null default 12
                               check (daily_cap between 1 and 100),
    last_brief_date            date,
    last_weekly_date           date,
    updated_at                 timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 4) Yapay zeka özetleri (sabah brifingi / haftalık plan)
-- ---------------------------------------------------------------------
create table if not exists public.summaries (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references auth.users (id) on delete cascade,
    kind        text not null check (kind in ('gunluk', 'haftalik')),
    content     text not null,
    created_at  timestamptz not null default now()
);

create index if not exists summaries_user_kind_idx
    on public.summaries (user_id, kind, created_at desc);

-- ---------------------------------------------------------------------
-- 5) Gönderilen bildirim kaydı (günlük üst sınır için)
-- ---------------------------------------------------------------------
create table if not exists public.notification_log (
    id        bigint generated always as identity primary key,
    user_id   uuid not null references auth.users (id) on delete cascade,
    kind      text not null,          -- kritik | yuksek | gunluk | haftalik
    title     text not null,
    body      text,
    sent_at   timestamptz not null default now()
);

create index if not exists notification_log_user_sent_idx
    on public.notification_log (user_id, sent_at desc);

-- ---------------------------------------------------------------------
-- 6) Satır düzeyi güvenlik: herkes sadece kendi verisini görür
--    (Bildirim motoru doğrudan veritabanı bağlantısıyla çalıştığı için
--     bu kurallardan etkilenmez.)
-- ---------------------------------------------------------------------
alter table public.tasks              enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.settings           enable row level security;
alter table public.summaries          enable row level security;
alter table public.notification_log   enable row level security;

drop policy if exists "kendi gorevleri" on public.tasks;
create policy "kendi gorevleri" on public.tasks
    for all to authenticated
    using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "kendi abonelikleri" on public.push_subscriptions;
create policy "kendi abonelikleri" on public.push_subscriptions
    for all to authenticated
    using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "kendi ayarlari" on public.settings;
create policy "kendi ayarlari" on public.settings
    for all to authenticated
    using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "kendi ozetleri (okuma)" on public.summaries;
create policy "kendi ozetleri (okuma)" on public.summaries
    for select to authenticated
    using (user_id = auth.uid());

drop policy if exists "kendi bildirim kaydi (okuma)" on public.notification_log;
create policy "kendi bildirim kaydi (okuma)" on public.notification_log
    for select to authenticated
    using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 7) Öncelik görünümü — aciliyet hesabının TEK kaynağı.
--    Hem arayüz hem bildirim motoru bu görünümü okur.
--
--    Seviyeler:
--      kritik : gecikmiş ve önem ≥ 2  |  bugün ve önem = 3
--      yuksek : bugün/gecikmiş (diğer) |  1–2 gün kaldı
--      normal : 3–7 gün kaldı          |  tarihsiz ama önem = 3
--      dusuk  : 7 günden fazla         |  tarihsiz
-- ---------------------------------------------------------------------
create or replace view public.tasks_view
with (security_invoker = true) as
with base as (
    select t.*,
           (now() at time zone 'Europe/Istanbul')::date as today_tr,
           (t.due_date - (now() at time zone 'Europe/Istanbul')::date) as days_left
    from public.tasks t
)
select b.*,
       case
           when b.status = 'tamam' then 'tamam'
           when b.due_date is null and b.importance = 3 then 'normal'
           when b.due_date is null then 'dusuk'
           when b.days_left < 0 and b.importance >= 2 then 'kritik'
           when b.days_left = 0 and b.importance = 3 then 'kritik'
           when b.days_left <= 2 then 'yuksek'
           when b.days_left <= 7 then 'normal'
           else 'dusuk'
       end as level,
       case
           when b.status = 'tamam' then 0
           when b.due_date is null and b.importance = 3 then 2
           when b.due_date is null then 1
           when b.days_left < 0 and b.importance >= 2 then 4
           when b.days_left = 0 and b.importance = 3 then 4
           when b.days_left <= 2 then 3
           when b.days_left <= 7 then 2
           else 1
       end as level_rank
from base b;

grant select on public.tasks_view to authenticated;
