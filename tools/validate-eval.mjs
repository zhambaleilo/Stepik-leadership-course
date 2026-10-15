// Детерминированный аудитор оценки. Ноль токенов, ноль ИИ.
export const VIOLATION_CRITERIA = ['no_devaluation', 'boundaries'];
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

// Цитата дословна, если каждый её кусок (мнооточие = законный разрыв)
// находится в нормализованном тексте реплик руководителя
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
    if (!(Number.isInteger(c.score) && c.score >= 0 && c.score <= 2))
      hard.push(`${c.id}: балл ${c.score} вне 0..2`);
    if (c.quote && !quoteIsVerbatim(c.quote, managerText))
      hard.push(`${c.id}: цитата не найдена в репликах руководителя`);
  }

  const sum = crit.reduce((a, c) => a + (Number(c.score) || 0), 0);
  if (res.total_score !== sum) hard.push(`total_score ${res.total_score} != сумма ${sum}`);
  if (res.max_score !== crit.length * 2) hard.push(`max_score ${res.max_score} != ${crit.length * 2}`);

  if (Array.isArray(ctx.expectedIds)) {
    const got = crit.map(c => c.id).sort().join(',');
    const exp = [...ctx.expectedIds].sort().join(',');
    if (got !== exp) hard.push(`набор критериев не совпал: получен [${got}]`);
  }

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
