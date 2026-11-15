// api/intel.js — Market Intel: потенциал мини-продукта по следам в интернете.
// Действия: login | run | enrich | history. Поиск без ключей: Reddit + HN Algolia + RSS.
// Анализ: Groq openai/gpt-oss-120b (strict JSON). RU-сегменты: GigaChat (enrich).
// Скоринг: код по intel/scoring.json. Пакет списывается только при успешном отчёте.
import crypto from 'crypto';
import https from 'https';
import fs from 'fs';
import path from 'path';

const ALLOW = ['https://my-pro-skills.ru', 'http://localhost:8000'];
const SECRET = process.env.INTEL_SECRET || 'set-INTEL_SECRET-in-env';
const UA = 'MarketIntel/1.0 (research; my-pro-skills.ru)';

// ---------- Supabase ----------
function sb() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url: process.env.SUPABASE_URL, h: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
}

// ---------- пароль / сессия ----------
const sha256hex = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const hmac = d => crypto.createHmac('sha256', SECRET).update(d).digest('hex');
async function makeToken(id) { const p = `${id}.${Date.now() + 7 * 86400000}`; return `${p}.${hmac(p)}`; }
function verifyToken(req) {
  const t = (req.headers.cookie || '').split('; ').find(c => c.startsWith('intel_token='))?.slice(12);
  if (!t) return null;
  const [id, exp, sig] = t.split('.');
  if (!id || !exp || !sig || Date.now() > Number(exp)) return null;
  return hmac(`${id}.${exp}`) === sig ? id : null;
}
const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

// ---------- лимиты (готовая api_rate_hit из защиты RPG) ----------
async function rateHit(key, win, limit) {
  const { url, h } = sb();
  try {
    const r = await fetch(`${url}/rest/v1/rpc/api_rate_hit`, { method: 'POST', headers: h, body: JSON.stringify({ p_key: key, p_window_sec: win, p_limit: limit }) });
    if (!r.ok) return true;
    return (await r.json()) !== false;
  } catch (_) { return true; }
}

