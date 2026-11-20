// =====================================================================
// gorev-ayristir — Supabase Edge Function
//
// Doğal dille yazılmış görevi ("Cuma'ya kadar teklif dosyasını bitir,
// önemli") Gemini ile yapılandırılmış veriye çevirir. Gemini anahtarı
// burada, sunucu tarafında durur; tarayıcıya hiç gitmez.
//
// Gerekli gizli değişken (Supabase → Edge Functions → Secrets):
//   GEMINI_API_KEY
// İsteğe bağlı:
//   GEMINI_PARSE_MODEL   (varsayılan: gemini-flash-lite-latest)
// =====================================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TZ = "Europe/Istanbul";
const GUNLER = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];

export type Parsed = {
  title: string;
  due_date: string | null;
  due_time: string | null;
  importance: 1 | 2 | 3;
  estimate_minutes: number | null;
  category: "iş" | "kişisel";
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

/** İstanbul saatine göre bugünden itibaren 15 günlük takvim. */
export function calendar(now = new Date()): { today: string; lines: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
  const today = fmt.format(now); // YYYY-MM-DD
  const [y, m, d] = today.split("-").map(Number);
  const lines: string[] = [];
  for (let i = 0; i < 15; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    const iso = dt.toISOString().slice(0, 10);
    const label = i === 0 ? " (bugün)" : i === 1 ? " (yarın)" : "";
    lines.push(`${iso} ${GUNLER[dt.getUTCDay()]}${label}`);
  }
  return { today, lines: lines.join("\n") };
}

export function buildPrompt(text: string, now = new Date()): string {
  const { lines } = calendar(now);
  const time = new Intl.DateTimeFormat("tr-TR", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit",
  }).format(now);
  return `Şu an saat ${time} (Türkiye). Önümüzdeki günlerin takvimi:
${lines}

Kullanıcının yazdığı görev:
"""${text}"""

Bu metinden görev bilgilerini çıkar:
- title: kısa, net görev adı (emir kipinde, tarih/önem ifadelerini çıkar).
- due_date: son tarih YYYY-MM-DD. "Cuma'ya kadar" gibi ifadelerde takvimdeki
  ilk uygun günü seç. "haftaya" = gelecek haftanın aynı günü, "hafta sonu" =
  ilk Cumartesi, "ay sonu" = ayın son günü. Tarih belirtilmemişse null.
- due_time: saat belirtilmişse HH:MM (24 saat), yoksa null.
- importance: "acil", "önemli", "kritik", "mutlaka" gibi ifadeler varsa 3;
  "boş vaktimde", "önemsiz", "fırsat olursa" gibi ifadeler varsa 1; aksi halde 2.
- estimate_minutes: süre belirtilmişse dakika olarak; belirtilmemişse
  görevin türüne göre makul bir tahmin (15–240 arası); emin değilsen null.
- category: işle/kariyerle ilgiliyse "iş", değilse "kişisel".`;
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    due_date: { type: "STRING", nullable: true },
    due_time: { type: "STRING", nullable: true },
    importance: { type: "INTEGER" },
    estimate_minutes: { type: "INTEGER", nullable: true },
    category: { type: "STRING", enum: ["iş", "kişisel"] },
  },
  required: ["title", "due_date", "due_time", "importance", "estimate_minutes", "category"],
};

/** Modelden geleni doğrula ve güvenli hale getir. */
export function normalize(raw: Record<string, unknown>, original: string): Parsed {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const title = str(raw.title).slice(0, 200) || original.trim().slice(0, 200);

  let due_date: string | null = str(raw.due_date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due_date) || isNaN(Date.parse(due_date))) due_date = null;

  let due_time: string | null = str(raw.due_time);
  const tm = due_time.match(/^(\d{1,2})[:.](\d{2})/);
  due_time = tm && +tm[1] < 24 && +tm[2] < 60 ? `${tm[1].padStart(2, "0")}:${tm[2]}` : null;

  const imp = Number(raw.importance);
  const importance = (imp === 1 || imp === 3 ? imp : 2) as 1 | 2 | 3;

  const est = Number(raw.estimate_minutes);
  const estimate_minutes = Number.isFinite(est) && est > 0 ? Math.min(Math.round(est), 24 * 60) : null;

  const category = raw.category === "iş" ? "iş" : "kişisel";
  return { title, due_date, due_time, importance, estimate_minutes, category };
}

async function askGemini(text: string): Promise<Parsed> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY tanımlı değil");
  const model = Deno.env.get("GEMINI_PARSE_MODEL") || "gemini-flash-lite-latest";

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt(text) }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA },
      }),
    },
  );
  if (!res.ok) {
    const detail = await res.text();
    const err = new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const data = await res.json();
  const out = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
  return normalize(JSON.parse(out), text);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Sadece POST" }, 405);

  let text = "";
  try {
    text = String((await req.json())?.text ?? "").trim();
  } catch {
    return json({ error: "Geçersiz istek" }, 400);
  }
  if (!text) return json({ error: "Metin boş" }, 400);
  if (text.length > 1000) return json({ error: "Metin çok uzun (en fazla 1000 karakter)" }, 400);

  try {
    return json({ task: await askGemini(text) });
  } catch (e) {
    const status = (e as { status?: number }).status;
    console.error(e);
    const msg = status === 429
      ? "Yapay zeka limiti doldu, biraz sonra tekrar dene ya da formu elle doldur."
      : "Yapay zeka şu an yanıt vermiyor; formu elle doldurabilirsin.";
    return json({ error: msg }, 502);
  }
});
