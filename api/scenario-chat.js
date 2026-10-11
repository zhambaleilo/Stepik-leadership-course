import fs from 'fs';
import path from 'path';

// Функция для получения токена GigaChat (переиспользует твои существующие переменные)
async function getGigaChatToken() {
  // ВАЖНО: Замени 'GIGACHAT_CLIENT_ID' и 'GIGACHAT_CLIENT_SECRET' на точные имена 
  // твоих переменных окружения в Vercel, если они называются иначе (например, AUTH_KEY)
  const clientId = process.env.GIGACHAT_CLIENT_ID;
  const clientSecret = process.env.GIGACHAT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('GigaChat credentials not found in environment variables');
  }

  const authString = `${clientId}:${clientSecret}`;
  const base64Auth = Buffer.from(authString).toString('base64');

  const response = await fetch('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${base64Auth}`,
      'RqUID': 'vercel-scenario-req-' + Date.now(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: 'scope=GIGACHAT_API_PERS',
    // В продакшене для self-signed сертификатов Сбера может понадобиться агент, 
    // но на Vercel часто работает без rejectUnauthorized, либо используй process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' для теста
  });

  if (!response.ok) {
    throw new Error(`GigaChat auth failed: ${response.statusText}`);
  }

  const data = await response.json();
  return data.access_token;
}

export default async function handler(req, res) {
  // Разрешаем CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { scenario_id, user_message, history = [] } = req.body;

    if (!scenario_id || !user_message) {
      return res.status(400).json({ error: 'scenario_id and user_message are required' });
    }

    // 1. Читаем сценарий из локальной папки (Vercel бандлит файлы проекта)
    // Путь: корень репозитория / scenarios / {scenario_id}.json
    const scenarioPath = path.join(process.cwd(), 'scenarios', `${scenario_id}.json`);
    
    let scenario;
    try {
      const fileContents = fs.readFileSync(scenarioPath, 'utf8');
      scenario = JSON.parse(fileContents);
    } catch (err) {
      return res.status(404).json({ error: 'Scenario not found' });
    }

    // 2. Проверка динамических триггеров
    const updatedElements = { ...scenario.active_elements };
    if (scenario.dynamic_triggers) {
      for (const trigger of scenario.dynamic_triggers) {
        const regex = new RegExp(trigger.keyword, 'i'); // 'i' для регистронезависимого поиска
        if (regex.test(user_message)) {
          if (trigger.action === 'show_calendar') updatedElements.calendar = true;
          if (trigger.action === 'show_dashboard') updatedElements.dashboard = true;
          if (trigger.action === 'show_tasks') updatedElements.tasks = true;
          if (trigger.action === 'show_email') updatedElements.email = true;
        }
      }
    }

    // 3. Формируем системный промпт
    const persona = scenario.ai_persona;
    const systemPrompt = `Ты играешь роль: ${persona.name}, ${persona.role}.
Твое скрытое состояние: ${persona.hidden_state}.
Твой стиль общения: ${persona.communication_style}.
Контекст ситуации: ${scenario.context}.
Цель игрока (руководителя): ${scenario.player_goal}.

Правила:
1. Отвечай ТОЛЬКО от лица персонажа, коротко (1-3 предложения), как в рабочем мессенджере.
2. Не используй форматирование Markdown, пиши как живой человек.
3. Если игрок проявляет эмпатию, постепенно раскрывай свое скрытое состояние.
4. Если игрок токсичен или давит, замыкайся, отвечай односложно или с пассивной агрессией.
5. НИКОГДА не раскрывай, что ты ИИ или что это игра.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: user_message }
    ];

    // 4. Запрос к GigaChat
    const token = await getGigaChatToken();
    
    const chatResponse = await fetch('https://ngw.devices.sberbank.ru:9443/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        model: 'GigaChat', // или 'GigaChat-Pro', если используешь его
        messages: messages,
        temperature: 0.7,
        max_tokens: 150
      })
    });

    if (!chatResponse.ok) {
      const errText = await chatResponse.text();
      throw new Error(`GigaChat API failed: ${chatResponse.status} - ${errText}`);
    }

    const chatData = await chatResponse.json();
    const aiResponse = chatData.choices[0].message.content.trim();

    // 5. Возвращаем результат фронтенду
    return res.status(200).json({
      ai_response: aiResponse,
      updated_elements: updatedElements
    });

  } catch (error) {
    console.error('Scenario chat error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
