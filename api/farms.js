// api/farms.js — универсальный CRUD для ферм (list, save, delete, simulate)
import https from 'https';
import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getCorsHeaders(origin) {
  const allow = ['https://my-pro-skills.ru', 'http://localhost:8000'];
  if (allow.includes(origin)) {
    return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type, x-access-code', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  }
  return {};
}

let cache = { token: null, exp: 0 };
function sreq(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const r = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers, rejectUnauthorized: false, timeout: 60000 }, (res) => {
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
  const auth = process.env.GIGACHAT_AUTH_KEY || Buffer.from((process.env.GIGACHAT_CLIENT_ID || '') + ':' + (process.env.GIGACHAT_CLIENT_SECRET || '')).toString('base64');
  const r = await sreq('POST', 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth', { Authorization: 'Basic ' + auth, RqUID: crypto.randomUUID(), 'Content-Type': 'application/x-www-form-urlencoded' }, 'scope=' + (process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS'));
  if (r.status !== 200) throw new Error('oauth ' + r.status);
  const j = JSON.parse(r.text);
  cache = { token: j.access_token, exp: Date.now() + (j.expires_in || 1800) * 1000 };
  return cache.token;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  Object.entries(getCorsHeaders(origin)).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  // === 1. LIST ===
  if (req.method === 'GET' && action === 'list') {
    const code = req.headers['x-access-code'];
    if (!code) return res.status(200).json({ farms: [], remaining_sessions: 0, active_farms_count: 0 });
    try {
      const codeRes = await fetch(`${SUPABASE_URL}/rest/v1/access_codes?code=eq.${encodeURIComponent(code.trim().toUpperCase())}&select=id,max_sessions,used_sessions,active`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const codeRows = await codeRes.json();
      if (!codeRows.length || !codeRows[0].active) return res.status(200).json({ farms: [], remaining_sessions: 0, active_farms_count: 0 });
      const farmsRes = await fetch(`${SUPABASE_URL}/rest/v1/sessions?access_code_id=eq.${codeRows[0].id}&kind=eq.ant_farm&status=neq.finished&select=id,team_config,current_day,metrics,last_saved_at`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const farms = await farmsRes.json();
      return res.status(200).json({ farms: farms || [], remaining_sessions: codeRows[0].max_sessions - codeRows[0].used_sessions, active_farms_count: farms ? farms.length : 0 });
    } catch (e) { return res.status(200).json({ farms: [], remaining_sessions: 0, active_farms_count: 0 }); }
  }

  // === 2. SAVE ===
  if (req.method === 'POST' && action === 'save') {
    const { session_id, metrics, event_log, current_day, status } = req.body;
    if (!session_id) return res.status(400).json({ ok: false, reason: 'session_id required' });
    try {
      const updateData = { last_saved_at: new Date().toISOString() };
      if (metrics !== undefined) updateData.metrics = metrics;
      if (event_log !== undefined) updateData.event_log = event_log;
      if (current_day !== undefined) updateData.current_day = current_day;
      if (status !== undefined) updateData.status = status;
      await fetch(`${SUPABASE_URL}/rest/v1/sessions?id=eq.${session_id}`, { method: 'PATCH', headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' }, body: JSON.stringify(updateData) });
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(502).json({ ok: false, reason: 'Save error: ' + e.message }); }
  }

  // === 3. DELETE ===
  if (req.method === 'POST' && action === 'delete') {
    const { session_id, user_code } = req.body;
    if (!session_id || !user_code) return res.status(400).json({ ok: false, reason: 'session_id and user_code required' });
    try {
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/delete_farm`, { method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_session_id: session_id, p_user_code: user_code.trim().toUpperCase() }) });
      return res.status(rpcRes.ok ? 200 : rpcRes.status).json(await rpcRes.json());
    } catch (e) { return res.status(502).json({ ok: false, reason: 'Delete error: ' + e.message }); }
  }

  // === 4. SIMULATE ===
  if (req.method === 'POST' && action === 'simulate') {
    const { session_id, days_to_simulate = 1 } = req.body;
    if (!session_id) return res.status(400).json({ ok: false, reason: 'session_id required' });
    try {
      const fetchRes = await fetch(`${SUPABASE_URL}/rest/v1/sessions?id=eq.${session_id}&select=*`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const rows = await fetchRes.json();
      if (!rows.length) return res.status(404).json({ ok: false, reason: 'Not found' });

      const session = rows[0];
      const teamConfig = typeof session.team_config === 'string' ? JSON.parse(session.team_config) : session.team_config;
      const metrics = typeof session.metrics === 'string' ? JSON.parse(session.metrics) : session.metrics;
      const eventLog = typeof session.event_log === 'string' ? JSON.parse(session.event_log) : session.event_log;

      const systemPrompt = `Ты — движок симуляции. Сгенерируй события за ${days_to_simulate} день.
Команда: ${JSON.stringify(teamConfig)}
Метрики: настроение=${metrics.mood}, доверие=${metrics.trust}, продуктивность=${metrics.productivity} (0-10)
Последние события: ${eventLog.slice(-3).map(e => `День ${e.day}: ${e.text}`).join('\n')}
Правила: 1) Реалистичные офисные события. 2) Учитывай триггеры. 3) Влияй на метрики (дельта ±1 или ±2). 4) Верни ТОЛЬКО валидный JSON-массив: [{"day": N, "text": "...", "metrics_delta": {"mood": -1, "trust": 0, "productivity": 1}}]. Без markdown.`;

      const token = await getToken();
      const r = await sreq('POST', 'https://api.giga.chat/v1/chat/completions', { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, JSON.stringify({
        model: process.env.GIGACHAT_MODEL || 'GigaChat-2-Pro',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: 'Сгенерируй события.' }],
        temperature: 0.7, max_tokens: 1500
      }));

      let content = (JSON.parse(r.text).choices?.[0]?.message?.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      let newEvents;
      try {
        newEvents = JSON.parse(content);
        if (!Array.isArray(newEvents)) throw new Error('Not array');
      } catch (e) {
        newEvents = [{ day: session.current_day, text: 'Команда работала в штатном режиме.', metrics_delta: { mood: 0, trust: 0, productivity: 0 } }];
      }

      const updatedMetrics = { ...metrics };
      const updatedEventLog = [...eventLog];
      const newDay = session.current_day;

      newEvents.forEach(event => {
        event.day = newDay;
        updatedEventLog.push(event);
        if (event.metrics_delta) {
          updatedMetrics.mood = Math.max(0, Math.min(10, updatedMetrics.mood + Math.max(-2, Math.min(2, event.metrics_delta.mood || 0))));
          updatedMetrics.trust = Math.max(0, Math.min(10, updatedMetrics.trust + Math.max(-2, Math.min(2, event.metrics_delta.trust || 0))));
          updatedMetrics.productivity = Math.max(0, Math.min(10, updatedMetrics.productivity + Math.max(-2, Math.min(2, event.metrics_delta.productivity || 0))));
        }
      });

      await fetch(`${SUPABASE_URL}/rest/v1/sessions?id=eq.${session_id}`, { method: 'PATCH', headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ current_day: newDay + days_to_simulate, metrics: updatedMetrics, event_log: updatedEventLog, last_saved_at: new Date().toISOString() }) });

      return res.status(200).json({ ok: true, new_day: newDay, new_metrics: updatedMetrics, new_events: newEvents });
    } catch (e) { return res.status(502).json({ ok: false, reason: 'Simulate error: ' + e.message }); }
  }

  return res.status(400).json({ error: 'Invalid action' });
}
