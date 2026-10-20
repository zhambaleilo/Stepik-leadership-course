// Получение списка активных ферм для текущего кода
export default async function handler(req, res) {
  const allow = ['https://my-pro-skills.ru', 'http://localhost:8000'];
  const origin = req.headers.origin || '';
  if (allow.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-access-code');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const code = req.headers['x-access-code'];

  if (!code || !SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json({ farms: [], remaining_sessions: 0, active_farms_count: 0 });
  }

  try {
    const codeRes = await fetch(
      `${SUPABASE_URL}/rest/v1/access_codes?code=eq.${encodeURIComponent(code.trim().toUpperCase())}&select=id,max_sessions,used_sessions,active`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const codeRows = await codeRes.json();
    if (!codeRows.length || !codeRows[0].active) {
      return res.status(200).json({ farms: [], remaining_sessions: 0, active_farms_count: 0 });
    }

    const accessCodeId = codeRows[0].id;
    const remainingSessions = codeRows[0].max_sessions - codeRows[0].used_sessions;

    const farmsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/sessions?access_code_id=eq.${accessCodeId}&kind=eq.ant_farm&status=neq.finished&select=id,team_config,current_day,metrics,last_saved_at`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const farms = await farmsRes.json();

    return res.status(200).json({
      farms: farms || [],
      remaining_sessions: remainingSessions,
      active_farms_count: farms ? farms.length : 0
    });

  } catch (e) {
    console.error('list-farms error:', e);
    return res.status(200).json({ farms: [], remaining_sessions: 0, active_farms_count: 0 });
  }
}
