// api/intel.js — Market Intel: оценка рыночного потенциала мини-продукта по следам в интернете.
// Один файл, четыре действия: login, run, enrich, history.
// Стек: Supabase (intel_accesses, intel_runs), Serper.dev (поиск),
//       Groq openai/gpt-oss-120b (анализ со strict JSON), GigaChat (RU-сегменты в enrich).
import crypto from 'crypto';
import https from 'https';
import fs from 'fs';
import path from 'path';

const ALLOW = ['https://my-pro-skills.ru', 'http://localhost:8000'];
const SECRET = process.env.INTEL_SECRET || 'please-set-INTEL-secret-in-env';

// ====================== Supabase ======================
function sb() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    url: process.env.SUPABASE_URL,
    h: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  };
}

// ====================== Пароль + сессия ======================
function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

const enc = new TextEncoder();
async function hmac(data) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function makeToken(accessId) {
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  const payload = `${accessId}.${exp}`;
  return `${payload}.${await hmac(payload)}`;
}

async function verifyToken(req) {
  const cookie = req.headers.cookie || '';
  const token = cookie.split('; ').find(c => c.startsWith('intel_token='))?.slice(12);
  if (!token) return null;
  const [accessId, exp, sig] = token.split('.');
  if (!accessId || !exp || !sig) return null;
  if (Date.now() > Number(exp)) return null;
  if (await hmac(`${accessId}.${exp}`) !== sig) return null;
  return accessId;
}

// ====================== Rate limit (через api_rate_hit из _guard.js) ======================
const clientIp = req => String((req.headers && req.headers['x-forwarded-for']) || '')
  .split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';

async function rateHit(key, windowSec, limit) {
  const { url, h } = sb();
  try {
    const r = await fetch(`${url}/rest/v1/rpc/api_rate_hit`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ p_key: key, p_window_sec: windowSec, p_limit: limit }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined
    });
    if (!r.ok) return true; // счётчик недоступен — пропускаем (fail-open для логина)
    const v = await r.json();
    return typeof v === 'boolean' ? v : true;
  } catch (_) { return true; }
}

// ====================== HTTP-запросы (sreq как в evaluate.js) ======================
function sreq(method, urlStr, headers, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const r = https.request({
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method, headers,
      rejectUnauthorized: true, timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    r.on('timeout', () => r.destroy(new Error('upstream timeout')));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// ====================== Serper (поиск в Google) ======================
async function serper(query, { gl = 'ru', hl = 'ru', num = 8 } = {}) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return [];
  try {
    const r = await sreq('POST', 'https://google.serper.dev/search', {
      'X-API-KEY': key, 'Content-Type': 'application/json'
    }, JSON.stringify({ q: query, gl, hl, num }), 5000);
    if (r.status !== 200) return [];
    const j = JSON.parse(r.text);
    const organic = (j.organic || []).slice(0, num).map((x, i) => ({
      idx: null, title: String(x.title || '').slice(0, 200),
      snippet: String(x.snippet || x.description || '').slice(0, 500),
      link: String(x.link || '')
    }));
    return organic.filter(x => x.title || x.snippet);
  } catch (_) { return []; }
}

// ====================== Groq (анализ со strict JSON) ======================
async function groqAnalyze(messages, schema) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');
  const r = await sreq('POST', 'https://api.groq.com/openai/v1/chat/completions', {
    Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'
  }, JSON.stringify({
    model: 'openai/gpt-oss-120b',
    messages,
    temperature: 0.2,
    response_format: { type: 'json_schema', json_schema: { schema, strict: true } }
  }), 20000);
  if (r.status === 429) throw new Error('groq_rate_limited');
  if (r.status !== 200) throw new Error('groq ' + r.status + ': ' + r.text.slice(0, 300));
  const j = JSON.parse(r.text);
  const content = (j.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('groq: пустой ответ');
  try { return JSON.parse(content); }
  catch (e) { throw new Error('groq: невалидный JSON: ' + e.message); }
}

// ====================== GigaChat (RU-сегменты в enrich) ======================
let gigaCache = { token: null, exp: 0 };
async function gigaToken() {
  if (gigaCache.token && Date.now() < gigaCache.exp - 60000) return gigaCache.token;
  const auth = process.env.GIGACHAT_AUTH_KEY ||
    Buffer.from((process.env.GIGACHAT_CLIENT_ID || '') + ':' + (process.env.GIGACHAT_SECRET || '')).toString('base64');
  const scope = process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';
  const r = await sreq('POST', 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
    Authorization: 'Basic ' + auth, RqUID: crypto.randomUUID(),
    'Content-Type': 'application/x-www-form-urlencoded'
  }, 'scope=' + scope, 10000);
  if (r.status !== 200) throw new Error('giga oauth ' + r.status);
  const j = JSON.parse(r.text);
  gigaCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 1800) * 1000 };
  return gigaCache.token;
}

