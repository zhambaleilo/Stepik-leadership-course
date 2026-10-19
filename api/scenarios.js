// api/scenarios.js — read-only витрина папки scenarios/ для фронтенда
import fs from 'fs';
import path from 'path';

// Fallback: вытащить цитату сотрудника из context, если нет initial_message
function extractInitialFromContext(context) {
  if (!context) return '';
  const m = context.match(/написал:\s*['«"]([^'»"]+)['»"]/i);
  return m ? m[1].trim() : '';
}

export default function handler(req, res) {
  const allow = ['https://my-pro-skills.ru', 'http://localhost:8000'];
  const origin = req.headers.origin || '';
  if (allow.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const dir = path.join(process.cwd(), 'scenarios');
    if (!fs.existsSync(dir)) return res.status(200).json({ scenarios: [] });

    const scenarios = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') && !f.startsWith('golden_'))
      .map(f => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          const item = {
            id: s.id || s.scenario_id || f.replace('.json', ''),
            title: s.title || '',
            role: s.role || (s.ai_persona && s.ai_persona.role) || '',
            desc: s.description || s.desc || s.context || '',
            initialMessage: s.initial_message || s.first_message ||
                            extractInitialFromContext(s.context) || ''
          };
          // Игровой сценарий = есть id, заголовок и первое сообщение
          return (item.id && item.title && item.initialMessage) ? item : null;
        } catch (e) {
          console.error('Bad scenario file:', f, e.message);
          return null;
        }
      })
      .filter(Boolean);

    return res.status(200).json({ scenarios });
  } catch (e) {
    console.error('scenarios list error:', e);
    return res.status(500).json({ error: e.message });
  }
}
