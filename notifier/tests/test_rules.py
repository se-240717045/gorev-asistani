import sys
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import rules  # noqa: E402
from rules import Settings, Task  # noqa: E402

TZ = ZoneInfo("Europe/Istanbul")


def at(y, m, d, hh, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=TZ)


MON_0810 = at(2026, 11, 23, 8, 10)   # Pazartesi
MON_1007 = at(2026, 11, 23, 10, 7)
YESTERDAY = at(2026, 11, 22, 12, 0)


def task(tid, level, **kw):
    kw.setdefault("created_at", YESTERDAY)
    return Task(id=tid, title=f"İş {tid}", level=level, **kw)


# --- sessiz saatler ---------------------------------------------------------

def test_quiet_hours_overnight():
    s = Settings()
    assert rules.in_quiet_hours(at(2026, 11, 23, 23, 0), s)
    assert rules.in_quiet_hours(at(2026, 11, 23, 7, 59), s)
    assert not rules.in_quiet_hours(at(2026, 11, 23, 8, 0), s)
    assert not rules.in_quiet_hours(at(2026, 11, 23, 21, 59), s)


def test_quiet_hours_same_day_and_disabled():
    s = Settings(quiet_start=time(13), quiet_end=time(15))
    assert rules.in_quiet_hours(at(2026, 11, 23, 14), s)
    assert not rules.in_quiet_hours(at(2026, 11, 23, 15), s)
    s2 = Settings(quiet_start=time(0), quiet_end=time(0))
    assert not rules.in_quiet_hours(at(2026, 11, 23, 3), s2)


def test_nothing_sent_in_quiet_hours():
    s = Settings()
    tasks = [task("1", "kritik")]
    assert rules.plan_task_notifications(tasks, s, at(2026, 11, 23, 23, 30), 0) == []


# --- kritik -----------------------------------------------------------------

def test_critical_old_task_notified_immediately():
    s = Settings()
    out = rules.plan_task_notifications([task("1", "kritik")], s, MON_1007, 0)
    assert [n.kind for n in out] == ["kritik"]
    assert out[0].task_ids == ["1"]
    assert out[0].urgent


def test_critical_new_task_waits_interval():
    s = Settings(critical_interval_minutes=150)
    created = MON_1007 - timedelta(minutes=30)
    t = task("1", "kritik", created_at=created)
    assert rules.plan_task_notifications([t], s, MON_1007, 0) == []
    later = created + timedelta(minutes=150)
    assert len(rules.plan_task_notifications([t], s, later, 0)) == 1


def test_critical_repeats_after_interval():
    s = Settings(critical_interval_minutes=150)
    t = task("1", "kritik", last_notified_at=MON_1007 - timedelta(minutes=149))
    assert rules.plan_task_notifications([t], s, MON_1007, 0) == []
    t.last_notified_at = MON_1007 - timedelta(minutes=150)
    assert len(rules.plan_task_notifications([t], s, MON_1007, 0)) == 1


def test_multiple_criticals_grouped_into_one():
    s = Settings()
    out = rules.plan_task_notifications(
        [task("1", "kritik"), task("2", "kritik"), task("3", "normal")], s, MON_1007, 0
    )
    assert len(out) == 1
    assert "2 kritik" in out[0].title
    assert set(out[0].task_ids) == {"1", "2"}


# --- yüksek -----------------------------------------------------------------

def test_high_only_after_slot_and_once_per_slot():
    s = Settings(high_slots=[time(9), time(15)])
    t = task("1", "yuksek")
    # 08:30: henüz ilk hatırlatma saati gelmedi
    assert rules.plan_task_notifications([t], s, at(2026, 11, 23, 8, 30), 0) == []
    # 09:07: gönder
    out = rules.plan_task_notifications([t], s, at(2026, 11, 23, 9, 7), 0)
    assert [n.kind for n in out] == ["yuksek"]
    # 09:07'de bildirildi → 12:00'de tekrar yok
    t.last_notified_at = at(2026, 11, 23, 9, 7)
    assert rules.plan_task_notifications([t], s, at(2026, 11, 23, 12), 0) == []
    # 15:07: ikinci hatırlatma
    assert len(rules.plan_task_notifications([t], s, at(2026, 11, 23, 15, 7), 0)) == 1


