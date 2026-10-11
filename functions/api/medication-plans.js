function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) {
      return json({ error: "DB 연결을 확인해 주세요." }, 500);
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
      .replace(/\D/g, "").slice(-4);
    const pet = String(data.pet_name || "").trim().slice(0, 100);
    const plan = data.plan;

    if (!owner || phone.length !== 4 || !pet ||
        !plan || typeof plan !== "object") {
      return json({ error: "입력 내용을 확인해 주세요." }, 400);
    }

    const planJson = JSON.stringify(plan);
    if (planJson.length > 200000) {
      return json({ error: "복약지도 내용이 너무 큽니다." }, 413);
    }

    for (let i = 0; i < 30; i++) {
      const code = String(Math.floor(Math.random() * 100000))
        .padStart(5, "0");

      try {
        await env.DB.prepare(`
          INSERT INTO medication_plans
          (lookup_code, owner_name, phone_last4, pet_name, plan_json)
          VALUES (?, ?, ?, ?, ?)
        `).bind(code, owner, phone, pet, planJson).run();

        return json({ success: true, lookup_code: code });
      } catch (e) {
        if (!/unique|constraint/i.test(String(e.message || e))) {
          throw e;
        }
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
      return json({ error: "DB 연결을 확인해 주세요." }, 500);
    }

    const url = new URL(request.url);
    const code = url.searchParams.get("code") || "";
    const phone = String(url.searchParams.get("phone_last4") || "")
      .replace(/\D/g, "").slice(-4);

    if (!/^\d{5}$/.test(code) || phone.length !== 4) {
      return json({ error: "출력번호 5자리와 전화번호 뒤 4자리를 입력해 주세요." }, 400);
    }

    const row = await env.DB.prepare(`
      SELECT lookup_code, owner_name, phone_last4, pet_name,
             plan_json, created_at
      FROM medication_plans
      WHERE lookup_code = ? AND phone_last4 = ?
      LIMIT 1
    `).bind(code, phone).first();

    if (!row) {
      return json({ error: "일치하는 복약지도 내역이 없습니다." }, 404);
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
