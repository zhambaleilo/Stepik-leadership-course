// Сохранение сессии (диалог + разбор) в Supabase
// POST { access_code_id, scenario_id, dialogue, evaluation, base_score, base_max, goe_score, goe_max, total_score, max_score, summary }

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
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  try {
    const {
      access_code_id, scenario_id, dialogue, evaluation,
      base_score, base_max, goe_score, goe_max,
      total_score, max_score, summary
    } = req.body;

    if (!scenario_id || !dialogue || !Array.isArray(dialogue)) {
      return res.status(400).json({ error: 'scenario_id и dialogue обязательны' });
    }

    const row = {
      access_code_id: access_code_id || null,
      scenario_id,
      dialogue,
      evaluation: evaluation || null,
      base_score: base_score ?? null,
      base_max: base_max ?? null,
      goe_score: goe_score ?? null,
      goe_max: goe_max ?? null,
      total_score: total_score ?? null,
      max_score: max_score ?? null,
      summary: summary || null
    };

    const insertRes = await fetch(
      `${SUPABASE_URL}/rest/v1/sessions`,
      {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(row)
      }
    );

    if (!insertRes.ok) {
      const text = await insertRes.text();
      throw new Error('Supabase insert error: ' + insertRes.status + ' ' + text.slice(0, 200));
    }

    const created = await insertRes.json();
    return res.status(200).json({ success: true, session_id: created[0]?.id });

  } catch (e) {
    console.error('save-session error:', e);
    return res.status(502).json({ error: e.message || String(e) });
  }
}
