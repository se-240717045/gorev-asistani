"""
Bildirim motoru — GitHub Actions tarafından ~15 dakikada bir çalıştırılır.

Her çalıştırmada, her kullanıcı için:
  1. Pazartesi sabahıysa haftalık planı üret (Gemini) ve gönder
  2. Sabah brifingi zamanı geldiyse günlük özeti üret ve gönder
  3. Değilse kritik / yüksek öncelikli işler için hatırlatma gönder

Yerelde deneme:
  python notifier/run.py --dry-run
  python notifier/run.py --dry-run --now "2026-11-23 08:10"
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

import ai
import db
import push
import rules
from rules import Notification

TZ = ZoneInfo("Europe/Istanbul")
log = logging.getLogger("run")


def build_notifications(conn, uid: str, now: datetime) -> list[Notification]:
    s = db.load_settings(conn, uid)
    tasks = db.open_tasks(conn, uid)
    notes: list[Notification] = []
    covered_by_summary = False

    if rules.weekly_due(now, s):
        monday = now.date()
        done = db.done_titles_since(conn, uid, now - timedelta(days=7))
        text = ai.weekly_plan(tasks, done, monday) or rules.fallback_weekly_plan(
            tasks, len(done), monday
        )
        db.save_summary(conn, uid, "haftalik", text)
        db.set_weekly_date(conn, uid, monday)
        notes.append(Notification("haftalik", "🗓️ Haftalık planın hazır", rules.first_line(text)))
        covered_by_summary = True
        log.info("Haftalık plan üretildi.")

    if rules.brief_due(now, s):
        text = ai.daily_brief(tasks, now.date()) or rules.fallback_daily_brief(tasks, now.date())
        db.save_summary(conn, uid, "gunluk", text)
        db.set_brief_date(conn, uid, now.date())
        if not covered_by_summary:   # Pazartesi iki bildirim yerine tek bildirim
            notes.append(Notification("gunluk", "☀️ Günaydın", rules.first_line(text)))
        covered_by_summary = True
        log.info("Sabah brifingi üretildi.")

    if covered_by_summary:
        # Özet kritik işleri zaten anlatıyor; aynı anda ayrıca hatırlatma atma.
        crit = [t.id for t in tasks if t.level == "kritik"]
        db.mark_notified(conn, crit, now)
    else:
        day_start = datetime.combine(now.date(), time(0), tzinfo=TZ)
        sent_today = db.sent_count_since(conn, uid, day_start)
        notes += rules.plan_task_notifications(tasks, s, now, sent_today)

    return notes


def deliver(conn, uid: str, notes: list[Notification], now: datetime, dry_run: bool) -> None:
    subs = db.subscriptions(conn, uid)
    for n in notes:
        if dry_run:
            print(f"[DENEME] {n.kind}: {n.title}\n          {n.body}")
            continue
        if not subs:
            log.info("Kayıtlı cihaz yok; bildirim atlanıyor: %s", n.title)
            continue
        payload = {
            "title": n.title,
            "body": n.body,
            "tag": n.kind,
            "url": "./?sekme=hafta" if n.kind == "haftalik" else "./?sekme=bugun",
        }
        delivered = False
        for sub in subs:
            result = push.send(sub["endpoint"], sub["p256dh"], sub["auth"], payload, n.urgent)
            if result == push.OK:
                delivered = True
            elif result == push.GONE:
                db.delete_subscription(conn, sub["id"])
        if delivered:
            db.log_notification(conn, uid, n.kind, n.title, n.body)
            db.mark_notified(conn, n.task_ids, now)
            log.info("Gönderildi: %s", n.title)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="gönderme, sadece yazdır; veritabanını değiştirme")
    parser.add_argument("--now", help='test için zaman, örn. "2026-11-23 08:10"')
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    now = (
        datetime.fromisoformat(args.now).replace(tzinfo=TZ)
        if args.now
        else datetime.now(TZ).replace(microsecond=0)
    )
    log.info("Çalışma zamanı: %s", now.isoformat())

    failures = 0
    with db.connect() as conn:
        for uid in db.user_ids(conn):
            try:
                notes = build_notifications(conn, uid, now)
                deliver(conn, uid, notes, now, args.dry_run)
                if args.dry_run:
                    conn.rollback()
                else:
                    conn.commit()
            except Exception:
                conn.rollback()
                failures += 1
                log.exception("Kullanıcı işlenirken hata: %s", uid)
        if not args.dry_run:
            db.cleanup(conn)
            conn.commit()
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
