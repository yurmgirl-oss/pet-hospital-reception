// ======================================================
// 카카오 Access Token 자동 갱신
// ======================================================
async function getKakaoAccessToken(env) {
  const token = await env.DB.prepare(
    "SELECT * FROM kakao_tokens WHERE id = 1"
  ).first();

  if (!token) {
    throw new Error("카카오 토큰 정보가 없습니다.");
  }

  const now = Math.floor(Date.now() / 1000);

  // Access Token이 아직 유효하면 그대로 사용
  if (
    token.access_token &&
    Number(token.access_expires_at) > now + 60
  ) {
    return token.access_token;
  }

  // ====================================================
  // Access Token 만료 → Refresh Token으로 갱신
  // ====================================================
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.KAKAO_REST_API_KEY,
    refresh_token: token.refresh_token
  });

  const response = await fetch(
    "https://kauth.kakao.com/oauth/token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded;charset=utf-8"
      },
      body: body.toString()
    }
  );

  const result = await response.json();

  if (!response.ok || !result.access_token) {
    console.error(
      "카카오 Access Token 갱신 실패:",
      JSON.stringify(result)
    );

    throw new Error(
      "카카오 Access Token 갱신 실패"
    );
  }

  const newAccessToken = result.access_token;

  const newAccessExpiresAt =
    now + Number(result.expires_in || 21600);

  // 카카오가 새 Refresh Token을 주지 않았다면 기존 것 유지
  const newRefreshToken =
    result.refresh_token || token.refresh_token;

  const newRefreshExpiresAt =
    result.refresh_token_expires_in
      ? now + Number(result.refresh_token_expires_in)
      : token.refresh_expires_at;

  await env.DB.prepare(
    `UPDATE kakao_tokens
     SET access_token = ?,
         refresh_token = ?,
         access_expires_at = ?,
         refresh_expires_at = ?
     WHERE id = 1`
  ).bind(
    newAccessToken,
    newRefreshToken,
    newAccessExpiresAt,
    newRefreshExpiresAt
  ).run();

  console.log(
    "카카오 Access Token 자동 갱신 완료"
  );

  return newAccessToken;
}


// ======================================================
// 카카오 '나에게 보내기'
// ======================================================
async function sendKakaoAlert(
  env,
  phone,
  petName,
  reason
) {
  let accessToken =
    await getKakaoAccessToken(env);

  const messageText =
    `[23시 신규 재진 접수]\n` +
    `- 환자: ${petName || "미입력"}\n` +
    `- 연락처: ${phone || "미입력"}\n` +
    `- 내원사유: ${reason || "미입력"}`;

  const sendMessage = async (token) => {
    return await fetch(
      "https://kapi.kakao.com/v2/api/talk/memo/default/send",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type":
            "application/x-www-form-urlencoded;charset=utf-8"
        },
        body: new URLSearchParams({
          template_object: JSON.stringify({
            object_type: "text",
            text: messageText,
            link: {
              web_url: "https://23si.net",
              mobile_web_url: "https://23si.net"
            }
          })
        })
      }
    );
  };

  let response =
    await sendMessage(accessToken);

  // 혹시 토큰이 예상보다 일찍 무효화된 경우
  // 한 번 강제로 갱신하고 다시 시도
  if (response.status === 401) {

    const token = await env.DB.prepare(
      "SELECT * FROM kakao_tokens WHERE id = 1"
    ).first();

    if (!token) {
      throw new Error(
        "카카오 토큰 정보가 없습니다."
      );
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.KAKAO_REST_API_KEY,
      refresh_token: token.refresh_token
    });

    const refreshResponse =
      await fetch(
        "https://kauth.kakao.com/oauth/token",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded;charset=utf-8"
          },
          body: body.toString()
        }
      );

    const refreshResult =
      await refreshResponse.json();

    if (
      !refreshResponse.ok ||
      !refreshResult.access_token
    ) {
      console.error(
        "카카오 재갱신 실패:",
        JSON.stringify(refreshResult)
      );

      throw new Error(
        "카카오 토큰 재갱신 실패"
      );
    }

    const now =
      Math.floor(Date.now() / 1000);

    const newRefreshToken =
      refreshResult.refresh_token ||
      token.refresh_token;

    const newRefreshExpiresAt =
      refreshResult.refresh_token_expires_in
        ? now +
          Number(
            refreshResult.refresh_token_expires_in
          )
        : token.refresh_expires_at;

    await env.DB.prepare(
      `UPDATE kakao_tokens
       SET access_token = ?,
           refresh_token = ?,
           access_expires_at = ?,
           refresh_expires_at = ?
       WHERE id = 1`
    ).bind(
      refreshResult.access_token,
      newRefreshToken,
      now +
        Number(
          refreshResult.expires_in || 21600
        ),
      newRefreshExpiresAt
    ).run();

    accessToken =
      refreshResult.access_token;

    response =
      await sendMessage(accessToken);
  }

  if (!response.ok) {
    const errorText =
      await response.text();

    console.error(
      "카카오 알림 전송 실패:",
      errorText
    );

    throw new Error(
      "카카오 알림 전송 실패"
    );
  }

  console.log(
    "카카오 알림 전송 성공"
  );

  return true;
}