def test_high_created_after_slot_waits_for_next_slot():
    s = Settings(high_slots=[time(9), time(15)])
    t = task("1", "yuksek", created_at=at(2026, 11, 23, 10, 0))
    assert rules.plan_task_notifications([t], s, at(2026, 11, 23, 11, 7), 0) == []
    assert len(rules.plan_task_notifications([t], s, at(2026, 11, 23, 15, 7), 0)) == 1


def test_normal_and_low_never_individually_notified():
    s = Settings()
    tasks = [task("1", "normal"), task("2", "dusuk")]
    assert rules.plan_task_notifications(tasks, s, at(2026, 11, 23, 15, 7), 0) == []


# --- günlük üst sınır ----------------------------------------------------------

def test_daily_cap():
    s = Settings(daily_cap=3)
    tasks = [task("1", "kritik"), task("2", "yuksek")]
    now = at(2026, 11, 23, 9, 7)
    assert len(rules.plan_task_notifications(tasks, s, now, 1)) == 2
    assert len(rules.plan_task_notifications(tasks, s, now, 2)) == 1
    assert rules.plan_task_notifications(tasks, s, now, 3) == []


# --- özet zamanlaması --------------------------------------------------------

def test_brief_due_once_per_day():
    s = Settings()
    assert not rules.brief_due(at(2026, 11, 23, 7, 50), s)
    assert rules.brief_due(MON_0810, s)
    s.last_brief_date = date(2026, 11, 23)
    assert not rules.brief_due(at(2026, 11, 23, 12), s)


def test_weekly_only_on_monday():
    s = Settings()
    assert rules.weekly_due(MON_0810, s)
    assert not rules.weekly_due(at(2026, 11, 24, 8, 10), s)
    s.last_weekly_date = date(2026, 11, 23)
    assert not rules.weekly_due(at(2026, 11, 23, 9), s)


# --- yardımcılar ---------------------------------------------------------------

def test_parse_slots():
    assert rules.parse_slots("15:00, 09:00,bozuk,") == [time(9), time(15)]
    assert rules.parse_slots("") == []


def test_due_label():
    assert rules.due_label(task("1", "kritik", due_date=date(2026, 11, 21), days_left=-2)) == "2 gün gecikmiş"
    assert rules.due_label(task("1", "kritik", due_date=date(2026, 11, 23), days_left=0, due_time=time(14))) == "bugün 14:00"
    assert rules.due_label(task("1", "yuksek", due_date=date(2026, 11, 24), days_left=1)) == "yarın"
    assert rules.due_label(task("1", "dusuk")) == "tarihsiz"


def test_fallback_texts():
    tasks = [
        task("1", "kritik", due_date=date(2026, 11, 22), days_left=-1),
        task("2", "normal", due_date=date(2026, 11, 26), days_left=3, estimate_minutes=45),
    ]
    brief = rules.fallback_daily_brief(tasks, date(2026, 11, 23))
    assert "1 kritik" in brief and "İş 1" in brief
    weekly = rules.fallback_weekly_plan(tasks, 4, date(2026, 11, 23))
    assert "4 iş tamamladın" in weekly and "Perşembe (~45 dk)" in weekly
    assert rules.first_line(brief).startswith("23 Kasım Pazartesi")


def test_long_body_truncated():
    s = Settings()
    tasks = [Task(id=str(i), title="Çok uzun bir görev adı " * 3, level="kritik", created_at=YESTERDAY) for i in range(10)]
    out = rules.plan_task_notifications(tasks, s, MON_1007, 0)
    assert len(out[0].body) <= rules.MAX_BODY
