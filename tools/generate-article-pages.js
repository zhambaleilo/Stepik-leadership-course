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
    '<style>',
    '.back{display:inline-block;margin-bottom:18px;color:var(--mint);text-decoration:none;font-weight:600}',
    '.article{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px 34px}',
    '.article h1{font-size:28px;margin:0 0 8px}',
    '.article h2{font-size:21px;margin:30px 0 10px;padding-bottom:8px;border-bottom:1px solid var(--line)}',
    '.article h3{font-size:17px;margin:22px 0 8px}',
    '.article p,.article li{color:var(--ink2);font-size:16px}',
    '.article ul,.article ol{padding-left:22px;color:var(--ink2)}',
    '.article a{color:var(--mint);font-weight:600}',
    '.article code{background:#eef1f6;padding:1px 6px;border-radius:6px;font-size:14px}',
    '.article pre{background:#0f1622;color:#d6deeb;padding:14px 16px;border-radius:12px;overflow:auto}',
    '.article pre code{background:none;color:inherit;padding:0}',
    '.article img{max-width:100%;border-radius:12px}',
    '.article blockquote{border-left:3px solid var(--mint);margin:16px 0;padding:4px 16px;color:var(--ink2);font-style:italic}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="progress"></div>',
    '<header class="header">',
    '<nav class="nav">',
    '<a class="logo" href="/index.html">',
    '<svg viewBox="0 0 24 24" fill="none"><rect x="2" y="12" width="5" height="9" rx="2.5" fill="#9AA5B1"/><rect x="9.5" y="7" width="5" height="14" rx="2.5" fill="#E1E7EE"/><rect x="17" y="2" width="5" height="19" rx="2.5" fill="#FFFFFF"/></svg>',
    'My Pro Skills',
    '</a>',
    '<button class="burger" aria-label="Меню"><span></span><span></span><span></span></button>',
    '<div class="menu">',
    '<a href="/index.html#courses">Курсы</a>',
    '<a href="/projects.html">Проекты</a>',
    '<a href="/blog.html">Статьи</a>',
    '<a href="/index.html#approach">Подход</a>',
    '<a href="/index.html#contacts">Контакты</a>',
    '</div>',
    '</nav>',
    '</header>',
    '<main id="app">',
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
    '<div id="reactions-block" style="margin-top:32px;padding-top:24px;border-top:1px solid var(--line);text-align:center;display:none">',
    '<p style="color:var(--ink2);font-size:15px;margin-bottom:16px">Как вам статья?</p>',
    '<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap" id="reactions">',
    '<button class="rate-btn" data-key="' + slug + '-like" style="font-size:24px;background:none;border:2px solid var(--light-stripe);border-radius:12px;padding:10px 16px;cursor:pointer;transition:.2s;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:70px"><span style="font-size:28px">👍</span><span class="rcount" style="font-size:13px;color:var(--gray);font-weight:600">0</span></button>',
    '<button class="rate-btn" data-key="' + slug + '-love" style="font-size:24px;background:none;border:2px solid var(--light-stripe);border-radius:12px;padding:10px 16px;cursor:pointer;transition:.2s;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:70px"><span style="font-size:28px">❤️</span><span class="rcount" style="font-size:13px;color:var(--gray);font-weight:600">0</span></button>',
    '<button class="rate-btn" data-key="' + slug + '-fire" style="font-size:24px;background:none;border:2px solid var(--light-stripe);border-radius:12px;padding:10px 16px;cursor:pointer;transition:.2s;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:70px"><span style="font-size:28px">🔥</span><span class="rcount" style="font-size:13px;color:var(--gray);font-weight:600">0</span></button>',
    '<button class="rate-btn" data-key="' + slug + '-think" style="font-size:24px;background:none;border:2px solid var(--light-stripe);border-radius:12px;padding:10px 16px;cursor:pointer;transition:.2s;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:70px"><span style="font-size:28px">🤔</span><span class="rcount" style="font-size:13px;color:var(--gray);font-weight:600">0</span></button>',
    '</div>',
    '<p id="rate-msg" style="margin-top:14px;color:var(--mint);font-size:14px;opacity:0;transition:.3s">Спасибо за оценку!</p>',
    '</div>',
    '<div id="views-block" style="margin-top:20px;padding-top:16px;border-top:1px solid var(--line);display:flex;justify-content:flex-end;display:none">',
    '<span style="display:inline-flex;align-items:center;gap:4px;color:var(--gray);font-size:13px"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg><span id="views-count">0</span></span>',
    '</div>',
    '</section>',
    '</main>',
    '<footer class="footer">',
    '<div class="wrap">',
    '<div class="footer__row">',
    '<div>© 2026 My Pro Skills. Все права защищены.<br>',
    'Email: <a href="mailto:zhambalkhumaev@yandex.ru">zhambalkhumaev@yandex.ru</a> ·',
    'Telegram: <a href="https://t.me/Zhambaleilo">@Zhambaleilo</a></div>',
    '<div><a href="index.html">Все курсы</a>,
    '</div>',
    '</div>',
    '<div class="wm"><i></i><i></i><i></i></div>',
    '</footer>',
    '<button class="top" aria-label="Наверх">↑</button>',
    '<script src="/js/marked.min.js"></script>',
    '<script>',
    'const NS = "myproskills";',
    'const slug = ' + JSON.stringify(slug) + ';',
    'async function counterGet(key) { try { const r = await fetch("https://api.counterapi.dev/v1/" + NS + "/" + key); const d = await r.json(); return d.count || 0; } catch(e) { return 0; } }',
    'async function counterUp(key) { try { const r = await fetch("https://api.counterapi.dev/v1/" + NS + "/" + key + "/up"); const d = await r.json(); return d.count || 0; } catch(e) { return 0; } }',
    'fetch("/articles/" + slug + ".md").then(r => r.text()).then(t => {',
    't = t.replace(/^---[\\s\\S]*?---\\r?\\n?/, "");',
    'document.getElementById("article-content").innerHTML = marked.parse(t);',
    'Promise.all([counterUp(slug + "-views"), counterGet(slug + "-like"), counterGet(slug + "-love"), counterGet(slug + "-fire"), counterGet(slug + "-think")]).then(([views, like, love, fire, think]) => {',
    'document.getElementById("views-count").textContent = views;',
    'document.querySelector(\'[data-key="' + slug + \'-like"] .rcount\').textContent = like;',
    'document.querySelector(\'[data-key="' + slug + \'-love"] .rcount\').textContent = love;',
    'document.querySelector(\'[data-key="' + slug + \'-fire"] .rcount\').textContent = fire;',
    'document.querySelector(\'[data-key="' + slug + \'-think"] .rcount\').textContent = think;',
    'document.getElementById("reactions-block").style.display = "block";',
    'document.getElementById("views-block").style.display = "flex";',
    'document.querySelectorAll(".rate-btn").forEach(btn => {',
    'btn.addEventListener("click", async function() {',
    'const key = this.dataset.key;',
    'const voted = localStorage.getItem("voted_" + slug);',
    'if (voted) { const msg = document.getElementById("rate-msg"); msg.textContent = "Вы уже голосовали!"; msg.style.opacity = "1"; setTimeout(() => msg.style.opacity = "0", 2000); return; }',
    'const newCount = await counterUp(key);',
    'this.querySelector(".rcount").textContent = newCount;',
    'localStorage.setItem("voted_" + slug, key);',
    'document.querySelectorAll(".rate-btn").forEach(b => b.style.borderColor = "var(--light-stripe)");',
    'this.style.borderColor = "var(--mint)";',
    'const msg = document.getElementById("rate-msg");',
    'msg.textContent = "Спасибо за оценку!";',
    'msg.style.opacity = "1";',
    'setTimeout(() => msg.style.opacity = "0", 2000);',
    '});',
    '});',
    '});',
    '});',
    '</script>',
    '<script src="/script.js"></script>',
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
