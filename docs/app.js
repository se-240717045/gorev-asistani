// =====================================================================
// Görev Asistanı — arayüz
// Veriler doğrudan Supabase'e yazılır/okunur (satır düzeyi güvenlik sayesinde
// herkes sadece kendi verisini görür). Öncelik seviyesi veritabanındaki
// tasks_view görünümünde hesaplanır; burada tekrar hesaplanmaz.
// =====================================================================

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY, VAPID_PUBLIC_KEY } from "./config.js";

const TZ = "Europe/Istanbul";
const GUNLER = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"];
const AYLAR = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
const SEVIYE = {
  kritik: { ad: "Kritik", renk: "var(--kritik)" },
  yuksek: { ad: "Yüksek", renk: "var(--yuksek)" },
  normal: { ad: "Normal", renk: "var(--normal)" },
  dusuk: { ad: "Düşük", renk: "var(--dusuk)" },
};
const GUNLUK_KAPASITE_DK = 360; // hafta görünümündeki doluluk çubuğu için

const $ = (sel) => document.querySelector(sel);
const durum = { sekme: "bugun", haftaKaydir: 0, kullanici: null };
let sb = null;

// ---------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------

/** Güvenli DOM üretici: kullanıcı verisi her zaman textContent ile girer. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const bugunISO = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
function gunEkle(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const haftaGunu = (iso) => (new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7; // 0 = Pazartesi
const haftaBasi = (iso) => gunEkle(iso, -haftaGunu(iso));
function trTarih(iso, gunlu = false) {
  const [, m, d] = iso.split("-").map(Number);
  const s = `${d} ${AYLAR[m - 1]}`;
  return gunlu ? `${s} ${GUNLER[haftaGunu(iso)]}` : s;
}
const isoTR = (tarihZaman) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(tarihZaman));
const gunBaslangici = (iso) => `${iso}T00:00:00+03:00`; // Türkiye 2016'dan beri sabit UTC+3

function sureYazi(dk) {
  if (!dk) return "";
  if (dk < 60) return `${dk} dk`;
  const s = Math.floor(dk / 60), k = dk % 60;
  return k ? `${s} sa ${k} dk` : `${s} sa`;
}

function tarihEtiketi(g) {
  if (!g.due_date) return { yazi: "Tarihsiz", gecikmis: false };
  const saat = g.due_time ? " " + g.due_time.slice(0, 5) : "";
  const dl = g.days_left;
  if (dl < 0) return { yazi: `${-dl} gün gecikmiş`, gecikmis: true };
  if (dl === 0) return { yazi: "Bugün" + saat, gecikmis: false };
  if (dl === 1) return { yazi: "Yarın" + saat, gecikmis: false };
  if (dl < 7) return { yazi: GUNLER[haftaGunu(g.due_date)] + saat, gecikmis: false };
  return { yazi: trTarih(g.due_date) + saat, gecikmis: false };
}

let toastZamanlayici;
function toast(mesaj) {
  const el = $("#bildirim-cubugu");
  el.textContent = mesaj;
  el.hidden = false;
  clearTimeout(toastZamanlayici);
  toastZamanlayici = setTimeout(() => (el.hidden = true), 2600);
}

function hataGoster(err, varsayilan = "Bir hata oluştu") {
  console.error(err);
  toast(`${varsayilan}${err?.message ? ": " + err.message : ""}`);
}

const ekranlar = ["#yukleniyor", "#kurulum-eksik", "#giris", "#uygulama"];
function ekranGoster(sec) {
  for (const e of ekranlar) $(e).hidden = e !== sec;
}

// ---------------------------------------------------------------------
// Görev satırı
// ---------------------------------------------------------------------

function gorevSatiri(g, { bitti = false, yarinaAt = true } = {}) {
  const etiket = tarihEtiketi(g);
  const meta = h("div", { class: "gorev-meta" },
    bitti ? null : h("span", { class: etiket.gecikmis ? "gecikmis" : "" }, etiket.yazi),
    g.estimate_minutes ? h("span", {}, "⏱ " + sureYazi(g.estimate_minutes)) : null,
    h("span", {}, g.category === "iş" ? "💼 İş" : "🏠 Kişisel"),
    g.importance === 3 ? h("span", {}, "★ Önemli") : null,
  );

  const satir = h("div", { class: "gorev" + (bitti ? " bitti" : ""), "data-level": bitti ? "tamam" : g.level },
    h("button", {
      class: "tik",
      "aria-label": bitti ? "Tamamlanmadı olarak işaretle" : "Tamamlandı olarak işaretle",
      onclick: () => tamamla(g, !bitti),
    }, "✓"),
    h("div", { class: "gorev-govde", onclick: () => duzenle(g), role: "button", tabindex: "0" },
      h("div", { class: "gorev-baslik" }, g.title),
      meta,
    ),
    !bitti && yarinaAt && (g.days_left === null || g.days_left <= 0)
      ? h("button", { class: "kucuk-btn", onclick: () => yarinaErtele(g) }, "Yarına")
      : h("span"),
  );
  return satir;
}

function ozetKarti(etiket, icerik) {
  return h("div", { class: "kart ozet" }, h("div", { class: "etiket" }, etiket), h("div", {}, icerik));
}

// ---------------------------------------------------------------------
// BUGÜN
// ---------------------------------------------------------------------

async function bugunuYukle() {
  const bugun = bugunISO();
  $("#alt-baslik").textContent = trTarih(bugun, true);

  const [acik, biten, ozet] = await Promise.all([
    sb.from("tasks_view").select("*").eq("status", "acik")
      .order("level_rank", { ascending: false })
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("due_time", { ascending: true, nullsFirst: false })
      .order("importance", { ascending: false }),
    sb.from("tasks_view").select("*").eq("status", "tamam")
      .gte("done_at", gunBaslangici(bugun)).order("done_at", { ascending: false }),
    sb.from("summaries").select("content, created_at").eq("kind", "gunluk")
      .order("created_at", { ascending: false }).limit(1),
  ]);
  for (const r of [acik, biten, ozet]) if (r.error) throw r.error;

  // Sabah brifingi (bugün üretildiyse)
  const ozetKutu = $("#bugun-ozet");
  ozetKutu.replaceChildren();
  const son = ozet.data[0];
  if (son && isoTR(son.created_at) === bugun) ozetKutu.append(ozetKarti("☀️ Sabah brifingi", son.content));

  // Seviyelere göre gruplar
  const liste = $("#bugun-liste");
  liste.replaceChildren();
  if (!acik.data.length) {
    liste.append(h("div", { class: "bos" }, h("span", { class: "buyuk" }, "🎉"), "Açık işin yok. ", h("br"), "Yeni bir iş eklemek için ＋ sekmesine dokun."));
  }
  for (const [seviye, bilgi] of Object.entries(SEVIYE)) {
    const grup = acik.data.filter((g) => g.level === seviye);
    if (!grup.length) continue;
    const toplam = grup.reduce((t, g) => t + (g.estimate_minutes || 0), 0);
    liste.append(h("div", { class: "grup" },
      h("div", { class: "grup-baslik" },
        h("span", { class: "nokta", style: `background:${bilgi.renk}` }),
        bilgi.ad,
        h("span", { class: "sayi" }, `${grup.length} iş${toplam ? " · " + sureYazi(toplam) : ""}`),
      ),
      h("div", { class: "liste" }, grup.map((g) => gorevSatiri(g))),
    ));
  }

  // Bugün bitenler
  const bitenKutu = $("#bugun-biten");
  bitenKutu.hidden = !biten.data.length;
  bitenKutu.querySelector("summary").textContent = `Bugün tamamlanan: ${biten.data.length}`;
  bitenKutu.querySelector(".liste").replaceChildren(...biten.data.map((g) => gorevSatiri(g, { bitti: true })));
}

// ---------------------------------------------------------------------
// HAFTA
// ---------------------------------------------------------------------

async function haftayiYukle() {
  const bugun = bugunISO();
  const pzt = gunEkle(haftaBasi(bugun), durum.haftaKaydir * 7);
  const pzr = gunEkle(pzt, 6);
  const buHafta = durum.haftaKaydir === 0;
  $("#hafta-aralik").textContent = `${trTarih(pzt)} – ${trTarih(pzr)}`;
  $("#alt-baslik").textContent = buHafta ? "Bu hafta" : durum.haftaKaydir < 0 ? "Geçmiş hafta" : "Gelecek hafta";

  const sorgular = [
    sb.from("tasks_view").select("*").gte("due_date", pzt).lte("due_date", pzr)
      .order("due_time", { ascending: true, nullsFirst: false }).order("level_rank", { ascending: false }),
    sb.from("summaries").select("content, created_at").eq("kind", "haftalik")
      .gte("created_at", gunBaslangici(pzt)).lte("created_at", gunBaslangici(gunEkle(pzr, 1)))
      .order("created_at", { ascending: false }).limit(1),
  ];
  if (buHafta) {
    sorgular.push(sb.from("tasks_view").select("*").eq("status", "acik").is("due_date", null)
      .order("importance", { ascending: false }));
    sorgular.push(sb.from("tasks_view").select("*").eq("status", "acik").lt("due_date", pzt)
      .order("due_date"));
  }
  const [gorevler, ozet, tarihsiz, eskiGecikmis] = await Promise.all(sorgular);
  for (const r of [gorevler, ozet, tarihsiz, eskiGecikmis]) if (r?.error) throw r.error;

  const ozetKutu = $("#hafta-ozet");
  ozetKutu.replaceChildren();
  if (ozet.data[0]) ozetKutu.append(ozetKarti("🗓️ Haftalık plan", ozet.data[0].content));

  const kutu = $("#hafta-gunler");
  kutu.replaceChildren();

  if (eskiGecikmis?.data.length) {
    kutu.append(gunBolumu("⚠️ Önceki haftalardan gecikenler", eskiGecikmis.data, { bugunMu: false }));
  }

  for (let i = 0; i < 7; i++) {
    const gun = gunEkle(pzt, i);
    const gunGorevleri = gorevler.data.filter((g) => g.due_date === gun);
    const baslik = `${GUNLER[i]} · ${trTarih(gun)}`;
    kutu.append(gunBolumu(baslik, gunGorevleri, { bugunMu: gun === bugun, yukGoster: true }));
  }

  if (buHafta && tarihsiz?.data.length) {
    kutu.append(gunBolumu("📥 Tarihsiz", tarihsiz.data, { bugunMu: false }));
  }
}

function gunBolumu(baslik, gorevler, { bugunMu, yukGoster = false }) {
  const acikDk = gorevler.filter((g) => g.status === "acik").reduce((t, g) => t + (g.estimate_minutes || 0), 0);
  const oran = Math.min(100, Math.round((acikDk / GUNLUK_KAPASITE_DK) * 100));
  return h("div", { class: "gun" },
    h("div", { class: "gun-baslik" + (bugunMu ? " bugun" : "") },
      baslik + (bugunMu ? " (bugün)" : ""),
      h("span", { class: "yuk" }, gorevler.length ? `${gorevler.length} iş${acikDk ? " · " + sureYazi(acikDk) : ""}` : ""),
    ),
    yukGoster && acikDk
      ? h("div", { class: "yuk-cubuk" + (acikDk > GUNLUK_KAPASITE_DK ? " fazla" : "") }, h("span", { style: `width:${oran}%` }))
      : null,
    gorevler.length
      ? h("div", { class: "liste" }, gorevler.map((g) => gorevSatiri(g, { bitti: g.status === "tamam", yarinaAt: false })))
      : h("div", { class: "gun-bos" }, "—"),
  );
}

// ---------------------------------------------------------------------
// Görev işlemleri
// ---------------------------------------------------------------------

async function tamamla(g, bitti) {
  const { error } = await sb.from("tasks")
    .update(bitti ? { status: "tamam", done_at: new Date().toISOString() } : { status: "acik", done_at: null })
    .eq("id", g.id);
  if (error) return hataGoster(error, "Güncellenemedi");
  toast(bitti ? "Tamamlandı ✓" : "Geri alındı");
  sekmeyiYenile();
}

async function yarinaErtele(g) {
  const { error } = await sb.from("tasks")
    .update({ due_date: gunEkle(bugunISO(), 1), last_notified_at: null })
    .eq("id", g.id);
  if (error) return hataGoster(error, "Ertelenemedi");
  toast("Yarına taşındı");
  sekmeyiYenile();
}

function formuTemizle() {
  const f = $("#gorev-formu");
  f.reset();
  f.gorev_id.value = "";
  $("#form-baslik").textContent = "Görev bilgileri";
  $("#form-sil").hidden = true;
  $("#form-durum").textContent = "";
  $("#ayristir-durum").textContent = "";
}

function formuDoldur(g) {
  const f = $("#gorev-formu");
  f.baslik.value = g.title || "";
  f.due_date.value = g.due_date || "";
  f.due_time.value = g.due_time ? g.due_time.slice(0, 5) : "";
  f.querySelector(`input[name="importance"][value="${g.importance || 2}"]`).checked = true;
  f.estimate_minutes.value = g.estimate_minutes || "";
  f.category.value = g.category === "iş" ? "iş" : "kişisel";
  if ("notes" in g) f.notes.value = g.notes || "";
}

function duzenle(g) {
  formuTemizle();
  formuDoldur(g);
  $("#gorev-formu").gorev_id.value = g.id;
  $("#form-baslik").textContent = "Görevi düzenle";
  $("#form-sil").hidden = false;
  $("#dogal-metin").value = "";
  sekmeAc("ekle", { formuKoru: true });
}

async function formuKaydet(e) {
  e.preventDefault();
  const f = e.target;
  const veri = {
    title: f.baslik.value.trim(),
    due_date: f.due_date.value || null,
    due_time: f.due_time.value || null,
    importance: Number(f.querySelector('input[name="importance"]:checked')?.value || 2),
    estimate_minutes: f.estimate_minutes.value ? Number(f.estimate_minutes.value) : null,
    category: f.category.value,
    notes: f.notes.value.trim() || null,
  };
  if (!veri.title) return;
  const btn = f.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const id = f.gorev_id.value;
    const { error } = id
      ? await sb.from("tasks").update({ ...veri, last_notified_at: null }).eq("id", id)
      : await sb.from("tasks").insert(veri);
    if (error) throw error;
    toast(id ? "Güncellendi" : "Eklendi ✓");
    formuTemizle();
    $("#dogal-metin").value = "";
    sekmeAc("bugun");
  } catch (err) {
    hataGoster(err, "Kaydedilemedi");
  } finally {
    btn.disabled = false;
  }
}

async function gorevSil() {
  const id = $("#gorev-formu").gorev_id.value;
  if (!id || !confirm("Bu görev silinsin mi?")) return;
  const { error } = await sb.from("tasks").delete().eq("id", id);
  if (error) return hataGoster(error, "Silinemedi");
  toast("Silindi");
  formuTemizle();
  sekmeAc("bugun");
}

async function ayristir() {
  const metin = $("#dogal-metin").value.trim();
  const durumEl = $("#ayristir-durum");
  if (!metin) {
    durumEl.textContent = "Önce bir şey yaz.";
    return;
  }
  const btn = $("#ayristir");
  btn.disabled = true;
  durumEl.textContent = "Yapay zeka okuyor…";
  try {
    const { data, error } = await sb.functions.invoke("gorev-ayristir", { body: { text: metin } });
    if (error) {
      let mesaj = "Yapay zekaya ulaşılamadı; formu elle doldurabilirsin.";
      try { mesaj = (await error.context.json()).error || mesaj; } catch { /* yoksay */ }
      throw new Error(mesaj);
    }
    formuDoldur({ ...data.task, notes: undefined });
    durumEl.textContent = "Form dolduruldu. Kontrol edip Kaydet'e bas.";
  } catch (err) {
    durumEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------
// AYARLAR ve bildirimler
// ---------------------------------------------------------------------

const iosMu = () => /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const anaEkrandanMi = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function vapidAnahtari(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function aboneligiKaydet(abonelik) {
  const j = abonelik.toJSON();
  const { error } = await sb.from("push_subscriptions").upsert(
    { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 300) },
    { onConflict: "endpoint" },
  );
  if (error) throw error;
}

async function bildirimDurumunuGoster() {
  const el = $("#bildirim-durum");
  const acBtn = $("#bildirim-ac");
  const testBtn = $("#bildirim-test");
  acBtn.hidden = false;
  testBtn.hidden = true;

  if (!("serviceWorker" in navigator)) {
    el.textContent = "Bu tarayıcı bildirimleri desteklemiyor.";
    acBtn.hidden = true;
    return;
  }
  if (iosMu() && !anaEkrandanMi()) {
    el.textContent = "iPhone'da bildirim için: Safari'de Paylaş (□↑) → \"Ana Ekrana Ekle\" de, sonra uygulamayı ana ekrandaki simgeden aç ve buraya dön.";
    acBtn.hidden = true;
    return;
  }
  if (!("PushManager" in window) || !("Notification" in window)) {
    el.textContent = "Bu cihaz push bildirimlerini desteklemiyor (iOS 16.4 veya üstü gerekir).";
    acBtn.hidden = true;
    return;
  }
  if (Notification.permission === "denied") {
    el.textContent = "Bildirim izni reddedilmiş. Ayarlar → Bildirimler → Görevler bölümünden izin verebilirsin.";
    acBtn.hidden = true;
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const abonelik = await reg.pushManager.getSubscription();
  if (abonelik && Notification.permission === "granted") {
    el.textContent = "✅ Bu cihazda bildirimler açık.";
    acBtn.hidden = true;
    testBtn.hidden = false;
  } else {
    el.textContent = "Bu cihazda bildirimler kapalı.";
  }
}

async function bildirimleriAc() {
  const btn = $("#bildirim-ac");
  btn.disabled = true;
  try {
    if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.startsWith("BURAYA")) {
      throw new Error("config.js içindeki VAPID_PUBLIC_KEY doldurulmamış");
    }
    const izin = await Notification.requestPermission();
    if (izin !== "granted") throw new Error("Bildirim izni verilmedi");
    const reg = await navigator.serviceWorker.ready;
    const abonelik = (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidAnahtari(VAPID_PUBLIC_KEY) }));
    await aboneligiKaydet(abonelik);
    toast("Bildirimler açıldı ✓");
  } catch (err) {
    hataGoster(err, "Bildirimler açılamadı");
  } finally {
    btn.disabled = false;
    bildirimDurumunuGoster();
  }
}

