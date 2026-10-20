// Проверка пароля доступа к полной версии игры
// POST { code: "ALPHA-7821" }
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
    const { code } = req.body;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ valid: false, reason: 'Код не указан' });
    }

    const trimmed = code.trim().toUpperCase();

    const findRes = await fetch(
      `${SUPABASE_URL}/rest/v1/access_codes?code=eq.${encodeURIComponent(trimmed)}&select=id,max_sessions,used_sessions,active`,
      {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!findRes.ok) throw new Error('Supabase find error: ' + findRes.status);
    const rows = await findRes.json();

    if (!rows.length) {
      return res.status(200).json({ valid: false, reason: 'Неверный код' });
    }

    const row = rows[0];
    if (!row.active) {
      return res.status(200).json({ valid: false, reason: 'Код деактивирован' });
    }

    if (row.used_sessions >= row.max_sessions) {
      return res.status(200).json({ valid: false, reason: 'Лимит сессий исчерпан' });
    }

    return res.status(200).json({
      valid: true,
      access_code_id: row.id,
      remaining_sessions: row.max_sessions - row.used_sessions,
      code: trimmed
    });

  } catch (e) {
    console.error('verify-code error:', e);
    return res.status(502).json({ valid: false, reason: 'Ошибка сервера' });
  }
}
