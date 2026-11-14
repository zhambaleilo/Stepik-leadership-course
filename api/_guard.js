// api/_guard.js — общая защита платных эндпоинтов (файл с «_» Vercel не публикует как маршрут)
//   guardPaid(req, res, opts): код доступа / владелец сессии → лимит по IP → суточный потолок
// Режимы отказа: лимит по IP при сбое Supabase пропускает (лучше пустить игрока),
// суточный потолок при сбое БД БЛОКИРУЕТ платный вызов (он страхует от разорения).
// Счётчики — таблица api_rate_counters + функция api_rate_hit (tools/api_rate_limits.sql).

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function sb() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url: process.env.SUPABASE_URL, h: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
}
const clientIp = req => String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';

// --- код доступа (с коротким кэшем: чат шлёт запрос на каждую реплику) ---
const codeCache = new Map();
export async function checkCode(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code || code.length > 64) return { ok: false, status: 401, reason: 'Нужен код доступа. Откройте игру с главной страницы.' };
  const hit = codeCache.get(code);
  if (hit && Date.now() - hit.t < 60000) return hit.v;
  const { url, h } = sb();
  try {
    const r = await fetch(`${url}/rest/v1/access_codes?code=eq.${encodeURIComponent(code)}&select=id,active,is_dev`, { headers: h });
    const rows = await r.json();
    const v = !Array.isArray(rows) || !rows.length || !rows[0].active
      ? { ok: false, status: 403, reason: 'Код доступа недействителен' }
      : { ok: true, id: rows[0].id, is_dev: !!rows[0].is_dev };
    codeCache.set(code, { t: Date.now(), v });
    if (codeCache.size > 500) codeCache.clear();
    return v;
  } catch (e) {
    console.error('checkCode error:', e);
    return { ok: false, status: 502, reason: 'Не удалось проверить код доступа' };
  }
}

// --- владелец сессии ---
export async function checkOwner(sessionId, rawCode, { kind } = {}) {
  const sid = String(sessionId || '');
  if (!SAFE_ID.test(sid)) return { ok: false, status: 400, reason: 'Некорректный session_id' };
  const c = await checkCode(rawCode);
  if (!c.ok) return c;
  const { url, h } = sb();
  try {
    const r = await fetch(`${url}/rest/v1/sessions?id=eq.${encodeURIComponent(sid)}&select=id,access_code_id,kind,status`, { headers: h });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return { ok: false, status: 404, reason: 'Сессия не найдена' };
    const s = rows[0];
    if (s.access_code_id !== c.id) return { ok: false, status: 403, reason: 'Эта сессия принадлежит другому коду доступа' };
    if (s.status === 'finished') return { ok: false, status: 409, reason: 'Сессия уже завершена' };
    if (kind && s.kind && s.kind !== kind) return { ok: false, status: 400, reason: 'Неверный тип сессии' };
    return { ok: true, is_dev: c.is_dev, session: s };
  } catch (e) {
    console.error('checkOwner error:', e);
    return { ok: false, status: 502, reason: 'Не удалось проверить сессию' };
  }
}

// --- счётчики ---
// true — в пределах лимита, false — превышен, null — счётчик недоступен
async function rpcHit(key, windowSec, limit) {
  const { url, h } = sb();
  try {
    const r = await fetch(`${url}/rest/v1/rpc/api_rate_hit`, {
      method: 'POST', headers: h, body: JSON.stringify({ p_key: key, p_window_sec: windowSec, p_limit: limit }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined
    });
    if (!r.ok) return null;
    const v = await r.json();
    return typeof v === 'boolean' ? v : null;
  } catch (_) { return null; }
}

const mem = new Map();
function memHit(key, limit, windowSec) {
  const now = Date.now();
  const arr = (mem.get(key) || []).filter(t => now - t < windowSec * 1000);
  if (arr.length >= limit) { mem.set(key, arr); return false; }
  arr.push(now); mem.set(key, arr);
  if (mem.size > 5000) for (const [k, v] of mem) if (!v.length || now - v[v.length - 1] > 3600e3) mem.delete(k);
  return true;
}

export async function rateLimit(req, scope, { limit, windowSec }, { memOnly = false } = {}) {
  const key = `${scope}:${clientIp(req)}`;
  if (!memHit(key, limit, windowSec)) return { ok: false, retry_after: windowSec };
  if (memOnly) return { ok: true };
  return (await rpcHit(key, windowSec, limit)) === false ? { ok: false, retry_after: windowSec } : { ok: true }; // null → пропускаем
}

export async function dailyCap(scope, cap) {
  const v = await rpcHit(`global:${scope}`, 86400, cap);
  if (v === null) return { ok: false, unavailable: true };  // fail-closed
  return { ok: v };
}

// Единая проверка для платного эндпоинта. Возвращает true, если можно идти дальше; иначе уже ответила клиенту.
// opts: scope, limit, windowSec, cap, requireCode (по умолчанию true), sessionId + kind (проверка владельца)
export async function guardPaid(req, res, opts) {
  const { scope, limit, windowSec = 60, cap, requireCode = true, sessionId, kind } = opts;
  const deny = (status, body) => { res.status(status).json(body); return false; };
  const code = req.headers['x-access-code'];

  if (!(await rateLimit(req, scope + ':pre', { limit: limit * 5, windowSec }, { memOnly: true })).ok)
    return deny(429, { ok: false, reason: 'too_many_requests', error: 'too_many_requests' });

  let isDev = false;
  if (sessionId !== undefined) {
    const own = await checkOwner(sessionId, code, { kind });
    if (!own.ok) return deny(own.status, { ok: false, reason: own.reason, error: own.reason });
    isDev = own.is_dev;
  } else if (requireCode) {
    const c = await checkCode(code);
    if (!c.ok) return deny(c.status, { ok: false, reason: c.reason, error: c.reason });
    isDev = c.is_dev;
  }

  if (!isDev) {   // коды разработчика не режем по IP (golden-set, ручные проверки), но суточный потолок действует на всех
    const rl = await rateLimit(req, scope, { limit, windowSec });
    if (!rl.ok) return deny(429, { ok: false, reason: 'too_many_requests', error: 'too_many_requests', retry_after: rl.retry_after });
  }
  const c = await dailyCap(scope.split(':')[0], cap);
  if (!c.ok) return c.unavailable
    ? deny(503, { ok: false, reason: 'guard_unavailable', error: 'guard_unavailable', message: 'Защита временно недоступна, попробуйте позже.' })
    : deny(429, { ok: false, reason: 'daily_cap', error: 'daily_cap', message: 'Дневной лимит запросов к ИИ исчерпан. Попробуйте завтра.' });
  return true;
}
