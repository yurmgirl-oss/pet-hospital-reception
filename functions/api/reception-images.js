
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
//
// Version management:
// version_no : 접수번호별 저장 순서
// is_latest  : 최신 버전이면 1, 과거 버전이면 0
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

// ============================================
// 관리자 PIN 확인
// ============================================

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
// 공통 문자열 정리
// ============================================

function safeFileName(value) {
  return String(value || "환자")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .trim()
    .slice(0, 60) || "환자";
}

// ============================================
// PNG 저장 - 중복 허용 / 누락 방지 우선 / 버전 관리
// 저장 버튼을 누를 때마다 새로운 이미지와 D1 기록을 생성한다.
// 같은 접수번호, 같은 동물, 같은 날짜라도 저장을 차단하지 않는다.
// ============================================

function getKoreaDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const values = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function resolveVisitDate(value) {
  const input = String(value || "").trim();

  // 날짜만 전달된 경우에는 전달된 날짜를 그대로 사용한다.
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;

  // 시간대가 명시된 ISO 날짜는 한국 시간 기준으로 변환한다.
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(input)) {
    const parsed = new Date(input);
    if (!Number.isNaN(parsed.getTime())) return getKoreaDate(parsed);
  }

  // 시간대가 없는 기존 DB 날짜/시간 문자열은 앞의 날짜를 보존한다.
  if (/^\d{4}-\d{2}-\d{2}/.test(input)) return input.slice(0, 10);

  return getKoreaDate();
}