async function gigaChat(messages) {
  const token = await gigaToken();
  const r = await sreq('POST', 'https://api.giga.chat/v1/chat/completions', {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'
  }, JSON.stringify({
    model: process.env.GIGACHAT_MODEL || 'GigaChat-2-Pro',
    messages, temperature: 0.4, max_tokens: 2000
  }), 20000);
  if (r.status !== 200) throw new Error('giga ' + r.status + ': ' + r.text.slice(0, 200));
  const j = JSON.parse(r.text);
  return (j.choices?.[0]?.message?.content || '').trim();
}

// ====================== Скоринг (из scoring.json) ======================
let scoringCache = null;
function loadScoring() {
  if (scoringCache) return scoringCache;
  try {
    const p = path.join(process.cwd(), 'intel', 'scoring.json');
    scoringCache = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    scoringCache = {
      weights: { demand: 0.30, unresolved_pain: 0.25, willingness_to_pay: 0.20, competition: 0.15, audience_reach: 0.10 },
      thresholds: { high: 70, medium: 45 }
    };
  }
  return scoringCache;
}

function computeVerdict(score) {
  const s = loadScoring();
  if (score >= s.thresholds.high) return 'Стоит тестировать';
  if (score >= s.thresholds.medium) return 'Спорно: нужен дешёвый эксперимент';
  return 'Спроса не видно';
}

// ====================== Сбор поисковых гипотез (детерминированно) ======================
function buildQueries(brief) {
  const pains = Array.isArray(brief.pains) ? brief.pains.slice(0, 3) : [];
  const cat = String(brief.category || '').trim();
  const queries = [];
  for (const p of pains) {
    const q = String(p).trim();
    if (q) queries.push({ q, gl: 'ru', hl: 'ru' });
    if (q) queries.push({ q: q + ' форум отзывы', gl: 'ru', hl: 'ru' });
  }
  if (cat) queries.push({ q: `${cat} аналоги приложение`, gl: 'ru', hl: 'ru' });
  if (cat) queries.push({ q: `${cat} app competitors`, gl: 'us', hl: 'en' });
  return queries.slice(0, 6); // максимум 6 поисковых запросов
}

