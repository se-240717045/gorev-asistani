# Görev Asistanı — Kurulum Rehberi

Bu rehberi baştan sona bir kez uyguladığında, iPhone'unda ana ekrandan açılan, aciliyete göre bildirim gönderen ve sabahları yapay zekayla brifing hazırlayan kişisel görev uygulaman çalışır hale gelir. Toplam süre yaklaşık **45–60 dakika**. Maliyeti **0 TL**.

---

## Nasıl çalışıyor?

```
iPhone (ana ekrana eklenmiş uygulama)
   │
   ├─► GitHub Pages ─── arayüz (docs/ klasörü)
   │
   └─► Supabase ─────── veritabanı + giriş + "gorev-ayristir" fonksiyonu (Gemini)
            ▲
            │  her 15 dakikada bir
   GitHub Actions ───── notifier/run.py (Python)
                         aciliyet kontrolü → Gemini özetleri → push bildirimi
```

| Parça | Ne yapar | Nerede |
|---|---|---|
| `docs/` | Arayüz: Bugün, Hafta, Ekle, Ayarlar | GitHub Pages |
| `supabase/schema.sql` | Tablolar, güvenlik kuralları, öncelik hesabı | Supabase |
| `supabase/functions/gorev-ayristir` | Doğal dildeki görevi forma çevirir (Gemini) | Supabase Edge Functions |
| `notifier/` | Bildirim kuralları, sabah brifingi, haftalık plan | GitHub Actions |
| `tools/vapid_olustur.py` | Push bildirim anahtarlarını üretir | Senin bilgisayarın (bir kez) |

---

## 0. Gerekenler

- Bir **GitHub** hesabı (github.com)
- Bir **Supabase** hesabı (supabase.com; GitHub ile giriş yapabilirsin)
- Bir **Google** hesabı (Gemini API anahtarı için)
- Bilgisayarında **Python 3** (sadece 4. adımda bir kez kullanılacak)
- iOS **16.4 veya üstü** olan iPhone

Aşağıdaki adımlarda bazı değerleri bir yere not etmen gerekecek. Bir not dosyası aç. 📝 işaretli değerler ileride lazım olacak.

---

## 1. Supabase projesini kur

1. supabase.com → **New project**.
   - **Name:** `gorev-asistani`
   - **Database Password:** güçlü bir şifre belirle → 📝 **VERİTABANI ŞİFRESİ**
   - **Region:** `Central EU (Frankfurt)`. Türkiye'ye en yakın bölge bu.
   - Plan: **Free**
2. Proje hazır olunca soldan **SQL Editor** → **New query**. `supabase/schema.sql` dosyasının **tamamını** yapıştır ve **Run**'a bas. "Success" görmelisin.
3. **Kendi kullanıcını oluştur:** Soldan **Authentication** → **Users** → **Add user** → **Create new user**.
   - E-posta ve şifreni yaz. Bunlarla uygulamaya giriş yapacaksın.
   - **Auto Confirm User** seçeneğini işaretle.
4. **Yeni kayıtları kapat (önemli):** **Authentication** → **Sign In / Providers** (ya da **Settings**) bölümünde **"Allow new users to sign up"** seçeneğini **kapat** ve kaydet.
   > Uygulamanın adresi herkese açık olacak. Kayıt açık kalırsa başkası hesap açıp senin Gemini kotanı kullanabilir.
5. **Bağlantı bilgilerini al:**
   - **Project Settings → API** (ya da **Data API / API Keys**):
     - **Project URL** → 📝 **SUPABASE_URL** (örn. `https://abcdxyz.supabase.co`)
     - **anon public** ya da **publishable** anahtar → 📝 **SUPABASE_ANON_KEY**
   - Üstteki **Connect** düğmesi → **Connection string** → **Session pooler** bölümündeki URI'yi kopyala. Şuna benzer:
     ```
     postgresql://postgres.abcdxyz:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:5432/postgres
     ```
     `[YOUR-PASSWORD]` kısmını veritabanı şifrenle değiştir (köşeli parantezler dahil) → 📝 **DATABASE_URL**
     > ⚠️ **Direct connection** değil, **Session pooler** adresini kullan. GitHub'ın sunucuları doğrudan bağlantıya ulaşamaz.
     > Şifrende `@`, `#`, `/`, `:` gibi karakterler varsa bağlantı bozulur. Ya şifreyi sadece harf ve rakamdan oluşacak şekilde değiştir (Project Settings → Database → Reset password) ya da bu karakterleri URL kodlamasıyla yaz (`@` → `%40`, `#` → `%23`).

