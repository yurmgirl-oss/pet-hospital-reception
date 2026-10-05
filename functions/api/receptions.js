export async function onRequestGet({ env }) {
  try {
    await env.DB.prepare("DELETE FROM receptions WHERE created_at < datetime('now', '+9 hours', '-3 days')").run();
    const { results } = await env.DB.prepare("SELECT * FROM receptions ORDER BY id DESC").all();
    return Response.json(results);
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const data = await request.json();
    const { type, owner_name, pet_name, phone, symptom, payload } = data;

    await env.DB.prepare("DELETE FROM receptions WHERE created_at < datetime('now', '+9 hours', '-3 days')").run();

    const result = await env.DB.prepare(
      `INSERT INTO receptions (type, owner_name, pet_name, phone, symptom, payload)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      type,
      owner_name || '',
      pet_name || '',
      phone || '',
      symptom || '',
      JSON.stringify(payload || {})
    ).run();

    return Response.json({ success: true, id: result.meta.last_row_id });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

export async function onRequestPatch({ request, env }) {
  try {
    const { id, status } = await request.json();
    await env.DB.prepare("UPDATE receptions SET status = ? WHERE id = ?").bind(status, id).run();
    return Response.json({ success: true });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

// 개별 접수 삭제 (DELETE 요청 처리)
export async function onRequestDelete({ request, env }) {
  try {
    const { id } = await request.json();
    if (!id) {
      return new Response(JSON.stringify({ error: "삭제할 id가 필요합니다." }), { status: 400 });
    }
    await env.DB.prepare("DELETE FROM receptions WHERE id = ?").bind(id).run();
    return Response.json({ success: true });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
