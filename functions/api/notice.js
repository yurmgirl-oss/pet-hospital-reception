// functions/api/notice.js

// 1. 공지사항 조회 (GET)
export async function onRequestGet(context) {
  const { env } = context;
  try {
    const result = await env.DB.prepare(
      "SELECT value FROM hospital_settings WHERE key = 'hospital_notice'"
    ).first();

    return new Response(JSON.stringify({ 
      success: true, 
      notice: result ? (result.value || '') : '' 
    }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate"
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

// 2. 공지사항 저장 및 삭제 (POST - COUNTER_PIN 검증)
export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const body = await request.json();
    const pin = (body.pin || '').trim();
    const notice = (body.notice || '').trim();

    // Cloudflare 환경 변수 COUNTER_PIN 검증
    if (!env.COUNTER_PIN || pin !== String(env.COUNTER_PIN).trim()) {
      return new Response(JSON.stringify({ 
        success: false, 
        message: "비밀번호(PIN)가 일치하지 않습니다." 
      }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    // D1 DB에 등록/갱신
    await env.DB.prepare(`
      INSERT INTO hospital_settings (key, value, updated_at) 
      VALUES ('hospital_notice', ?1, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = CURRENT_TIMESTAMP
    `).bind(notice).run();

    return new Response(JSON.stringify({ success: true, message: "공지가 반영되었습니다." }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
