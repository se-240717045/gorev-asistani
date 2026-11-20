"""
Gemini bağlantısı — yapay zekaya giden HER ŞEY bu dosyada.

Başka bir modele (Claude, OpenAI, yerel model…) geçmek istersen sadece
`_generate` fonksiyonunu değiştirmen yeterli; uygulamanın geri kalanı
etkilenmez.

Gemini çalışmazsa (limit doldu, ağ hatası, anahtar yok) fonksiyonlar None
döner ve çağıran taraf kural tabanlı düz metin özete geri düşer.
"""

from __future__ import annotations

import logging
import os
import time as _time
from datetime import date, timedelta

from rules import GUNLER, LEVEL_NAME, Task, due_label, tr_date

log = logging.getLogger("ai")

# Model adı GitHub'daki GEMINI_MODEL değişkeniyle değiştirilebilir.
# "-latest" takma adı, Google eski bir modeli emekliye ayırdığında
# uygulamanın bozulmamasını sağlar.
DEFAULT_MODEL = "gemini-flash-latest"

SYSTEM_PROMPT = (
    "Sen kullanıcının kişisel planlama asistanısın. Türkçe, samimi ama kısa "
    "yazarsın. Markdown başlığı, tablo veya kalın yazı kullanma; düz metin "
    "yaz. Emoji kullanabilirsin ama abartma. Sana verilmeyen görev uydurma."
)


def _generate(prompt: str) -> str | None:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        log.warning("GEMINI_API_KEY tanımlı değil; düz metin özete geçiliyor.")
        return None

    from google import genai
    from google.genai import errors, types

    model = os.environ.get("GEMINI_MODEL", "").strip() or DEFAULT_MODEL
    client = genai.Client(api_key=api_key)
    config = types.GenerateContentConfig(system_instruction=SYSTEM_PROMPT)

    for attempt in (1, 2):
        try:
            resp = client.models.generate_content(model=model, contents=prompt, config=config)
            text = (resp.text or "").strip()
            return text or None
        except errors.APIError as exc:   # 429 (limit), 5xx (geçici) vb.
            code = getattr(exc, "code", None)
            log.warning("Gemini hatası (deneme %s, kod %s): %s", attempt, code, exc)
            if attempt == 1 and code in (429, 500, 503):
                _time.sleep(8)
                continue
            return None
        except Exception as exc:  # ağ hatası vb.
            log.warning("Gemini'ye ulaşılamadı: %s", exc)
            return None
    return None


def _task_line(t: Task) -> str:
    parts = [f"- [{LEVEL_NAME.get(t.level, t.level)}] {t.title}", f"({due_label(t)}"]
    if t.estimate_minutes:
        parts[-1] += f", ~{t.estimate_minutes} dk"
    parts[-1] += f", {t.category}, önem {t.importance}/3)"
    return " ".join(parts)


def daily_brief(tasks: list[Task], today: date) -> str | None:
    relevant = [t for t in tasks if t.level in ("kritik", "yuksek", "normal")]
    task_text = "\n".join(_task_line(t) for t in relevant) or "(bugün için acil iş yok)"
    prompt = f"""Bugün {tr_date(today)}.
Kullanıcının açık işleri (öncelik seviyeleri kod tarafından hesaplandı, değiştirme):
{task_text}

Bir sabah brifingi yaz:
1. İlk satır: tek cümlelik özet (bildirimde bu satır görünecek, en fazla 120 karakter).
2. Ardından hangi işle başlaması gerektiğini ve nedenini 1-2 cümleyle söyle.
3. Sonra bugünün önerilen sırasını kısa maddeler halinde ("- " ile) ver.
Toplam en fazla 8 satır."""
    return _generate(prompt)


def weekly_plan(open_tasks: list[Task], done_titles: list[str], monday: date) -> str | None:
    sunday = monday + timedelta(days=6)
    task_text = "\n".join(_task_line(t) for t in open_tasks) or "(açık iş yok)"
    done_text = "\n".join(f"- {d}" for d in done_titles[:30]) or "(geçen hafta tamamlanan iş yok)"
    days = ", ".join(f"{GUNLER[i]} {(monday + timedelta(days=i)).day}" for i in range(7))
    prompt = f"""Bu hafta: {tr_date(monday, False)} – {tr_date(sunday, False)} ({days}).

Geçen 7 günde tamamlanan işler:
{done_text}

Şu an açık olan işler:
{task_text}

Haftalık plan yaz:
1. İlk satır: tek cümlelik özet (bildirimde görünecek, en fazla 120 karakter).
2. Geçen haftayı bir cümleyle değerlendir.
3. Gecikmiş işler varsa önce onları ele al.
4. Tarihsiz işleri de dikkate alarak gün gün kısa bir dağılım öner
   ("Pazartesi: …" biçiminde, sadece iş olan günler). Bir güne çok fazla iş
   yükleme; tahmini süreleri dikkate al.
Toplam en fazla 12 satır."""
    return _generate(prompt)
