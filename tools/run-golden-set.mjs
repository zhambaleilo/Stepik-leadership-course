#!/usr/bin/env node
// node tools/run-golden-set.mjs [baseUrl] [--wait=90]
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { validateEvaluation, defaultTolerance } from './validate-eval.mjs';

const args = process.argv.slice(2);
const BASE = (args.find(a => a.startsWith('http')) || 'https://stepik-leadership-course.vercel.app').replace(/\/$/, '');
const waitArg = args.find(a => a.startsWith('--wait='));
if (waitArg) {
  const s = parseInt(waitArg.split('=')[1], 10);
  console.log(`Ждём ${s} c, пока Vercel задеплоит...`);
  await new Promise(r => setTimeout(r, s * 1000));
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const goldenDir = join(root, 'tests', 'golden');
const THRESHOLD = parseFloat(process.env.SOFT_THRESHOLD || '0.35');

let hardFiles = 0, softHits = 0, checkedScores = 0, reviewHits = 0;

for (const f of readdirSync(goldenDir).filter(f => f.endsWith('.json')).sort()) {
  const g = JSON.parse(readFileSync(join(goldenDir, f), 'utf8'));
  const managerText = g.dialogue.filter(m => m.role === 'user').map(m => m.content).join('\n');

  let expectedIds = g.expected_ids;
  if (!expectedIds) {
    try {
      const sc = JSON.parse(readFileSync(join(root, 'scenarios', g.scenario_id + '.json'), 'utf8'));
      const ec = sc.evaluation_criteria || {};
      expectedIds = [...(ec.psychological_safety || []), ...(ec.improvisation || [])];
    } catch (e) { /* нет сценария локально */ }
  }

  let res = null;
  try {
    const r = await fetch(BASE + '/api/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario_id: g.scenario_id, dialogue: g.dialogue })
    });
    res = await r.json();
  } catch (e) {
    console.log(`❌ ${f}\n   ЖЁСТКО: запрос упал: ${e.message}`);
    hardFiles++; continue;
  }

  const { hard, review } = validateEvaluation(res, { managerText, expectedIds });

  const soft = [];
  for (const [id, exp] of Object.entries(g.expected_scores || {})) {
    const got = (res.criteria || []).find(c => c.id === id);
    checkedScores++;
    if (!got) { softHits++; soft.push(`${id}: отсутствует в ответе`); continue; }
    const tol = (g.tolerance || {})[id] ?? defaultTolerance(id);
    if (Math.abs(got.score - exp) > tol) { softHits++; soft.push(`${id}: получено ${got.score}, ожидалось ${exp} (допуск ${tol})`); }
  }

  if (hard.length) { hardFiles++; console.log(`❌ ${f}\n   ЖЁСТКО: ${hard.join('; ')}`); }
  else if (soft.length) console.log(`⚠️  ${f}\n   МЯГКО: ${soft.join('; ')}`);
  else console.log(`✅ ${f}`);

  if (review.length) { reviewHits += review.length; console.log(`   🔍 НА РУЧНУЮ ПРОВЕРКУ: ${review.join(' | ')}`); }
}

const rate = checkedScores ? softHits / checkedScores : 0;
console.log(`\nИтог: жёстких ${hardFiles}, мягких ${softHits}/${checkedScores} (${Math.round(rate * 100)}%), на ручную проверку ${reviewHits}`);
if (hardFiles > 0 || rate > THRESHOLD) { console.log('Порог превышен — регресс промпта или кода.'); process.exit(1); }
console.log('Golden set зелёный.');