// Антигаллюцинация: каждая ссылка на evidence_idx должна быть в пределах массива сниппетов
function sanitizeEvidence(raw, snippets) {
  const max = snippets.length;
  const norm = (arr) => (Array.isArray(arr) ? arr : [])
    .map(x => Number(x))
    .filter(i => Number.isInteger(i) && i >= 0 && i < max);
  const out = { ...raw };
  if (out.signals) {
    for (const k of Object.keys(out.signals)) {
      const s = out.signals[k] || {};
      s.evidence_idx = norm(s.evidence_idx);
      s.score = Math.max(0, Math.min(100, Number(s.score) || 0));
      s.comment = String(s.comment || '').slice(0, 400);
      out.signals[k] = s;
    }
  }
  out.competitors = (Array.isArray(out.competitors) ? out.competitors : []).slice(0, 8).map(c => ({
    name: String(c.name || '').slice(0, 100),
    type: c.type === 'indirect' ? 'indirect' : 'direct',
    positioning: String(c.positioning || '').slice(0, 300),
    weakness: String(c.weakness || '').slice(0, 300),
    evidence_idx: norm(c.evidence_idx)
  }));
  out.trends = (Array.isArray(out.trends) ? out.trends : []).slice(0, 6).map(t => ({
    trend: String(t.trend || '').slice(0, 120),
    opportunity: String(t.opportunity || '').slice(0, 300),
    evidence_idx: norm(t.evidence_idx)
  }));
  out.base_segments = (Array.isArray(out.base_segments) ? out.base_segments : []).slice(0, 4).map(s => ({
    name: String(s.name || '').slice(0, 120),
    pain: String(s.pain || '').slice(0, 300),
    habitats: (Array.isArray(s.habitats) ? s.habitats : []).slice(0, 6).map(h => String(h).slice(0, 80)),
    offer_hypothesis: String(s.offer_hypothesis || '').slice(0, 300)
  }));
  out.summary = String(out.summary || '').slice(0, 800);
  return out;
}

// ====================== Квота пакета ======================
async function getQuota(accessId) {
  const { url, h } = sb();
  const [aRes, uRes] = await Promise.all([
    fetch(`${url}/rest/v1/intel_accesses?id=eq.${accessId}&select=package_limit`, { headers: h }),
    fetch(`${url}/rest/v1/intel_runs?access_id=eq.${accessId}&select=id`, { headers: h })
  ]);
  const aRows = await aRes.json();
  const uRows = await uRes.json();
  if (!Array.isArray(aRows) || !aRows.length) return null;
  const limit = aRows[0].package_limit;
  const used = Array.isArray(uRows) ? uRows.length : 0;
  return { limit, used, remaining: Math.max(0, limit - used) };
}