export async function onRequestPost({ request, env }) {
  if (!authorized(request, env)) return authError();

  let objectKey = null;
  let uploaded = false;

  try {
    if (!env.DB || !env.RECEPTION_FILES) {
      return json({ error: "D1 또는 R2 바인딩이 없습니다." }, 500);
    }

    const data = await request.json();
    const imageData = String(data.image_data || "");
    const prefix = "data:image/png;base64,";

    if (!imageData.startsWith(prefix)) {
      return json({ error: "PNG 이미지 데이터가 필요합니다." }, 400);
    }

    const base64 = imageData.slice(prefix.length);
    if (base64.length > 11184812) {
      return json({ error: "이미지는 8MB 이하만 저장할 수 있습니다." }, 413);
    }

    let binary;
    try {
      binary = atob(base64);
    } catch {
      return json({ error: "이미지 데이터 형식이 올바르지 않습니다." }, 400);
    }

    if (binary.length > 8 * 1024 * 1024) {
      return json({ error: "이미지는 8MB 이하만 저장할 수 있습니다." }, 413);
    }

    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const visitDate = resolveVisitDate(data.created_at);
    const petName = String(data.pet_name || "환자").trim().slice(0, 100) || "환자";
    const phone = String(data.phone || "").replace(/\D/g, "").slice(0, 20);
    const visitType = String(data.visit_type || "").trim().slice(0, 30);
    const receptionId =
      data.reception_id == null || String(data.reception_id).trim() === ""
        ? null
        : String(data.reception_id).trim().slice(0, 80);

    // 자동 A4 백업 요청만 접수번호별로 한 번 저장한다.
    // 수동 A4 버튼 요청은 save_key가 없으므로 누를 때마다 새 기록을 추가한다.
    const saveKey = String(data.save_key || "").trim().slice(0, 150) || null;

    if (saveKey) {
      const existing = await env.DB.prepare(`
        SELECT id, version_no, is_latest, object_key
        FROM reception_images
        WHERE save_key = ?
        ORDER BY id DESC
        LIMIT 1
      `).bind(saveKey).first();

      if (existing) {
        const existingObject = await env.RECEPTION_FILES.head(existing.object_key);
        if (existingObject) {
          return json({
            success: true,
            duplicate: true,
            saved_new_record: false,
            image_id: existing.id,
            version_no: existing.version_no,
            is_latest: existing.is_latest,
            reception_id: receptionId,
            pet_name: petName,
            message: "자동 A4 기록이 이미 보관되어 있어 기존 기록을 유지했습니다."
          });
        }
      }
    }

    const safePetName = safeFileName(petName);
    objectKey = `${visitDate}/${crypto.randomUUID()}_${safePetName}.png`;

    await env.RECEPTION_FILES.put(objectKey, bytes, {
      httpMetadata: {
        contentType: "image/png",
        cacheControl: "private, no-store"
      }
    });
    uploaded = true;

    // INSERT OR IGNORE를 사용하지 않는다.
    // D1 제약조건/오류로 저장이 무시되면 성공으로 오인하지 않고 오류를 반환한다.
    await env.DB.prepare(`
      INSERT INTO reception_images
        (reception_id, pet_name, phone, visit_type, visit_date,
         object_key, created_at, version_no, is_latest, save_key)
      VALUES (
        ?, ?, ?, ?, ?, ?, datetime('now','+9 hours'),
        COALESCE(
          (SELECT MAX(version_no) + 1
           FROM reception_images WHERE reception_id = ?), 1
        ),
        1, ?
      )
    `).bind(
      receptionId, petName, phone, visitType, visitDate,
      objectKey, receptionId, saveKey
    ).run();

    const savedRow = await env.DB.prepare(`
      SELECT id, version_no, is_latest, object_key
      FROM reception_images
      WHERE object_key = ?
      LIMIT 1
    `).bind(objectKey).first();

    if (!savedRow) {
      // R2 원본은 보존한다. D1 확인 실패 시에도 이미지 자체를 삭제하지 않는다.
      return json({
        success: false,
        error: "R2 이미지 업로드는 완료됐지만 D1 기록 확인에 실패했습니다. 원본 이미지는 R2에 보존되어 있습니다.",
        image_saved_to_r2: true,
        recovery_object_key: objectKey,
        pet_name: petName,
        visit_date: visitDate
      }, 500);
    }

    // 같은 접수번호의 이전 기록은 보존하고, 이번 기록만 최신으로 표시한다.
    if (receptionId !== null) {
      await env.DB.prepare(`
        UPDATE reception_images
        SET is_latest = CASE WHEN id = ? THEN 1 ELSE 0 END
        WHERE reception_id = ?
      `).bind(savedRow.id, receptionId).run();
    }

    return json({
      success: true,
      duplicate: false,
      saved_new_record: true,
      image_id: savedRow.id,
      version_no: savedRow.version_no,
      is_latest: 1,
      reception_id: receptionId,
      pet_name: petName,
      visit_date: visitDate,
      object_key: objectKey,
      message: "A4 이미지가 새 기록으로 저장되었습니다. 기존 기록은 유지됩니다."
    });

  } catch (error) {
    console.error("reception image save error", error);

    // 누락 방지 우선: R2 업로드가 성공했다면 D1 처리 중 오류가 나도
    // 원본 PNG를 자동 삭제하지 않는다. 복구할 수 있도록 object_key를 반환한다.
    return json({
      error: error.message || "이미지 저장에 실패했습니다.",
      image_saved_to_r2: uploaded,
      recovery_object_key: uploaded ? objectKey : null,
      message: uploaded
        ? "R2 원본 이미지는 보존했습니다. D1 등록 상태를 확인해야 합니다."
        : "R2 이미지 업로드 단계에서 실패했습니다. 다시 저장해 주세요."
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
    const receptionId = url.searchParams.get("reception_id");

    // ----------------------------------------
    // 이미지 원본 열기
    // id: 이미지 기록 번호로 열기
    // reception_id: 접수번호에 연결된 최신 PNG 열기
    // ----------------------------------------

    if (id || receptionId) {
      const lookupValue = id || receptionId;
      if (!/^\d+$/.test(lookupValue)) {
        return json({
          error: "잘못된 이미지 번호입니다."
        }, 400);
      }

      const row = id
        ? await env.DB.prepare(`
            SELECT
              id,
              object_key,
              pet_name,
              visit_date,
              visit_type,
              reception_id,
              version_no,
              is_latest
            FROM reception_images
            WHERE id = ?
          `).bind(id).first()
        : await env.DB.prepare(`
            SELECT
              id,
              object_key,
              pet_name,
              visit_date,
              visit_type,
              reception_id,
              version_no,
              is_latest
            FROM reception_images
            WHERE reception_id = ?
            ORDER BY is_latest DESC, id DESC
            LIMIT 1
          `).bind(receptionId).first();

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

      const safePetName = safeFileName(row.pet_name);

      const safeDate =
        /^\d{4}-\d{2}-\d{2}$/.test(row.visit_date || "")
          ? row.visit_date
          : "날짜미상";

      const typeLabel =
        row.visit_type === "초진"
          ? "초진기록"
          : row.visit_type === "재진"
            ? "재진기록"
            : "방문상담";

      const versionLabel =
        row.reception_id == null
          ? ""
          : `_v${row.version_no || 1}`;

      const filename =
        `${safePetName}_${safeDate}_${typeLabel}${versionLabel}.png`;

      const headers = new Headers();

      object.writeHttpMetadata(headers);

      headers.set("Content-Type", "image/png");
      headers.set("Cache-Control", "private, no-store");

      headers.set(
        "Content-Disposition",
        `inline; filename="reception.png"; filename*=UTF-8''${encodeURIComponent(filename)}`
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
        created_at,
        version_no,
        is_latest
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

    sql += " ORDER BY created_at DESC, id DESC LIMIT 200";

    const result = await env.DB
      .prepare(sql)
      .bind(...params)
      .all();

    return json({
      success: true,
      results: result.results || [],
      count: (result.results || []).length
    });

  } catch (error) {
    console.error("reception image search error", error);

    return json({
      error: error.message || "검색에 실패했습니다."
    }, 500);
  }
}