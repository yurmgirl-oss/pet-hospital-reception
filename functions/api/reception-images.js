
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
// PNG 저장 + 접수별 자동 저장 중복 방지 + 버전 관리
// ============================================

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
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const now = new Date();
    const dateInput = String(data.created_at || "");
    const visitDate =
      /^\d{4}-\d{2}-\d{2}$/.test(dateInput.slice(0, 10))
        ? dateInput.slice(0, 10)
        : now.toISOString().slice(0, 10);

    const petName = String(data.pet_name || "환자").trim().slice(0, 100) || "환자";
    const phone = String(data.phone || "").replace(/\D/g, "").slice(0, 20);
    const visitType = String(data.visit_type || "").trim().slice(0, 30);
    const receptionId =
      data.reception_id == null || String(data.reception_id).trim() === ""
        ? null
        : String(data.reception_id).trim().slice(0, 80);

    // 자동 저장 키는 브라우저가 보내지 않아도 서버가 접수번호로 생성한다.
    // 현재 프런트엔드의 A4 POST는 신규 접수 자동 보관 전용이다.
    const suppliedSaveKey = String(data.save_key || "").trim().slice(0, 150);
    const saveKey = suppliedSaveKey ||
      (receptionId !== null ? `auto-reception-${receptionId}` : null);

    if (saveKey) {
      // 새 키로 저장된 기록이 이미 있으면 즉시 중복 처리한다.
      let existing = await env.DB.prepare(`
        SELECT id, version_no, is_latest
        FROM reception_images
        WHERE save_key = ?
        LIMIT 1
      `).bind(saveKey).first();

      // 이전 버전에서 저장되어 save_key만 NULL인 동일 접수 기록도 재사용한다.
      // 기존 이미지/버전은 삭제하지 않고 최신 기록에 키만 연결한다.
      if (!existing && receptionId !== null) {
        const legacy = await env.DB.prepare(`
          SELECT id, version_no, is_latest
          FROM reception_images
          WHERE reception_id = ?
          ORDER BY COALESCE(version_no, 0) DESC, id DESC
          LIMIT 1
        `).bind(receptionId).first();

        if (legacy) {
          await env.DB.prepare(`
            UPDATE reception_images
            SET save_key = ?
            WHERE id = ? AND save_key IS NULL
          `).bind(saveKey, legacy.id).run();

          existing = await env.DB.prepare(`
            SELECT id, version_no, is_latest
            FROM reception_images
            WHERE save_key = ?
            LIMIT 1
          `).bind(saveKey).first();
        }
      }

      if (existing) {
        return json({
          success: true,
          duplicate: true,
          image_id: existing.id,
          version_no: existing.version_no,
          is_latest: existing.is_latest,
          reception_id: receptionId,
          pet_name: petName,
          message: "이 접수의 A4 기록이 이미 존재하여 추가 저장하지 않았습니다."
        });
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

    const insertNew = env.DB.prepare(`
      INSERT OR IGNORE INTO reception_images
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
    );

    await env.DB.batch([insertNew]);

    let savedRow;
    if (saveKey) {
      savedRow = await env.DB.prepare(`
        SELECT id, version_no, is_latest, object_key
        FROM reception_images
        WHERE save_key = ?
        LIMIT 1
      `).bind(saveKey).first();
    } else {
      savedRow = await env.DB.prepare(`
        SELECT id, version_no, is_latest, object_key
        FROM reception_images
        WHERE object_key = ?
        LIMIT 1
      `).bind(objectKey).first();
    }

    if (!savedRow) throw new Error("D1 이미지 저장 결과를 확인할 수 없습니다.");

    // 다른 PC가 같은 자동 저장 키를 먼저 저장했다면 이번 R2 파일만 제거한다.
    if (savedRow.object_key !== objectKey) {
      await env.RECEPTION_FILES.delete(objectKey);
      uploaded = false;
      objectKey = null;

      return json({
        success: true,
        duplicate: true,
        image_id: savedRow.id,
        version_no: savedRow.version_no,
        is_latest: savedRow.is_latest,
        reception_id: receptionId,
        pet_name: petName,
        message: "다른 화면에서 이미 저장한 접수입니다. 중복 이미지는 폐기했습니다."
      });
    }

    // 실제로 새 기록이 저장된 경우에만 최신 버전을 갱신한다.
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
      image_id: savedRow.id,
      version_no: savedRow.version_no,
      is_latest: 1,
      reception_id: receptionId,
      pet_name: petName
    });

  } catch (error) {
    console.error("reception image save error", error);

    if (uploaded && objectKey) {
      try {
        await env.RECEPTION_FILES.delete(objectKey);
      } catch (deleteError) {
        console.error("R2 cleanup error", deleteError);
      }
    }

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

      const row = await env.DB.prepare(`
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
      `).bind(id).first();

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