// ============================================
// A4 접수 이미지 보관 API (Cloudflare Pages Functions)
// GET  /api/reception-images?q=두부
// GET  /api/reception-images?phone=01012345678
// GET  /api/reception-images?date=2026-11-03
// GET  /api/reception-images?id=123  -> PNG 원본
// POST /api/reception-images         -> PNG 저장
// ============================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function cleanName(value) {
  return String(value || "환자").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 60);
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.RECEPTION_FILES) return json({ error: "D1 또는 R2 바인딩이 없습니다." }, 500);
    const body = await request.json();
    const { reception_id, pet_name, phone, visit_type, created_at, image_data } = body;
    if (!image_data || typeof image_data !== "string" || !image_data.startsWith("data:image/png;base64,")) {
      return json({ error: "PNG 이미지 데이터가 올바르지 않습니다." }, 400);
    }
    const base64 = image_data.slice("data:image/png;base64,".length);
    const binary = atob(base64);
    if (binary.length > 8 * 1024 * 1024) return json({ error: "이미지는 8MB 이하로 저장해 주세요." }, 413);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const now = new Date();
    const datePart = String(created_at || now.toISOString()).slice(0, 10).replace(/[^0-9-]/g, "") || now.toISOString().slice(0, 10);
    const idPart = String(reception_id || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "");
    const key = `${datePart}/${idPart}_${cleanName(pet_name)}_${Date.now()}.png`;
    await env.RECEPTION_FILES.put(key, bytes, {
      httpMetadata: { contentType: "image/png", cacheControl: "private, no-store" },
      customMetadata: { pet_name: String(pet_name || ""), phone: String(phone || ""), visit_type: String(visit_type || "") }
    });

    const result = await env.DB.prepare(`
      INSERT INTO reception_images (reception_id, pet_name, phone, visit_type, visit_date, object_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now','+9 hours'))
    `).bind(reception_id || null, pet_name || "", String(phone || "").replace(/[^0-9]/g, ""), visit_type || "", datePart, key).run();

    return json({ success: true, image_id: result.meta.last_row_id, object_key: key });
  } catch (err) {
    console.error("reception image save error", err);
    return json({ error: err.message || "이미지 저장 실패" }, 500);
  }
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.RECEPTION_FILES) return json({ error: "D1 또는 R2 바인딩이 없습니다." }, 500);
    const url = new URL(request.url);
    const imageId = url.searchParams.get("id");

    if (imageId) {
      const row = await env.DB.prepare("SELECT object_key FROM reception_images WHERE id = ?").bind(imageId).first();
      if (!row) return json({ error: "이미지를 찾을 수 없습니다." }, 404);
      const object = await env.RECEPTION_FILES.get(row.object_key);
      if (!object) return json({ error: "R2에서 이미지 파일을 찾을 수 없습니다." }, 404);
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("Content-Type", "image/png");
      headers.set("Cache-Control", "private, no-store");
      headers.set("Content-Disposition", "inline; filename=\"reception.png\"");
      return new Response(object.body, { headers });
    }

    const q = (url.searchParams.get("q") || "").trim();
    const phone = (url.searchParams.get("phone") || "").replace(/[^0-9]/g, "");
    const date = (url.searchParams.get("date") || "").trim();
    let sql = "SELECT id, reception_id, pet_name, phone, visit_type, visit_date, created_at FROM reception_images WHERE 1=1";
    const values = [];
    if (q) { sql += " AND pet_name LIKE ?"; values.push(`%${q}%`); }
    if (phone) { sql += " AND phone LIKE ?"; values.push(`%${phone}%`); }
    if (date) { sql += " AND visit_date = ?"; values.push(date); }
    sql += " ORDER BY id DESC LIMIT 200";
    const result = await env.DB.prepare(sql).bind(...values).all();
    return json({ results: result.results || [] });
  } catch (err) {
    console.error("reception image search error", err);
    return json({ error: err.message || "검색 실패" }, 500);
  }
}
