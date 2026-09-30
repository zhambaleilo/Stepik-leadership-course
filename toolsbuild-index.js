const fs = require('fs');
const dir = 'articles';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
const items = files.map(f => {
  const t = fs.readFileSync(dir + '/' + f, 'utf8');
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = {};
  if (m) m[1].split(/\r?\n/).forEach(l => {
    const i = l.indexOf(':');
    if (i > 0) fm[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  });
  return {
    slug: f.replace(/\.md$/, ''),
    title: fm.title || f,
    date: fm.date || '',
    description: fm.description || '',
    tags: (fm.tags || '').split(',').map(s => s.trim()).filter(Boolean),
    cover: fm.cover || ''
  };
}).sort((a, b) => String(b.date).localeCompare(String(a.date)));
fs.writeFileSync(dir + '/index.json', JSON.stringify(items, null, 2));
console.log('index.json: ' + items.length + ' статей');