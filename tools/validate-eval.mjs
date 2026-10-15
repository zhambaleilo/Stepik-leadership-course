// Детерминированный аудитор оценки. Ноль токенов, ноль ИИ.
// Каноническая карта блоков — тестовый оракул; синхронизировать с META в api/evaluate.js.
export const GROUPS = {
  no_devaluation: 'base', i_messages: 'base', solution_focus: 'base', concrete_next_step: 'base',
  emotion_validation: 'base', boundaries: 'base',
  active_listening: 'goe', adaptability: 'goe', yes_and: 'goe', reframing: 'goe', creativity: 'goe'
};
export const SUBJECTIVE_CRITERIA = ['creativity', 'adaptability'];

export function defaultTolerance(id) {
  return SUBJECTIVE_CRITERIA.includes(id) ? 1 : 0;
}

function norm(s) {
  return String(s).toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"']/g, '')
    .replace(/[—–‐-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function quoteIsVerbatim(quote, managerText) {
  const t = norm(managerText);
  const frags = String(quote).split(/…|\.\.\./).map(norm).filter(f => f.length > 0);
  if (!frags.length) return false;
  return frags.every(f => t.includes(f));
}

function wordOverlap(a, b) {
  const wa = new Set(a.split(/\s+/).filter(w => w.length > 3));
  const wb = new Set(b.split(/\s+/).filter(w => w.length > 3));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.min(wa.size, wb.size);
}

export function validateEvaluation(res, ctx) {
  const hard = [], review = [];
  const crit = Array.isArray(res?.criteria) ? res.criteria : [];
  if (!crit.length) hard.push('в ответе нет criteria');
  const managerText = ctx.managerText || '';

  for (const c of crit) {
    if (GROUPS[c.id] && c.group !== GROUPS[c.id])
      hard.push(`${c.id}: группа ${c.group} != каноническая ${GROUPS[c.id]}`);
    if (c.na) {
      if (c.score !== null && c.score !== undefined) hard.push(`${c.id}: помечен N/A, но есть score`);
      if (c.quote) hard.push(`${c.id}: цитата при N/A`);
      continue;
    }
    if (!(Number.isInteger(c.score) && c.score >= 0 && c.score <= 2))
      hard.push(`${c.id}: балл ${c.score} вне 0..2`);
    if (c.quote && !quoteIsVerbatim(c.quote, managerText))
      hard.push(`${c.id}: цитата не найдена в репликах руководителя`);
  }

  // Поблочная арифметика (база / GOE) и итоги
  const base = crit.filter(c => (GROUPS[c.id] || c.group) === 'base' && !c.na);
  const goe = crit.filter(c => (GROUPS[c.id] || c.group) === 'goe' && !c.na);
  const baseSum = base.reduce((a, c) => a + c.score, 0);
  const goeSum = goe.reduce((a, c) => a + c.score, 0);
  if (res.base_score !== baseSum) hard.push(`base_score ${res.base_score} != сумма ${baseSum}`);
  if (res.base_max !== base.length * 2) hard.push(`base_max ${res.base_max} != ${base.length * 2}`);
  if (res.goe_score !== goeSum) hard.push(`goe_score ${res.goe_score} != сумма ${goeSum}`);
  if (res.goe_max !== goe.length * 2) hard.push(`goe_max ${res.goe_max} != ${goe.length * 2}`);
  if (res.total_score !== baseSum + goeSum) hard.push(`total_score ${res.total_score} != ${baseSum + goeSum}`);
  if (res.max_score !== base.length * 2 + goe.length * 2) hard.push(`max_score ${res.max_score} != ${base.length * 2 + goe.length * 2}`);

  if (Array.isArray(ctx.expectedIds)) {
    const got = crit.map(c => c.id).sort().join(',');
    const exp = [...ctx.expectedIds].sort().join(',');
    if (got !== exp) hard.push(`набор критериев не совпал: получен [${got}]`);
  }

  // Ленивое натягивание: повтор цитаты легален, идентичные/перефразные comment — нет
  const byQuote = new Map();
  for (const c of crit) {
    if (!c.quote) continue;
    const k = norm(c.quote);
    if (!byQuote.has(k)) byQuote.set(k, []);
    byQuote.get(k).push(c);
  }
  for (const [, list] of byQuote) {
    if (list.length < 2) continue;
    const comments = list.map(c => (c.comment || '').trim().toLowerCase());
    if (comments.every(x => x === comments[0])) {
      review.push(`quote для ${list.map(c => c.id).join(', ')} с идентичным comment — похоже на ленивое натягивание`);
      continue;
    }
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const ov = wordOverlap(comments[i], comments[j]);
        if (ov > 0.8)
          review.push(`quote для ${list[i].id} и ${list[j].id}: comment — перефраз (${Math.round(ov * 100)}%), аспекты не разведены`);
      }
  }

  return { hard, review };
}
