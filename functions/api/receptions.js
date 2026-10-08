// ============================================
// 카카오 액세스 토큰 자동 갱신
// ============================================

async function getKakaoAccessToken(env, forceRefresh = false) {

  const row = await env.DB.prepare(
    "SELECT * FROM kakao_tokens WHERE id = 1"
  ).first();

  if (!row) {
    throw new Error("카카오 토큰 정보가 없습니다.");
  }

  const now = Date.now();

  // 만료까지 1분 이상 남았다면 기존 토큰 사용
  if (
    !forceRefresh &&
    Number(row.access_expires_at) > now + 60000
  ) {
    return row.access_token;
  }

  if (!env.KAKAO_REST_API_KEY || !env.KAKAO_CLIENT_SECRET) {
    throw new Error("카카오 API 환경변수가 설정되지 않았습니다.");
  }

  // 토큰 자동 갱신
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.KAKAO_REST_API_KEY,
    client_secret: env.KAKAO_CLIENT_SECRET,
    refresh_token: row.refresh_token
  });

  const response = await fetch(
    "https://kauth.kakao.com/oauth/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(
      "카카오 토큰 갱신 실패: " +
      (data.error_description || data.error || response.status)
    );
  }

  const accessExpiresAt =
    Date.now() + Number(data.expires_in || 21600) * 1000;

  // 새 리프레시 토큰이 발급되면 함께 저장
  const refreshToken =
    data.refresh_token || row.refresh_token;

  const refreshExpiresAt = data.refresh_token_expires_in
    ? Date.now() + Number(data.refresh_token_expires_in) * 1000
    : Number(row.refresh_expires_at || 0);

  await env.DB.prepare(
    `UPDATE kakao_tokens
     SET access_token = ?,
         refresh_token = ?,
         access_expires_at = ?,
         refresh_expires_at = ?
     WHERE id = 1`
  ).bind(
    data.access_token,
    refreshToken,
    accessExpiresAt,
    refreshExpiresAt
  ).run();

  return data.access_token;
}


// ============================================
// 카카오톡 나에게 보내기
// ============================================

async function sendKakaoAlert(env, petName, phone, reason) {

  const message =
    "🐾 23시 하단오거리 동물병원\n" +
    "🔔 신규 재진 접수\n\n" +
    "환자명: " + (petName || "미입력") + "\n" +
    "연락처: " + (phone || "미입력") + "\n" +
    "내원사유: " + (reason || "미입력");

  const template = {
    object_type: "text",
    text: message,
    link: {
      web_url: "https://23si.net",
      mobile_web_url: "https://23si.net"
    }
  };

  async function sendWithToken(token) {

    const response = await fetch(
      "https://kapi.kakao.com/v2/api/talk/memo/default/send",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          template_object: JSON.stringify(template)
        }).toString()
      }
    );

    const result = await response.json();

    return { response, result };
  }

  // 첫 번째 발송
  let token = await getKakaoAccessToken(env);
  let { response, result } = await sendWithToken(token);

  // 토큰 인증 오류 발생 시 강제 갱신 후 재시도
  if (response.status === 401) {

    token = await getKakaoAccessToken(env, true);

    ({ response, result } = await sendWithToken(token));
  }

  if (!response.ok || result.result_code !== 0) {
    throw new Error(
      "카카오톡 발송 실패: " + JSON.stringify(result)
    );
  }

  return true;
}


// ============================================
// 이메일 알림 발송 - Resend
// ============================================

async function sendEmailAlert(env, petName, phone, reason) {

  if (!env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY가 설정되지 않았습니다.");
  }

  const subject =
    "🔔 신규 재진 접수 - " +
    (petName || "환자명 미입력");

  const text =
    "🐾 23시 하단오거리 동물병원\n\n" +
    "🔔 신규 재진 접수\n\n" +
    "환자명: " + (petName || "미입력") + "\n" +
    "연락처: " + (phone || "미입력") + "\n" +
    "내원사유: " + (reason || "미입력") + "\n\n" +
    "접수 확인: https://23si.net";

  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.RESEND_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "23시 하단오거리 동물병원 <admin@23si.net>",
        to: ["yurmgirl@naver.com"],
        subject: subject,
        text: text
      })
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      "이메일 발송 실패: " +
      JSON.stringify(result)
    );
  }

  return true;
}


// ============================================
// 기존 접수 목록 조회
// ============================================

export async function onRequestGet({ env }) {

  try {

    await env.DB.prepare(
      "DELETE FROM receptions WHERE created_at < datetime('now', '+9 hours', '-3 days')"
    ).run();

    const { results } = await env.DB.prepare(
      "SELECT * FROM receptions ORDER BY id DESC"
    ).all();

    return Response.json(results);

  } catch (err) {

    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500 }
    );
  }
}


// ============================================
// 신규 접수 저장 + 카카오톡 + 이메일 자동 발송
// ============================================

export async function onRequestPost({ request, env }) {

  try {

    const data = await request.json();

    const {
      type,
      owner_name,
      pet_name,
      phone,
      symptom,
      payload
    } = data;

    await env.DB.prepare(
      "DELETE FROM receptions WHERE created_at < datetime('now', '+9 hours', '-3 days')"
    ).run();

    // 접수 저장
    const result = await env.DB.prepare(
      `INSERT INTO receptions
       (type, owner_name, pet_name, phone, symptom, payload)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      type,
      owner_name || "",
      pet_name || "",
      phone || "",
      symptom || "",
      JSON.stringify(payload || {})
    ).run();


    // ============================================
    // 카카오톡 + 이메일 동시 발송
    // ============================================

    const [kakaoResult, emailResult] = await Promise.allSettled([

      sendKakaoAlert(
        env,
        pet_name,
        phone,
        symptom
      ),

      sendEmailAlert(
        env,
        pet_name,
        phone,
        symptom
      )

    ]);


    // 카카오 결과
    const kakaoSent =
      kakaoResult.status === "fulfilled";

    if (!kakaoSent) {
      console.error(
        "카카오톡 알림 발송 오류:",
        kakaoResult.reason?.message ||
        kakaoResult.reason
      );
    }


    // 이메일 결과
    const emailSent =
      emailResult.status === "fulfilled";

    if (!emailSent) {
      console.error(
        "이메일 알림 발송 오류:",
        emailResult.reason?.message ||
        emailResult.reason
      );
    }


    return Response.json({
      success: true,
      id: result.meta.last_row_id,
      kakao_sent: kakaoSent,
      email_sent: emailSent
    });

  } catch (err) {

    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500 }
    );
  }
}


// ============================================
// 기존 접수 상태 변경
// ============================================

export async function onRequestPatch({ request, env }) {

  try {

    const { id, status } = await request.json();

    await env.DB.prepare(
      "UPDATE receptions SET status = ? WHERE id = ?"
    ).bind(status, id).run();

    return Response.json({ success: true });

  } catch (err) {

    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500 }
    );
  }
}


// ============================================
// 기존 접수 개별 삭제
// ============================================

export async function onRequestDelete({ request, env }) {

  try {

    const { id } = await request.json();

    if (!id) {
      return new Response(
        JSON.stringify({ error: "삭제할 id가 필요합니다." }),
        { status: 400 }
      );
    }

    await env.DB.prepare(
      "DELETE FROM receptions WHERE id = ?"
    ).bind(id).run();

    return Response.json({ success: true });

  } catch (err) {

    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500 }
    );
  }
}
