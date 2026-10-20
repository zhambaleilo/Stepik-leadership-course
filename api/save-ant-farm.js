// api/save-ant-farm.js — сохранение состояния фермы
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
    const { session_id, metrics, event_log, current_day, status } = req.body;
    
    if (!session_id) {
      return res.status(400).json({ ok: false, reason: 'session_id is required' });
    }

    // Формируем объект для обновления (только переданные поля)
    const updateData = { last_saved_at: new Date().toISOString() };
    if (metrics !== undefined) updateData.metrics = metrics;
    if (event_log !== undefined) updateData.event_log = event_log;
    if (current_day !== undefined) updateData.current_day = current_day;
    if (status !== undefined) updateData.status = status;

    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/sessions?id=eq.${session_id}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(updateData)
      }
    );

    if (!updateRes.ok) {
      throw new Error('Supabase update error: ' + updateRes.status);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('save-ant-farm error:', e);
    return res.status(502).json({ ok: false, reason: 'Ошибка сервера при сохранении' });
  }
}