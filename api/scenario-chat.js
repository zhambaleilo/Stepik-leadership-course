// api/scenario-chat.js — прокси к GigaChat для симулятора управленческих диалогов
import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import { hasToxicity } from '../tools/offline-rules.js';

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
      timeout: 20000,
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
  }, JSON.stringify({
    model: process.env.GIGACHAT_MODEL || 'GigaChat-2-Pro',
    messages,
    temperature,
    max_tokens: maxTokens
  }));
  
  if (r.status !== 200) throw new Error('chat ' + r.status + ': ' + r.text.slice(0, 120));
  const j = JSON.parse(r.text);
  const content = (j.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('GigaChat вернул пустой ответ');
  return content;
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
    const { scenario_id, user_message, history = [] } = b;
    
    if (!scenario_id || !user_message) {
      return res.status(400).json({ error: 'scenario_id and user_message are required' });
    }

    // 1. Чтение сценария
    const scenarioPath = path.join(process.cwd(), 'scenarios', `${scenario_id}.json`);
    let scenario;
    try {
      const fileContents = fs.readFileSync(scenarioPath, 'utf8');
      scenario = JSON.parse(fileContents);
    } catch (err) {
      return res.status(404).json({ error: 'Scenario not found' });
    }

    // 2. Валидация обязательных полей сценария
    const persona = scenario.ai_persona || {};
    if (!persona.name || !persona.role) {
      console.error('Scenario missing ai_persona.name or ai_persona.role:', scenario_id);
      return res.status(500).json({ error: 'Scenario misconfigured: missing persona' });
    }

    // 3. Проверка динамических триггеров (УНИВЕРСАЛЬНОЕ РЕШЕНИЕ)
    // Инициализируем базовые элементы, затем динамически включаем нужные по action
    const updatedElements = { 
      chat: true, 
      calendar: false, 
      dashboard: false, 
      tasks: false, 
      email: false,
      ...(scenario.active_elements || {}) 
    };

    if (scenario.dynamic_triggers && Array.isArray(scenario.dynamic_triggers)) {
      for (const trigger of scenario.dynamic_triggers) {
        try {
          // Универсальный regex с игнорированием регистра (работает для "ai|нейросеть|...")
          const regex = new RegExp(trigger.keyword, 'i');
          if (regex.test(user_message)) {
            // Динамически извлекаем ключ: "show_tasks" -> "tasks"
            const actionKey = trigger.action.replace('show_', '');
            if (actionKey in updatedElements) {
              updatedElements[actionKey] = true;
            }
          }
        } catch (e) {
          // Fallback на случай невалидного regex в JSON (чтобы бэкенд не упал)
          if (user_message.toLowerCase().includes(trigger.keyword.toLowerCase())) {
            const actionKey = trigger.action.replace('show_', '');
            if (actionKey in updatedElements) {
              updatedElements[actionKey] = true;
            }
          }
        }
      }
    }

    // 4. Детерминированный детект токсичности игрока
    const playerIsToxic = hasToxicity(user_message);

    // 5. Формирование системного промпта
    const systemPrompt = `Ты играешь роль: ${persona.name}, ${persona.role}.
Твое скрытое состояние: ${persona.hidden_state || 'не указано'}.
Твой стиль общения: ${persona.communication_style || 'нейтральный, деловой'}.
Контекст ситуации: ${scenario.context || ''}.
Цель игрока (руководителя): ${scenario.player_goal || ''}.
${playerIsToxic ? '\nВАЖНО: Последняя реплика игрока токсична (давление, обвинения, угрозы). Реагируй соответственно — замыкайся, будь односложным или с пассивной агрессией.' : ''}
Правила:
Отвечай ТОЛЬКО от лица персонажа, коротко (1-3 предложения), как в рабочем мессенджере.
Не используй форматирование Markdown, пиши как живой человек.
Если игрок проявляет эмпатию, постепенно раскрывай свое скрытое состояние.
Если игрок токсичен или давит, замыкайся, отвечай односложно или с пассивной агрессией.
НИКОГДА не раскрывай, что ты ИИ или что это игра.
Помни предыдущие реплики — диалог развивается, не начинай каждый раз сначала.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: user_message }
    ];

    // 6. Запрос к GigaChat
    const aiResponse = await giga(messages, 0.55, 220);

    // 7. Возврат результата
    return res.status(200).json({
      ai_response: aiResponse,
      updated_elements: updatedElements
    });
  } catch (e) {
    console.error('Scenario chat error:', e);
    return res.status(502).json({ error: String(e.code || e.message || e) });
  }
}
