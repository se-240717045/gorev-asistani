"""
Bildirim kuralları — yan etkisi olmayan saf fonksiyonlar.

Ne zaman, hangi görevler için bildirim gideceğine burada karar verilir.
Veritabanı, Gemini ya da push ile ilgili hiçbir şey bu dosyada yok; bu
yüzden kolayca test edilebilir (bkz. tests/test_rules.py).

Kurallar (KURULUM.md'de de anlatılıyor):
  🔴 kritik : ilk kez kritik olduğunda bildirim, sonra iş bitene kadar
              her `critical_interval_minutes` dakikada bir hatırlatma
  🟠 yuksek : günde belirli saatlerde (varsayılan 09:00 ve 15:00) bir kez
  🟡 normal : sadece sabah brifinginde
  ⚪ dusuk  : sadece haftalık planda
  Sessiz saatlerde hiçbir şey gönderilmez. Görev bildirimleri günlük üst
  sınıra tabidir; sabah brifingi ve haftalık plan bu sınıra sayılmaz.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta

LEVEL_EMOJI = {"kritik": "🔴", "yuksek": "🟠", "normal": "🟡", "dusuk": "⚪"}
LEVEL_NAME = {"kritik": "Kritik", "yuksek": "Yüksek", "normal": "Normal", "dusuk": "Düşük"}
GUNLER = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"]
AYLAR = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz",
         "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"]

MAX_BODY = 230  # iOS kilit ekranında görünen makul uzunluk


@dataclass
class Settings:
    quiet_start: time = time(22, 0)
    quiet_end: time = time(8, 0)
    brief_time: time = time(8, 0)
    high_slots: list[time] = field(default_factory=lambda: [time(9, 0), time(15, 0)])
    critical_interval_minutes: int = 150
    daily_cap: int = 12
    last_brief_date: date | None = None
    last_weekly_date: date | None = None


@dataclass
class Task:
    id: str
    title: str
    level: str
    importance: int = 2
    due_date: date | None = None
    due_time: time | None = None
    days_left: int | None = None
    estimate_minutes: int | None = None
    category: str = "kişisel"
    created_at: datetime | None = None
    last_notified_at: datetime | None = None


@dataclass
class Notification:
    kind: str                 # kritik | yuksek | gunluk | haftalik
    title: str
    body: str
    task_ids: list[str] = field(default_factory=list)
    urgent: bool = False


# ---------------------------------------------------------------------------
# Yardımcılar
# ---------------------------------------------------------------------------

def parse_slots(text: str | None) -> list[time]:
    """'09:00,15:00' → [time(9,0), time(15,0)]. Hatalı parçaları atlar."""
    slots: list[time] = []
    for part in (text or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            hh, mm = part.split(":")[:2]
            slots.append(time(int(hh), int(mm)))
        except (ValueError, TypeError):
            continue
    return sorted(set(slots))


def in_quiet_hours(now: datetime, s: Settings) -> bool:
    t = now.time()
    start, end = s.quiet_start, s.quiet_end
    if start == end:
        return False
    if start < end:                       # örn. 13:00–15:00
        return start <= t < end
    return t >= start or t < end          # gece yarısını aşan, örn. 22:00–08:00


def current_slot_start(now: datetime, slots: list[time]) -> datetime | None:
    """Bugün, şu andan önceki en son hatırlatma saatinin başlangıcı."""
    past = [t for t in slots if t <= now.time()]
    if not past:
        return None
    return datetime.combine(now.date(), max(past), tzinfo=now.tzinfo)


def week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def tr_date(d: date, with_weekday: bool = True) -> str:
    s = f"{d.day} {AYLAR[d.month - 1]}"
    return f"{s} {GUNLER[d.weekday()]}" if with_weekday else s


def due_label(t: Task) -> str:
    if t.due_date is None or t.days_left is None:
        return "tarihsiz"
    if t.days_left < 0:
        return f"{-t.days_left} gün gecikmiş"
    if t.days_left == 0:
        return f"bugün {t.due_time.strftime('%H:%M')}" if t.due_time else "bugün"
    if t.days_left == 1:
        return "yarın"
    return f"{t.days_left} gün kaldı"


def _truncate(text: str, limit: int = MAX_BODY) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _sort_key(t: Task):
    return (
        t.due_date or date.max,
        t.due_time or time.max,
        -t.importance,
        t.title.lower(),
    )


# ---------------------------------------------------------------------------
# Özetlerin ne zaman üretileceği
# ---------------------------------------------------------------------------

def brief_due(now: datetime, s: Settings) -> bool:
    return (
        not in_quiet_hours(now, s)
        and now.time() >= s.brief_time
        and s.last_brief_date != now.date()
    )


def weekly_due(now: datetime, s: Settings) -> bool:
    return (
        now.weekday() == 0                 # Pazartesi
        and not in_quiet_hours(now, s)
        and now.time() >= s.brief_time
        and s.last_weekly_date != now.date()
    )


# ---------------------------------------------------------------------------
# Görev bildirimleri
# ---------------------------------------------------------------------------

def _last_touch(t: Task) -> datetime | None:
    """Son bildirim zamanı; hiç bildirilmediyse oluşturulma zamanı.

    Böylece yeni eklediğin bir görev için hemen bildirim gelmez (zaten
    biliyorsun); ama bir hafta önce eklenip bugün kritik hale gelen bir iş
    için ilk çalışmada bildirim gider.
    """
    return t.last_notified_at or t.created_at


def critical_candidates(tasks: list[Task], s: Settings, now: datetime) -> list[Task]:
    interval = timedelta(minutes=s.critical_interval_minutes)
    out = []
    for t in tasks:
        if t.level != "kritik":
            continue
        last = _last_touch(t)
        # Hiç bildirilmemiş ve daha önceki bir günde oluşturulmuşsa hemen bildir.
        never_notified_old = (
            t.last_notified_at is None
            and t.created_at is not None
            and t.created_at.astimezone(now.tzinfo).date() < now.date()
        )
        if last is None or never_notified_old or now - last >= interval:
            out.append(t)
    return sorted(out, key=_sort_key)


def high_candidates(tasks: list[Task], s: Settings, now: datetime) -> list[Task]:
    slot = current_slot_start(now, s.high_slots)
    if slot is None:
        return []
    out = []
    for t in tasks:
        if t.level != "yuksek":
            continue
        last = _last_touch(t)
        if last is None or last < slot:
            out.append(t)
    return sorted(out, key=_sort_key)


def _group_message(kind: str, tasks: list[Task]) -> Notification:
    emoji = LEVEL_EMOJI[kind]
    if len(tasks) == 1:
        t = tasks[0]
        title = f"{emoji} {LEVEL_NAME[kind]}: {t.title}"
        body = due_label(t).capitalize()
        if t.estimate_minutes:
            body += f" · ~{t.estimate_minutes} dk"
    else:
        title = f"{emoji} {len(tasks)} {LEVEL_NAME[kind].lower()} öncelikli iş"
        body = " • ".join(f"{t.title} ({due_label(t)})" for t in tasks)
    return Notification(
        kind=kind,
        title=_truncate(title, 90),
        body=_truncate(body),
        task_ids=[t.id for t in tasks],
        urgent=(kind == "kritik"),
    )


def plan_task_notifications(
    tasks: list[Task], s: Settings, now: datetime, sent_today: int
) -> list[Notification]:
    """Bu çalıştırmada gönderilecek görev bildirimleri (en fazla 2 adet:
    biri kritikler, biri yüksekler için gruplanmış)."""
    if in_quiet_hours(now, s):
        return []
    remaining = s.daily_cap - sent_today
    if remaining <= 0:
        return []

    out: list[Notification] = []
    crit = critical_candidates(tasks, s, now)
    if crit:
        out.append(_group_message("kritik", crit))
    high = high_candidates(tasks, s, now)
    if high:
        out.append(_group_message("yuksek", high))
    return out[:remaining]


# ---------------------------------------------------------------------------
# Yapay zeka çalışmazsa kullanılacak düz metin özetler
# ---------------------------------------------------------------------------

def fallback_daily_brief(tasks: list[Task], today: date) -> str:
    by_level: dict[str, list[Task]] = {k: [] for k in LEVEL_EMOJI}
    for t in tasks:
        by_level.setdefault(t.level, []).append(t)
    crit, high, normal = by_level["kritik"], by_level["yuksek"], by_level["normal"]

    if not (crit or high or normal):
        return f"{tr_date(today)}: Bugün için acil bir iş yok. Güzel bir gün geçir!"

    parts = []
    if crit:
        parts.append(f"{len(crit)} kritik")
    if high:
        parts.append(f"{len(high)} yüksek öncelikli")
    if normal:
        parts.append(f"{len(normal)} normal")
    lines = [f"{tr_date(today)}: Bugün {', '.join(parts)} işin var."]

    first = sorted(crit, key=_sort_key) or sorted(high, key=_sort_key)
    if first:
        lines.append(f"İlk olarak şununla başla: {first[0].title} ({due_label(first[0])}).")
    for level in ("kritik", "yuksek", "normal"):
        for t in sorted(by_level[level], key=_sort_key)[:5]:
            lines.append(f"{LEVEL_EMOJI[level]} {t.title} — {due_label(t)}")
    return "\n".join(lines)


def fallback_weekly_plan(open_tasks: list[Task], done_count: int, monday: date) -> str:
    sunday = monday + timedelta(days=6)
    overdue = [t for t in open_tasks if t.days_left is not None and t.days_left < 0]
    this_week = [t for t in open_tasks if t.due_date and monday <= t.due_date <= sunday]
    lines = [
        f"Hafta: {tr_date(monday, False)} – {tr_date(sunday, False)}",
        f"Geçen hafta {done_count} iş tamamladın. "
        f"Bu hafta {len(this_week)} planlı iş var"
        + (f", {len(overdue)} iş gecikmiş." if overdue else "."),
    ]
    for i in range(7):
        d = monday + timedelta(days=i)
        day_tasks = [t for t in this_week if t.due_date == d]
        if not day_tasks:
            continue
        minutes = sum(t.estimate_minutes or 0 for t in day_tasks)
        extra = f" (~{minutes} dk)" if minutes else ""
        names = ", ".join(t.title for t in sorted(day_tasks, key=_sort_key))
        lines.append(f"{GUNLER[d.weekday()]}{extra}: {names}")
    if overdue:
        lines.append("Önce gecikenleri kapat: " + ", ".join(t.title for t in overdue[:5]))
    return "\n".join(lines)


def first_line(text: str) -> str:
    for line in text.splitlines():
        if line.strip():
            return _truncate(line.strip())
    return ""
