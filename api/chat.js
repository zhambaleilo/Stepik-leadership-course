// api/chat.js — прокси к GigaChat (Sбер). Секреты ТОЛЬКО в env Vercel.
import https from 'https';

let cache = { token: null, exp: 0 };

function sreq(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const r = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers,
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function getToken() {
  if (cache.token && Date.now() < cache.exp - 60000) return cache.token;
  const auth = process.env.GIGACHAT_AUTH_KEY ||
    Buffer.from(process.env.GIGACHAT_CLIENT_ID + ':' + process.env.GIGACHAT_CLIENT_SECRET).toString('base64');
  const scope = process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';
  const r = await sreq('POST', 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
    Authorization: 'Basic ' + auth,
    RqUID: crypto.randomUUID(),
    'Content-Type': 'application/x-www-form-urlencoded',
  }, 'scope=' + scope);
  if (r.status !== 200) throw new Error('oauth ' + r.status + ': ' + r.text.slice(0, 120));
  const j = JSON.parse(r.text);
  cache = { token: j.access_token, exp: Date.now() + (j.expires_in || 1800) * 1000 };
  return cache.token;
}

async function giga(messages, temperature, maxTokens) {
  const token = await getToken();
  const r = await sreq('POST', 'https://api.giga.chat/v1/chat/completions', {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
  }, JSON.stringify({ model: process.env.GIGACHAT_MODEL || 'GigaChat-2-Pro', messages, temperature, max_tokens: maxTokens }));
  if (r.status !== 200) throw new Error('chat ' + r.status + ': ' + r.text.slice(0, 120));
  const j = JSON.parse(r.text);
  return (j.choices?.[0]?.message?.content || '').trim();
}

export default async function handler(req, res) {
  const allow = ['https://my-pro-skills.ru', 'http://localhost:8000'];
  const origin = req.headers.origin || '';
  if (allow.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  }
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') {
    try {
      const token = await getToken();
      const r = await sreq('GET', 'https://api.giga.chat/v1/models', { Authorization: 'Bearer ' + token });
      if (r.status !== 200) return res.status(502).json({ error: 'models ' + r.status, raw: r.text.slice(0, 300) });
      return res.status(200).json(JSON.parse(r.text));
    } catch (e) {
      return res.status(502).json({ error: String(e.code || e.message || e) });
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const b = req.body || {};
    if (b.kind === 'review') {
      const sys = 'Ты — старший L&D-методолог, эксперт по деловым коммуникациям. Оценивай ТОЛЬКО реплики руководителя в диалоге с сотрудником по 6 критериям (список дан). По каждому критерию выведи: verdict (0 — не выполнено, 1 — частично, 2 — выполнено), quote — ТОЧНУЮ цитату из реплик руководителя, подтверждающую вердикт (если её нет — пустую строку), comment — 1-2 предложения на русском с подсказкой, что усилить. Самопроверка перед выводом: НЕ помечай как токсичность, давление или провал констатацию фактов о работе, твёрдые, но уважительные формулировки и границы без оскорблений; токсичность — это ярлыки о личности, сарказм, угрозы, унижения. Верни СТРОГО валидный JSON без markdown и лишних слов: {"criteria":[{"verdict":2,"quote":"...","comment":"..."}],"total":9,"summary":"2-3 предложения: что было сильным и что изменить в следующий раз".';
      const user = 'Ситуация: ' + (b.intro || '') + '\nКритерии по порядку:\n' + (b.criteria || []).map((c, i) => (i + 1) + '. ' + c.n).join('\n') + '\nДиалог:\n' + (b.dialogue || []).map(m => (m.role === 'user' ? 'Руководитель: ' : 'Сотрудник: ') + m.content).join('\n');
      const text = await giga([{ role: 'system', content: sys }, { role: 'user', content: user }], 0.4, 900);
      return res.json({ text });
    }
    const messages = b.messages;
    if (!Array.isArray(messages) || messages.length > 14) return res.status(400).json({ error: 'bad messages' });
    const text = await giga(messages, 0.9, 150);
    return res.json({ reply: text });
  } catch (e) {
    return res.status(502).json({ error: String(e.code || e.message || e) });
  }
}
