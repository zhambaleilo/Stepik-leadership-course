# My Pro Skills — карта репозитория

Платформа: курсы и SEO-контент по управлению, тренажёры soft skills,
RPG-симулятор руководителя «Лаборатория лидеров», портфолио автора.

## Три точки деплоя
1. **GitHub Pages** — вся статика (страницы, стили, статьи, сценарии). Домен my-pro-skills.ru (CNAME).
2. **Vercel** — только папка `api/` (serverless-функции). Проект stepik-leadership-course.
   Секреты GigaChat — в Environment Variables Vercel, в репозитории их нет.
3. **GitHub Actions** — автогенерация страниц статей и sitemap; регресс-тест golden-set.

## Кто пишет файлы
- **Decap CMS** (`/admin/`) сам пишет в `articles/*.md` и `scenarios/*.json`. Руками эти файлы не правим.
- **Actions** сам генерирует `sitemap.xml` и страницы статей. Руками не правим.
- Всё остальное — руками через коммиты.

## Карта папок
| Путь | Ответственность |
|---|---|
| `api/` | Vercel-функции: chat.js (прокси тренажёра курса), scenario-chat.js (диалог игры), evaluate.js (ИИ-судья по 11 критериям) |
| `admin/` | конфиг Decap: коллекции «Статьи» и «Сценарии игры» |
| `articles/` | MD-исходники статей (пишет Decap) |
| `scenarios/` | JSON-сценарии игры (пишет Decap); читает Vercel |
| `play/` | игра: index.html (демо, 0 токенов), game.html (полная версия), styles.css, script.js |
| `tools/` | build-sitemap.js, generate-article-pages.js, run-golden-set.mjs, validate-eval.mjs |
| `tests/golden/` | эталонные диалоги-ловушки с замороженной разметкой |
| `.github/workflows/` | generate-pages.yml, golden-set.yml |
| `trainers/`, `data/` | legacy-тренажёры и их данные (заморожено) |
| корневые *.html | публичные входные страницы |

## Правила репозитория
1. Публичные URL не меняются. Перенос страницы = файл на новом месте + redirect-заглушка на старом URL.
2. `api/`, `articles/`, `scenarios/` не перемещаются (конвенции Vercel и Decap).
3. Правка промпта в `evaluate.js` = обязательный прогон golden-set (Actions сделает сам).
4. Изменение ожидания в `tests/golden/` = отдельный коммит `golden: <id> — <причина>` + запись в `revision` файла.
5. ИИ не арбитр: разметку эталонов визирует человек.

## Рецепты
- **Новая статья:** админка → Статьи → Publish. Дальше Actions сам.
- **Новый сценарий игры:** админка → Сценарии игры → Publish. Файл появится в `scenarios/`.
- **Новая API-функция:** файл в `api/`, CORS-блок копировать из scenario-chat.js.
- **Новая страница:** html в корне или папке + ссылка в навигации + href в sitemap-генератор.
- **Новая ловушка:** json в `tests/golden/` по образцу существующих.

## Локальные проверки
node tools/run-golden-set.mjs            # прогон эталонов по проду
node tools/run-golden-set.mjs --wait=90  # если только что коммитил api/
