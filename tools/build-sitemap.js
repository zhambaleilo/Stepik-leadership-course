// Пересобирает sitemap.xml: базовые страницы + все статьи из articles/*.md
const fs = require('fs');

const SITE = 'https://my-pro-skills.ru';
const today = new Date().toISOString().slice(0, 10);

const base = [
  { loc: '/', changefreq: 'weekly', priority: '1.0' },
  { loc: '/leadership.html', changefreq: 'monthly', priority: '0.9' },
  { loc: '/gost-45003.html', changefreq: 'weekly', priority: '0.9' },
  { loc: '/templates.html', changefreq: 'monthly', priority: '0.8' },
  { loc: '/blog.html', changefreq: 'daily', priority: '0.8' },
  { loc: '/projects.html', changefreq: 'monthly', priority: '0.8' },
  { loc: '/playground.html', changefreq: 'monthly', priority: '0.7' },
  { loc: '/resume.html', changefreq: 'monthly', priority: '0.6' }
];

const urls = base.map(u => ({ loc: u.loc, lastmod: today, changefreq: u.changefreq, priority: u.priority }));

const files = fs.readdirSync('articles').filter(f => f.endsWith('.md'));
for (const f of files) {
  const slug = f.replace(/\.md$/, '');
  const m = slug.match(/^(\d{4}-\d{2}-\d{2})/);
  urls.push({
    loc: '/articles/pages/' + slug + '.html',
    lastmod: m ? m[1] : today,
    changefreq: 'monthly',
    priority: '0.7'
  });
}

const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls.map(u =>
    '  <url>\n    <loc>' + SITE + u.loc + '</loc>\n    <lastmod>' + u.lastmod +
    '</lastmod>\n    <changefreq>' + u.changefreq + '</changefreq>\n    <priority>' + u.priority + '</priority>\n  </url>'
  ).join('\n') +
  '\n</urlset>\n';

fs.writeFileSync('sitemap.xml', xml);
console.log('sitemap.xml пересобран: ' + urls.length + ' URL (' + files.length + ' статей)');