async function testBildirimi() {
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification("🔔 Test bildirimi", {
    body: "Bildirimler bu cihazda görünüyor. Gerçek hatırlatmalar 15 dakikada bir kontrol edilir.",
    icon: "icons/icon-192.png",
    tag: "test",
  });
}

// Uygulama her açıldığında aboneliği veritabanıyla eşitle (silinmişse geri ekler).
async function aboneligiEsitle() {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (Notification.permission !== "granted") return;
    const reg = await navigator.serviceWorker.ready;
    const abonelik = await reg.pushManager.getSubscription();
    if (abonelik) await aboneligiKaydet(abonelik);
  } catch (err) {
    console.warn("Abonelik eşitlenemedi", err);
  }
}

const saat = (t) => (t ? t.slice(0, 5) : "");

async function ayarlariYukle() {
  $("#alt-baslik").textContent = "";
  $("#hesap-eposta").textContent = durum.kullanici?.email ? `Giriş: ${durum.kullanici.email}` : "";
  bildirimDurumunuGoster().catch(console.error);

  const { data, error } = await sb.from("settings").select("*").maybeSingle();
  if (error) throw error;
  const s = data || {};
  const f = $("#ayar-formu");
  f.quiet_start.value = saat(s.quiet_start) || "22:00";
  f.quiet_end.value = saat(s.quiet_end) || "08:00";
  f.brief_time.value = saat(s.brief_time) || "08:00";
  f.high_slots.value = s.high_slots || "09:00,15:00";
  f.critical_interval_minutes.value = s.critical_interval_minutes || 150;
  f.daily_cap.value = s.daily_cap || 12;
}