// ======================================================
// 접수 목록 조회
// ======================================================
export async function onRequestGet({ env }) {
  try {
    await env.DB.prepare(
      "DELETE FROM receptions WHERE created_at < datetime('now', '+9 hours', '-3 days')"
    ).run();

    const { results } =
      await env.DB.prepare(
        "SELECT * FROM receptions ORDER BY id DESC"
      ).all();

    return Response.json(results);

  } catch (err) {

    return new Response(
      JSON.stringify({
        error: err.message
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }
}


// ======================================================
// 신규 접수
// ======================================================
export async function onRequestPost({
  request,
  env
}) {
  try {

    const data =
      await request.json();

    const {
      type,
      owner_name,
      pet_name,
      phone,
      symptom,
      payload
    } = data;


    // 오래된 접수 삭제
    await env.DB.prepare(
      "DELETE FROM receptions WHERE created_at < datetime('now', '+9 hours', '-3 days')"
    ).run();


    // 접수 저장
    const result =
      await env.DB.prepare(
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


    // ==================================================
    // 접수 저장 성공 후 카카오 알림
    // ==================================================
    try {

      await sendKakaoAlert(
        env,
        phone || "",
        pet_name || "",
        symptom || ""
      );

    } catch (kakaoError) {

      // 카카오 알림이 실패해도
      // 접수 자체는 정상적으로 유지
      console.error(
        "카카오 알림 오류:",
        kakaoError.message
      );
    }


    return Response.json({
      success: true,
      id: result.meta.last_row_id
    });


  } catch (err) {

    return new Response(
      JSON.stringify({
        error: err.message
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }
}


// ======================================================
// 접수 상태 변경
// ======================================================
export async function onRequestPatch({
  request,
  env
}) {
  try {

    const {
      id,
      status
    } = await request.json();

    await env.DB.prepare(
      "UPDATE receptions SET status = ? WHERE id = ?"
    ).bind(
      status,
      id
    ).run();

    return Response.json({
      success: true
    });

  } catch (err) {

    return new Response(
      JSON.stringify({
        error: err.message
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }
}


// ======================================================
// 개별 접수 삭제
// ======================================================
export async function onRequestDelete({
  request,
  env
}) {
  try {

    const {
      id
    } = await request.json();

    if (!id) {

      return new Response(
        JSON.stringify({
          error:
            "삭제할 id가 필요합니다."
        }),
        {
          status: 400,
          headers: {
            "Content-Type":
              "application/json"
          }
        }
      );
    }

    await env.DB.prepare(
      "DELETE FROM receptions WHERE id = ?"
    ).bind(id).run();

    return Response.json({
      success: true
    });

  } catch (err) {

    return new Response(
      JSON.stringify({
        error: err.message
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }
}
