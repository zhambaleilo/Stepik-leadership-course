import https from 'https';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { hasToxicity, hasOffer, hasEmotion } from '../tools/offline-rules.js';

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

    const assistantText = dialogue.filter(m => m.role === 'assistant').map(m => m.content).join('\n');

    const criteriaBlock = keyIds.map((id, i) => {
      const [name, group, trigger] = META[id];
      let desc = (i + 1) + '. ' + id + ' [' + group + ']';
      if (trigger) {
        desc += ' — УСЛОВНЫЙ: верни null, если ' + trigger.toLowerCase() + '. Иначе оцени 0-2.';
      } else {
        desc += ' — ВСЕГДА ПРИМЕНИМ. Оцени 0-2.';
      }
      return desc;
    }).join('\n');

    const userMessageCount = req.body.user_message_count || 
    (req.body.dialogue && req.body.dialogue.filter(m => m.role === 'user').length) || 0;
    
    const systemPrompt = `Оцени диалог руководителя по критериям ниже. Верни JSON.


ИНФОРМАЦИЯ О ДИАЛОГЕ:
- Количество ответов руководителя: ${userMessageCount}
${userMessageCount < 2 ? '- ДИАЛОГ ОЧЕНЬ КОРОТКИЙ. Будь строже к баллам, верни N/A для adaptability/yes_and/reframing.' : ''}
${userMessageCount >= 2 && userMessageCount < 4 ? '- ДИАЛОГ КОРОТКИЙ. Оценивай консервативно.' : ''}

КРИТЕРИИ:
${criteriaBlock}

ПРАВИЛА:
1. 2 = отлично, 1 = частично, 0 = провал
2. null = условие не выполнено (критерий не применим)
3. Цитаты короткие (до 15 слов), дословные из текста диалога
4. ВАЛИДАЦИЯ ЭМОЦИЙ — СТРОГО:
   - 2 балла: руководитель НАЗВАЛ чувство сотрудника своими словами ("вижу, что тебе тяжело", "понимаю, что ты расстроен", "чувствую, что ты устал") И развил его
   - 1 балл: руководитель проявил интерес через вопрос ("что случилось?", "расскажи подробнее"), но не назвал чувство словами
   - 0 баллов: руководитель проигнорировал эмоцию или обесценил её
   - Если сотрудник УЖЕ назвал чувство явно ("чувствую себя неудачником"), валидация = признание и развитие ("да, это действительно тяжело"), а не просто переспрос
5. Псевдоштамп ("взгляни внутрь себя", "всё будет хорошо") без называния чувства = не валидация, балл 0
6. KILL: прямое оскорбление личности ("ты идиот", "такой код в мусор") = всегда 0 по no_devaluation, даже при извинении
7. ЗАПРЕТ ГАЛЛЮЦИНАЦИЙ:
   - Никогда не придумывай цитату, которой нет в тексте диалога.
   - Если не можешь найти дословную цитату для обоснования балла — поставь quote: "" и снизь балл на 1.
   - Если критерий ВСЕГДА ПРИМЕНИМ, но поведение не проявлено — верни score:0, quote:"".
   - Проверяй каждую цитату: она должна быть СЛОВО В СЛОВО из реплики руководителя.
8. УСЛОВНАЯ ПРИМЕНИМОСТЬ — КРИТИЧНО:
   - Если триггер условного критерия НЕ возник в диалоге, верни score: null (не 0!), quote: "", comment: "N/A: [причина]"
   - 0 означает: триггер БЫЛ, но руководитель провалил
   - null означает: триггера НЕ БЫЛО, оценивать нечего
   - Пример N/A: {"id":"boundaries","score":null,"quote":"","comment":"N/A: сотрудник не был токсичен"}
   - НЕ путай: отсутствие события ≠ провал. Если сотрудник не хамил, boundaries = null, а не 0.
9. АДАПТИВНАЯ ОЦЕНКА ПО ДЛИНЕ ДИАЛОГА:
   - Если ответов руководителя < 2, верни N/A для критериев, требующих наблюдения за динамикой: adaptability, yes_and, reframing. Оцени только: no_devaluation, emotion_validation, concrete_next_step, solution_focus.
   - Если ответов 2-3, будь строже к баллам: 2 ставь только при явном, чистом проявлении техники.
10. АРИФМЕТИКА: base_score = сумма баллов применимых критериев БАЗЫ; base_max = 2 умножить на их количество. goe_score = сумма применимых критериев GOE; goe_max = 2 умножить на их количество. total_score = base_score + goe_score; max_score = base_max + goe_max. Проверь сумму перед выводом.
11. summary: 2-3 предложения, начни с главной ошибки руководителя, затем отметь сильное место.

ПРИМЕРЫ JSON:

Пример N/A (условие не выполнено):
{"id":"boundaries","name":"Удержание границ","group":"base","score":null,"quote":"","comment":"N/A: сотрудник не был токсичен"}

Пример 0 (провал):
{"id":"no_devaluation","name":"Отсутствие обесценивания","group":"base","score":0,"quote":"соберись","comment":"обесценивание без извинений"}

Пример 2 (отлично):
{"id":"emotion_validation","name":"Валидация эмоций","group":"base","score":2,"quote":"вижу, что тебе тяжело","comment":"назвал чувство своими словами"}

Пример 0 с пустой цитатой:
{"id":"i_messages","name":"Я-сообщения","group":"base","score":0,"quote":"","comment":"руководитель не использовал я-сообщения"}

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
      
      // ПРИНУДИТЕЛЬНАЯ ПРОВЕРКА ТРИГГЕРОВ через зеркало оффлайн-правил
      let isNa = m.score === null || m.score === 'na';
      if (id === 'boundaries' && !hasToxicity(assistantText)) isNa = true;
      if (id === 'yes_and' && !hasOffer(assistantText)) isNa = true;
      if (id === 'emotion_validation' && !hasEmotion(assistantText)) isNa = true;
      
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
      // === ВРЕМЕННО ДЛЯ ОТЛАДКИ (удалим потом) ===
      _debug: {
        userMessageCount,
        richness,
        hasEmotion: hasEmotion(userText),
        hasOffer: hasOffer(userText),
        hasToxicity: hasToxicity(userText)
      }
    });

  } catch (e) {
    console.error('Eval error:', e);
    return res.status(502).json({ error: e.message || String(e) });
  }
}
