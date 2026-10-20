// api/start-game.js — атомарный старт игры (линейной или фермы) через RPC
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
    const { code, kind, payload } = req.body;

    if (!code || !kind) {
      return res.status(400).json({ ok: false, reason: 'code and kind are required' });
    }

    // Вызываем RPC функцию start_game
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/start_game`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        p_code: code.trim().toUpperCase(),
        p_kind: kind,
        p_payload: payload || {}
      })
    });

    if (!rpcRes.ok) {
      const errorText = await rpcRes.text();
      console.error('RPC call failed:', rpcRes.status, errorText);
      throw new Error('RPC call failed: ' + rpcRes.status);
    }

    const result = await rpcRes.json();
    return res.status(200).json(result);

  } catch (e) {
    console.error('start-game error:', e);
    return res.status(502).json({ ok: false, reason: 'Ошибка сервера при старте игры: ' + e.message });
  }
}
