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
    .replace(/"/g, '&quot;');
}

function generatePage(article) {
  const title = escapeHtml(article.title);
  const description = escapeHtml(article.description);
  const cover = article.cover ? escapeHtml(article.cover) : '/img/logo-og.png';
  const slug = escapeHtml(article.slug);

  const descriptionBlock = description
    ? '<p style="margin-top:16px;color:var(--gray);font-size:19px;max-width:640px">' + description + '</p>'
    : '';

  let html = '';
  html += '<!doctype html>\n';
  html += '<html lang="ru">\n';
  html += '<head>\n';
  html += '<meta charset="utf-8"/>\n';
  html += '<meta name="viewport" content="width=device-width, initial-scale=1"/>\n';
  html += '<title>' + title + ' — My Pro Skills</title>\n';
  html += '<meta name="description" content="' + description + '">\n';
  html += '<meta property="og:type" content="article">\n';
  html += '<meta property="og:url" content="https://my-pro-skills.ru/articles/pages/' + slug + '.html">\n';
  html += '<meta property="og:title" content="' + title + '">\n';
  html += '<meta property="og:description" content="' + description + '">\n';
  html += '<meta property="og:image" content="https://my-pro-skills.ru' + cover + '">\n';
  html += '<meta property="og:site_name" content="My Pro Skills">\n';
  html += '<meta name="twitter:card" content="summary_large_image">\n';
  html += '<meta name="twitter:title" content="' + title + '">\n';
  html += '<meta name="twitter:description" content="' + description + '">\n';
  html += '<meta name="twitter:image" content="https://my-pro-skills.ru' + cover + '">\n';
  html += '<link rel="canonical" href="https://my-pro-skills.ru/articles/pages/' + slug + '.html">\n';
  html += '<meta name="theme-color" content="#16202C">\n';
  html += '<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n';
  html += '<link rel="preconnect" href="https://fonts.googleapis.com">\n';
  html += '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Manrope:wght@600;700;800&display=swap" rel="stylesheet">\n';
  html += '<link rel="stylesheet" href="/styles.css">\n';
  html += '<style>\n';
  html += '.back{display:inline-block;margin-bottom:18px;color:var(--mint);text-decoration:none;font-weight:600}\n';
  html += '.article{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px 34px}\n';
  html += '.article h1{font-size:28px;margin:0 0 8px}\n';
  html += '.article h2{font-size:21px;margin:30px 0 10px;padding-bottom:8px;border-bottom:1px solid var(--line);text-align:left}\n';
  html += '.article h3{font-size:17px;margin:22px 0 8px}\n';
  html += '.article p,.article li{color:var(--ink2);font-size:16px}\n';
  html += '.article ul,.article ol{padding-left:22px;color:var(--ink2)}\n';
  html += '.article a{color:var(--mint);font-weight:600}\n';
  html += '.article code{background:#eef1f6;padding:1px 6px;border-radius:6px;font-size:14px}\n';
  html += '.article pre{background:#0f1622;color:#d6deeb;padding:14px 16px;border-radius:12px;overflow:auto}\n';
  html += '.article pre code{background:none;color:inherit;padding:0}\n';
  html += '.article img{max-width:100%;border-radius:12px}\n';
  html += '.article blockquote{border-left:3px solid var(--mint);margin:16px 0;padding:4px 16px;color:var(--ink2);font-style:italic}\n';
  html += '.rate-btn{font-size:24px;background:none;border:2px solid var(--light-stripe);border-radius:12px;padding:10px 16px;cursor:pointer;transition:.2s;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:70px}\n';
  html += '.rate-btn:hover{border-color:var(--mint)}\n';
  html += '.rcount{font-size:13px;color:var(--gray);font-weight:600}\n';
  html += '.btn-emoji{font-size:28px}\n';
  html += '</style>\n';
  html += '</head>\n';
  html += '<body>\n';
  html += '<div class="progress"></div>\n';
  html += '<header class="header">\n';
  html += '<nav class="nav">\n';
  html += '<a class="logo" href="/index.html">\n';
  html += '<svg viewBox="0 0 24 24" fill="none"><rect x="2" y="12" width="5" height="9" rx="2.5" fill="#9AA5B1"/><rect x="9.5" y="7" width="5" height="14" rx="2.5" fill="#E1E7EE"/><rect x="17" y="2" width="5" height="19" rx="2.5" fill="#FFFFFF"/></svg>\n';
  html += 'My Pro Skills\n';
  html += '</a>\n';
  html += '<button class="burger" aria-label="Меню"><span></span><span></span><span></span></button>\n';
  html += '<div class="menu">\n';
  html += '<a href="/index.html#courses">Курсы</a>\n';
  html += '<a href="/projects.html">Проекты</a>\n';
  html += '<a href="/blog.html">Статьи</a>\n';
  html += '<a href="/index.html#approach">Подход</a>\n';
  html += '<a href="/index.html#contacts">Контакты</a>\n';
  html += '</div>\n';
  html += '</nav>\n';
  html += '</header>\n';
  html += '<main id="app">\n';
  html += '<section class="sec-dark hero">\n';
  html += '<div class="wrap">\n';
  html += '<h1>' + title + '</h1>\n';
  html += '<span class="grad-line visible"></span>\n';
  html += descriptionBlock + '\n';
  html += '</div>\n';
  html += '</section>\n';
  html += '<section class="sec-light">\n';
  html += '<div class="wrap">\n';
  html += '<a class="back" href="/blog.html">&#8592; ко всем статьям</a>\n';
  html += '<article class="article" id="article-content">Загрузка...</article>\n';
  html += '<div id="reactions-block" style="margin-top:32px;padding-top:24px;border-top:1px solid var(--line);text-align:center;display:none">\n';
  html += '<p style="color:var(--ink2);font-size:15px;margin-bottom:16px">Как вам статья?</p>\n';
  html += '<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">\n';
  html += '<button id="btn-like" class="rate-btn"><span class="btn-emoji">&#128077;</span><span id="count-like" class="rcount">0</span></button>\n';
  html += '<button id="btn-love" class="rate-btn"><span class="btn-emoji">&#10084;&#65039;</span><span id="count-love" class="rcount">0</span></button>\n';
  html += '<button id="btn-fire" class="rate-btn"><span class="btn-emoji">&#128293;</span><span id="count-fire" class="rcount">0</span></button>\n';
  html += '<button id="btn-think" class="rate-btn"><span class="btn-emoji">&#129300;</span><span id="count-think" class="rcount">0</span></button>\n';
  html += '</div>\n';
  html += '<p id="rate-msg" style="margin-top:14px;color:var(--mint);font-size:14px;opacity:0;transition:.3s">Спасибо за оценку!</p>\n';
  html += '</div>\n';
  html += '<div id="views-block" style="margin-top:20px;padding-top:16px;border-top:1px solid var(--line);justify-content:flex-end;display:none">\n';
  html += '<span style="display:inline-flex;align-items:center;gap:4px;color:var(--gray);font-size:13px"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg><span id="views-count">0</span></span>\n';
  html += '</div>\n';
  html += '</div>\n';
  html += '</section>\n';
  html += '</main>\n';
  html += '<footer class="footer">\n';
  html += '<div class="wrap">\n';
  html += '<div class="footer__row">\n';
  html += '<div>&#169; 2026 My Pro Skills. Все права защищены.<br>\n';
  html += 'Email: <a href="mailto:zhambalkhumaev@yandex.ru">zhambalkhumaev@yandex.ru</a> &#183;\n';
  html += 'Telegram: <a href="https://t.me/Zhambaleilo">@Zhambaleilo</a></div>\n';
  html += '<div><a href="index.html">Все курсы</a> &#183;
  html += '</div>\n';
  html += '</div>\n';
  html += '<div class="wm"><i></i><i></i><i></i></div>\n';
  html += '</footer>\n';
  html += '<button class="top" aria-label="Наверх">&#8593;</button>\n';
  html += '<script src="/js/marked.min.js"></script>\n';
  html += '<script>\n';
  html += 'var NS="myproskills";\n';
  html += 'var slug=' + JSON.stringify(slug) + ';\n';
  html += 'function counterGet(key){return fetch("https://api.counterapi.dev/v1/"+NS+"/"+key).then(function(r){return r.json();}).then(function(d){return d.count||0;}).catch(function(){return 0;});}\n';
  html += 'function counterUp(key){return fetch("https://api.counterapi.dev/v1/"+NS+"/"+key+"/up").then(function(r){return r.json();}).then(function(d){return d.count||0;}).catch(function(){return 0;});}\n';
  html += 'function showMsg(text){var m=document.getElementById("rate-msg");m.textContent=text;m.style.opacity="1";setTimeout(function(){m.style.opacity="0";},2000);}\n';
  html += 'function setupBtn(id,suffix){var btn=document.getElementById(id);btn.addEventListener("click",function(){if(localStorage.getItem("voted_"+slug)){showMsg("Вы уже голосовали!");return;}counterUp(slug+"-"+suffix).then(function(n){document.getElementById("count-"+suffix).textContent=n;localStorage.setItem("voted_"+slug,suffix);var all=document.querySelectorAll(".rate-btn");for(var i=0;i<all.length;i++){all[i].style.borderColor="var(--light-stripe)";}btn.style.borderColor="var(--mint)";showMsg("Спасибо за оценку!");});});}\n';
  html += 'fetch("/articles/"+slug+".md").then(function(r){return r.text();}).then(function(t){\n';
  html += 't=t.replace(/^---[\\s\\S]*?---\\r?\\n?/,"");\n';
  html += 'document.getElementById("article-content").innerHTML=marked.parse(t);\n';
  html += 'counterUp(slug+"-views").then(function(v){document.getElementById("views-count").textContent=v;});\n';
  html += 'counterGet(slug+"-like").then(function(n){document.getElementById("count-like").textContent=n;});\n';
  html += 'counterGet(slug+"-love").then(function(n){document.getElementById("count-love").textContent=n;});\n';
  html += 'counterGet(slug+"-fire").then(function(n){document.getElementById("count-fire").textContent=n;});\n';
  html += 'counterGet(slug+"-think").then(function(n){document.getElementById("count-think").textContent=n;});\n';
  html += 'document.getElementById("reactions-block").style.display="block";\n';
  html += 'document.getElementById("views-block").style.display="flex";\n';
  html += 'setupBtn("btn-like","like");\n';
  html += 'setupBtn("btn-love","love");\n';
  html += 'setupBtn("btn-fire","fire");\n';
  html += 'setupBtn("btn-think","think");\n';
  html += '});\n';
  html += '</script>\n';
  html += '<script src="/script.js"></script>\n';
  html += '</body>\n';
  html += '</html>';

  return html;
}

articles.forEach(article => {
  const html = generatePage(article);
  const outputPath = path.join(outputDir, article.slug + '.html');
  fs.writeFileSync(outputPath, html, 'utf-8');
  console.log('OK: ' + article.slug + '.html');
});

console.log('Generated ' + articles.length + ' article pages');
