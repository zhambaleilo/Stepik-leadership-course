// api/chat.js — прокси к GigaChat (Sбер). Ключи ТОЛЬКО в env Vercel.
let cache = { token: null, exp: 0 };

async function getToken() {
  if (cache.token && Date.now() < cache.exp - 60000) return cache.token;
  const auth = Buffer.from(process.env.GIGACHAT_CLIENT_ID + ':' + process.env.GIGACHAT_CLIENT_SECRET).toString('base64');
  const r = await fetch('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, RqUID: crypto.randomUUID(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'scope=GIGACHAT_API_PERS', // для ключей юрлица — GIGACHAT_API_B2B
  });
  if (!r.ok) throw new Error('oauth ' + r.status);
  const j = await r.json();
  cache = { token: j.access_token, exp: Date.now() + (j.expires_in || 1800) * 1000 };
  return cache.token;
}

async function giga(messages, temperature, maxTokens) {
  const token = await getToken();
  const r = await fetch('https://gigachat.devices.sberbank.ru/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.GIGACHAT_MODEL || 'GigaChat-Pro', messages, temperature, max_tokens: maxTokens }),
  });
  if (!r.ok) throw new Error('chat ' + r.status);
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || '').trim();
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
    return res.status(502).json({ error: String(e.message || e) });
  }
}