async function ayarlariKaydet(e) {
  e.preventDefault();
  const f = e.target;
  const veri = {
    user_id: durum.kullanici.id,
    quiet_start: f.quiet_start.value,
    quiet_end: f.quiet_end.value,
    brief_time: f.brief_time.value,
    high_slots: f.high_slots.value.split(",").map((s) => s.trim()).filter(Boolean)
      .map((s) => s.padStart(5, "0")).join(","),
    critical_interval_minutes: Number(f.critical_interval_minutes.value),
    daily_cap: Number(f.daily_cap.value),
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from("settings").upsert(veri, { onConflict: "user_id" });
  if (error) return hataGoster(error, "Kaydedilemedi");
  $("#ayar-durum").textContent = "Kaydedildi ✓ Yeni kurallar bir sonraki kontrolde (en geç 15 dk) geçerli olur.";
}

// ---------------------------------------------------------------------
// Sekmeler
// ---------------------------------------------------------------------

const BASLIKLAR = { bugun: "Bugün", hafta: "Hafta", ekle: "Yeni görev", ayarlar: "Ayarlar" };
const YUKLEYICILER = { bugun: bugunuYukle, hafta: haftayiYukle, ayarlar: ayarlariYukle, ekle: async () => {} };

function sekmeAc(ad, { formuKoru = false } = {}) {
  durum.sekme = ad;
  for (const s of Object.keys(BASLIKLAR)) $(`#sekme-${s}`).hidden = s !== ad;
  document.querySelectorAll(".alt-menu button").forEach((b) => b.classList.toggle("aktif", b.dataset.sekme === ad));
  $("#baslik").textContent = ad === "ekle" && $("#gorev-formu").gorev_id.value ? "Görevi düzenle" : BASLIKLAR[ad];
  if (ad === "ekle") {
    $("#alt-baslik").textContent = "";
    if (!formuKoru && !$("#gorev-formu").gorev_id.value) $("#dogal-metin").focus({ preventScroll: true });
  }
  if (ad !== "ekle" && !formuKoru) formuTemizle();
  window.scrollTo({ top: 0 });
  sekmeyiYenile();
}

async function sekmeyiYenile() {
  try {
    await YUKLEYICILER[durum.sekme]();
  } catch (err) {
    hataGoster(err, "Veriler yüklenemedi");
  }
}

// ---------------------------------------------------------------------
// Başlangıç
// ---------------------------------------------------------------------

async function uygulamayiBaslat(kullanici) {
  durum.kullanici = kullanici;
  ekranGoster("#uygulama");
  // Ayar satırı yoksa varsayılanlarla oluştur (bildirim motoru buna bakar).
  await sb.from("settings").upsert({ user_id: kullanici.id }, { onConflict: "user_id", ignoreDuplicates: true });
  aboneligiEsitle();
  const istenen = new URLSearchParams(location.search).get("sekme");
  sekmeAc(BASLIKLAR[istenen] ? istenen : "bugun");
}

function olaylariBagla() {
  document.querySelectorAll(".alt-menu button").forEach((b) => b.addEventListener("click", () => sekmeAc(b.dataset.sekme)));
  $("#yenile").addEventListener("click", sekmeyiYenile);
  $("#hafta-onceki").addEventListener("click", () => { durum.haftaKaydir--; haftayiYukle().catch(hataGoster); });
  $("#hafta-sonraki").addEventListener("click", () => { durum.haftaKaydir++; haftayiYukle().catch(hataGoster); });
  $("#ayristir").addEventListener("click", ayristir);
  $("#gorev-formu").addEventListener("submit", formuKaydet);
  $("#form-temizle").addEventListener("click", () => { formuTemizle(); $("#dogal-metin").value = ""; sekmeAc("ekle"); });
  $("#form-sil").addEventListener("click", gorevSil);
  $("#ayar-formu").addEventListener("submit", ayarlariKaydet);
  $("#bildirim-ac").addEventListener("click", bildirimleriAc);
  $("#bildirim-test").addEventListener("click", () => testBildirimi().catch(hataGoster));
  $("#cikis").addEventListener("click", async () => { await sb.auth.signOut(); location.reload(); });

  $("#giris-formu").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    $("#giris-hata").textContent = "";
    const { data, error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
    if (error) {
      $("#giris-hata").textContent = "Giriş başarısız: e-posta ya da şifre hatalı.";
      return;
    }
    uygulamayiBaslat(data.user);
  });

  // Uygulamaya geri dönüldüğünde verileri tazele.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && durum.kullanici) sekmeyiYenile();
  });
}

async function basla() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Service worker kaydedilemedi", e));
  }
  if (!SUPABASE_URL || SUPABASE_URL.includes("PROJE-KODUN") || SUPABASE_ANON_KEY.startsWith("BURAYA")) {
    ekranGoster("#kurulum-eksik");
    return;
  }
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  olaylariBagla();
  const { data } = await sb.auth.getSession();
  if (data.session?.user) uygulamayiBaslat(data.session.user);
  else ekranGoster("#giris");
}

basla();
