"""Supabase (PostgreSQL) erişimi. Bildirim motoru veritabanına doğrudan
bağlanır; bağlantı adresi GitHub'daki DATABASE_URL gizli değişkenindedir."""

from __future__ import annotations

import os
from datetime import date, datetime

import psycopg
from psycopg.rows import dict_row

from rules import Settings, Task, parse_slots


def connect() -> psycopg.Connection:
    url = os.environ["DATABASE_URL"].strip()
    # prepare_threshold=None: Supabase bağlantı havuzuyla (pooler) uyumluluk için.
    return psycopg.connect(url, row_factory=dict_row, prepare_threshold=None, connect_timeout=20)


def user_ids(conn) -> list[str]:
    # Aboneliği olup ayarı olmayan kullanıcılar için varsayılan ayar oluştur.
    conn.execute(
        """insert into public.settings (user_id)
           select distinct user_id from public.push_subscriptions
           on conflict (user_id) do nothing"""
    )
    rows = conn.execute("select user_id from public.settings").fetchall()
    return [str(r["user_id"]) for r in rows]


def load_settings(conn, user_id: str) -> Settings:
    r = conn.execute("select * from public.settings where user_id = %s", (user_id,)).fetchone()
    return Settings(
        quiet_start=r["quiet_start"],
        quiet_end=r["quiet_end"],
        brief_time=r["brief_time"],
        high_slots=parse_slots(r["high_slots"]),
        critical_interval_minutes=r["critical_interval_minutes"],
        daily_cap=r["daily_cap"],
        last_brief_date=r["last_brief_date"],
        last_weekly_date=r["last_weekly_date"],
    )


def _to_task(r: dict) -> Task:
    return Task(
        id=str(r["id"]),
        title=r["title"],
        level=r["level"],
        importance=r["importance"],
        due_date=r["due_date"],
        due_time=r["due_time"],
        days_left=r["days_left"],
        estimate_minutes=r["estimate_minutes"],
        category=r["category"],
        created_at=r["created_at"],
        last_notified_at=r["last_notified_at"],
    )


def open_tasks(conn, user_id: str) -> list[Task]:
    rows = conn.execute(
        """select * from public.tasks_view
           where user_id = %s and status = 'acik'
           order by level_rank desc, due_date nulls last, due_time nulls last""",
        (user_id,),
    ).fetchall()
    return [_to_task(r) for r in rows]


def done_titles_since(conn, user_id: str, since: datetime) -> list[str]:
    rows = conn.execute(
        """select title from public.tasks
           where user_id = %s and status = 'tamam' and done_at >= %s
           order by done_at""",
        (user_id, since),
    ).fetchall()
    return [r["title"] for r in rows]


def sent_count_since(conn, user_id: str, since: datetime) -> int:
    r = conn.execute(
        """select count(*) as n from public.notification_log
           where user_id = %s and sent_at >= %s and kind in ('kritik', 'yuksek')""",
        (user_id, since),
    ).fetchone()
    return int(r["n"])


def subscriptions(conn, user_id: str) -> list[dict]:
    return conn.execute(
        "select id, endpoint, p256dh, auth from public.push_subscriptions where user_id = %s",
        (user_id,),
    ).fetchall()


def delete_subscription(conn, sub_id) -> None:
    conn.execute("delete from public.push_subscriptions where id = %s", (sub_id,))


def mark_notified(conn, task_ids: list[str], at: datetime) -> None:
    if task_ids:
        conn.execute(
            "update public.tasks set last_notified_at = %s where id = any(%s::uuid[])",
            (at, task_ids),
        )


def log_notification(conn, user_id: str, kind: str, title: str, body: str) -> None:
    conn.execute(
        "insert into public.notification_log (user_id, kind, title, body) values (%s, %s, %s, %s)",
        (user_id, kind, title, body),
    )


def save_summary(conn, user_id: str, kind: str, content: str) -> None:
    conn.execute(
        "insert into public.summaries (user_id, kind, content) values (%s, %s, %s)",
        (user_id, kind, content),
    )


def set_brief_date(conn, user_id: str, d: date) -> None:
    conn.execute("update public.settings set last_brief_date = %s where user_id = %s", (d, user_id))


def set_weekly_date(conn, user_id: str, d: date) -> None:
    conn.execute("update public.settings set last_weekly_date = %s where user_id = %s", (d, user_id))


def cleanup(conn) -> None:
    """Eski kayıtları temizle (ücretsiz plandaki 500 MB sınırından çok uzak
    kalmak için)."""
    conn.execute("delete from public.notification_log where sent_at < now() - interval '30 days'")
    conn.execute("delete from public.summaries where created_at < now() - interval '90 days'")
    conn.execute(
        "delete from public.tasks where status = 'tamam' and done_at < now() - interval '180 days'"
    )
