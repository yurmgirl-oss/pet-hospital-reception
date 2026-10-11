function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function hashIP(ip) {
  const bytes = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function checkLookupLimit(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await hashIP(ip);
  const now = Math.floor(Date.now() / 1000);

  const result = await env.DB.prepare(`
    INSERT INTO medication_lookup_attempts
      (ip_hash, window_start, attempts)
    VALUES (?, ?, 1)
    ON CONFLICT(ip_hash) DO UPDATE SET
      attempts = CASE
        WHEN window_start <= ? THEN 1
        ELSE attempts + 1
      END,
      window_start = CASE
        WHEN window_start <= ? THEN excluded.window_start
        ELSE window_start
      END
    RETURNING attempts
  `).bind(ipHash, now, now - 900, now - 900).first();

  return result && result.attempts <= 10;
}

function makeCode() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return String(values[0] % 100000).padStart(5, "0");
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) {
      return json({ error: "데이터베이스 연결 오류" }, 500);
    }

    if (
      !env.COUNTER_PIN ||
      request.headers.get("X-Clinic-Pin") !== env.COUNTER_PIN
    ) {
      return json({ error: "병원 인증에 실패했습니다." }, 401);
    }

    const data = await request.json();

    const owner = String(data.owner_name || "").trim().slice(0, 100);
    const phone = String(data.phone_last4 || "")
      .replace(/\D/g, "");
    const pet = String(data.pet_name || "").trim().slice(0, 100);
    const plan = data.plan;

    if (
      !owner ||
      !/^\d{4}$/.test(phone) ||
      !pet ||
      !plan ||
      typeof plan !== "object" ||
      Array.isArray(plan)
    ) {
      return json({ error: "입력 내용을 확인해 주세요." }, 400);
    }

    const planJson = JSON.stringify(plan);

    if (planJson.length > 200000) {
      return json({ error: "복약지도 내용이 너무 큽니다." }, 413);
    }

    for (let i = 0; i < 20; i++) {
      const code = makeCode();

      try {
        await env.DB.prepare(`
          INSERT INTO medication_plans
            (lookup_code, owner_name, phone_last4, pet_name, plan_json)
          VALUES (?, ?, ?, ?, ?)
        `).bind(code, owner, phone, pet, planJson).run();

        return json({
          success: true,
          lookup_code: code
        });
      } catch (e) {
        if (/unique|constraint/i.test(String(e.message || e))) {
          continue;
        }
        throw e;
      }
    }

    return json({ error: "번호 발급에 실패했습니다." }, 503);
  } catch (e) {
    console.error("Medication save error:", e);
    return json({ error: "저장 중 오류가 발생했습니다." }, 500);
  }
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB) {
      return json({ error: "데이터베이스 연결 오류" }, 500);
    }

    const allowed = await checkLookupLimit(request, env);

    if (!allowed) {
      return json({
        error: "조회 요청이 많습니다. 15분 후 다시 시도해 주세요."
      }, 429);
    }

    const url = new URL(request.url);
    const code = url.searchParams.get("code") || "";
    const phone = url.searchParams.get("phone_last4") || "";

    if (!/^\d{5}$/.test(code) || !/^\d{4}$/.test(phone)) {
      return json({
        error: "출력번호 5자리와 전화번호 뒤 4자리를 입력해 주세요."
      }, 400);
    }

    const row = await env.DB.prepare(`
      SELECT lookup_code, owner_name, phone_last4,
             pet_name, plan_json, created_at
      FROM medication_plans
      WHERE lookup_code = ? AND phone_last4 = ?
      LIMIT 1
    `).bind(code, phone).first();

    if (!row) {
      return json({
        error: "일치하는 복약지도 내역이 없습니다."
      }, 404);
    }

    return json({
      success: true,
      lookup_code: row.lookup_code,
      owner_name: row.owner_name,
      pet_name: row.pet_name,
      created_at: row.created_at,
      plan: JSON.parse(row.plan_json)
    });
  } catch (e) {
    console.error("Medication lookup error:", e);
    return json({ error: "조회 중 오류가 발생했습니다." }, 500);
  }
}
