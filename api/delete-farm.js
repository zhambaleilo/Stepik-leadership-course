// api/delete-farm.js — удаление фермы (с возвратом сессии для DEV и незрелых)
export default async function handler(req, res) {
  const allow = ['https://my-pro-skills.ru', 'http://localhost:8000'];
  const origin = req.headers.origin || '';
  if (allow.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing Supabase config');
    return res.status(500).json({ ok: false, reason: 'Supabase not configured' });
  }

  try {
    const { session_id, user_code } = req.body;
    if (!session_id || !user_code) {
      return res.status(400).json({ ok: false, reason: 'session_id and user_code are required' });
    }

    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/delete_farm`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        p_session_id: session_id,
        p_user_code: user_code.trim().toUpperCase()
      })
    });

    if (!rpcRes.ok) {
      const errorText = await rpcRes.text();
      console.error('RPC delete_farm failed:', rpcRes.status, errorText);
      return res.status(rpcRes.status).json({ 
        ok: false, 
        reason: 'RPC call failed: ' + rpcRes.status,
        details: errorText
      });
    }
    
    const result = await rpcRes.json();
    console.log('delete_farm result:', result);
    return res.status(200).json(result);
    
  } catch (e) {
    console.error('delete-farm error:', e);
    return res.status(502).json({ ok: false, reason: 'Ошибка сервера: ' + e.message });
  }
}
