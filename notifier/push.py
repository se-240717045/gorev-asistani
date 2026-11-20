"""Web Push gönderimi (iPhone'da ana ekrana eklenmiş PWA'ya bildirim)."""

from __future__ import annotations

import json
import logging
import os

from pywebpush import WebPushException, webpush

log = logging.getLogger("push")

OK, GONE, ERROR = "ok", "gone", "error"


def send(endpoint: str, p256dh: str, auth: str, payload: dict, urgent: bool = False) -> str:
    """Tek bir cihaza bildirim gönderir.

    Döner: "ok" | "gone" (abonelik artık geçersiz, silinmeli) | "error"
    """
    private_key = os.environ["VAPID_PRIVATE_KEY"].strip()
    subject = os.environ.get("VAPID_SUBJECT", "").strip() or "mailto:admin@example.com"

    try:
        webpush(
            subscription_info={"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}},
            data=json.dumps(payload, ensure_ascii=False),
            vapid_private_key=private_key,
            # pywebpush bu sözlüğü değiştiriyor; her seferinde yenisini ver.
            vapid_claims={"sub": subject},
            ttl=6 * 3600,
            headers={"Urgency": "high" if urgent else "normal"},
            timeout=15,
        )
        return OK
    except WebPushException as exc:
        status = getattr(exc.response, "status_code", None)
        if status in (404, 410):
            log.info("Abonelik geçersiz (%s), silinecek: %s…", status, endpoint[:60])
            return GONE
        log.warning("Push hatası (%s): %s", status, exc)
        return ERROR
    except Exception as exc:
        log.warning("Push gönderilemedi: %s", exc)
        return ERROR
