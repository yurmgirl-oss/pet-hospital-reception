const ALLOWED_DATASETS = new Set(["example", "real"]);
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function authorized(request, env) {
  const expected = String(env.COUNTER_PIN || "");
  const supplied = String(request.headers.get("X-Clinic-Pin") || "");
  return Boolean(expected && supplied && expected === supplied);
}

function error(message, status) {
  return json({ error: message }, status);
}

export async function onRequestGet({ request, env }) {
  if (!authorized(request, env)) {
    return error("인증이 필요합니다.", 401);
  }

  const dataset =
    new URL(request.url).searchParams.get("dataset") || "real";

  if (!ALLOWED_DATASETS.has(dataset)) {
    return error("dataset 값이 올바르지 않습니다.", 400);
  }

  try {
    const row = await env.DB.prepare(
      "SELECT dataset, data_json, updated_at FROM focus_management_data WHERE dataset = ?"
    ).bind(dataset).first();

    if (!row) {
      return json({
        dataset,
        data: null,
        updated_at: null
      });
    }

    return json({
      dataset: row.dataset,
      data: JSON.parse(row.data_json),
      updated_at: row.updated_at
    });
  } catch {
    return error("데이터를 불러오지 못했습니다.", 500);
  }
}

export async function onRequestPost({ request, env }) {
  if (!authorized(request, env)) {
    return error("인증이 필요합니다.", 401);
  }

  const length = Number(request.headers.get("Content-Length") || 0);

  if (length > MAX_BODY_BYTES) {
    return error("전송 데이터가 너무 큽니다.", 413);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return error("JSON 형식이 올바르지 않습니다.", 400);
  }

  const { dataset, data } = body || {};

  if (!ALLOWED_DATASETS.has(dataset)) {
    return error("dataset은 example 또는 real이어야 합니다.", 400);
  }

  if (!Array.isArray(data)) {
    return error("data는 배열이어야 합니다.", 400);
  }

  const dataJson = JSON.stringify(data);

  if (new TextEncoder().encode(dataJson).length > MAX_BODY_BYTES) {
    return error("저장 데이터가 너무 큽니다.", 413);
  }

  try {
    await env.DB.prepare(`
      INSERT INTO focus_management_data
        (dataset, data_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(dataset) DO UPDATE SET
        data_json = excluded.data_json,
        updated_at = CURRENT_TIMESTAMP
    `).bind(dataset, dataJson).run();

    const row = await env.DB.prepare(
      "SELECT updated_at FROM focus_management_data WHERE dataset = ?"
    ).bind(dataset).first();

    return json({
      success: true,
      dataset,
      updated_at: row?.updated_at || null
    });
  } catch {
    return error("데이터를 저장하지 못했습니다.", 500);
  }
}