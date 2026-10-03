const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const tplFile = path.join(__dirname, 'article-template.html');
const idxFile = path.join(root, 'articles', 'index.json');
const outDir = path.join(root, 'articles', 'pages');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const tpl = fs.readFileSync(tplFile, 'utf-8');
const list = JSON.parse(fs.readFileSync(idxFile, 'utf-8'));

function esc(s) {
  if (!s) return '';
  return String(s)
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;');
}

list.forEach(function (a) {
  const cover = a.cover ? esc(a.cover) : '/img/logo-og.png';
  const desc = esc(a.description);
  let block = '';
  if (desc) {
    block = '<p class="hero-sub">' + desc + '</p>';
  }
  let out = tpl;
  out = out.split('{{TITLE}}').join(esc(a.title));
  out = out.split('{{DESC}}').join(desc);
  out = out.split('{{SLUG}}').join(esc(a.slug));
  out = out.split('{{COVER}}').join(cover);
  out = out.split('{{DESC_BLOCK}}').join(block);
  const file = path.join(outDir, a.slug + '.html');
  fs.writeFileSync(file, out, 'utf-8');
  console.log('OK ' + a.slug);
});

console.log('Done: ' + list.length);
