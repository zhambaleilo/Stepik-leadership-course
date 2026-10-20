// api/get-session.js — получение данных одной сессии (линейной или фермы)
export default async function handler(req, res) {
  const allow = ['https://my-pro-skills.ru', 'http://localhost:8000'];
  const origin = req.headers.origin || '';
  if (allow.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sessionId = req.query.id;

  if (!sessionId || !SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(400).json({ error: 'Missing session_id or config' });
  }

  try {
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/sessions?id=eq.${sessionId}&select=*`,
      { 
        headers: { 
          'apikey': SUPABASE_KEY, 
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json'
        } 
      }
    );
    
    if (!fetchRes.ok) {
      throw new Error('Supabase fetch error: ' + fetchRes.status);
    }
    
    const rows = await fetchRes.json();

    if (!rows.length) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = rows[0];
    
    // Парсим JSON-поля, если Supabase вернул их как строки
    if (typeof session.dialogue === 'string') {
      try { session.dialogue = JSON.parse(session.dialogue); } catch(e) {}
    }
    if (typeof session.evaluation === 'string') {
      try { session.evaluation = JSON.parse(session.evaluation); } catch(e) {}
    }
    if (typeof session.event_log === 'string') {
      try { session.event_log = JSON.parse(session.event_log); } catch(e) {}
    }
    if (typeof session.metrics === 'string') {
      try { session.metrics = JSON.parse(session.metrics); } catch(e) {}
    }
    if (typeof session.team_config === 'string') {
      try { session.team_config = JSON.parse(session.team_config); } catch(e) {}
    }

    return res.status(200).json({ session });
  } catch (e) {
    console.error('get-session error:', e);
    return res.status(502).json({ error: 'Ошибка сервера при получении сессии: ' + e.message });
  }
}