// ---------- HTTP ----------
function sreq(method, urlStr, headers, body, timeoutMs = 3000, insecure = false) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const r = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers, rejectUnauthorized: !insecure, timeout: timeoutMs }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, text: d }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// ---------- сбор следов: три источника без ключей ----------
async function redditSearch(q) {
  try {
    const r = await sreq('GET', `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&limit=6&sort=relevance&t=year`, { 'User-Agent': UA }, null, 3000);
    if (r.status !== 200) return [];
    return ((JSON.parse(r.text).data || {}).children || []).map(c => c.data || {}).filter(x => x.title).map(x => ({
      title: String(x.title).slice(0, 200),
      snippet: String(x.selftext || x.title).replace(/\s+/g, ' ').slice(0, 450),
      link: 'https://www.reddit.com' + (x.permalink || ''), source: 'reddit'
    }));
  } catch (_) { return []; }
}
async function hnSearch(q) {
  try {
    const r = await sreq('GET', `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=6`, { 'User-Agent': UA }, null, 3000);
    if (r.status !== 200) return [];
    return (JSON.parse(r.text).hits || []).filter(x => x.title).map(x => ({
      title: String(x.title).slice(0, 200),
      snippet: String(x.story_text || x.title).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 450),
      link: x.url || `https://news.ycombinator.com/item?id=${x.objectID}`, source: 'hn'
    }));
  } catch (_) { return []; }
}
async function rssFetch(url) {
  try {
    const r = await sreq('GET', url, { 'User-Agent': UA }, null, 3000);
    if (r.status !== 200) return [];
    const items = r.text.match(/<item>[\s\S]*?<\/item>|<entry>[\s\S]*?<\/entry>/g) || [];
    const pick = (s, re) => ((s.match(re) || [])[1] || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return items.slice(0, 5).map(it => ({
      title: pick(it, /<title>([\s\S]*?)<\/title>/).slice(0, 200),
      snippet: pick(it, /<description>([\s\S]*?)<\/description>|<content[^>]*>([\s\S]*?)<\/content>/).slice(0, 450),
      link: pick(it, /<link>([\s\S]*?)<\/link>/) || ((it.match(/<link[^>]*href="([^"]+)"/) || [])[1] || ''), source: 'rss'
    })).filter(x => x.title);
  } catch (_) { return []; }
}
async function gatherSignals(brief) {
  const pains = (brief.pains || []).slice(0, 2);
  const compQ = `${brief.category || brief.product_name} app alternatives`;
  const jobs = [
    ...pains.map(q => redditSearch(q)),
    redditSearch(pains[0] ? pains[0] + ' forum' : brief.product_name),
    hnSearch(compQ),
    rssFetch('https://vc.ru/rss'),
    rssFetch('https://medium.com/feed/tag/startups')
  ];
  const batches = await Promise.allSettled(jobs);
  const out = [];
  for (const b of batches) {
    if (b.status !== 'fulfilled') continue;
    for (const it of b.value) { if (out.length >= 24) break; out.push({ ...it, idx: out.length }); }
  }
  return out;
}

// ---------- Groq: strict JSON ----------
async function groqAnalyze(messages, schema) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');
  const r = await sreq('POST', 'https://api.groq.com/openai/v1/chat/completions', { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, JSON.stringify({
    model: 'openai/gpt-oss-120b', messages, temperature: 0.2, reasoning_effort: 'low', max_tokens: 1800,
    response_format: { type: 'json_schema', json_schema: { name: 'intel_report', strict: true, schema } }
  }), 6500);
  if (r.status === 429) throw new Error('groq_rate_limited');
  if (r.status !== 200) throw new Error('groq ' + r.status + ': ' + r.text.slice(0, 200));
  const c = (JSON.parse(r.text).choices?.[0]?.message?.content || '').trim();
  if (!c) throw new Error('groq empty');
  return JSON.parse(c);
}

// ---------- GigaChat: RU-сегменты ----------
let gCache = { token: null, exp: 0 };
async function gigaToken() {
  if (gCache.token && Date.now() < gCache.exp - 60000) return gCache.token;
  const auth = process.env.GIGACHAT_AUTH_KEY || Buffer.from((process.env.GIGACHAT_CLIENT_ID || '') + ':' + (process.env.GIGACHAT_CLIENT_SECRET || '')).toString('base64');
  const r = await sreq('POST', 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth', { Authorization: 'Basic ' + auth, RqUID: crypto.randomUUID(), 'Content-Type': 'application/x-www-form-urlencoded' }, 'scope=' + (process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS'), 6000, true);
  if (r.status !== 200) throw new Error('giga oauth ' + r.status);
  const j = JSON.parse(r.text);
  gCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 1800) * 1000 };
  return gCache.token;
}
async function gigaChat(messages) {
  const t = await gigaToken();
  const r = await sreq('POST', 'https://api.giga.chat/v1/chat/completions', { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, JSON.stringify({ model: process.env.GIGACHAT_MODEL || 'GigaChat-2-Pro', messages, temperature: 0.4, max_tokens: 1500 }), 8000, true);
  if (r.status !== 200) throw new Error('giga ' + r.status);
  return (JSON.parse(r.text).choices?.[0]?.message?.content || '').trim();
}

// ---------- скоринг ----------
let scCache = null;
function scoring() {
  if (scCache) return scCache;
  try { scCache = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'intel', 'scoring.json'), 'utf8')); }
  catch (_) { scCache = { weights: { demand: .30, unresolved_pain: .25, willingness_to_pay: .20, competition: .15, audience_reach: .10 }, thresholds: { high: 70, medium: 45 } }; }
  return scCache;
}
const verdictOf = s => { const t = scoring().thresholds; return s >= t.high ? 'Стоит тестировать' : s >= t.medium ? 'Спорно: нужен дешёвый эксперимент' : 'Спроса не видно'; };

