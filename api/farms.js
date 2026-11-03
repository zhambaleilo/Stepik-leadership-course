// api/farms.js — фермы: list, save, delete, simulate (с журналом действий руководителя), chat (1-on-1)
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

let tokenInflight = null;
async function fetchToken() {
  const auth = process.env.GIGACHAT_AUTH_KEY || Buffer.from((process.env.GIGACHAT_CLIENT_ID || '') + ':' + (process.env.GIGACHAT_CLIENT_SECRET || '')).toString('base64');
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await sreq('POST', 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth', { Authorization: 'Basic ' + auth, RqUID: crypto.randomUUID(), 'Content-Type': 'application/x-www-form-urlencoded' }, 'scope=' + (process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS'));
    if (r.status !== 429) break;
    await new Promise(res => setTimeout(res, 700 * (attempt + 1)));
  }
  if (r.status !== 200) throw new Error('oauth ' + r.status);
  const j = JSON.parse(r.text);
  cache = { token: j.access_token, exp: Date.now() + (j.expires_in || 1800) * 1000 };
  return cache.token;
}
async function getToken() {
  if (cache.token && Date.now() < cache.exp - 60000) return cache.token;
  if (!tokenInflight) tokenInflight = fetchToken().finally(() => { tokenInflight = null; });
  return tokenInflight;
}

// Запрос к GigaChat с повтором при 429
async function gigaChat(token, messages, opts = {}) {
  let rr;
  for (let attempt = 0; attempt < 3; attempt++) {
    rr = await sreq('POST', 'https://api.giga.chat/v1/chat/completions', { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, JSON.stringify({
      model: process.env.GIGACHAT_MODEL || 'GigaChat-2-Pro',
      messages,
      temperature: opts.temperature ?? 0.8,
      max_tokens: opts.max_tokens ?? 2000
    }));
    if (rr.status !== 429) break;
    await new Promise(res => setTimeout(res, 800 * (attempt + 1)));
  }
  if (rr.status !== 200) throw new Error('GigaChat returned ' + rr.status + ': ' + rr.text.slice(0, 200));
  return (JSON.parse(rr.text).choices?.[0]?.message?.content || '').trim();
}

// === ДЕЙСТВИЯ РУКОВОДИТЕЛЯ ===
const ACTION_TYPES = { chat: 'Общий чат', '1on1': '1-on-1', task: 'Поручение' };
const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
function sanitizeActions(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 12).map(a => {
    const type = ACTION_TYPES[a && a.type] ? a.type : null;
    if (!type) return null;
    const thread = Array.isArray(a.thread)
      ? a.thread.slice(0, 10).map(t => ({ from: t && t.from === 'employee' ? 'employee' : 'manager', text: clean(t && t.text, 400) })).filter(t => t.text)
      : [];
    const text = clean(a.text, 400) || (thread.find(t => t.from === 'manager') || {}).text || '';
    if (!text) return null;
    const out = { type, text };
    if (a.target) out.target = clean(a.target, 80);
    if (type === '1on1') {
      if (thread.length) out.thread = thread;
      const lastEmp = thread.filter(t => t.from === 'employee').pop();
      const reply = lastEmp ? lastEmp.text : clean(a.reply, 400);
      if (reply) out.reply = reply;
    } else if (Array.isArray(a.reactions)) {
      const reactions = a.reactions.slice(0, 3).map(r => ({ name: clean(r && r.name, 60), reply: clean(r && r.reply, 400) })).filter(r => r.name && r.reply);
      if (reactions.length) out.reactions = reactions;
    }
    return out;
  }).filter(Boolean);
}
function memberName(m, i) {
  const raw = String((m && m.name_role) || '').trim() || ('Сотрудник ' + (i + 1));
  return raw.split(/\s*[,—–]\s*/)[0].trim();
}
const TRIGGER_DESC = {
  burnout: 'выгорание: устал, перегружен, не видит смысла, держится из последних сил',
  imposter: 'синдром самозванца: боится, что его некомпетентность раскроется, обесценивает свои успехи',
  conflict: 'конфликты с соседними отделами: чувствует, что его не поддерживают в спорах',
  ai_fear: 'страх замены ИИ: тревожится, что его работу заберёт нейросеть',
  toxic: 'скрытая токсичность: сарказм, недомолвки, обесценивание коллег'
};
function describeAction(a) {
  const who = a.target || 'сотрудник';
  if (a.type === '1on1') {
    const thread = a.thread && a.thread.length ? a.thread : [{ from: 'manager', text: a.text }].concat(a.reply ? [{ from: 'employee', text: a.reply }] : []);
    const last = thread[thread.length - 1];
    const open = last && last.from === 'employee' && /\?\s*$/.test(last.text);
    return '[1-on-1 с ' + who + ']\n' + thread.map(t => '  ' + (t.from === 'manager' ? 'Руководитель' : who) + ': «' + t.text + '»').join('\n') + (open ? '\n  (последний вопрос сотрудника остался без ответа руководителя)' : '');
  }
  const react = a.reactions && a.reactions.length ? '\n  Реакции: ' + a.reactions.map(r => r.name + ': «' + r.reply + '»').join('; ') : '';
  if (a.type === 'chat') return '[Общий чат] «' + a.text + '»' + react;
  return '[Поручение' + (a.target ? ' для ' + a.target : ' всей команде') + '] «' + a.text + '»' + react;
}

