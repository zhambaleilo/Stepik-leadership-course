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

const META = {
  no_devaluation: ['Отсутствие обесценивания', 'base', ''],
  i_messages: ['Я-сообщения', 'base', ''],
  solution_focus: ['Фокус на решении', 'base', ''],
  concrete_next_step: ['Конкретный следующий шаг', 'base', ''],
  emotion_validation: ['Валидация эмоций', 'base', 'Сотрудник высказал эмоцию или чувство'],
  boundaries: ['Удержание границ', 'base', 'Сотрудник проявил токсичность, хамство или давление'],
  active_listening: ['Активное слушание', 'goe', ''],
  adaptability: ['Адаптивность', 'goe', ''],
  yes_and: ['Принцип «Да, и…»', 'goe', 'Сотрудник высказал идею, предложение или просьбу'],
  reframing: ['Переформулирование', 'goe', 'У собеседника была негативная рамка или оценочное суждение'],
  creativity: ['Креативность', 'goe', 'В диалоге возник проблемный момент, требующий решения']
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

    const criteriaBlock = keyIds.map((id, i) => {
      const [name, group, trigger] = META[id];
      return (i + 1) + '. ' + id + ' [' + group + (trigger ? ', триггер: ' + trigger : '') + ']';
    }).join('\n');

    const systemPrompt = `Оцени диалог руководителя по критериям ниже. Верни JSON.

КРИТЕРИИ (0, 1 или 2 балла, либо null если триггер не сработал):
${criteriaBlock}

ПРАВИЛА:
1. 2 = отлично, 1 = частично, 0 = провал
2. null = триггер не сработал (например, boundaries: сотрудник не был токсичен)
3. Цитаты короткие (до 15 слов), дословные из текста диалога
4. Действие без называния чувства НЕ является валидацией: если руководитель молча забрал задачи, но не сказал "вижу, что тебе тяжело" — emotion_validation не выше 1
5. Псевдоштамп ("взгляни внутрь себя", "всё будет хорошо") без называния чувства = не валидация, балл 0
6. KILL: прямое оскорбление личности ("ты идиот", "такой код в мусор") = всегда 0 по no_devaluation, даже при извинении

ПРИМЕРЫ JSON:

Пример N/A (триггер не сработал):
{"id":"boundaries","name":"Удержание границ","group":"base","score":null,"quote":"","comment":"N/A: сотрудник не проявлял токсичность"}

Пример 0 (провал):
{"id":"no_devaluation","name":"Отсутствие обесценивания","group":"base","score":0,"quote":"соберись","comment":"обесценивание без извинений"}

Пример 2 (отлично):
{"id":"emotion_validation","name":"Валидация эмоций","group":"base","score":2,"quote":"вижу, что тебе тяжело","comment":"назвал чувство своими словами"}

ФОРМАТ ОТВЕТА:
{"criteria":[{"id":"...","name":"...","group":"base или goe","score":0,"quote":"...","comment":"..."}],"base_score":0,"base_max":0,"goe_score":0,"goe_max":0,"total_score":0,"max_score":0,"summary":"..."}`;

    const token = await getToken();
    
    let parsed = null;
    for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
      const temp = attempt === 0 ? 0.3 : (attempt === 1 ? 0.2 : 0.1);
      const extra = attempt === 2 ? '\n\nВАЖНО: верни JSON в ОДНУ строку, без переносов внутри строк.' : '';
      
      const r = await sreq('POST', 'https://api.giga.chat/v1/chat/completions', {
        Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
      }, JSON.stringify({
        model: process.env.GIGACHAT_MODEL || 'GigaChat-2-Pro',
        messages: [
          { role: 'system', content: systemPrompt + extra },
          { role: 'user', content: 'Диалог:\n\n' + dialogueText }
        ],
        temperature: temp,
        max_tokens: 3000
      }));

      if (r.status !== 200) {
        if (attempt === 2) throw new Error('GigaChat ' + r.status + ': ' + r.text.slice(0, 200));
        continue;
      }

      let content = (JSON.parse(r.text).choices?.[0]?.message?.content || '')
        .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      const fb = content.indexOf('{'), lb = content.lastIndexOf('}');
      if (fb !== -1 && lb !== -1) content = content.slice(fb, lb + 1);
      content = content.replace(/[\n\r\t]+/g, ' ').replace(/,\s*([}\]])/g, '$1');

      try { parsed = JSON.parse(content); }
      catch (e) { if (attempt === 2) console.error('JSON parse failed: ' + e.message); }
    }
    if (!parsed) throw new Error('GigaChat вернул невалидный JSON после трех попыток');

    const quoteCount = {};
    const criteria = keyIds.map(id => {
      const [name, group] = META[id];
      const m = (parsed.criteria || []).find(c => c.id === id) || {};
      const isNa = m.score === null || m.score === 'na';
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

    return res.status(200).json({
      criteria,
      base_score: baseScore, base_max: base.length * 2,
      goe_score: goeScore, goe_max: goe.length * 2,
      total_score: baseScore + goeScore, max_score: (base.length + goe.length) * 2,
      summary: String(parsed.summary || '').trim()
    });

  } catch (e) {
    console.error('Eval error:', e);
    return res.status(502).json({ error: e.message || String(e) });
  }
}
