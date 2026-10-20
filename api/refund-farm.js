// api/refund-farm.js — удаление фермы и возврат сессии (только для незрелых)
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

  try {
    const { session_id, user_code } = req.body;
    if (!session_id || !user_code) {
      return res.status(400).json({ ok: false, reason: 'session_id and user_code are required' });
    }

    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/refund_farm`, {
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
      throw new Error('RPC call failed: ' + rpcRes.status);
    }
    
    const result = await rpcRes.json();
    return res.status(200).json(result);
    
  } catch (e) {
    console.error('refund-farm error:', e);
    return res.status(502).json({ ok: false, reason: 'Ошибка сервера: ' + e.message });
  }
}