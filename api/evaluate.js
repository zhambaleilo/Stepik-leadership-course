import https from 'https';
import crypto from 'crypto';

let cache = { token: null, exp: 0 };

function sreq(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const r = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method, headers, rejectUnauthorized: false, timeout: 30000,
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
  // CORS — как в scenario-chat.js
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
    const { dialogue } = req.body;
    if (!Array.isArray(dialogue) || dialogue.length === 0) {
      return res.status(400).json({ error: 'dialogue is required' });
    }

    const dialogueText = dialogue.map(m =>
      (m.role === 'user' ? 'Руководитель: ' : 'Сотрудник: ') + m.content
    ).join('\n');

    const systemPrompt = `Ты эксперт по оценке управленческих диалогов. Верни ТОЛЬКО валидный JSON без markdown-обёрток, без пояснений.

Оцени диалог по 11 критериям (0, 1 или 2 балла за каждый):

ПСИХОЛОГИЧЕСКАЯ БЕЗОПАСНОСТЬ:
1. emotion_validation — Валидация эмоций (распознал и озвучил чувства сотрудника)
2. no_devaluation — Отсутствие обесценивания (не "да ладно", "соберись")
3. boundaries — Удержание границ (экологично остановил токсичность)
4. solution_focus — Фокус на решении (не застрял в жалобах)
5. i_messages — Я-сообщения (говорил о фактах, не обвинял)
6. concrete_next_step — Конкретный следующий шаг

ИМПРОВИЗАЦИЯ:
7. yes_and — Принцип "Да, и..." (развивал идеи, не блокировал)
8. adaptability — Адаптивность (менял стиль под реакцию)
9. reframing — Переформулирование (возвращал смысл своими словами)
10. active_listening — Активное слушание (использовал слова собеседника)
11. creativity — Креативность (нестандартное решение)

Для каждого критерия:
- score: 0, 1 или 2
- quote: ТОЧНАЯ цитата из реплик Руководителя, подтверждающая оценку (если нет — пустая строка)
- comment: 1-2 предложения совета на русском

В конце добавь:
- total_score: сумма всех баллов
- max_score: 22
- summary: 2-3 предложения общего вывода

Структура JSON:
{"criteria":[{"id":"emotion_validation","name":"Валидация эмоций","score":2,"quote":"...","comment":"..."}],"total_score":18,"max_score":22,"summary":"..."}`;

    const userPrompt = `Проанализируй этот диалог:\n\n${dialogueText}`;

    const token = await getToken();
    const r = await sreq('POST', 'https://api.giga.chat/v1/chat/completions', {
      Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
    }, JSON.stringify({
      model: process.env.GIGACHAT_MODEL || 'GigaChat-2-Pro',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      max_tokens: 1500
    }));

    if (r.status !== 200) {
      console.error('GigaChat error:', r.status, r.text.slice(0, 300));
      throw new Error('GigaChat ' + r.status);
    }

    const j = JSON.parse(r.text);
    let content = j.choices?.[0]?.message?.content || '';

    // Чистим markdown-обёртки и лишний текст
    content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    // Если модель добавила текст до/после JSON — ищем первую { и последнюю }
    const firstBrace = content.indexOf('{');
    const lastBrace = content.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      content = content.slice(firstBrace, lastBrace + 1);
    }

    const result = JSON.parse(content);
    return res.status(200).json(result);

  } catch (e) {
    console.error('Eval error:', e);
    return res.status(502).json({ error: e.message || String(e) });
  }
}
