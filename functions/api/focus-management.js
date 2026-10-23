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

function error(message, status) {
  return json({ success: false, error: message }, status);
}

function authorized(request, env) {
  const expected = String(env.COUNTER_PIN || "");
  const supplied = String(request.headers.get("X-Clinic-Pin") || "");
  return Boolean(expected && supplied && expected === supplied);
}

export async function onRequestGet({ request, env }) {
  if (!authorized(request, env)) return error("인증이 필요합니다.", 401);
  const dataset = new URL(request.url).searchParams.get("dataset") || "real";
  if (!ALLOWED_DATASETS.has(dataset)) return error("dataset 값이 올바르지 않습니다.", 400);

  try {
    const row = await env.DB.prepare(
      "SELECT dataset, data_json, updated_at, revision FROM focus_management_data WHERE dataset = ?"
    ).bind(dataset).first();

    // 빈 DB를 정상적인 빈 배열로 위장하지 않습니다. 클라이언트는 저장을 중단합니다.
    if (!row) return json({ dataset, data: null, updated_at: null, revision: 0 });

    let data;
    try { data = JSON.parse(row.data_json); }
    catch { return error("서버 데이터 JSON이 손상되어 읽기를 중단했습니다.", 500); }
    if (!Array.isArray(data)) return error("서버 데이터 형식이 배열이 아닙니다.", 500);

    return json({ dataset, data, updated_at: row.updated_at, revision: Number(row.revision) });
  } catch (err) {
    return error("데이터를 불러오지 못했습니다.", 500);
  }
}

export async function onRequestPost({ request, env }) {
  if (!authorized(request, env)) return error("인증이 필요합니다.", 401);
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_BODY_BYTES) return error("전송 데이터가 너무 큽니다.", 413);

  let body;
  try { body = await request.json(); }
  catch { return error("JSON 형식이 올바르지 않습니다.", 400); }

  const { dataset, data, expected_revision: expectedRevision } = body || {};
  if (!ALLOWED_DATASETS.has(dataset)) return error("dataset은 example 또는 real이어야 합니다.", 400);
  if (!Array.isArray(data)) return error("data는 배열이어야 합니다.", 400);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return error("저장 버전 정보가 없습니다. 최신 데이터를 다시 불러와 주세요.", 428);
  }

  const dataJson = JSON.stringify(data);
  if (new TextEncoder().encode(dataJson).length > MAX_BODY_BYTES) return error("저장 데이터가 너무 큽니다.", 413);

  try {
    if (expectedRevision === 0) {
      // 최초 생성만 허용. 이미 행이 있으면 절대 덮어쓰지 않습니다.
      const inserted = await env.DB.prepare(
        "INSERT INTO focus_management_data (dataset, data_json, updated_at, revision) VALUES (?, ?, CURRENT_TIMESTAMP, 1) ON CONFLICT(dataset) DO NOTHING"
      ).bind(dataset, dataJson).run();
      if (Number(inserted.meta?.changes || 0) !== 1) {
        const current = await env.DB.prepare(
          "SELECT revision, updated_at FROM focus_management_data WHERE dataset = ?"
        ).bind(dataset).first();
        return json({ success: false, conflict: true, error: "다른 컴퓨터에서 먼저 자료가 저장되었습니다. 최신 자료를 다시 불러와 주세요.", revision: Number(current?.revision || 0), updated_at: current?.updated_at || null }, 409);
      }
      return json({ success: true, dataset, revision: 1 });
    }

    // Compare-and-swap: 읽었던 버전과 같을 때만 갱신합니다.
    const updated = await env.DB.prepare(
      "UPDATE focus_management_data SET data_json = ?, updated_at = CURRENT_TIMESTAMP, revision = revision + 1 WHERE dataset = ? AND revision = ?"
    ).bind(dataJson, dataset, expectedRevision).run();

    if (Number(updated.meta?.changes || 0) !== 1) {
      const current = await env.DB.prepare(
        "SELECT revision, updated_at FROM focus_management_data WHERE dataset = ?"
      ).bind(dataset).first();
      return json({ success: false, conflict: true, error: "다른 컴퓨터에서 먼저 자료가 변경되었습니다. 덮어쓰기를 막았습니다. 최신 자료를 다시 불러와 주세요.", revision: Number(current?.revision || 0), updated_at: current?.updated_at || null }, 409);
    }

    const row = await env.DB.prepare(
      "SELECT revision, updated_at FROM focus_management_data WHERE dataset = ?"
    ).bind(dataset).first();
    return json({ success: true, dataset, revision: Number(row.revision), updated_at: row.updated_at });
  } catch (err) {
    return error("데이터를 저장하지 못했습니다. 서버 설정과 revision 컬럼을 확인해 주세요.", 500);
  }
}