// ====================== HANDLER ======================
export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOW.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = (req.query.action || '').toString();

  // ================= LOGIN =================
  if (action === 'login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (!(await rateHit(`intel:login:${ip}:60`, 60, 5)))
      return res.status(429).json({ error: 'too_many_attempts', retry_after: 60 });
    if (!(await rateHit(`intel:login:${ip}:3600`, 3600, 30)))
      return res.status(429).json({ error: 'too_many_attempts', retry_after: 3600 });

    const password = String(req.body?.password || '');
    if (!password || password.length > 128) return res.status(400).json({ error: 'password required' });

    const { url, h } = sb();
    const r = await fetch(`${url}/rest/v1/intel_accesses?password_hash=eq.${encodeURIComponent(sha256hex(password))}&is_active=eq.true&select=id,label,package_limit`, { headers: h });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return res.status(401).json({ error: 'Неверный пароль' });

    const access = rows[0];
    const token = await makeToken(access.id);
    res.setHeader('Set-Cookie',
      `intel_token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/intel; Max-Age=604800`);

    const quota = await getQuota(access.id);
    return res.status(200).json({ ok: true, label: access.label, quota });
  }

  // ================= HISTORY =================
  if (action === 'history' && req.method === 'GET') {
    const accessId = await verifyToken(req);
    if (!accessId) return res.status(401).json({ error: 'unauthorized' });

    const { url, h } = sb();
    const id = req.query.id;
    if (id && /^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      const r = await fetch(`${url}/rest/v1/intel_runs?id=eq.${id}&access_id=eq.${accessId}&select=*`, { headers: h });
      const rows = await r.json();
      if (!Array.isArray(rows) || !rows.length) return res.status(404).json({ error: 'not found' });
      const quota = await getQuota(accessId);
      return res.status(200).json({ run: rows[0], quota });
    }
    // список последних 20
    const r = await fetch(`${url}/rest/v1/intel_runs?access_id=eq.${accessId}&select=id,brief,score,verdict,created_at&order=created_at.desc&limit=20`, { headers: h });
    const items = await r.json();
    const quota = await getQuota(accessId);
    const list = (Array.isArray(items) ? items : []).map(it => ({
      id: it.id,
      product: (it.brief && it.brief.product_name) || '—',
      score: it.score, verdict: it.verdict, created_at: it.created_at
    }));
    return res.status(200).json({ items: list, quota });
  }

  // ================= RUN =================
  if (action === 'run' && req.method === 'POST') {
    const accessId = await verifyToken(req);
    if (!accessId) return res.status(401).json({ error: 'unauthorized' });

    const quota = await getQuota(accessId);
    if (!quota) return res.status(401).json({ error: 'access not found' });
    if (quota.remaining <= 0) return res.status(429).json({ error: 'package_exhausted', quota });

    const brief = req.body?.brief || {};
    const productName = String(brief.product_name || '').trim();
    const description = String(brief.description || '').trim();
    const pains = Array.isArray(brief.pains) ? brief.pains.slice(0, 3).map(p => String(p).trim()).filter(Boolean) : [];
    if (!productName || !description) {
      return res.status(400).json({ error: 'product_name and description are required' });
    }
    if (productName.length > 120 || description.length > 2000) {
      return res.status(400).json({ error: 'product_name or description too long' });
    }

    const cleanBrief = {
      product_name: productName, description,
      category: String(brief.category || '').slice(0, 120),
      target_geo: (['RU', 'EN'].includes(brief.target_geo) ? brief.target_geo : 'RU'),
      price_model: String(brief.price_model || '').slice(0, 120),
      pains
    };

    // 1. Сбор сниппетов (Serper, все запросы параллельно)
    const queries = buildQueries(cleanBrief);
    const results = await Promise.all(queries.map(q => serper(q.q, { gl: q.gl, hl: q.hl })));
    let snippets = [];
    for (const batch of results) {
      for (const it of batch) {
        if (snippets.length >= 24) break;
        snippets.push({ ...it, idx: snippets.length });
      }
    }

    // 2. Groq: анализ со strict JSON
    const analysisSchema = {
      type: 'object',
      properties: {
        signals: {
          type: 'object',
          properties: {
            demand:            { type: 'object', properties: { score: { type: 'integer' }, comment: { type: 'string' }, evidence_idx: { type: 'array', items: { type: 'integer' } } }, required: ['score','comment','evidence_idx'], additionalProperties: false },
            unresolved_pain:   { type: 'object', properties: { score: { type: 'integer' }, comment: { type: 'string' }, evidence_idx: { type: 'array', items: { type: 'integer' } } }, required: ['score','comment','evidence_idx'], additionalProperties: false },
            willingness_to_pay:{ type: 'object', properties: { score: { type: 'integer' }, comment: { type: 'string' }, evidence_idx: { type: 'array', items: { type: 'integer' } } }, required: ['score','comment','evidence_idx'], additionalProperties: false },
            competition:       { type: 'object', properties: { score: { type: 'integer' }, comment: { type: 'string' }, evidence_idx: { type: 'array', items: { type: 'integer' } } }, required: ['score','comment','evidence_idx'], additionalProperties: false },
            audience_reach:    { type: 'object', properties: { score: { type: 'integer' }, comment: { type: 'string' }, evidence_idx: { type: 'array', items: { type: 'integer' } } }, required: ['score','comment','evidence_idx'], additionalProperties: false }
          },
          required: ['demand','unresolved_pain','willingness_to_pay','competition','audience_reach'],
          additionalProperties: false
        },
        competitors: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, type: { type: 'string', enum: ['direct','indirect'] }, positioning: { type: 'string' }, weakness: { type: 'string' }, evidence_idx: { type: 'array', items: { type: 'integer' } } },
            required: ['name','type','positioning','weakness','evidence_idx'],
            additionalProperties: false
          }
        },
        trends: {
          type: 'array',
          items: {
            type: 'object',
            properties: { trend: { type: 'string' }, opportunity: { type: 'string' }, evidence_idx: { type: 'array', items: { type: 'integer' } } },
            required: ['trend','opportunity','evidence_idx'],
            additionalProperties: false
          }
        },
        base_segments: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, pain: { type: 'string' }, habitats: { type: 'array', items: { type: 'string' } }, offer_hypothesis: { type: 'string' } },
            required: ['name','pain','habitats','offer_hypothesis'],
            additionalProperties: false
          }
        },
        summary: { type: 'string' }
      },
      required: ['signals','competitors','trends','base_segments','summary'],
      additionalProperties: false
    };

    let analysis;
    try {
      analysis = await groqAnalyze([
        { role: 'system', content:
`Ты — старший аналитик рынка. Оцени рыночный потенциал мини-продукта на основе найденных в интернете следов.

ПРАВИЛА:
1. Каждый из 5 сигналов оцени по шкале 0–100:
   - demand: насколько люди активно ищут решение этой боли
   - unresolved_pain: есть ли свидетельства, что текущие решения не закрывают боль (отзывы, вопросы)
   - willingness_to_pay: есть ли платные аналоги, какие цены, жалобы на отсутствие платных версий
   - competition: ПЛОТНОСТЬ конкурентов. Инверсия: 100 = конкуренты слабые/отсутствуют, 0 = рынок перегрет сильными игроками
   - audience_reach: существуют ли концентрированные места обитания ЦА (каналы, сабреддиты, форумы, чаты)
2. Для каждого сигнала укажи evidence_idx — индексы релевантных сниппетов из списка ниже.
3. Сформулируй 2–8 конкурентов (прямых и косвенных), 2–6 трендов и 2–4 базовых сегмента аудитории.
4. Каждый объект конкурента/тренда должен ссылаться на сниппеты через evidence_idx.
5. Не выдумывай источники. Если данных мало — честно укажи низкий score и объясни почему.
6. Итог: краткий summary 2–4 предложения о потенциале продукта.` },
        { role: 'user', content:
`ПРОДУКТ:
Название: ${cleanBrief.product_name}
Описание: ${cleanBrief.description}
Категория: ${cleanBrief.category || '—'}
Гео: ${cleanBrief.target_geo}
Боли аудитории (словами создателя): ${pains.join(' | ') || 'не указаны'}

НАЙДЕННЫЕ СЛЕДЫ В ИНТЕРНЕТЕ (сниппеты, индекс = номер строки):
${snippets.map((s, i) => `[${i}] ${s.title}\n    ${s.snippet}\n    ${s.link}`).join('\n\n')}

Верни JSON строго по схеме.` }
      ], analysisSchema);
    } catch (e) {
      console.error('Groq analyze failed:', e);
      return res.status(502).json({ error: 'analyze_failed', detail: String(e.message) });
    }

    analysis = sanitizeEvidence(analysis, snippets);

    // 3. Код считает итоговый балл
    const sc = loadScoring();
    const sig = analysis.signals;
    let total = 0;
    for (const [k, w] of Object.entries(sc.weights)) {
      total += (Number(sig[k]?.score) || 0) * w;
    }
    const score = Math.round(total);
    const verdict = computeVerdict(score);

    const report = { signals: sig, competitors: analysis.competitors, trends: analysis.trends,
                     base_segments: analysis.base_segments, summary: analysis.summary };

    // 4. INSERT в intel_runs — списание пакета
    const { url, h } = sb();
    const ins = await fetch(`${url}/rest/v1/intel_runs`, {
      method: 'POST', headers: { ...h, Prefer: 'return=representation' },
      body: JSON.stringify({
        access_id: accessId,
        brief: cleanBrief,
        signals: snippets,
        report,
        score,
        verdict
      })
    });
    if (!ins.ok) {
      const t = await ins.text();
      console.error('insert run failed:', ins.status, t);
      return res.status(502).json({ error: 'save_failed', detail: t.slice(0, 300) });
    }
    const saved = (await ins.json())[0];
    const newQuota = await getQuota(accessId);
    return res.status(200).json({ ok: true, run: saved, quota: newQuota });
  }

  // ================= ENRICH (RU-сегменты через GigaChat) =================
  if (action === 'enrich' && req.method === 'POST') {
    const accessId = await verifyToken(req);
    if (!accessId) return res.status(401).json({ error: 'unauthorized' });

    const runId = String(req.body?.run_id || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) return res.status(400).json({ error: 'run_id required' });

    const { url, h } = sb();
    const r = await fetch(`${url}/rest/v1/intel_runs?id=eq.${runId}&access_id=eq.${accessId}&select=*`, { headers: h });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return res.status(404).json({ error: 'run not found' });

    const run = rows[0];
    const report = run.report || {};
    if (Array.isArray(report.segments) && report.segments.length) {
      return res.status(200).json({ ok: true, already_enriched: true });
    }

    const snippets = Array.isArray(run.signals) ? run.signals : [];
    const snippetsText = snippets.map((s, i) =>
      `[${i}] ${s.title || ''}\n    ${s.snippet || ''}\n    ${s.link || ''}`
    ).join('\n\n');

    let segments = [];
    try {
      const raw = await gigaChat([
        { role: 'system', content:
`Ты — исследователь русскоязычного рынка. На основе списка сниппетов из интернета выдели 2–4 сегмента целевой аудитории продукта.

ПРАВИЛА:
1. Для каждого сегмента укажи: name (название сегмента), pain_quote (точная цитата боли из сниппетов, до 25 слов), habitats (где обитают: каналы, форумы, сабреддиты), offer_hypothesis (какой оффер сработает).
2. pain_quote ДОЛЖНА быть дословно взята из одного сниппета. Если не можешь найти — оставь пустой строкой.
3. Формат — ТОЛЬКО валидный JSON-массив объектов {name, pain_quote, habitats[], offer_hypothesis}.
4. Без пояснений, без markdown.` },
        { role: 'user', content:
`Продукт: ${run.brief?.product_name || ''}
Описание: ${run.brief?.description || ''}

Сниппеты:
${snippetsText || '— данных нет —'}

Верни JSON-массив сегментов.` }
      ]);

      const fb = raw.indexOf('['), lb = raw.lastIndexOf(']');
      if (fb !== -1 && lb !== -1) {
        const arr = JSON.parse(raw.slice(fb, lb + 1).replace(/,(\s*[}\]])/g, '$1'));
        segments = (Array.isArray(arr) ? arr : []).slice(0, 4).map(s => ({
          name: String(s.name || '').slice(0, 120),
          pain_quote: String(s.pain_quote || '').slice(0, 300),
          habitats: (Array.isArray(s.habitats) ? s.habitats : []).slice(0, 6).map(h => String(h).slice(0, 80)),
          offer_hypothesis: String(s.offer_hypothesis || '').slice(0, 300)
        }));
        // антигаллюцинация: цитата должна быть подстрокой одного из сниппетов
        const pool = snippets.map(s => String(s.snippet || '').toLowerCase()).join('\n');
        for (const s of segments) {
          if (s.pain_quote && !pool.includes(s.pain_quote.toLowerCase())) s.pain_quote = '';
        }
      }
    } catch (e) {
      console.error('enrich failed:', e);
      // enrich упал — не блокируем пользователя, возвращаем run как есть
    }

    if (segments.length) {
      report.segments = segments;
      await fetch(`${url}/rest/v1/intel_runs?id=eq.${runId}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=representation' },
        body: JSON.stringify({ report })
      });
    }
    return res.status(200).json({ ok: true, run: { ...run, report } });
  }

  return res.status(404).json({ error: 'unknown action' });
}