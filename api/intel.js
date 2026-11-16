// api/intel.js — Market Intel: потенциал мини-продукта по следам в интернете.
// Действия: login | logout | plan | run | enrich | history.
// Источники: Яндекс Search API (если заданы ключ+каталог) → Reddit RSS → HN Algolia.
// Нет доказательства — нет утверждения. Пакет списывается только при успешном отчёте.
import crypto from 'crypto';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { rateLimit, dailyCap } from './_guard.js';

const ALLOW = ['https://my-pro-skills.ru', 'http://localhost:8000'];
const UA = 'MarketIntel/1.0 (research; my-pro-skills.ru)';
const SUBREDDIT = /^[A-Za-z0-9_]{2,30}$/;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const BUDGET_MS = 8000;
const MIN_SNIPPETS = 4, MIN_CITED = 4, MIN_MEASURED = 3;
const SIGNAL_KEYS = ['demand', 'unresolved_pain', 'willingness_to_pay', 'competition', 'audience_reach'];

// ---------- Supabase ----------
function sb() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url: process.env.SUPABASE_URL, h: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
}

// ---------- пароль / сессия ----------
const secret = () => process.env.INTEL_SECRET || '';
const sha256hex = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const hmac = d => crypto.createHmac('sha256', secret()).update(d).digest('hex');
const makeToken = id => { const p = `${id}.${Date.now() + 7 * 86400000}`; return `${p}.${hmac(p)}`; };
function verifyToken(req) {
  const raw = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(c => c.startsWith('intel_token='));
  const t = raw ? raw.slice(12) : '';
  const [id, exp, sig] = t.split('.');
  if (!id || !exp || !sig || !ID_RE.test(id) || Date.now() > Number(exp)) return null;
  const a = Buffer.from(hmac(`${id}.${exp}`), 'hex'), b = Buffer.from(sig, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
}
const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

async function rpcHit(key, win, limit) {
  const { url, h } = sb();
  try {
    const r = await fetch(`${url}/rest/v1/rpc/api_rate_hit`, { method: 'POST', headers: h, body: JSON.stringify({ p_key: key, p_window_sec: win, p_limit: limit }), signal: AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined });
    if (!r.ok) return null;
    const v = await r.json();
    return typeof v === 'boolean' ? v : null;
  } catch (_) { return null; }
}
const cap = () => Number(process.env.INTEL_DAILY_CAP) || 200;

// ---------- HTTP ----------
function sreq(method, urlStr, headers, body, timeoutMs = 3000, insecure = false) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const r = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers, rejectUnauthorized: !insecure, timeout: timeoutMs }, res => {
      res.setEncoding('utf8');
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, text: d }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// ---------- очистка текста: CDATA → сущности → теги → пробелы ----------
const ENT = { quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D' };
const cp = n => { try { return n > 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : ''; } catch (_) { return ''; } };
function decodeEnt(s) {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(+d))
    .replace(/&([a-z]+);/gi, (m, n) => { n = n.toLowerCase(); return n === 'amp' ? m : (ENT[n] !== undefined ? ENT[n] : m); })
    .replace(/&amp;/gi, '&');
}
const stripTags = s => s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
function cleanTxt(raw) {
  const t = String(raw || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const d = decodeEnt(t);
  if (!/</.test(t) && /<[a-z!\/]/i.test(d)) return decodeEnt(stripTags(d));
  return stripTags(d);
}

function parseRss(xml, source, limit = 6) {
  const items = String(xml).match(/<item>[\s\S]*?<\/item>|<entry>[\s\S]*?<\/entry>/g) || [];
  const pick = (s, re) => { const m = s.match(re); return cleanTxt(m ? (m.slice(1).find(Boolean) || '') : ''); };
  return items.slice(0, limit).map(it => ({
    title: pick(it, /<title[^>]*>([\s\S]*?)<\/title>/).slice(0, 200),
    snippet: pick(it, /<description[^>]*>([\s\S]*?)<\/description>|<content[^>]*>([\s\S]*?)<\/content>|<summary[^>]*>([\s\S]*?)<\/summary>/).slice(0, 350),
    link: pick(it, /<link[^>]*>([\s\S]*?)<\/link>/) || ((it.match(/<link[^>]*href="([^"]+)"/) || [])[1] || ''),
    source
  })).filter(x => x.title);
}

// ---------- источники ----------
// Яндекс Search API v2: ответ — JSON { rawData: base64(XML) }, внутри — group/doc, подсветка <hlword>.
async function yandexSearch(q, geo) {
  const key = process.env.YANDEX_SEARCH_API_KEY, folder = process.env.YANDEX_FOLDER_ID;
  if (!key || !folder) return { status: 'no_key', items: [] };
  const ru = geo !== 'EN';
  const body = JSON.stringify({
    query: { searchType: ru ? 'SEARCH_TYPE_RU' : 'SEARCH_TYPE_COM', queryText: String(q).slice(0, 400) },
    folderId: folder,
    responseFormat: 'FORMAT_XML',
    groupSpec: { groupMode: 'GROUP_MODE_FLAT', groupsOnPage: '8', docsInGroup: '1' },
    maxPassages: '3',
    l10n: ru ? 'LOCALIZATION_RU' : 'LOCALIZATION_EN',
    ...(ru ? { region: '225' } : {})
  });
  try {
    const r = await sreq('POST', 'https://searchapi.api.cloud.yandex.net/v2/web/search', { Authorization: `Api-Key ${key}`, 'Content-Type': 'application/json' }, body, 2500);
    if (r.status !== 200) return { status: r.status, items: [] };
    const xml = Buffer.from(JSON.parse(r.text).rawData || '', 'base64').toString('utf8');
    const err = xml.match(/<error[^>]*code="(\d+)"/);
    if (err) return { status: Number(err[1]), items: [] };
    const docs = xml.match(/<doc(?:\s[^>]*)?>[\s\S]*?<\/doc>/g) || [];
    const pick = (s, re) => { const m = s.match(re); return m ? cleanTxt(m[1]) : ''; };
    const items = docs.map(d => {
      const passages = (d.match(/<passage>([\s\S]*?)<\/passage>/g) || [])
        .map(p => cleanTxt(p.replace(/<\/?passage>/g, ''))).filter(Boolean);
      const title = pick(d, /<title>([\s\S]*?)<\/title>/);
      return {
        title: title.slice(0, 200),
        snippet: (passages.join(' ') || title).slice(0, 350),
        link: pick(d, /<url>([\s\S]*?)<\/url>/),
        source: 'yandex'
      };
    }).filter(x => x.title && /^https?:\/\//i.test(x.link));
    return { status: 200, items: items.slice(0, 8) };
  } catch (e) { return { status: String(e.message || 'error'), items: [] }; }
}

async function redditRss(q, sub) {
  const url = sub
    ? `https://www.reddit.com/r/${sub}/search.rss?q=${encodeURIComponent(q)}&restrict_sr=on&sort=relevance&t=all`
    : `https://www.reddit.com/search.rss?q=${encodeURIComponent(q)}&sort=relevance&t=all`;
  try {
    const r = await sreq('GET', url, { 'User-Agent': UA, Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml' }, null, 1800);
    return { status: r.status, items: r.status === 200 ? parseRss(r.text, 'reddit') : [] };
  } catch (e) { return { status: String(e.message || 'error'), items: [] }; }
}

async function hnSearch(q) {
  try {
    const r = await sreq('GET', `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=6`, { 'User-Agent': UA }, null, 1800);
    if (r.status !== 200) return { status: r.status, items: [] };
    return { status: 200, items: (JSON.parse(r.text).hits || []).filter(x => x.title).map(x => ({
      title: String(x.title).slice(0, 200),
      snippet: cleanTxt(x.story_text || x.title).slice(0, 350),
      link: x.url || `https://news.ycombinator.com/item?id=${x.objectID}`, source: 'hn'
    })) };
  } catch (e) { return { status: String(e.message || 'error'), items: [] }; }
}

// ---------- план поиска ----------
function validatePlan(p) {
  const strs = (a, n, max) => [...new Set((Array.isArray(a) ? a : []).map(x => String(x == null ? '' : x).replace(/\s+/g, ' ').trim()).filter(x => x.length >= 3 && x.length <= max))].slice(0, n);
  return {
    queries: strs(p && p.queries, 3, 100),
    ru_queries: strs(p && p.ru_queries, 2, 100),
    subreddits: [...new Set((Array.isArray(p && p.subreddits) ? p.subreddits : []).map(x => String(x == null ? '' : x).replace(/^r\//i, '').trim()).filter(x => SUBREDDIT.test(x)))].slice(0, 3),
    hn_queries: strs(p && p.hn_queries, 2, 100)
  };
}
function fallbackPlan(brief) {
  return validatePlan({
    queries: brief.pains.length ? brief.pains : [brief.product_name],
    ru_queries: brief.pains.length ? brief.pains : [brief.product_name],
    subreddits: [],
    hn_queries: [brief.category || brief.product_name]
  });
}

async function gatherSignals(plan, geo) {
  const jobs = [];
  const yOn = !!(process.env.YANDEX_SEARCH_API_KEY && process.env.YANDEX_FOLDER_ID);
  if (yOn) (plan.ru_queries.length ? plan.ru_queries : plan.queries).slice(0, 2).forEach(q => jobs.push(['yandex', () => yandexSearch(q, geo)]));
  plan.queries.forEach(q => jobs.push(['reddit:all', () => redditRss(q)]));
  if (plan.queries[0]) plan.subreddits.forEach(s => jobs.push([`reddit:r/${s}`, () => redditRss(plan.queries[0], s)]));
  plan.hn_queries.forEach(q => jobs.push(['hn', () => hnSearch(q)]));
  const use = jobs.slice(0, 10);
  const settled = await Promise.allSettled(use.map(([, fn]) => fn()));
  const stats = {}, lists = [];
  settled.forEach((s, i) => {
    const label = use[i][0], v = s.status === 'fulfilled' ? s.value : { status: 'error', items: [] };
    const st = stats[label] || (stats[label] = { requests: 0, items: 0, codes: [] });
    st.requests++; st.items += v.items.length; if (!st.codes.includes(v.status)) st.codes.push(v.status);
    lists.push(v.items);
  });
  const out = [], seen = new Set();
  for (let r = 0; out.length < 20 && lists.some(l => r < l.length); r++) {
    for (const l of lists) {
      const it = l[r];
      if (!it || out.length >= 20) continue;
      const key = it.link || it.title;
      if (seen.has(key)) continue;
      seen.add(key); out.push({ ...it, idx: out.length });
    }
  }
  // семейство источников недоступно целиком (только 403/429, ноль следов) — это не вина описания
  const fam = {};
  for (const [label, st] of Object.entries(stats)) {
    const f = label.split(':')[0];
    const bad = st.items === 0 && st.codes.length > 0 && st.codes.every(c => c === 403 || c === 429);
    fam[f] = fam[f] === undefined ? bad : (fam[f] && bad);
  }
  const names = { reddit: 'Reddit', hn: 'Hacker News', yandex: 'Яндекс' };
  const unavailable = Object.keys(fam).filter(f => fam[f]).map(f => names[f] || f);
  return { items: out, stats, unavailable };
}

// ---------- Groq: strict JSON ----------
async function groq(messages, schema, name, maxTokens, timeoutMs) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');
  const r = await sreq('POST', 'https://api.groq.com/openai/v1/chat/completions', { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, JSON.stringify({
    model: 'openai/gpt-oss-120b', messages, temperature: 0.2, reasoning_effort: 'low', max_tokens: maxTokens,
    response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } }
  }), timeoutMs);
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

// ---------- скоринг (ключи с пробелами нормализуются) ----------
let scCache = null;
function scoring() {
  if (scCache) return scCache;
  const def = { weights: { demand: .30, unresolved_pain: .25, willingness_to_pay: .20, competition: .15, audience_reach: .10 }, thresholds: { high: 70, medium: 45 } };
  const trim = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [String(k).trim(), v]));
  const paths = [
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'intel', 'scoring.json'),
    path.join(process.cwd(), 'intel', 'scoring.json')
  ];
  for (const p of paths) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      scCache = { weights: { ...def.weights, ...trim(raw.weights) }, thresholds: { ...def.thresholds, ...trim(raw.thresholds) } };
      return scCache;
    } catch (_) { /* пробуем следующий путь */ }
  }
  scCache = def;
  return scCache;
}
function scoreOf(signals) {
  const w = scoring().weights;
  const measured = SIGNAL_KEYS.filter(k => signals[k] && signals[k].measured);
  const wsum = measured.reduce((s, k) => s + (Number(w[k]) || 0), 0);
  if (!measured.length || !wsum) return null;
  return Math.round(measured.reduce((s, k) => s + signals[k].score * (Number(w[k]) || 0), 0) / wsum);
}
function verdictOf(score, measuredCount) {
  const t = scoring().thresholds;
  const base = score >= t.high ? 'Стоит тестировать' : score >= t.medium ? 'Спорно: нужен дешёвый эксперимент' : 'Спроса не видно';
  return measuredCount < SIGNAL_KEYS.length ? `${base} (по неполным данным)` : base;
}

// ---------- анти-галлюцинации ----------
function sanitize(a, n) {
  const idx = arr => [...new Set((Array.isArray(arr) ? arr : []).map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < n))];
  const str = (v, m) => String(v == null ? '' : v).slice(0, m);
  const signals = {};
  for (const k of SIGNAL_KEYS) {
    const s = (a.signals || {})[k] || {};
    const ev = idx(s.evidence_idx);
    signals[k] = { score: Math.max(0, Math.min(100, Math.round(Number(s.score) || 0))), comment: str(s.comment, 400), evidence_idx: ev, measured: ev.length > 0 };
  }
  const keep = x => x.evidence_idx.length > 0;
  const list = v => (Array.isArray(v) ? v : []);
  return {
    signals,
    competitors: list(a.competitors).map(c => ({ name: str(c.name, 100), type: c.type === 'indirect' ? 'indirect' : 'direct', positioning: str(c.positioning, 300), weakness: str(c.weakness, 300), evidence_idx: idx(c.evidence_idx) })).filter(keep).slice(0, 8),
    trends: list(a.trends).map(t => ({ trend: str(t.trend, 120), opportunity: str(t.opportunity, 300), evidence_idx: idx(t.evidence_idx) })).filter(keep).slice(0, 6),
    base_segments: list(a.base_segments).map(s => ({ name: str(s.name, 120), pain: str(s.pain, 300), habitats: list(s.habitats).slice(0, 6).map(h => str(h, 80)), offer_hypothesis: str(s.offer_hypothesis, 300), evidence_idx: idx(s.evidence_idx) })).filter(keep).slice(0, 4),
    summary: str(a.summary, 800)
  };
}
function citedUnique(rep) {
  const set = new Set();
  SIGNAL_KEYS.forEach(k => rep.signals[k].evidence_idx.forEach(i => set.add(i)));
  [rep.competitors, rep.trends, rep.base_segments].forEach(arr => arr.forEach(x => x.evidence_idx.forEach(i => set.add(i))));
  return set.size;
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

// ---------- схемы Groq ----------
const IDX = { type: 'array', items: { type: 'integer' } };
const STR = { type: 'string' };
const SIG_SCHEMA = { type: 'object', properties: { score: { type: 'integer' }, comment: STR, evidence_idx: IDX }, required: ['score', 'comment', 'evidence_idx'], additionalProperties: false };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const SCHEMA = obj({
  signals: obj({ demand: SIG_SCHEMA, unresolved_pain: SIG_SCHEMA, willingness_to_pay: SIG_SCHEMA, competition: SIG_SCHEMA, audience_reach: SIG_SCHEMA }),
  competitors: { type: 'array', items: obj({ name: STR, type: { type: 'string', enum: ['direct', 'indirect'] }, positioning: STR, weakness: STR, evidence_idx: IDX }) },
  trends: { type: 'array', items: obj({ trend: STR, opportunity: STR, evidence_idx: IDX }) },
  base_segments: { type: 'array', items: obj({ name: STR, pain: STR, habitats: { type: 'array', items: STR }, offer_hypothesis: STR, evidence_idx: IDX }) },
  summary: STR
});
const PLAN_SCHEMA = obj({ queries: { type: 'array', items: STR }, ru_queries: { type: 'array', items: STR }, subreddits: { type: 'array', items: STR }, hn_queries: { type: 'array', items: STR } });

const SYS_ANALYZE = 'Ты — старший аналитик рынка. Оцени потенциал мини-продукта ТОЛЬКО по приведённым следам. Сигналы 0-100: demand (активность поиска решения), unresolved_pain (боль не закрыта текущими решениями), willingness_to_pay (платные аналоги/жалобы на цены), competition (ИНВЕРСИЯ: 100=конкуренты слабые, 0=рынок перегрет), audience_reach (концентрированные места обитания ЦА). Каждый сигнал, конкурент, тренд и сегмент ОБЯЗАН ссылаться хотя бы на один сниппет через evidence_idx; ссылайся только на сниппеты, которые действительно относятся к продукту и его аудитории. Если доказательств нет — для сигнала верни evidence_idx: [] и низкий score, для конкурентов, трендов и сегментов верни пустой массив. НЕ придумывай названия продуктов, каналов и сообществ. Все тексты (comment, summary, positioning, weakness, pain, offer_hypothesis, trend, opportunity) пиши ПО-РУССКИ. summary — 2-4 предложения.';
const SYS_PLAN = 'Ты помогаешь искать в интернете следы спроса на мини-продукт. По брифу составь: queries — 2-3 поисковых запроса НА АНГЛИЙСКОМ (до 80 символов) так, как боль формулируют сами люди на Reddit; ru_queries — 2 запроса ПО-РУССКИ для Яндекса: первый — как аудитория описывает свою боль на форумах и отзовиках, второй — про аналоги, тренажёры и цены; subreddits — 2-3 реальных профильных сабреддита без «r/» (только латиница, цифры, подчёркивание); hn_queries — 1-2 коротких запроса для Hacker News про аналоги и рынок. Только JSON по схеме.';

const briefText = b => `ПРОДУКТ: ${b.product_name}\nОПИСАНИЕ: ${b.description}\nКАТЕГОРИЯ: ${b.category || '—'}\nГЕО: ${b.target_geo}\nБОЛИ: ${b.pains.join(' | ') || '—'}`;
function readBrief(b) {
  b = b || {};
  const name = String(b.product_name || '').trim(), desc = String(b.description || '').trim();
  const pains = (Array.isArray(b.pains) ? b.pains : []).slice(0, 3).map(x => String(x).trim().slice(0, 200)).filter(Boolean);
  if (!name || !desc) return { error: 'product_name and description required' };
  if (name.length > 120 || desc.length > 2000) return { error: 'too long' };
  return { brief: { product_name: name, description: desc, category: String(b.category || '').slice(0, 120), target_geo: b.target_geo === 'EN' ? 'EN' : 'RU', price_model: String(b.price_model || '').slice(0, 120), pains } };
}
const noData = (res, stage, snippets, stats, extra = {}) => {
  const un = Array.isArray(extra.unavailable) ? extra.unavailable : [];
  return res.status(200).json({
    ok: false, reason: 'no_data', stage,
    coverage: { snippets: snippets.length, sources: [...new Set(snippets.map(s => s.source))], stats, ...extra },
    message: un.length
      ? `Источники недоступны с сервера: ${un.join(', ')}. Это ограничение доступа, а не вина вашего описания. Пакет не списан.`
      : 'Не удалось собрать достаточно следов по этому описанию. Пакет не списан. Уточните боли словами аудитории или повторите позже.'
  });
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
  if (secret().length < 16) { console.error('INTEL_SECRET is not set or too short'); return res.status(500).json({ error: 'server_misconfigured' }); }
  const action = String(req.query.action || '');
  const t0 = Date.now();

  // ===== LOGIN =====
  if (action === 'login' && req.method === 'POST') {
    const ip = clientIp(req);
    const a = await rpcHit(`intel:login:${ip}:m`, 60, 5), b = await rpcHit(`intel:login:${ip}:h`, 3600, 30);
    if (a === null || b === null) return res.status(503).json({ error: 'guard_unavailable' });
    if (!a || !b) return res.status(429).json({ error: 'too_many_attempts' });
    const pw = String((req.body && req.body.password) || '');
    if (!pw || pw.length > 128) return res.status(400).json({ error: 'password required' });
    const { url, h } = sb();
    const r = await fetch(`${url}/rest/v1/intel_accesses?password_hash=eq.${sha256hex(pw)}&is_active=eq.true&select=id,label`, { headers: h });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return res.status(401).json({ error: 'Неверный пароль' });
    res.setHeader('Set-Cookie', `intel_token=${makeToken(rows[0].id)}; HttpOnly; Secure; SameSite=Strict; Path=/api/intel; Max-Age=604800`);
    return res.status(200).json({ ok: true, label: rows[0].label, quota: await quota(rows[0].id) });
  }

  if (action === 'logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', 'intel_token=; HttpOnly; Secure; SameSite=Strict; Path=/api/intel; Max-Age=0');
    return res.status(200).json({ ok: true });
  }

  // ===== HISTORY =====
  if (action === 'history' && req.method === 'GET') {
    const id = verifyToken(req);
    if (!id) return res.status(401).json({ error: 'unauthorized' });
    const { url, h } = sb();
    const rid = String(req.query.id || '');
    if (rid) {
      if (!ID_RE.test(rid)) return res.status(400).json({ error: 'bad id' });
      const r = await fetch(`${url}/rest/v1/intel_runs?id=eq.${rid}&access_id=eq.${id}&select=*`, { headers: h });
      const rows = await r.json();
      if (!Array.isArray(rows) || !rows.length) return res.status(404).json({ error: 'not found' });
      return res.status(200).json({ run: rows[0], quota: await quota(id) });
    }
    const r = await fetch(`${url}/rest/v1/intel_runs?access_id=eq.${id}&select=id,brief,score,verdict,created_at&order=created_at.desc&limit=20`, { headers: h });
    const items = ((await r.json()) || []).map(x => ({ id: x.id, product: (x.brief && x.brief.product_name) || '—', score: x.score, verdict: x.verdict, created_at: x.created_at }));
    return res.status(200).json({ items, quota: await quota(id) });
  }

  // ===== PLAN =====
  if (action === 'plan' && req.method === 'POST') {
    const id = verifyToken(req);
    if (!id) return res.status(401).json({ error: 'unauthorized' });
    if (!(await rateLimit(req, 'intel:plan', { limit: 10, windowSec: 60 })).ok) return res.status(429).json({ error: 'too_many_requests' });
    const rb = readBrief(req.body && req.body.brief);
    if (rb.error) return res.status(400).json({ error: rb.error });
    const dc = await dailyCap('intel:plan', cap());
    if (!dc.ok) return dc.unavailable ? res.status(503).json({ error: 'guard_unavailable' }) : res.status(429).json({ error: 'daily_cap', message: 'Дневной лимит анализов исчерпан. Попробуйте завтра.' });
    try {
      const plan = validatePlan(await groq([{ role: 'system', content: SYS_PLAN }, { role: 'user', content: briefText(rb.brief) }], PLAN_SCHEMA, 'intel_plan', 500, 5000));
      if (plan.queries.length || plan.ru_queries.length) return res.status(200).json({ ok: true, plan });
    } catch (e) { console.error('plan failed:', e.message); }
    return res.status(200).json({ ok: true, plan: fallbackPlan(rb.brief), fallback: true });
  }

  // ===== RUN =====
  if (action === 'run' && req.method === 'POST') {
    const id = verifyToken(req);
    if (!id) return res.status(401).json({ error: 'unauthorized' });
    if (!(await rateLimit(req, 'intel:run', { limit: 6, windowSec: 60 })).ok) return res.status(429).json({ error: 'too_many_requests' });
    const q = await quota(id);
    if (!q) return res.status(401).json({ error: 'access not found' });
    if (q.remaining <= 0) return res.status(429).json({ error: 'package_exhausted', quota: q });
    const rb = readBrief(req.body && req.body.brief);
    if (rb.error) return res.status(400).json({ error: rb.error });
    const brief = rb.brief;
    const dc = await dailyCap('intel:run', cap());
    if (!dc.ok) return dc.unavailable ? res.status(503).json({ error: 'guard_unavailable' }) : res.status(429).json({ error: 'daily_cap', message: 'Дневной лимит анализов исчерпан. Попробуйте завтра.' });

    let plan = validatePlan(req.body && req.body.plan);
    if (!plan.queries.length && !plan.ru_queries.length) plan = fallbackPlan(brief);
    const { items: snippets, stats, unavailable } = await gatherSignals(plan, brief.target_geo);
    if (snippets.length < MIN_SNIPPETS) return noData(res, 'collect', snippets, stats, { unavailable });

    const left = BUDGET_MS - (Date.now() - t0);
    if (left < 3500) return res.status(200).json({ ok: false, reason: 'too_slow', message: 'Источники ответили слишком медленно. Пакет не списан, повторите.', coverage: { snippets: snippets.length, stats, unavailable } });
    let analysis;
    try {
      analysis = await groq([
        { role: 'system', content: SYS_ANALYZE },
        { role: 'user', content: `${briefText(brief)}\n\nСЛЕДЫ (индекс = номер):\n${snippets.map(s => `[${s.idx}] (${s.source}) ${s.title}\n    ${s.snippet}\n    ${s.link}`).join('\n\n')}\n\nВерни JSON по схеме.` }
      ], SCHEMA, 'intel_report', 2000, Math.min(4200, left - 1200));
    } catch (e) {
      console.error('groq failed:', e.message);
      return res.status(502).json({ error: 'analyze_failed', detail: String(e.message) });
    }

    const rep = sanitize(analysis, snippets.length);
    const measured = SIGNAL_KEYS.filter(k => rep.signals[k].measured).length, cited = citedUnique(rep);
    rep.coverage = { snippets: snippets.length, sources: [...new Set(snippets.map(s => s.source))], stats, measured_signals: measured, cited_unique: cited, unavailable };
    if (cited < MIN_CITED || measured < MIN_MEASURED) {
      return res.status(200).json({ ok: false, reason: 'no_data', stage: 'analyze', coverage: rep.coverage, summary: rep.summary,
        message: 'Найденные следы почти не относятся к вашему продукту, поэтому оценку по ним давать нельзя. Пакет не списан.' });
    }
    const score = scoreOf(rep.signals), verdict = verdictOf(score, measured);

    const { url, h } = sb();
    const ins = await fetch(`${url}/rest/v1/rpc/intel_try_insert_run`, { method: 'POST', headers: h, body: JSON.stringify({ p_access_id: id, p_brief: brief, p_signals: snippets, p_report: rep, p_score: score, p_verdict: verdict }) });
    if (!ins.ok) { console.error('intel_try_insert_run failed:', ins.status); return res.status(503).json({ error: 'migration_missing' }); }
    const runId = await ins.json();
    if (!runId) return res.status(429).json({ error: 'package_exhausted', quota: await quota(id) });
    // без повторного чтения из БД: экономим ~1 с на критическом пути
    const saved = { id: runId, access_id: id, brief, signals: snippets, report: rep, score, verdict, created_at: new Date().toISOString() };
    return res.status(200).json({ ok: true, run: saved, quota: { limit: q.limit, used: q.used + 1, remaining: Math.max(0, q.remaining - 1) } });
  }

  // ===== ENRICH =====
  if (action === 'enrich' && req.method === 'POST') {
    const id = verifyToken(req);
    if (!id) return res.status(401).json({ error: 'unauthorized' });
    const rid = String((req.body && req.body.run_id) || '');
    if (!ID_RE.test(rid)) return res.status(400).json({ error: 'run_id required' });
    if (!(await rateLimit(req, 'intel:enrich', { limit: 6, windowSec: 60 })).ok) return res.status(429).json({ error: 'too_many_requests' });
    const { url, h } = sb();
    const r = await fetch(`${url}/rest/v1/intel_runs?id=eq.${encodeURIComponent(rid)}&access_id=eq.${id}&select=*`, { headers: h });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return res.status(404).json({ error: 'not found' });
    const run = rows[0], report = run.report || {};
    if (Array.isArray(report.segments) && report.segments.length) return res.status(200).json({ ok: true, already_enriched: true, run });
    const en = report.enrich || { attempts: 0, last_at: 0 };
    if (en.attempts >= 2) return res.status(200).json({ ok: true, enrich_unavailable: 'attempts_exhausted', run });
    if (Date.now() - (en.last_at || 0) < 60000) return res.status(429).json({ error: 'too_soon' });
    const dc = await dailyCap('intel:enrich', cap());
    if (!dc.ok) return dc.unavailable ? res.status(503).json({ error: 'guard_unavailable' }) : res.status(429).json({ error: 'daily_cap' });
    report.enrich = { attempts: (en.attempts || 0) + 1, last_at: Date.now() };
    await fetch(`${url}/rest/v1/intel_runs?id=eq.${encodeURIComponent(rid)}`, { method: 'PATCH', headers: h, body: JSON.stringify({ report }) });

    const sn = Array.isArray(run.signals) ? run.signals : [];
    const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    let segments = [];
    try {
      const raw = await gigaChat([
        { role: 'system', content: 'Выдели 2-4 сегмента ЦА продукта по сниппетам. Для каждого: name, pain_quote (ДОСЛОВНАЯ цитата боли из сниппета, до 25 слов; если нет — пустая строка), habitats (каналы/форумы/сабреддиты), offer_hypothesis. ТОЛЬКО JSON-массив, без markdown. Не выдумывай сообщества: если по сниппетам их не видно, оставь habitats пустым.' },
        { role: 'user', content: `Продукт: ${(run.brief && run.brief.product_name) || ''}\nОписание: ${(run.brief && run.brief.description) || ''}\n\nСниппеты:\n${sn.map(s => `[${s.idx}] ${s.title}\n    ${s.snippet}`).join('\n\n') || '—'}\n\nВерни JSON-массив.` }
      ]);
      const f = raw.indexOf('['), l = raw.lastIndexOf(']');
      if (f !== -1 && l > f) {
        const pool = sn.map(s => norm(s.snippet)).join('\n');
        segments = (JSON.parse(raw.slice(f, l + 1).replace(/,(\s*[}\]])/g, '$1')) || []).slice(0, 4).map(s => ({
          name: String(s.name || '').slice(0, 120),
          pain_quote: String(s.pain_quote || '').slice(0, 300),
          habitats: (Array.isArray(s.habitats) ? s.habitats : []).slice(0, 6).map(x => String(x).slice(0, 80)),
          offer_hypothesis: String(s.offer_hypothesis || '').slice(0, 300)
        }));
        for (const s of segments) if (s.pain_quote && !pool.includes(norm(s.pain_quote))) s.pain_quote = '';
      }
    } catch (e) { console.error('enrich failed:', e.message); }
    if (segments.length) {
      report.segments = segments;
      await fetch(`${url}/rest/v1/intel_runs?id=eq.${encodeURIComponent(rid)}`, { method: 'PATCH', headers: h, body: JSON.stringify({ report }) });
    }
    return res.status(200).json({ ok: true, run: { ...run, report } });
  }

  return res.status(404).json({ error: 'unknown action' });
}
