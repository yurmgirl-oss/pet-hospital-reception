const CATEGORIES = ['코드블루','4days','호스피스','수술관리','심폐관리','신부전','종양관리','골관절','피부알러지','발작경련','추적관리','호르몬장애','특수관리'];
const json = (data, status=200) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});

export async function onRequest({request, env}) {
  if (!env.DB) return json({success:false,message:'D1 DB 바인딩(env.DB)을 찾을 수 없습니다.'},500);
  const method = request.method.toUpperCase();
  if (method === 'GET') {
    const {results=[]} = await env.DB.prepare('SELECT * FROM m8_management ORDER BY starred DESC, last_visit DESC, created_at DESC').all();
    return json({success:true, patients:results});
  }
  if (method === 'POST') {
    const p = await request.json();
    const name = String(p.name || '').trim();
    const category = String(p.category || '');
    if (!name || !CATEGORIES.includes(category)) return json({success:false,message:'동물 이름과 관리실을 확인해 주세요.'},400);
    const result = await env.DB.prepare(`INSERT INTO m8_management (name, phone, category, registered_at, last_visit, starred, memo, notes_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(name, String(p.phone||''), category, p.registered_at || new Date().toISOString().slice(0,10), p.last_visit || null, p.starred ? 1 : 0, String(p.memo||''), JSON.stringify(Array.isArray(p.notes)?p.notes:[])).run();
    return json({success:true,id:result.meta?.last_row_id});
  }
  if (method === 'PATCH') {
    const p = await request.json();
    if (!p.id) return json({success:false,message:'환자 항목 ID가 없습니다.'},400);
    const allowed = ['name','phone','category','registered_at','last_visit','starred','memo','notes_json'];
    const fields = Object.keys(p).filter(k => allowed.includes(k));
    if (!fields.length) return json({success:false,message:'변경할 항목이 없습니다.'},400);
    if (p.category && !CATEGORIES.includes(p.category)) return json({success:false,message:'잘못된 관리실입니다.'},400);
    const values = fields.map(k => k === 'starred' ? (p[k] ? 1 : 0) : k === 'notes_json' ? (typeof p[k] === 'string' ? p[k] : JSON.stringify(p[k])) : p[k]);
    const set = fields.map(k => `${k} = ?`).join(', ');
    await env.DB.prepare(`UPDATE m8_management SET ${set}, updated_at=datetime('now','+9 hours') WHERE id=?`).bind(...values, p.id).run();
    return json({success:true});
  }
  if (method === 'DELETE') {
    const {id} = await request.json();
    if (!id) return json({success:false,message:'환자 항목 ID가 없습니다.'},400);
    await env.DB.prepare('DELETE FROM m8_management WHERE id=?').bind(id).run();
    return json({success:true});
  }
  return json({success:false,message:'허용되지 않은 요청입니다.'},405);
}