---

## 2. Gemini API anahtarını al

1. **aistudio.google.com** → Google hesabınla giriş yap.
2. **Get API key** → **Create API key** → 📝 **GEMINI_API_KEY**

Ücretsiz katmandasın; kredi kartı gerekmiyor. Güncel limitleri AI Studio'daki **Rate limits** sayfasında görebilirsin.

> ℹ️ Ücretsiz katmanda Google, gönderilen içeriği ürünlerini geliştirmek için kullanabilir. Görev başlıklarına çok hassas bilgi yazmamaya dikkat et.

---

## 3. Görev ayrıştırma fonksiyonunu yükle

Bu fonksiyon "Cuma'ya kadar teklif dosyasını bitir, önemli" gibi bir cümleyi forma çevirir.

**Tarayıcıdan (en kolay yol):**

1. Supabase'de soldan **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Fonksiyon adı tam olarak: `gorev-ayristir`
3. Editördeki örnek kodu sil. `supabase/functions/gorev-ayristir/index.ts` dosyasının tamamını yapıştır → **Deploy function**.
4. **Edge Functions** → **Secrets** (ya da **Manage secrets**) → **Add new secret**:
   - Name: `GEMINI_API_KEY`, Value: Gemini anahtarın → **Save**
5. Fonksiyon ayarlarında **"Verify JWT"** (ya da **Enforce JWT verification**) **açık** kalmalı. Varsayılan olarak açıktır. Böylece fonksiyonu sadece giriş yapmış olan sen çağırabilirsin.

<details>
<summary>Alternatif: Supabase CLI ile</summary>

```bash
npx supabase login
npx supabase link --project-ref PROJE-KODUN
npx supabase secrets set GEMINI_API_KEY=anahtarın
npx supabase functions deploy gorev-ayristir
```
</details>

---

## 4. Push bildirim anahtarlarını üret

Bilgisayarında, proje klasörünün içinde bir terminal aç:

```bash
pip install cryptography
python tools/vapid_olustur.py
```

Windows'ta `python` yerine `py` yazman gerekebilir. Çıktıda iki anahtar göreceksin:

