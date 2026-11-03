// ============================================
// 23시 동물병원 - A4 접수 이미지 보관 API
// Cloudflare Pages Functions
//
// GET  /api/reception-images?q=두부
// GET  /api/reception-images?phone=01012345678
// GET  /api/reception-images?date=2026-11-03
// GET  /api/reception-images?id=123  -> PNG 원본
// POST /api/reception-images         -> PNG 저장
//
// Bindings:
// DB             : D1 database
// RECEPTION_FILES: R2 bucket
// COUNTER_PIN    : Secret
// ============================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

// 관리자 PIN 확인
function authorized(request, env) {
  const expected = String(env.COUNTER_PIN || "");
  const supplied = String(
    request.headers.get("X-Counter-Pin") || ""
  );

  if (
    !expected ||
    !supplied ||
    expected.length !== supplied.length
  ) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  }

  return diff === 0;
}

function authError() {
  return json({
    error: "관리자 인증이 필요합니다. PIN을 확인해 주세요."
  }, 401);
}

// ============================================
// PNG 저장
// ============================================

export async function onRequestPost({ request, env }) {

  if (!authorized(request, env)) {
    return authError();
  }

  try {

    if (!env.DB || !env.RECEPTION_FILES) {
      return json({
        error: "D1 또는 R2 바인딩이 없습니다."
      }, 500);
    }

    const data = await request.json();

    const imageData = String(data.image_data || "");
    const prefix = "data:image/png;base64,";

    if (!imageData.startsWith(prefix)) {
      return json({
        error: "PNG 이미지 데이터가 필요합니다."
      }, 400);
    }

    const base64 = imageData.slice(prefix.length);

    if (base64.length > 11184812) {
      return json({
        error: "이미지는 8MB 이하만 저장할 수 있습니다."
      }, 413);
    }

    let binary;

    try {
      binary = atob(base64);
    } catch {
      return json({
        error: "이미지 데이터 형식이 올바르지 않습니다."
      }, 400);
    }

    if (binary.length > 8 * 1024 * 1024) {
      return json({
        error: "이미지는 8MB 이하만 저장할 수 있습니다."
      }, 413);
    }

    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const now = new Date();

    const dateInput = String(data.created_at || "");

    const visitDate =
      /^\d{4}-\d{2}-\d{2}$/.test(dateInput.slice(0, 10))
        ? dateInput.slice(0, 10)
        : now.toISOString().slice(0, 10);

    const petName = String(data.pet_name || "환자").slice(0, 100);

    const phone = String(data.phone || "")
      .replace(/\D/g, "")
      .slice(0, 20);

    const visitType = String(data.visit_type || "").slice(0, 30);

    const receptionId =
      data.reception_id == null
        ? null
        : String(data.reception_id).slice(0, 80);

    const safePetName = petName
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
      .slice(0, 60);

    const objectKey =
      `${visitDate}/${crypto.randomUUID()}_${safePetName}.png`;

    // R2에 이미지 저장
    await env.RECEPTION_FILES.put(objectKey, bytes, {
      httpMetadata: {
        contentType: "image/png",
        cacheControl: "private, no-store"
      }
    });

    try {

      // D1에 검색용 정보 저장
      const result = await env.DB.prepare(`
        INSERT INTO reception_images
          (
            reception_id,
            pet_name,
            phone,
            visit_type,
            visit_date,
            object_key,
            created_at
          )
        VALUES (?, ?, ?, ?, ?, ?, datetime('now','+9 hours'))
      `).bind(
        receptionId,
        petName,
        phone,
        visitType,
        visitDate,
        objectKey
      ).run();

      return json({
        success: true,
        image_id: result.meta.last_row_id
      });

    } catch (error) {

      // D1 저장 실패 시 R2 파일 정리
      await env.RECEPTION_FILES.delete(objectKey);

      throw error;
    }

  } catch (error) {

    console.error("reception image save error", error);

    return json({
      error: error.message || "이미지 저장에 실패했습니다."
    }, 500);
  }
}

// ============================================
// 이미지 검색 및 원본 열람
// ============================================

export async function onRequestGet({ request, env }) {

  if (!authorized(request, env)) {
    return authError();
  }

  try {

    if (!env.DB || !env.RECEPTION_FILES) {
      return json({
        error: "D1 또는 R2 바인딩이 없습니다."
      }, 500);
    }

    const url = new URL(request.url);

    const id = url.searchParams.get("id");

    // ----------------------------------------
    // 이미지 원본 열기
    // ----------------------------------------

    if (id) {

      if (!/^\d+$/.test(id)) {
        return json({
          error: "잘못된 이미지 번호입니다."
        }, 400);
      }

      const row = await env.DB.prepare(
        "SELECT object_key FROM reception_images WHERE id = ?"
      ).bind(id).first();

      if (!row) {
        return json({
          error: "이미지를 찾을 수 없습니다."
        }, 404);
      }

      const object = await env.RECEPTION_FILES.get(row.object_key);

      if (!object) {
        return json({
          error: "저장된 이미지 파일이 없습니다."
        }, 404);
      }

      const headers = new Headers();

      object.writeHttpMetadata(headers);

      headers.set("Content-Type", "image/png");
      headers.set("Cache-Control", "private, no-store");
      headers.set(
        "Content-Disposition",
        'inline; filename="reception.png"'
      );
      headers.set("X-Content-Type-Options", "nosniff");

      return new Response(object.body, {
        headers
      });
    }

    // ----------------------------------------
    // 검색 조건
    // ----------------------------------------

    const q = (url.searchParams.get("q") || "")
      .trim()
      .slice(0, 100);

    const phone = (url.searchParams.get("phone") || "")
      .replace(/\D/g, "")
      .slice(0, 20);

    const date = (url.searchParams.get("date") || "").trim();

    if (!q && !phone && !date) {
      return json({
        error: "동물이름, 전화번호 또는 날짜를 입력해 주세요."
      }, 400);
    }

    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return json({
        error: "날짜 형식은 YYYY-MM-DD입니다."
      }, 400);
    }

    let sql = `
      SELECT
        id,
        reception_id,
        pet_name,
        phone,
        visit_type,
        visit_date,
        created_at
      FROM reception_images
      WHERE 1=1
    `;

    const params = [];

    if (q) {
      sql += " AND pet_name LIKE ?";
      params.push(`%${q}%`);
    }

    if (phone) {
      sql += " AND phone LIKE ?";
      params.push(`%${phone}%`);
    }

    if (date) {
      sql += " AND visit_date = ?";
      params.push(date);
    }

    sql += " ORDER BY id DESC LIMIT 200";

    const result = await env.DB
      .prepare(sql)
      .bind(...params)
      .all();

    return json({
      results: result.results || []
    });

  } catch (error) {

    console.error("reception image search error", error);

    return json({
      error: error.message || "검색에 실패했습니다."
    }, 500);
  }
}