// ---------- анти-галлюцинации ----------
function sanitize(a, n) {
  const idx = arr => (Array.isArray(arr) ? arr : []).map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < n);
  const sig = {};
  for (const k of ['demand', 'unresolved_pain', 'willingness_to_pay', 'competition', 'audience_reach']) {
    const s = (a.signals || {})[k] || {};
    sig[k] = { score: Math.max(0, Math.min(100, Number(s.score) || 0)), comment: String(s.comment || '').slice(0, 400), evidence_idx: idx(s.evidence_idx) };
  }
  return {
    signals: sig,
    competitors: (Array.isArray(a.competitors) ? a.competitors : []).slice(0, 8).map(c => ({ name: String(c.name || '').slice(0, 100), type: c.type === 'indirect' ? 'indirect' : 'direct', positioning: String(c.positioning || '').slice(0, 300), weakness: String(c.weakness || '').slice(0, 300), evidence_idx: idx(c.evidence_idx) })),
    trends: (Array.isArray(a.trends) ? a.trends : []).slice(0, 6).map(t => ({ trend: String(t.trend || '').slice(0, 120), opportunity: String(t.opportunity || '').slice(0, 300), evidence_idx: idx(t.evidence_idx) })),
    base_segments: (Array.isArray(a.base_segments) ? a.base_segments : []).slice(0, 4).map(s => ({ name: String(s.name || '').slice(0, 120), pain: String(s.pain || '').slice(0, 300), habitats: (Array.isArray(s.habitats) ? s.habitats : []).slice(0, 6).map(h => String(h).slice(0, 80)), offer_hypothesis: String(s.offer_hypothesis || '').slice(0, 300) })),
    summary: String(a.summary || '').slice(0, 800)
  };
}

// ---------- квота ----------
async function quota(id) {
  const { url, h } = sb();
  const [a, u] = await Promise.all([
    fetch(`${url}/rest/v1/intel_accesses?id=eq.${id}&select=package_limit`, { headers: h }),
    fetch(`${url}/rest/v1/intel_runs?access_id=eq.${id}&select=id`, { headers: h })
  ]);
  const ar = await a.json(), ur = await u.json();
  if (!Array.isArray(ar) || !ar.length) return null;
  const limit = ar[0].package_limit, used = Array.isArray(ur) ? ur.length : 0;
  return { limit, used, remaining: Math.max(0, limit - used) };
}

const SIG_SCHEMA = { type: 'object', properties: { score: { type: 'integer' }, comment: { type: 'string' }, evidence_idx: { type: 'array', items: { type: 'integer' } } }, required: ['score', 'comment', 'evidence_idx'], additionalProperties: false };
const SCHEMA = {
  type: 'object',
  properties: {
    signals: { type: 'object', properties: { demand: SIG_SCHEMA, unresolved_pain: SIG_SCHEMA, willingness_to_pay: SIG_SCHEMA, competition: SIG_SCHEMA, audience_reach: SIG_SCHEMA }, required: ['demand', 'unresolved_pain', 'willingness_to_pay', 'competition', 'audience_reach'], additionalProperties: false },
    competitors: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', enum: ['direct', 'indirect'] }, positioning: { type: 'string' }, weakness: { type: 'string' }, evidence_idx: { type: 'array', items: { type: 'integer' } } }, required: ['name', 'type', 'positioning', 'weakness', 'evidence_idx'], additionalProperties: false } },
    trends: { type: 'array', items: { type: 'object', properties: { trend: { type: 'string' }, opportunity: { type: 'string' }, evidence_idx: { type: 'array', items: { type: 'integer' } } }, required: ['trend', 'opportunity', 'evidence_idx'], additionalProperties: false } },
    base_segments: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, pain: { type: 'string' }, habitats: { type: 'array', items: { type: 'string' } }, offer_hypothesis: { type: 'string' } }, required: ['name', 'pain', 'habitats', 'offer_hypothesis'], additionalProperties: false } },
    summary: { type: 'string' }
  },
  required: ['signals', 'competitors', 'trends', 'base_segments', 'summary'],
  additionalProperties: false
};

