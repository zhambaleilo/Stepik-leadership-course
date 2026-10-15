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

// Таксономия: base = минимум (гигиена + реактивные), goe = исполнение (качество + опциональные).
// trigger !== '' означает условную применимость: нет триггера → N/A.
const META = {
  no_devaluation: ['Отсутствие обесценивания', 'base', '', 'Нет фраз-обесценивания («соберись», «у всех так», «у тебя всё есть») и сравнений с собой или другими'],
  i_messages: ['Я-сообщения', 'base', '', 'Говорил о фактах и своих наблюдениях/чувствах, не обвиняя («я заметил», а не «ты вечно»)'],
  solution_focus: ['Фокус на решении', 'base', '', 'Перевёл разговор из жалоб в рабочую плоскость, не застревая в эмоциях'],
  concrete_next_step: ['Конкретный следующий шаг', 'base', '', 'Завершил договорённостью о конкретном действии с сроком или условием'],
  emotion_validation: ['Валидация эмоций', 'base', 'Сотрудник высказал эмоцию или чувство', 'Распознал и озвучил чувство сотрудника («вижу, что тебе тяжело»), а не проигнорировал'],
  boundaries: ['Удержание границ', 'base', 'Сотрудник проявил токсичность, хамство или давление', 'Экологично остановил токсичность сотрудника, не проваливаясь в агрессию или попустительство'],
  active_listening: ['Активное слушание', 'goe', '', 'Использовал слова собеседника, уточнял, проверял понимание'],
  adaptability: ['Адаптивность', 'goe', '', 'Менял стиль и тактику в ответ на реакцию сотрудника'],
  yes_and: ['Принцип «Да, и…»', 'goe', 'Сотрудник высказал идею, предложение или просьбу', 'Принял идею или предложение собеседника и развил их совместно (его словами, его вариант), не подменяя своим планом'],
  reframing: ['Переформулирование', 'goe', 'У собеседника была негативная рамка или оценочное суждение', 'Вернул смысл сказанного своими словами, открыв новый угол зрения'],
  creativity: ['Креативность', 'goe', 'В диалоге возник проблемный момент, требующий решения', 'Предложил нестандартный, но реалистичный ход']
};

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

    let keyIds = [];
    try {
      const sc = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scenarios', scenario_id + '.json'), 'utf8'));
      const ec = sc.evaluation_criteria || {};
      keyIds = [...(ec.psychological_safety || []), ...(ec.improvisation || [])].filter(id => META[id]);
    } catch (e) { /* сценарий не найден — оцениваем по всем */ }
    if (keyIds.length === 0) keyIds = Object.keys(META);

    const dialogueText = dialogue.map(m =>
      (m.role === 'user' ? 'Руководитель: ' : 'Сотрудник: ') + m.content
    ).join('\n');

    let n = 0;
    const criteriaBlock = keyIds.map(id => {
      n++;
      const [name, group, trigger, desc] = META[id];
      return n + '. ' + id + ' — ' + name + ' [' + (group === 'base' ? 'БАЗА' : 'GOE') + ']' +
        (trigger ? ' [УСЛОВНЫЙ, триггер: ' + trigger + ']' : '') + ': ' + desc;
    }).join('\n');

    const systemPrompt = `Ты — строгий аудитор управленческих диалогов. Оценивай ТОЛЬКО реплики Руководителя. Верни СТРОГО валидный JSON без markdown и пояснений.

КРИТЕРИИ (оценивай только этот список; каждый от 0 до 2 баллов либо N/A):
${criteriaBlock}

ПРАВИЛА:
1. Цитата может доказывать несколько критериев, НО только если в comment для каждого из них ты явно укажешь, КАКОЙ ИМЕННО фрагмент или аспект этой фразы доказывает именно этот критерий. Если объяснить связь не можешь — найди другую цитату или снизь балл.
2. quote копируй ДОСЛОВНО из текста диалога, символ в символ; запрещено восстанавливать по памяти, склеивать куски без многоточия или перефразировать. Если не можешь привести дословную цитату — поставь quote "" и снизи балл. Внутри значений quote и comment используй только кавычки « », никогда не двойные кавычки.
2.5. Цитаты держи короткими (до 15 слов), комментарии — одним предложением.
3. no_devaluation: 2 — обесценивания не было; 1 — было обесценивание БЕЗ оскорбления, но руководитель позже явно признал ошибку или извинился; 0 — обесценивание осталось без признания. KILL-уровень: прямое оскорбление, унижение или угроза в адрес личности = ВСЕГДА 0, независимо от любых извинений. Учитывай ВСЕ нарушения, а не только первое.
4. boundaries: если Сотрудник не проявлял токсичности, хамства или давления — критерий N/A. Иначе: 2 — токсичность экологично остановлена; 1 — остановлена, но с грубостью или частичной агрессией; 0 — не остановил, подхватил или ответил агрессией.
5. Не завышай: 2 — техника применена чисто и осознанно; 1 — частично или с оговорками; 0 — не применена или применена токсично.
6. Псевдопсихологические штампы без конкретики («взгляни внутрь себя») НЕ считаются валидацией эмоций.
7. Защитная реакция и перевод фокуса на себя («а я в свои годы…») НЕ считаются эмпатией и снижают балл по emotion_validation и adaptability.
8. УСЛОВНАЯ ПРИМЕНИМОСТЬ: критерии с пометкой [УСЛОВНЫЙ] возвращают score null, quote "" и comment с одним предложением причины, если их триггер не возник в диалоге. N/A — это не наказание и не награда: это отсутствие материала для оценки.
9. АРИФМЕТИКА: base_score = сумма баллов применимых критериев БАЗЫ; base_max = 2 умножить на их количество. goe_score = сумма применимых критериев GOE; goe_max = 2 умножить на их количество. total_score = base_score + goe_score; max_score = base_max + goe_max. Проверь сумму перед выводом.
10. summary: 2-3 предложения, начни с главной ошибки руководителя, затем отметь сильное место.

ФОРМАТ JSON:
{"criteria":[{"id":"...","name":"...","group":"base или goe","score":0,"quote":"...","comment":"..."},{"id":"...","group":"goe","score":null,"quote":"","comment":"причина N/A"}],"base_score":0,"base_max":0,"goe_score":0,"goe_max":0,"total_score":0,"max_score":0,"summary":"..."}`;

    const token = await getToken();
    const bodyFor = (temp) => JSON.stringify({
      model: process.env.GIGACHAT_MODEL || 'GigaChat-2-Pro',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Проанализируй диалог:\n\n' + dialogueText }
      ],
      temperature: temp,
      max_tokens: 3000
    });

    let parsed = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const r = await sreq('POST', 'https://api.giga.chat/v1/chat/completions', {
        Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
      }, bodyFor(attempt === 0 ? 0.2 : 0.1));

      if (r.status !== 200) throw new Error('GigaChat ' + r.status + ': ' + r.text.slice(0, 200));

      let content = (JSON.parse(r.text).choices?.[0]?.message?.content || '')
        .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      const fb = content.indexOf('{'), lb = content.lastIndexOf('}');
      if (fb !== -1 && lb !== -1) content = content.slice(fb, lb + 1);

      try { parsed = JSON.parse(content); }
      catch (e) { console.error('JSON parse attempt ' + attempt + ' failed: ' + e.message); }
    }
    if (!parsed) throw new Error('GigaChat вернул невалидный JSON после двух попыток');

    // Серверная нормализация: модель не может соврать в цифрах
    const quoteCount = {};
    const criteria = keyIds.map(id => {
      const [name, group] = META[id];
      const m = (parsed.criteria || []).find(c => c.id === id) || {};
      const isNa = m.score === null || m.score === 'na' || m.na === true;
      const score = isNa ? null : Math.max(0, Math.min(2, parseInt(m.score, 10) || 0));
      let quote = isNa ? '' : String(m.quote || '').trim();
      let reused = false;
      if (quote) {
        const k = quote.toLowerCase();
        quoteCount[k] = (quoteCount[k] || 0) + 1;
        reused = quoteCount[k] > 1;
      }
      return { id, name, group, score, na: isNa, quote, reused, comment: String(m.comment || '').trim() };
    });

    const base = criteria.filter(c => c.group === 'base' && !c.na);
    const goe = criteria.filter(c => c.group === 'goe' && !c.na);
    const baseScore = base.reduce((a, c) => a + c.score, 0);
    const goeScore = goe.reduce((a, c) => a + c.score, 0);
    const baseMax = base.length * 2, goeMax = goe.length * 2;

    return res.status(200).json({
      criteria,
      base_score: baseScore, base_max: baseMax,
      goe_score: goeScore, goe_max: goeMax,
      total_score: baseScore + goeScore, max_score: baseMax + goeMax,
      summary: String(parsed.summary || '').trim()
    });

  } catch (e) {
    console.error('Eval error:', e);
    return res.status(502).json({ error: e.message || String(e) });
  }
}
