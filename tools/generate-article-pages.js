const fs = require('fs');
const path = require('path');

const articlesDir = path.join(__dirname, '../articles');
const outputDir = path.join(__dirname, '../articles/pages');

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const indexFile = path.join(articlesDir, 'index.json');
const articles = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function generatePage(article) {
  const title = escapeHtml(article.title);
  const description = escapeHtml(article.description);
  const cover = article.cover ? escapeHtml(article.cover) : '/img/logo-og.png';
  const slug = escapeHtml(article.slug);
  
  const descriptionBlock = description 
    ? '<p style="margin-top:16px;color:var(--gray);font-size:19px;max-width:640px">' + description + '</p>' 
    : '';
  
  return [
    '<!doctype html>',
    '<html lang="ru">',
    '<head>',
    '<meta charset="utf-8"/>',
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>',
    '<title>' + title + ' — My Pro Skills</title>',
    '<meta name="description" content="' + description + '">',
    '<meta property="og:type" content="article">',
    '<meta property="og:url" content="https://my-pro-skills.ru/articles/pages/' + slug + '.html">',
    '<meta property="og:title" content="' + title + '">',
    '<meta property="og:description" content="' + description + '">',
    '<meta property="og:image" content="https://my-pro-skills.ru' + cover + '">',
    '<meta property="og:site_name" content="My Pro Skills">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:title" content="' + title + '">',
    '<meta name="twitter:description" content="' + description + '">',
    '<meta name="twitter:image" content="https://my-pro-skills.ru' + cover + '">',
    '<link rel="canonical" href="https://my-pro-skills.ru/articles/pages/' + slug + '.html">',
    '<meta name="theme-color" content="#16202C">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Manrope:wght@600;700;800&display=swap" rel="stylesheet">',
    '<link rel="stylesheet" href="/styles.css">',
    '</head>',
    '<body>',
    '<header class="header">',
    '<nav class="nav">',
    '<a class="logo" href="/index.html">',
    '<svg viewBox="0 0 24 24" fill="none"><rect x="2" y="12" width="5" height="9" rx="2.5" fill="#9AA5B1"/><rect x="9.5" y="7" width="5" height="14" rx="2.5" fill="#E1E7EE"/><rect x="17" y="2" width="5" height="19" rx="2.5" fill="#FFFFFF"/></svg>',
    'My Pro Skills',
    '</a>',
    '<div class="menu">',
    '<a href="/index.html#courses">Курсы</a>',
    '<a href="/projects.html">Проекты</a>',
    '<a href="/blog.html">Статьи</a>',
    '<a href="/index.html#approach">Подход</a>',
    '<a href="/index.html#contacts">Контакты</a>',
    '</div>',
    '</nav>',
    '</header>',
    '<main>',
    '<section class="sec-dark hero">',
    '<div class="wrap">',
    '<h1>' + title + '</h1>',
    '<span class="grad-line visible"></span>',
    descriptionBlock,
    '</div>',
    '</section>',
    '<section class="sec-light">',
    '<div class="wrap">',
    '<a class="back" href="/blog.html">← ко всем статьям</a>',
    '<article class="article" id="article-content">Загрузка...</article>',
    '</div>',
    '</section>',
    '</main>',
    '<footer class="footer">',
    '<div class="wrap">',
    '<div class="footer__row">',
    '<div>© 2026 My Pro Skills. Все права защищены.<br>',
    'Email: <a href="mailto:zhambalkhumaev@yandex.ru">zhambalkhumaev@yandex.ru</a> ·',
    'Telegram: <a href="https://t.me/Zhambaleilo">@Zhambaleilo</a></div>',
    '</div>',
    '</div>',
    '</footer>',
    '<script src="/js/marked.min.js"></script>',
    '<script>',
    'const slug = ' + JSON.stringify(article.slug) + ';',
    "fetch('/articles/' + slug + '.md')",
    ".then(r => r.text())",
    ".then(t => {",
    "t = t.replace(/^---[\\s\\S]*?---\\r?\\n?/, '');",
    "document.getElementById('article-content').innerHTML = marked.parse(t);",
    "});",
    '</script>',
    '</body>',
    '</html>'
  ].join('\n');
}

articles.forEach(article => {
  const html = generatePage(article);
  const outputPath = path.join(outputDir, article.slug + '.html');
  fs.writeFileSync(outputPath, html, 'utf-8');
  console.log('✓ Generated: ' + article.slug + '.html');
});

console.log('\n✅ Generated ' + articles.length + ' article pages');
