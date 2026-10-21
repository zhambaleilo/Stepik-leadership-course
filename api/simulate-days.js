// api/simulate-days.js — намотка времени и генерация событий фермы
import https from 'https';
import crypto from 'crypto';

let cache = { token: null, exp: 0 };

function sreq(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const r = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method, headers, rejectUnauthorized: false, timeout: 60000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    r.on('timeout', () => { r.destroy(new Error('upstream timeout')); });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function getToken() {
  if (cache.token && Date.now() < cache.exp - 60000) return cache.token;
  const auth = process.env.GIGACHAT_AUTH_KEY ||
    Buffer.from((process.env.GIGACHAT_CLIENT_ID || '') + ':' + (process.env.GIGACHAT_CLIENT_SECRET || '')).toString('base64');
  const scope = process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';
  const r = await sreq('POST', 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
    Authorization: 'Basic ' + auth, RqUID: crypto.randomUUID(), 'Content-Type': 'application/x-www-form-urlencoded',
  }, 'scope=' + scope);
  if (r.status !== 200) throw new Error('oauth ' + r.status);
  const j = JSON.parse(r.text);
  cache = { token: j.access_token, exp: Date.now() + (j.expires_in || 1800) * 1000 };
  return cache.token;
}

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
    const { session_id, days_to_simulate = 1 } = req.body;
    
    if (!session_id) {
      return res.status(400).json({ ok: false, reason: 'session_id is required' });
    }

    // 1. Читаем текущее состояние фермы
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/sessions?id=eq.${session_id}&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    
    if (!fetchRes.ok) throw new Error('Supabase fetch error: ' + fetchRes.status);
    const rows = await fetchRes.json();
    
    if (!rows.length) {
      return res.status(404).json({ ok: false, reason: 'Session not found' });
    }

    const session = rows[0];
    
    // Парсим JSON-поля
    const teamConfig = typeof session.team_config === 'string' ? JSON.parse(session.team_config) : session.team_config;
    const metrics = typeof session.metrics === 'string' ? JSON.parse(session.metrics) : session.metrics;
    const eventLog = typeof session.event_log === 'string' ? JSON.parse(session.event_log) : session.event_log;

    // 2. Формируем промпт для генерации событий
    const lastEvents = eventLog.slice(-5); // Последние 5 событий для контекста
    const lastEventsText = lastEvents.map(e => `День ${e.day}: ${e.text}`).join('\n');

    const systemPrompt = `Ты — движок симуляции рабочей команды. Сгенерируй события за ${days_to_simulate} рабочий день (дней).
Команда: ${JSON.stringify(teamConfig)}
Текущие метрики: настроение=${metrics.mood}, доверие=${metrics.trust}, продуктивность=${metrics.productivity} (шкала 0-10)
Последние события:
${lastEventsText}

Правила:
1. События должны быть реалистичными для офисной работы (чаты, личные сообщения, конфликты, успехи, стресс).
2. Учитывай скрытые триггеры сотрудников (выгорание, страх ИИ, токсичность и т.д.).
3. События могут влиять на метрики (указывай дельту: +1, -2 и т.д.).
4. Верни ТОЛЬКО валидный JSON-массив событий в формате: [{"day": N, "text": "...", "metrics_delta": {"mood": -1, "trust": 0, "productivity": 1}}]
5. Не добавляй markdown-обёртки, только чистый JSON.`;

    const token = await getToken();
    const r = await sreq('POST', 'https://api.giga.chat/v1/chat/completions', {
      Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
    }, JSON.stringify({
      model: process.env.GIGACHAT_MODEL || 'GigaChat-2-Pro',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Сгенерируй события для команды "${teamConfig.team_name}" на ${days_to_simulate} день(ей).` }
      ],
      temperature: 0.7,
      max_tokens: 2000
    }));

    if (r.status !== 200) throw new Error('GigaChat error: ' + r.status);
    
    let content = (JSON.parse(r.text).choices?.[0]?.message?.content || '').trim();
    // Убираем markdown-обёртки, если есть
    content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    
    let newEvents;
    try {
      newEvents = JSON.parse(content);
      if (!Array.isArray(newEvents)) throw new Error('Not an array');
    } catch (e) {
      console.error('JSON parse failed:', content);
      // Fallback: создаём системное событие
      newEvents = [{
        day: session.current_day + days_to_simulate,
        text: 'Симуляция прошла, но ИИ не смог сгенерировать события. Команда работала в штатном режиме.',
        metrics_delta: { mood: 0, trust: 0, productivity: 0 }
      }];
    }

    // 3. Применяем события к метрикам и добавляем в event_log
    const updatedMetrics = { ...metrics };
    const updatedEventLog = [...eventLog];
    const newDay = session.current_day + days_to_simulate;

    newEvents.forEach(event => {
      event.day = newDay; // Все события относятся к новому дню
      updatedEventLog.push(event);
      
      // Применяем дельты метрик
    if (event.metrics_delta) {
    const moodDelta = Math.max(-2, Math.min(2, event.metrics_delta.mood || 0));
    const trustDelta = Math.max(-2, Math.min(2, event.metrics_delta.trust || 0));
    const prodDelta = Math.max(-2, Math.min(2, event.metrics_delta.productivity || 0));
    
    updatedMetrics.mood = Math.max(0, Math.min(10, updatedMetrics.mood + moodDelta));
    updatedMetrics.trust = Math.max(0, Math.min(10, updatedMetrics.trust + trustDelta));
    updatedMetrics.productivity = Math.max(0, Math.min(10, updatedMetrics.productivity + prodDelta));
    }
    });

    // 4. Сохраняем обновлённое состояние
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
        body: JSON.stringify({
          current_day: newDay,
          metrics: updatedMetrics,
          event_log: updatedEventLog,
          last_saved_at: new Date().toISOString()
        })
      }
    );

    if (!updateRes.ok) throw new Error('Supabase update error: ' + updateRes.status);

    return res.status(200).json({
      ok: true,
      new_day: newDay,
      new_metrics: updatedMetrics,
      new_events: newEvents
    });

  } catch (e) {
    console.error('simulate-days error:', e);
    return res.status(502).json({ ok: false, reason: 'Ошибка сервера при симуляции' });
  }
}
