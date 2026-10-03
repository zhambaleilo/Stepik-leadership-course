const fs = require('fs');
const dir = 'articles';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));

function parseFM(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  let key = null;
  m[1].split(/\r?\n/).forEach(function (l) {
    if (/^\s+\S/.test(l) && key) {
      out[key] = (out[key] ? out[key] + ' ' : '') + l.trim();
      return;
    }
    const i = l.indexOf(':');
    if (i > 0) {
      key = l.slice(0, i).trim();
      const v = l.slice(i + 1).trim();
      out[key] = (v === '>-' || v === '>' || v === '|-' || v === '|') ? '' : v;
    } else {
      key = null;
    }
  });
  Object.keys(out).forEach(function (k) {
    out[k] = out[k].replace(/^["']|["']$/g, '').trim();
  });
  return out;
}

const items = files.map(f => {
  const t = fs.readFileSync(dir + '/' + f, 'utf8');
  const fm = parseFM(t);
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
