import https from 'https';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

let cache = { token: null, exp: 0 };

function sreq(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const r = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method, headers, rejectUnauthorized: false, timeout: 40000,
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

// Единая библиотека критериев: описания живут здесь, а не в промпте вручную
const LIB = {
  emotion_validation: ['Валидация эмоций', 'Распознал и озвучил чувство сотрудника («вижу, что тебе тяжело»), а не проигнорировал'],
  no_devaluation: ['Отсутствие обесценивания', 'Нет фраз-обесценивания («соберись», «у всех так», «у тебя всё есть») и сравнений с собой или другими'],
  boundaries: ['Удержание границ', 'Экологично остановил токсичность или хамство, не проваливаясь в агрессию или попустительство'],
  solution_focus: ['Фокус на решении', 'Перевёл разговор из жалоб в рабочую плоскость, не застревая в эмоциях'],
  i_messages: ['Я-сообщения', 'Говорил о фактах и своих наблюдениях/чувствах, не обвиняя («я заметил», а не «ты вечно»)'],
  concrete_next_step: ['Конкретный следующий шаг', 'Завершил договорённостью о конкретном действии со сроком или условием'],
  yes_and: ['Принцип «Да, и…»', 'Принял идею или чувство собеседника и развил их, не блокируя «нет / но / это неправильно»'],
  adaptability: ['Адаптивность', 'Менял стиль и тактику в ответ на реакцию сотрудника'],
  reframing: ['Переформулирование', 'Вернул смысл сказанного своими словами, открыв новый угол зрения'],
  active_listening: ['Активное слушание', 'Использовал слова собеседника, уточнял, проверял понимание'],
  creativity: ['Креативность', 'Предложил нестандартный, но реалистичный ход']
};
const VIOLATION = ['no_devaluation', 'boundaries'];

// ПОЛИТИКА KILL: true = прямое оскорбление/унижение/угроза всегда 0, даже при извинении.
// false = искреннее извинение после грубого нарушения даёт 1.
const KILL_POLICY = true;

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
    const { scenario_id, dialogue } = req.body;
    if (!Array.isArray(dialogue) || dialogue.length === 0) {
      return res.status(400).json({ error: 'dialogue is required' });
    }

    // Оцениваем ТОЛЬКО ключевые критерии сценария
    let keyIds = [];
    try {
      const sc = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scenarios', scenario_id + '.json'), 'utf8'));
      const ec = sc.evaluation_criteria || {};
      keyIds = [...(ec.psychological_safety || []), ...(ec.improvisation || [])].filter(id => LIB[id]);
    } catch (e) { /* сценарий не найден */ }
    if (keyIds.length === 0) keyIds = Object.keys(LIB);

    const dialogueText = dialogue.map(m =>
      (m.role === 'user' ? 'Руководитель: ' : 'Сотрудник: ') + m.content
    ).join('\n');

    const criteriaBlock = keyIds.map((id, i) =>
      (i + 1) + '. ' + id + ' — ' + LIB[id][0] + ': ' + LIB[id][1] +
      (VIOLATION.includes(id) ? ' [КРИТЕРИЙ-НАРУШЕНИЕ]' : '')
    ).join('\n');

    const rule3 = KILL_POLICY
      ? 'KILL: прямое оскорбление, унижение или угроза = всегда 0, даже при последующем извинении.'
      : 'Прямое оскорбление или унижение = 0, но искреннее извинение сразу после даёт 1.';

    const systemPrompt = `Ты — строгий аудитор управленческих диалогов. Оценивай ТОЛЬКО реплики Руководителя. Верни СТРОГО валидный JSON без markdown и пояснений.

КРИТЕРИИ (оценивай только этот список, каждый от 0 до 2 баллов):
${criteriaBlock}

ПРАВИЛА:
1. Цитата может доказывать несколько критериев, НО только если в comment для каждого из них ты явно укажешь, КАКОЙ ИМЕННО фрагмент или аспект этой фразы доказывает именно этот критерий. Если объяснить связь не можешь — найди другую цитату или снизь балл.
2. quote — ТОЧНАЯ цитата из реплик Руководителя. Если техника не применялась — score 0 и quote "".
3. ПОЛИТИКА КРИТЕРИЕВ-НАРУШЕНИЙ (${VIOLATION.join(', ')}): 2 — нарушения не было; 1 — нарушение было, но руководитель позже явно признал ошибку или извинился; 0 — нарушение осталось без признания. Учитывай ВСЕ нарушения в диалоге, а не только первое. ${rule3}
4. Не завышай: псевдопсихологические штампы без конкретики («взгляни внутрь себя») НЕ считаются валидацией эмоций; защитная реакция и перевод фокуса на себя («а я в свои годы…») НЕ считаются эмпатией.
5. Перед выводом ПРОВЕРЬ АРИФМЕТИКУ: total_score = сумма score по всем критериям списка; max_score = ${keyIds.length * 2}.
6. summary: 2-3 предложения, начни с главной ошибки руководителя, затем отметь сильное место.

ФОРМАТ JSON:
{"criteria":[{"id":"...","name":"...","score":0,"quote":"...","comment":"..."}],"total_score":0,"max_score":${keyIds.length * 2},"summary":"..."}`;

    const token = await getToken();
    const r = await sreq('POST', 'https://api.giga.chat/v1/chat/completions', {
      Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
    }, JSON.stringify({
      model: process.env.GIGACHAT_MODEL || 'GigaChat-2-Pro',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Проанализируй диалог:\n\n' + dialogueText }
      ],
      temperature: 0.2,
      max_tokens: 1500
    }));

    if (r.status !== 200) throw new Error('GigaChat ' + r.status + ': ' + r.text.slice(0, 200));

    let content = (JSON.parse(r.text).choices?.[0]?.message?.content || '')
      .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const fb = content.indexOf('{'), lb = content.lastIndexOf('}');
    if (fb !== -1 && lb !== -1) content = content.slice(fb, lb + 1);
    const parsed = JSON.parse(content);

    // Серверная нормализация: модель не может соврать в цифрах
    const quoteCount = {};
    const criteria = keyIds.map(id => {
      const m = (parsed.criteria || []).find(c => c.id === id) || {};
      let score = Math.max(0, Math.min(2, parseInt(m.score, 10) || 0));
      let quote = String(m.quote || '').trim();
      let reused = false;
      if (quote) {
        const key = quote.toLowerCase();
        quoteCount[key] = (quoteCount[key] || 0) + 1;
        reused = quoteCount[key] > 1;
      }
      return { id, name: LIB[id][0], score, quote, reused, comment: String(m.comment || '').trim() };
    });

    const total = criteria.reduce((a, c) => a + c.score, 0);

    return res.status(200).json({
      criteria,
      total_score: total,
      max_score: keyIds.length * 2,
      summary: String(parsed.summary || '').trim()
    });

  } catch (e) {
    console.error('Eval error:', e);
    return res.status(502).json({ error: e.message || String(e) });
  }
}