- **GENEL anahtar** → 📝 **VAPID_PUBLIC_KEY** (arayüze yazılacak, gizli değil)
- **ÖZEL anahtar** → 📝 **VAPID_PRIVATE_KEY** (sadece GitHub'ın gizli kasasına girecek)

> Bu anahtarları bir kez üret. Sonradan değiştirirsen iPhone'daki bildirim kaydını Ayarlar'dan yeniden açman gerekir.

---

## 5. Arayüz ayarlarını doldur

`docs/config.js` dosyasını bir metin düzenleyiciyle aç ve üç değeri doldur:

```js
export const SUPABASE_URL = "https://abcdxyz.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOi...";        // ya da sb_publishable_...
export const VAPID_PUBLIC_KEY = "BNc4...";
```

Bu üç değer herkese açık olacak şekilde tasarlanmıştır. Verilerini satır düzeyi güvenlik (RLS) kuralları korur. **Gizli anahtarları (Gemini, VAPID özel anahtarı, DATABASE_URL) asla bu dosyaya yazma.**

---

## 6. GitHub'a yükle ve yayına al

1. github.com → **New repository**
   - Ad: `gorev-asistani`
   - **Public** seç. GitHub Pages ücretsiz planda sadece herkese açık depolarda çalışır, GitHub Actions da herkese açık depolarda sınırsız ücretsiz. Koddaki hiçbir şey gizli değil, gizli anahtarlar ayrı bir kasada duracak.
   - Başka bir şey ekleme (README, .gitignore yok) → **Create repository**
2. Dosyaları yükle. **GitHub Desktop** en kolay yol (desktop.github.com):
   - File → Add local repository → proje klasörünü seç → "create a repository" de
   - **Publish repository** → depo adını aynı yaz, "Keep this code private" işaretini **kaldır**
   
   Ya da terminalden:
   ```bash
   cd gorev-asistani
   git init && git add . && git commit -m "İlk sürüm"
   git branch -M main
   git remote add origin https://github.com/KULLANICI-ADIN/gorev-asistani.git
   git push -u origin main
   ```
   > ⚠️ Web arayüzündeki "Upload files" ile yüklersen gizli `.github` klasörü (bildirim motorunun zamanlayıcısı) eksik kalabilir. Yükledikten sonra depoda `.github/workflows/bildirim.yml` dosyasının olduğunu kontrol et.
3. **GitHub Pages'i aç:** Depoda **Settings** → **Pages** →
   - Source: **Deploy from a branch**
   - Branch: **main**, klasör: **/docs** → **Save**
   - 1–2 dakika sonra adresin görünür: `https://KULLANICI-ADIN.github.io/gorev-asistani/` → 📝 **UYGULAMA ADRESİ**
4. **Gizli değişkenleri ekle:** **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Şu dördünü tek tek ekle:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | 1. adımdaki Session pooler adresi (şifre yerleştirilmiş hali) |
   | `GEMINI_API_KEY` | Gemini anahtarın |
   | `VAPID_PRIVATE_KEY` | 4. adımdaki ÖZEL anahtar |
   | `VAPID_SUBJECT` | `mailto:senin@epostan.com` (gerçek e-postan; Apple bunu zorunlu tutuyor) |

5. **Bildirim motorunu test et:** Depoda **Actions** sekmesi. Bir uyarı çıkarsa **"I understand my workflows, go ahead and enable them"** de. Ardından **Bildirim motoru** → **Run workflow** → **Run workflow**. 30–60 saniye içinde yeşil ✓ görmelisin. Kırmızı ✗ çıkarsa işe tıklayıp logu oku (aşağıdaki Sorun giderme bölümüne bak).

---

## 7. iPhone'a kur

1. **Safari**'de uygulama adresini aç (Chrome değil, mutlaka Safari).
2. Alttaki **Paylaş** düğmesi (□↑) → **Ana Ekrana Ekle** → **Ekle**.
3. Uygulamayı **ana ekrandaki simgeden** aç ve 1. adımda oluşturduğun e-posta ve şifreyle giriş yap.
4. **Ayarlar** sekmesi → **Bu cihazda bildirimleri aç** → iOS izin sorduğunda **İzin Ver**.
5. **Bu cihazda test bildirimi göster** düğmesine bas. Bildirim geliyorsa kurulum tamam. 🎉

### Uçtan uca deneme
1. **Ekle** sekmesinde şunu yaz: *"Dün bitirmem gereken raporu gönder, önemli"* → **Yapay zekayla doldur** → **Kaydet**.
   Bu iş gecikmiş ve önemli olduğu için 🔴 **kritik** olur.
2. GitHub → Actions → **Bildirim motoru** → **Run workflow**.
   Yeni eklenen işler ilk 2,5 saat bildirim üretmez (zaten biliyorsun). Hemen denemek istersen Supabase → Table Editor → `tasks` tablosunda bu görevin `created_at` değerini dünün tarihine çek.
3. Bir dakika içinde iPhone'una "🔴 Kritik: …" bildirimi gelmeli.

---

## Bildirim kuralları

| Seviye | Ne zaman olur | Bildirim |
|---|---|---|
| 🔴 Kritik | Gecikmiş ve önem ≥ normal, ya da bugün ve önem = yüksek | Kritik olduğu ilk kontrolde, sonra iş bitene kadar her 150 dakikada bir |
| 🟠 Yüksek | Bugün ya da gecikmiş (diğerleri), ya da 1–2 gün kaldı | Günde iki kez (09:00 ve 15:00 sonrası ilk kontrolde) |
| 🟡 Normal | 3–7 gün kaldı, ya da tarihsiz ama önemli | Sadece sabah brifinginde |
| ⚪ Düşük | 7 günden fazla, ya da tarihsiz | Sadece haftalık planda |

- **Sabah brifingi:** Her gün 08:00'den sonraki ilk kontrolde Gemini bir özet yazar. Bildirim olarak gelir, Bugün ekranının üstünde de görünür.
- **Haftalık plan:** Pazartesi sabahı brifingle birlikte gelir. Hafta ekranında görünür.
- **Sessiz saatler** (varsayılan 22:00–08:00) boyunca hiçbir bildirim gönderilmez.
- **Günlük sınır** (varsayılan 12) sadece kritik ve yüksek hatırlatmaları sayar.
- Birden fazla iş aynı anda bildirilecekse tek bir bildirimde gruplanır.
- Tüm saatler ve aralıklar uygulamanın **Ayarlar** sekmesinden değiştirilebilir.
- GitHub zamanlayıcısı yoğun saatlerde birkaç dakika gecikebilir. Bildirimler "dakikası dakikasına" değil, "en geç birkaç dakika içinde" gelir.

Seviye hesabı `supabase/schema.sql` içindeki `tasks_view` görünümünde, bildirim kuralları `notifier/rules.py` dosyasında. İkisi de bol açıklamalı; değiştirmek istersen oradan başla.

---

## Sorun giderme

| Belirti | Olası neden ve çözüm |
|---|---|
| Sayfada "Kurulum tamamlanmamış" yazıyor | `docs/config.js` doldurulmamış ya da GitHub'a gönderilmemiş. |
| Giriş başarısız | Kullanıcıyı Supabase'de **Auto Confirm** ile oluşturduğundan emin ol. |
| "Veriler yüklenemedi" | `schema.sql` çalıştırılmamış ya da yarıda kalmış. SQL Editor'de tekrar çalıştır (birden fazla çalıştırmak güvenli). |
| "Yapay zekaya ulaşılamadı" | Edge Function adı tam `gorev-ayristir` olmalı ve `GEMINI_API_KEY` secret'ı eklenmiş olmalı. Supabase → Edge Functions → gorev-ayristir → **Logs**'a bak. Bu arada formu elle doldurmaya devam edebilirsin. |
| iPhone'da "Bildirimleri aç" düğmesi yok | Uygulamayı Safari'den değil, **ana ekrandaki simgeden** açmalısın. iOS 16.4+ gerekir. |
| Test bildirimi geliyor ama hatırlatmalar gelmiyor | GitHub → Actions → son çalışmanın loguna bak. "Kayıtlı cihaz yok" yazıyorsa Ayarlar'dan bildirimleri tekrar aç. Odak modu (Rahatsız Etme) açık olabilir. |
| Actions logunda `connection` hatası | `DATABASE_URL` yanlış: **Session pooler** adresini kullandığından ve şifreyi doğru yerleştirdiğinden emin ol. |
| Actions logunda `403` / `VAPID` hatası | `VAPID_PRIVATE_KEY` ile `config.js`'teki genel anahtar aynı çiftten değil. Anahtarları yeniden üret, ikisini de güncelle, iPhone'da bildirimleri yeniden aç. |
| Logda "Gemini hatası (kod 429)" | Ücretsiz limit doldu. Uygulama otomatik olarak düz metin özete geçer, bir şey yapman gerekmez. |
| Logda "Gemini hatası (kod 404)" | Model adı değişmiş olabilir. GitHub → Settings → Secrets and variables → Actions → **Variables** → `GEMINI_MODEL` değişkeni ekle (örn. `gemini-flash-latest` ya da AI Studio'da gördüğün güncel bir Flash modeli). Ayrıştırma fonksiyonu için Supabase'de `GEMINI_PARSE_MODEL` secret'ı aynı işi görür. |
| Arayüz güncellemesi telefonda görünmüyor | `docs/sw.js` içindeki `SURUM` değerini artır (örn. `gorev-v2`), gönder. Uygulamayı kapatıp tekrar aç. |

---

## Ücretsiz katmanların sınırları (neden sorun olmaz)

- **Supabase:** Ücretsiz projeler bir hafta boyunca etkinlik görmezse duraklatılır. Bildirim motoru veritabanını her 15 dakikada okuduğu için bu yaşanmaz.
- **GitHub Actions:** Herkese açık depolarda dakika sınırı yok. 60 gün boyunca hiç commit olmayan depolarda zamanlanmış işler durur. `canli-tut.yml` her ayın 1'inde küçük bir commit atarak bunu engeller.
- **Gemini:** Günde kabaca 1 sabah brifingi, haftada 1 plan ve eklediğin görev sayısı kadar ayrıştırma isteği gider. Bu, ücretsiz limitin çok altında.
- Biten görevler 180 gün, bildirim kayıtları 30 gün, özetler 90 gün sonra otomatik silinir.

---

## Yerelde geliştirme (isteğe bağlı)

```bash
# Arayüz: docs/ klasörünü yerel sunucuyla aç
python -m http.server 8000 -d docs     # → http://localhost:8000

# Bildirim motoru: hiçbir şey göndermeden ne olacağını gör
pip install -r notifier/requirements.txt
export DATABASE_URL="postgresql://..."  GEMINI_API_KEY="..."  VAPID_PRIVATE_KEY="..."
cd notifier
python run.py --dry-run
python run.py --dry-run --now "2026-11-23 08:10"   # Pazartesi sabahını taklit et

# Kural testleri
pip install pytest && python -m pytest tests -q
```

## Sürüm 2 için fikirler
Tekrarlayan görevler, alt görevler, haftalık istatistik grafikleri, sesli ekleme. Hepsi mevcut yapıya eklenebilir.