// === САНИТАР JSON: чинит ответы GigaChat в JS-стиле ===
function sanitizeJson(rawText) {
  let c = String(rawText).replace(/```/g, '').trim();
  const start = c.indexOf('[');
  if (start === -1) throw new Error('No array bracket');
  // Вырезаем сбалансированный массив (игнорируем скобки внутри строк)
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < c.length; i++) {
    const ch = c[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error('Unbalanced brackets');
  c = c.slice(start, end + 1);
  // 1) Ключи с пробелами внутри кавычек: "day " :  ->  "day":
  c = c.replace(/"\s*(day|text|metrics_delta|mood|trust|productivity)\s*"\s*:/g, '"$1":');
  // 2) Ключи БЕЗ кавычек (JS-стиль): day:  ->  "day":
  c = c.replace(/(^|[{,\[]\s*)(day|text|metrics_delta|mood|trust|productivity)\s*:/g, '$1"$2":');
  // 3) Числа с плюсом: : +1  ->  : 1
  c = c.replace(/:\s*\+(\d+(\.\d+)?)/g, ': $1');
  // 4) Висячие запятые: , }  ->  }
  c = c.replace(/,(\s*[}\]])/g, '$1');
  return c;
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
    const actions = sanitizeActions(req.body.manager_actions);
    const intro = req.body.intro === true;
    if (!session_id) return res.status(400).json({ ok: false, reason: 'session_id required' });
    try {
      const fetchRes = await fetch(`${SUPABASE_URL}/rest/v1/sessions?id=eq.${session_id}&select=*`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const rows = await fetchRes.json();
      if (!rows.length) return res.status(404).json({ ok: false, reason: 'Not found' });

      const session = rows[0];
      const teamConfig = typeof session.team_config === 'string' ? JSON.parse(session.team_config) : session.team_config;
      const metrics = typeof session.metrics === 'string' ? JSON.parse(session.metrics) : session.metrics;
      const eventLog = typeof session.event_log === 'string' ? JSON.parse(session.event_log) : session.event_log;
      const lastEvents = eventLog.filter(e => e.kind !== 'action').slice(-3).map(e => 'День ' + e.day + ': ' + e.text).join('\n') || 'Событий ещё не было.';

      const example = '[{"day": ' + session.current_day + ', "text": "Марина в общем чате пожаловалась на перегрузку задачами", "metrics_delta": {"mood": -1, "trust": 0, "productivity": 0}}]';

      const members = (teamConfig && teamConfig.members) || [];
      const talked = new Set(actions.filter(a => a.type === '1on1').map(a => (a.target || '').toLowerCase()));
      const notTalked = members.map(memberName).filter(n => !talked.has(n.toLowerCase()));
      const actionsBlock = intro
        ? 'ПЕРВЫЙ ДЕНЬ: руководитель только знакомится с командой и пока ничего не предпринимал. Дай вводные события, покажи скрытые триггеры, но не наказывай за бездействие.'
        : actions.length
        ? 'ДЕЙСТВИЯ РУКОВОДИТЕЛЯ ЗА ДЕНЬ:\n' + actions.map(describeAction).join('\n') + '\nС кем не говорили один на один: ' + (notTalked.join(', ') || 'со всеми поговорили') + '.'
        : 'ДЕЙСТВИЯ РУКОВОДИТЕЛЯ ЗА ДЕНЬ: руководитель сегодня ничего не предпринял.';

      const basePrompt =
        'Ты — движок симуляции рабочей команды. Генерируй РЕАЛИСТИЧНЫЕ офисные события.\n\n' +
        'КОМАНДА:\n' + JSON.stringify(teamConfig) + '\n\n' +
        'МЕТРИКИ: настроение=' + metrics.mood + ', доверие=' + metrics.trust + ', продуктивность=' + metrics.productivity + ' (шкала 0-10)\n\n' +
        'ПОСЛЕДНИЕ СОБЫТИЯ:\n' + lastEvents + '\n\n' +
        actionsBlock + '\n\n' +
        'ПРАВИЛА:\n' +
        '1. От 2 до 4 событий за день.\n' +
        '2. Конкретика: имена сотрудников, действия, сообщения в чате, личные письма.\n' +
        '3. Учитывай скрытые триггеры (выгорание, страх ИИ, токсичность, синдром самозванца).\n' +
        '4. Дельты метрик — целые числа от -2 до 2, БЕЗ знака плюс перед положительными.\n' +
        '5. Продолжай логику предыдущих событий.\n' +
        '6. События ДОЛЖНЫ логично вытекать из действий руководителя за день. Забота, конкретная помощь и честность повышают настроение и доверие; давление, обесценивание и пустые слова их снижают. Общий чат влияет слабее, чем 1-on-1 с конкретным человеком.\n' +
        '7. Если с сотрудником, у которого есть скрытый триггер, не говорили один на один, его проблема нарастает: сделай минимум одно событие о нём.\n' +
        '8. Если руководитель ничего не делал, усиль скрытые триггеры и снизь доверие.\n' +
        '9. Поручение «фокус на задачах» повышает продуктивность, но может снижать настроение; «фокус на людях» работает наоборот.\n' +
        '10. НЕ придумывай реплики, обещания, решения и поступки руководителя. Описывай только то, что есть в списке его действий. Если сотрудник задал вопрос и руководитель не ответил, покажи это как неотвеченный вопрос (сотрудник ждёт, сомневается), а не как будто руководитель что-то пообещал.\n\n' +
        'ФОРМАТ: СТРОГО валидный JSON-массив. Все ключи в двойных кавычках: day, text, metrics_delta.\n' +
        'Пример: ' + example + '\n' +
        'Верни ТОЛЬКО массив. Без текста до и после. Без markdown.';

      const token = await getToken();

      const askGiga = messages => gigaChat(token, messages);

      function extractEvents(rawText) {
        const clean = sanitizeJson(rawText);
        const arr = JSON.parse(clean);
        if (!Array.isArray(arr) || arr.length === 0) throw new Error('Not an array');
        const norm = arr.map(e => {
          const text = String(e.text ?? e.event ?? e.description ?? '').trim();
          const md = e.metrics_delta ?? e.delta ?? e.impact ?? e.metrics ?? {};
          return {
            day: session.current_day,
            text: text,
            metrics_delta: { mood: Number(md.mood) || 0, trust: Number(md.trust) || 0, productivity: Number(md.productivity) || 0 }
          };
        }).filter(e => e.text.length > 0);
        if (norm.length === 0) throw new Error('No usable events');
        return norm;
      }

      let newEvents = null;
      let raw = '';
      try {
        raw = await askGiga([{ role: 'system', content: basePrompt }, { role: 'user', content: 'Сгенерируй события для этого дня.' }]);
        newEvents = extractEvents(raw);
      } catch (firstErr) {
        console.error('First attempt failed:', firstErr.message, 'raw:', (raw || '').slice(0, 500));
        try {
          raw = await askGiga([
            { role: 'system', content: basePrompt },
            { role: 'user', content: 'Сгенерируй события для этого дня.' },
            { role: 'assistant', content: raw || '(пустой ответ)' },
            { role: 'user', content: 'Твой предыдущий ответ невалиден. Верни ИСПРАВЛЕННЫЙ ответ: только валидный JSON-массив, все ключи в двойных кавычках (day, text, metrics_delta), числа без знака плюс. Без пояснений и markdown.' }
          ]);
          newEvents = extractEvents(raw);
        } catch (secondErr) {
          console.error('Retry failed:', secondErr.message, 'raw:', (raw || '').slice(0, 500));
          newEvents = [{ day: session.current_day, text: 'Команда работала в штатном режиме.', metrics_delta: { mood: 0, trust: 0, productivity: 0 } }];
        }
      }

      const updatedMetrics = { ...metrics };
      const updatedEventLog = [...eventLog];
      const newDay = session.current_day;
      actions.forEach(a => updatedEventLog.push({ day: newDay, kind: 'action', type: a.type, target: a.target || null, text: a.text, reply: a.reply || null, thread: a.thread || null, reactions: a.reactions || null, metrics_delta: { mood: 0, trust: 0, productivity: 0 } }));

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

      return res.status(200).json({ ok: true, new_day: newDay, new_metrics: updatedMetrics, new_events: newEvents, logged_actions: actions.length });
    } catch (e) {
      console.error('Simulate error:', e);
      return res.status(502).json({ ok: false, reason: 'Simulate error: ' + e.message });
    }
  }

  // === 5. CHAT (1-on-1: реплика руководителя -> ответ сотрудника) ===
  if (req.method === 'POST' && action === 'chat') {
    const { session_id } = req.body;
    const idx = Number(req.body.member_index);
    const text = String(req.body.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const history = Array.isArray(req.body.history) ? req.body.history.slice(-8).map(h => ({ role: h && h.from === 'employee' ? 'assistant' : 'user', content: clean(h && h.text, 500) })).filter(h => h.content) : [];
    if (!session_id || !Number.isInteger(idx) || !text) return res.status(400).json({ ok: false, reason: 'session_id, member_index and text required' });
    try {
      const fetchRes = await fetch(`${SUPABASE_URL}/rest/v1/sessions?id=eq.${encodeURIComponent(session_id)}&select=team_config,metrics,event_log,current_day`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const rows = await fetchRes.json();
      if (!Array.isArray(rows) || !rows.length) return res.status(404).json({ ok: false, reason: 'Not found' });
      const row = rows[0];
      const teamConfig = typeof row.team_config === 'string' ? JSON.parse(row.team_config) : row.team_config;
      const metrics = (typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics) || {};
      const eventLog = (typeof row.event_log === 'string' ? JSON.parse(row.event_log) : row.event_log) || [];
      const m = ((teamConfig && teamConfig.members) || [])[idx];
      if (!m) return res.status(404).json({ ok: false, reason: 'Member not found' });
      const name = memberName(m, idx);
      const first = name.split(/\s+/)[0];
      const stem = first.length >= 4 ? first.slice(0, -1) : first;
      const mine = eventLog.filter(e => e.kind !== 'action' && String(e.text || '').includes(stem)).slice(-2).map(e => 'День ' + e.day + ': ' + e.text).join('\n') || 'ничего особенного';
      const sys =
        'Ты играешь сотрудника в тренажёре для руководителей. Твоя роль: ' + String(m.name_role || name) + '.\n' +
        'Стиль общения: ' + (m.style || 'обычный деловой') + '.\n' +
        'Скрытая проблема (руководитель о ней не знает): ' + (TRIGGER_DESC[m.trigger] || 'нет') + '.\n' +
        'Настроение в команде: ' + (metrics.mood ?? 7) + '/10, доверие к руководителю: ' + (metrics.trust ?? 7) + '/10.\n' +
        'Недавно с тобой: ' + mine + '.\n\n' +
        'ПРАВИЛА: отвечай 1-3 предложениями, по-русски, от первого лица, как живой человек в рабочем чате. Без кавычек, без ремарок и пояснений, не выходи из роли. ' +
        'Если руководитель обесценивает, давит или говорит общими словами, отвечай сдержанно, коротко, закрыто. ' +
        'Отвечай только за себя: не описывай и не выдумывай действия, слова или обещания руководителя. Если нужно что-то уточнить, задай вопрос и жди ответа. ' +
        'Если он искренне интересуется и предлагает конкретную помощь, постепенно открывайся и намекни на свою проблему, но не называй диагноз прямо.';
      const token = await getToken();
      let reply = await gigaChat(token, [{ role: 'system', content: sys }, ...history, { role: 'user', content: text }], { temperature: 0.85, max_tokens: 300 });
      reply = reply.replace(/^["«»\s]+|["«»\s]+$/g, '').slice(0, 600);
      if (!reply) return res.status(502).json({ ok: false, reason: 'upstream_error' });
      return res.status(200).json({ ok: true, reply });
    } catch (e) {
      console.error('Farm chat error:', e);
      const rate = /\b429\b/.test(String(e.message));
      return res.status(rate ? 429 : 502).json({ ok: false, reason: rate ? 'rate_limited' : 'upstream_error' });
    }
  }

  // === 6. REACT (общий чат / поручение -> реакция 1-2 сотрудников) ===
  if (req.method === 'POST' && action === 'react') {
    const { session_id } = req.body;
    const kind = req.body.kind === 'task' ? 'task' : 'chat';
    const text = clean(req.body.text, 400);
    const only = req.body.member_index == null ? null : Number(req.body.member_index);
    if (!session_id || !text) return res.status(400).json({ ok: false, reason: 'session_id and text required' });
    try {
      const fetchRes = await fetch(`${SUPABASE_URL}/rest/v1/sessions?id=eq.${encodeURIComponent(session_id)}&select=team_config,metrics`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const rows = await fetchRes.json();
      if (!Array.isArray(rows) || !rows.length) return res.status(404).json({ ok: false, reason: 'Not found' });
      const teamConfig = typeof rows[0].team_config === 'string' ? JSON.parse(rows[0].team_config) : rows[0].team_config;
      const metrics = (typeof rows[0].metrics === 'string' ? JSON.parse(rows[0].metrics) : rows[0].metrics) || {};
      const members = ((teamConfig && teamConfig.members) || []).map((m, i) => ({ i, name: memberName(m, i), m }));
      const pool = Number.isInteger(only) && members[only] ? [members[only]] : members;
      if (!pool.length) return res.status(404).json({ ok: false, reason: 'Member not found' });
      const sys =
        'Ты играешь сотрудников команды в тренажёре для руководителей.\n' +
        'Команда:\n' + pool.map(x => '- ' + String(x.m.name_role || x.name) + '. Стиль: ' + (x.m.style || 'обычный деловой') + '. Скрытая проблема: ' + (TRIGGER_DESC[x.m.trigger] || 'нет') + '.').join('\n') + '\n' +
        'Настроение в команде: ' + (metrics.mood ?? 7) + '/10, доверие к руководителю: ' + (metrics.trust ?? 7) + '/10.\n\n' +
        (kind === 'task' ? 'Руководитель дал поручение' + (pool.length === 1 ? ' сотруднику ' + pool[0].name : ' всей команде') + '. ' : 'Руководитель написал в общий чат. ') +
        'Ответь ' + (pool.length === 1 ? 'от лица ' + pool[0].name : 'от лица одного или двух сотрудников, кому это ближе всего с учётом их скрытых проблем') + '. ' +
        'Реплика: 1-2 предложения, как в рабочем чате, от первого лица. Не описывай и не выдумывай действия руководителя. Если сообщение обесценивает или давит, отвечай сдержанно; если проявляет заботу или даёт конкретику, реагируй живее.\n' +
        'Верни ТОЛЬКО JSON-массив вида [{"name": "Имя", "reply": "текст"}]. Без пояснений и markdown.';
      const token = await getToken();
      const raw = await gigaChat(token, [{ role: 'system', content: sys }, { role: 'user', content: text }], { temperature: 0.85, max_tokens: 400 });
      let items = [];
      try {
        const a0 = raw.indexOf('['), b0 = raw.lastIndexOf(']');
        items = JSON.parse(raw.slice(a0, b0 + 1).replace(/,(\s*[}\]])/g, '$1'));
      } catch (_) {
        const re = /"name"\s*:\s*"([^"]+)"[^{}]*?"reply"\s*:\s*"([^"]+)"/g; let mm;
        while ((mm = re.exec(raw))) items.push({ name: mm[1], reply: mm[2] });
      }
      const reactions = (Array.isArray(items) ? items : []).slice(0, 2).map(it => {
        const nm = clean(it && it.name, 60).toLowerCase();
        const hit = pool.find(x => nm && (nm.startsWith(x.name.split(/\s+/)[0].toLowerCase()) || x.name.toLowerCase().startsWith(nm)));
        return hit ? { index: hit.i, name: hit.name, reply: clean(it.reply, 400) } : null;
      }).filter(r => r && r.reply);
      if (!reactions.length) {
        const plain = clean(raw.replace(/```/g, '').replace(/[\[\]{}]/g, ''), 300);
        if (!plain) return res.status(502).json({ ok: false, reason: 'upstream_error' });
        reactions.push({ index: pool[0].i, name: pool[0].name, reply: plain });
      }
      return res.status(200).json({ ok: true, reactions });
    } catch (e) {
      console.error('Farm react error:', e);
      const rate = /\b429\b/.test(String(e.message));
      return res.status(rate ? 429 : 502).json({ ok: false, reason: rate ? 'rate_limited' : 'upstream_error' });
    }
  }

  return res.status(400).json({ error: 'Invalid action' });
}
