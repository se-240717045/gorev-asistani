# Görev Asistanı

Kişisel görev takibi ve haftalık planlama uygulaması. iPhone'a ana ekran uygulaması (PWA) olarak kurulur, işleri aciliyete göre sıralar, push bildirimi gönderir. Gemini ile doğal dilden görev ekler, sabah brifingi ve haftalık plan hazırlar.

- **Arayüz:** Sade HTML/CSS/JS (`docs/`) → GitHub Pages
- **Veri:** Supabase (PostgreSQL + giriş + Edge Function)
- **Bildirim motoru:** Python (`notifier/`) → GitHub Actions, 15 dakikada bir
- **Yapay zeka:** Gemini API (ücretsiz katman), `notifier/ai.py` ve `supabase/functions/gorev-ayristir` içinde izole

Tamamen ücretsiz altyapıda, sunucusuz çalışır.

👉 **Kurulum için: [KURULUM.md](KURULUM.md)**