// ---------- HANDLER ----------
export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOW.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = String(req.query.action || '');

  // ===== LOGIN =====
  if (action === 'login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (!(await rateHit(`intel:login:${ip}`, 60, 5)) || !(await rateHit(`intel:login:${ip}:h`, 3600, 30)))
      return res.status(429).json({ error: 'too_many_attempts' });
    const pw = String(req.body?.password || '');
    if (!pw || pw.length > 128) return res.status(400).json({ error: 'password required' });
    const { url, h } = sb();
    const r = await fetch(`${url}/rest/v1/intel_accesses?password_hash=eq.${sha256hex(pw)}&is_active=eq.true&select=id,label`, { headers: h });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return res.status(401).json({ error: 'Неверный пароль' });
    res.setHeader('Set-Cookie', `intel_token=${await makeToken(rows[0].id)}; HttpOnly; Secure; SameSite=Strict; Path=/api/intel; Max-Age=604800`);
    return res.status(200).json({ ok: true, label: rows[0].label, quota: await quota(rows[0].id) });
  }

  // ===== HISTORY =====
  if (action === 'history' && req.method === 'GET') {
    const id = verifyToken(req);
    if (!id) return res.status(401).json({ error: 'unauthorized' });
    const { url, h } = sb();
    const rid = String(req.query.id || '');
    if (rid) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(rid)) return res.status(400).json({ error: 'bad id' });
      const r = await fetch(`${url}/rest/v1/intel_runs?id=eq.${rid}&access_id=eq.${id}&select=*`, { headers: h });
      const rows = await r.json();
      if (!Array.isArray(rows) || !rows.length) return res.status(404).json({ error: 'not found' });
      return res.status(200).json({ run: rows[0], quota: await quota(id) });
    }
    const r = await fetch(`${url}/rest/v1/intel_runs?access_id=eq.${id}&select=id,brief,score,verdict,created_at&order=created_at.desc&limit=20`, { headers: h });
    const items = (await r.json() || []).map(x => ({ id: x.id, product: x.brief?.product_name || '—', score: x.score, verdict: x.verdict, created_at: x.created_at }));
    return res.status(200).json({ items, quota: await quota(id) });
  }

  // ===== RUN =====
  if (action === 'run' && req.method === 'POST') {
    const id = verifyToken(req);
    if (!id) return res.status(401).json({ error: 'unauthorized' });
    if (!(await rateHit(`intel:run:${clientIp(req)}`, 60, 6))) return res.status(429).json({ error: 'too_many_requests' });
    const q = await quota(id);
    if (!q) return res.status(401).json({ error: 'access not found' });
    if (q.remaining <= 0) return res.status(429).json({ error: 'package_exhausted', quota: q });

    const b = req.body?.brief || {};
    const name = String(b.product_name || '').trim(), desc = String(b.description || '').trim();
    const pains = (Array.isArray(b.pains) ? b.pains : []).slice(0, 3).map(x => String(x).trim()).filter(Boolean);
    if (!name || !desc) return res.status(400).json({ error: 'product_name and description required' });
    if (name.length > 120 || desc.length > 2000) return res.status(400).json({ error: 'too long' });
    const brief = { product_name: name, description: desc, category: String(b.category || '').slice(0, 120), target_geo: b.target_geo === 'EN' ? 'EN' : 'RU', price_model: String(b.price_model || '').slice(0, 120), pains };

    const snippets = await gatherSignals(brief);
    if (!snippets.length) return res.status(502).json({ error: 'no_signals', message: 'Источники молчат, пакет не списан. Повторите позже.' });

    let analysis;
    try {
      analysis = await groqAnalyze([
        { role: 'system', content: 'Ты — старший аналитик рынка. Оцени потенциал мини-продукта ТОЛЬКО по приведённым следам. Сигналы 0-100: demand (активность поиска решения), unresolved_pain (боль не закрыта текущими решениями), willingness_to_pay (платные аналоги/жалобы на цены), competition (ИНВЕРСИЯ: 100=конкуренты слабые, 0=рынок перегрет), audience_reach (концентрированные места обитания ЦА). Каждый сигнал/конкурент/тренд ссылается на сниппеты через evidence_idx. Не выдумывай источники; мало данных — низкий score и честный comment. summary 2-4 предложения.' },
        { role: 'user', content: `ПРОДУКТ: ${brief.product_name}\nОПИСАНИЕ: ${brief.description}\nКАТЕГОРИЯ: ${brief.category || '—'}\nГЕО: ${brief.target_geo}\nБОЛИ: ${pains.join(' | ') || '—'}\n\nСЛЕДЫ (индекс = номер):\n${snippets.map(s => `[${s.idx}] (${s.source}) ${s.title}\n    ${s.snippet}\n    ${s.link}`).join('\n\n')}\n\nВерни JSON по схеме.` }
      ], SCHEMA);
    } catch (e) {
      console.error('groq failed:', e.message);
      return res.status(502).json({ error: 'analyze_failed', detail: String(e.message) });
    }
    const rep = sanitize(analysis, snippets.length);
    const w = scoring().weights;
    const score = Math.round(Object.entries(w).reduce((s, [k, v]) => s + (rep.signals[k]?.score || 0) * v, 0));
    const verdict = verdictOf(score);

    const { url, h } = sb();
    const ins = await fetch(`${url}/rest/v1/intel_runs`, { method: 'POST', headers: { ...h, Prefer: 'return=representation' }, body: JSON.stringify({ access_id: id, brief, signals: snippets, report: rep, score, verdict }) });
    if (!ins.ok) return res.status(502).json({ error: 'save_failed' });
    const saved = (await ins.json())[0];
    return res.status(200).json({ ok: true, run: saved, quota: await quota(id) });
  }

  // ===== ENRICH (RU-сегменты, пакет не тратится) =====
  if (action === 'enrich' && req.method === 'POST') {
    const id = verifyToken(req);
    if (!id) return res.status(401).json({ error: 'unauthorized' });
    const rid = String(req.body?.run_id || '');
    if (!/^[A-Za-z0-9-]{1,64}$/.test(rid)) return res.status(400).json({ error: 'run_id required' });
    const { url, h } = sb();
    const r = await fetch(`${url}/rest/v1/intel_runs?id=eq.${rid}&access_id=eq.${id}&select=*`, { headers: h });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return res.status(404).json({ error: 'not found' });
    const run = rows[0], report = run.report || {};
    if (Array.isArray(report.segments) && report.segments.length) return res.status(200).json({ ok: true, already_enriched: true, run });
    const sn = Array.isArray(run.signals) ? run.signals : [];
    let segments = [];
    try {
      const raw = await gigaChat([
        { role: 'system', content: 'Выдели 2-4 сегмента ЦА продукта по сниппетам. Для каждого: name, pain_quote (ДОСЛОВНАЯ цитата боли из сниппета, до 25 слов; если нет — пустая строка), habitats (каналы/форумы/сабреддиты), offer_hypothesis. ТОЛЬКО JSON-массив, без markdown.' },
        { role: 'user', content: `Продукт: ${run.brief?.product_name || ''}\nОписание: ${run.brief?.description || ''}\n\nСниппеты:\n${sn.map(s => `[${s.idx}] ${s.title}\n    ${s.snippet}`).join('\n\n') || '—'}\n\nВерни JSON-массив.` }
      ]);
      const f = raw.indexOf('['), l = raw.lastIndexOf(']');
      if (f !== -1 && l > f) {
        const pool = sn.map(s => String(s.snippet || '').toLowerCase()).join('\n');
        segments = (JSON.parse(raw.slice(f, l + 1).replace(/,(\s*[}\]])/g, '$1')) || []).slice(0, 4).map(s => ({
          name: String(s.name || '').slice(0, 120),
          pain_quote: String(s.pain_quote || '').slice(0, 300),
          habitats: (Array.isArray(s.habitats) ? s.habitats : []).slice(0, 6).map(x => String(x).slice(0, 80)),
          offer_hypothesis: String(s.offer_hypothesis || '').slice(0, 300)
        }));
        for (const s of segments) if (s.pain_quote && !pool.includes(s.pain_quote.toLowerCase())) s.pain_quote = '';
      }
    } catch (e) { console.error('enrich failed:', e.message); }
    if (segments.length) {
      report.segments = segments;
      await fetch(`${url}/rest/v1/intel_runs?id=eq.${rid}`, { method: 'PATCH', headers: h, body: JSON.stringify({ report }) });
    }
    return res.status(200).json({ ok: true, run: { ...run, report } });
  }

  return res.status(404).json({ error: 'unknown action' });
}
