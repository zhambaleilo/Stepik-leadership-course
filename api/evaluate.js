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
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  
  try {
    const { dialogue } = req.body;
    
    const dialogueText = dialogue.map(m => 
      (m.role === 'user' ? 'Руководитель: ' : 'Сотрудник: ') + m.content
    ).join('\n');

    const systemPrompt = `Ты — эксперт по психологической безопасности и бизнес-импровизации. Оцени диалог по 11 критериям.

КРИТЕРИИ (максимум 2 балла за каждый):
ПСИХОЛОГИЧЕСКАЯ БЕЗОПАСНОСТЬ:
1. Валидация эмоций (распознал и озвучил чувства сотрудника)
2. Отсутствие обесценивания (не использовал "да ладно", "соберись")
3. Удержание границ (экологично остановил токсичность)
4. Фокус на решении (не застрял в жалобах)
5. Использование "Я-сообщений" (говорил о фактах, не обвинял)
6. Конкретный следующий шаг (договорились о действии)

ИМПРОВИЗАЦИЯ:
7. Принцип "Да, и..." (развивал идеи, не блокировал)
8. Адаптивность (менял стиль под реакцию)
9. Переформулирование (возвращал смысл своими словами)
10. Активное слушание (использовал слова собеседника)
11. Креативность (предложил нестандартное решение)

ПРАВИЛА:
1. Верни СТРОГО валидный JSON без markdown-обёрток (без \`\`\`json).
2. Для каждого критерия: score (0, 1 или 2), quote (точная цитата Руководителя, если нет — ""), comment (совет на русском).
3. Добавь total_score (сумма), max_score (22), summary (2-3 предложения).

ФОРМАТ:
{"criteria":[{"id":"emotion_validation","name":"Валидация эмоций","score":2,"quote":"...","comment":"..."}],"total_score":18,"max_score":22,"summary":"..."}`;

    const token = await getToken();
    const r = await sreq('POST', 'https://api.giga.chat/v1/chat/completions', {
      Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
    }, JSON.stringify({
      model: process.env.GIGACHAT_MODEL || 'GigaChat-2-Pro',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Проанализируй диалог:\n\n${dialogueText}` }
      ],
      temperature: 0.3,
      max_tokens: 1500
    }));

    if (r.status !== 200) throw new Error('eval ' + r.status + ': ' + r.text.slice(0, 200));
    
    const j = JSON.parse(r.text);
    let content = j.choices?.[0]?.message?.content || '';
    
    // Чистим markdown-обёртку, если модель её добавила
    content = content.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    
    const result = JSON.parse(content);
    return res.status(200).json(result);

  } catch (e) {
    console.error('Eval error:', e);
    return res.status(502).json({ error: String(e.message) });
  }
}
