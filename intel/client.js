// Market Intel — клиент (index.html и app.html).
// Сессия — HttpOnly cookie с SameSite=Strict, поэтому кабинет живёт на домене API.
(function () {
  'use strict';

  var API_HOST = 'stepik-leadership-course.vercel.app';
  if (/(^|\.)my-pro-skills\.ru$/i.test(location.hostname)) {
    location.replace('https://' + API_HOST + location.pathname + location.search);
    return;
  }

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var safeUrl = function (u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : ''; };
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    json: function (k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } },
    setJson: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  var fmtDate = function (s) {
    try { return new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  };

  // ---------- настройки вида ----------
  var DEF_PREFS = { theme: 'dark', density: 'cozy', sigsort: 'weight', unmeasured: true, traces: 'all', motion: true };
  var prefs = Object.assign({}, DEF_PREFS, store.json('intel.prefs', {}));
  function applyPrefs() {
    var h = document.documentElement;
    h.dataset.theme = prefs.theme; h.dataset.density = prefs.density; h.dataset.motion = prefs.motion ? 'on' : 'off';
    store.setJson('intel.prefs', prefs);
  }
  applyPrefs();

  // ---------- тосты ----------
  function toast(msg, kind, action) {
    var box = $('toasts'); if (!box) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = '<span>' + esc(msg) + '</span>';
    if (action) {
      var b = document.createElement('button');
      b.className = 'btn ghost sm'; b.type = 'button'; b.textContent = action.label;
      b.addEventListener('click', function () { action.fn(); el.remove(); });
      el.appendChild(b);
    }
    box.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; setTimeout(function () { el.remove(); }, 260); }, action ? 7000 : 4200);
  }

  // ---------- API ----------
  async function api(action, opts) {
    opts = opts || {};
    try {
      var res = await fetch('/api/intel?action=' + action + (opts.query || ''), {
        method: opts.method || 'GET',
        credentials: 'same-origin',
        headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
      var data = null;
      try { data = await res.json(); } catch (e) {}
      return { status: res.status, data: data, json: !!data };
    } catch (e) { return { status: 0, data: null, json: false }; }
  }

  function errText(r, what) {
    var e = r.data && (r.data.error || r.data.reason), m = r.data && r.data.message;
    if (r.status === 0) return 'Нет связи с сервером. ' + what;
    if (!r.json) return 'Сервер не уложился во время ответа или временно недоступен. ' + what;
    if (e === 'package_exhausted') return 'Пакет анализов исчерпан. Обратитесь за продлением.';
    if (e === 'daily_cap') return m || 'Дневной лимит анализов исчерпан. Попробуйте завтра.';
    if (e === 'too_many_requests' || e === 'too_many_attempts') return 'Слишком много запросов. Подождите минуту и повторите.';
    if (e === 'too_soon') return 'Повторить можно через минуту после предыдущей попытки.';
    if (e === 'guard_unavailable' || e === 'migration_missing') return 'Сервис временно недоступен. ' + what;
    if (e === 'server_misconfigured') return 'Сервис ещё не настроен: сообщите владельцу.';
    if (e === 'analyze_failed') return 'Модель анализа не ответила или перегружена. Пакет не списан. ' + what;
    if (e === 'no_signals' || e === 'no_data') return m || 'Источники молчат. Пакет не списан. ' + what;
    if (e === 'too_slow') return m || 'Источники ответили слишком медленно. Пакет не списан, повторите.';
    if (e === 'unauthorized') return 'Сессия истекла. Войдите заново.';
    if (r.status === 400) return 'Проверьте поля формы: ' + (e || 'ошибка данных') + '.';
    return 'Не удалось выполнить запрос (' + r.status + '). ' + what;
  }

  // ================= ВХОД =================
  if (document.body.dataset.page === 'login') {
    var note = $('originNote');
    if (location.protocol === 'file:') note.textContent = 'Откройте страницу через сервер — локальный файл не сможет обратиться к API.';
    else note.textContent = 'Кабинет работает на домене ' + API_HOST + ': там же хранится сессия.';

    api('history').then(function (r) { if (r.status === 200) location.replace('app.html'); });

    $('togglePw').addEventListener('click', function () {
      var pw = $('pw'); var show = pw.type === 'password';
      pw.type = show ? 'text' : 'password';
      this.textContent = show ? '🙈' : '👁';
      this.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
      pw.focus();
    });

    $('loginForm').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var err = $('err'), go = $('go');
      err.textContent = ''; go.disabled = true; go.textContent = 'Проверяю…';
      var r = await api('login', { method: 'POST', body: { password: $('pw').value } });
      if (r.status === 200 && r.data && r.data.ok) {
        store.set('intelLabel', r.data.label || '');
        location.replace('app.html'); return;
      }
      err.textContent = r.status === 401 ? 'Неверный пароль.' : errText(r, 'Попробуйте ещё раз.');
      go.disabled = false; go.textContent = 'Войти'; $('pw').select();
    });
    return;
  }

  // ================= КАБИНЕТ =================
  var SIGNALS = [
    ['demand', 'Спрос', 'Насколько активно люди ищут решение', 'var(--cyan)', 0.30],
    ['unresolved_pain', 'Нерешённая боль', 'Закрыта ли боль текущими решениями', 'var(--signal)', 0.25],
    ['willingness_to_pay', 'Готовность платить', 'Платные аналоги и разговоры о цене', 'var(--amber)', 0.20],
    ['competition', 'Слабость конкурентов', '100 — конкуренты слабые, 0 — рынок перегрет', 'var(--magenta)', 0.15],
    ['audience_reach', 'Доступность аудитории', 'Есть ли места, где аудитория собрана', 'var(--violet)', 0.10]
  ];
  var state = { current: null, demo: false, busy: false, items: [], views: store.json('intel.views', []), lastDeleted: null };

  function setStatus(t, isErr, spin) {
    var s = $('status');
    s.className = 'status' + (isErr ? ' err' : '');
    s.innerHTML = (spin ? '<span class="spin" aria-hidden="true"></span>' : '') + esc(t || '');
  }
  function setQuota(q) {
    var el = $('quota');
    if (!q) { el.textContent = 'Пакет: —'; el.className = 'quota'; return; }
    el.textContent = 'Осталось ' + q.remaining + ' из ' + q.limit;
    el.className = 'quota' + (q.remaining <= 0 ? ' zero' : q.remaining <= 3 ? ' low' : '');
    $('runBtn').dataset.empty = q.remaining <= 0 ? '1' : '';
  }

  // ---------- демо-отчёт: интерфейс можно изучить без пароля и без расхода пакета ----------
  function demoRun() {
    var sn = [
      { idx: 0, source: 'reddit', title: 'Смены ставят без согласования — как вы это отслеживаете?', snippet: 'Каждый месяц одно и то же: двойная смена появляется в графике за день до выхода. Веду свой список в заметках, но постоянно теряю часы.', link: 'https://www.reddit.com/r/nursing/search/?q=scheduling&restrict_sr=1&sort=top' },
      { idx: 1, source: 'reddit', title: 'Переработки считаю вручную, бухгалтерия не сходится', snippet: 'Пыталась считать переработки в блокноте. За квартал набежало 40 часов, которые никто не подтвердил, потому что у меня нет выгрузки.', link: 'https://www.reddit.com/r/nursing/search/?q=overtime%20tracking&restrict_sr=1' },
      { idx: 2, source: 'reddit', title: 'Приложения для графика не учитывают наши правила', snippet: 'Пробовала три планировщика. Все заточены под офис: нет ночных смен, нет учёта отдыха между сменами, приходится править руками.', link: 'https://www.reddit.com/r/NursePractitioner/search/?q=shift%20app&restrict_sr=1' },
      { idx: 3, source: 'reddit', title: 'Чем пользуетесь для учёта смен?', snippet: 'В комментариях чаще всего называют общие календари и таблицы. Специализированные решения дорогие и рассчитаны на клиники, а не на человека.', link: 'https://www.reddit.com/r/nursing/search/?q=shift%20tracker%20app&restrict_sr=1' },
      { idx: 4, source: 'hn', title: 'Show HN: планировщик смен для небольших клиник', snippet: 'Обсуждение упирается в то, что продукт продаётся администрации, а не сотруднику. Личный учёт часов остаётся незакрытым.', link: 'https://hn.algolia.com/?query=shift%20scheduling%20nurses' },
      { idx: 5, source: 'reddit', title: 'Сообщество медсестёр: 300k+ участников, ежедневные обсуждения графика', snippet: 'Темы про график и выгорание стабильно в топе недели. Аудитория собрана в одном месте и активно обсуждает инструменты.', link: 'https://www.reddit.com/r/nursing/' }
    ];
    return {
      id: 'demo', created_at: new Date().toISOString(), score: 74,
      verdict: 'Стоит тестировать (по неполным данным)',
      brief: { product_name: 'Сменка', description: 'Личный трекер смен и переработок для медсестёр: считает часы, напоминает об отдыхе между сменами, выгружает отчёт для бухгалтерии.', category: 'health / workforce', target_geo: 'RU', price_model: 'подписка 290 ₽/мес', pains: ['опять поставили двойную смену без спроса', 'не могу посчитать переработки за месяц'] },
      signals: sn,
      report: {
        summary: 'Боль подтверждается прямыми обсуждениями: график меняют без согласования, а переработки нечем доказать. Существующие инструменты закрывают задачи администрации, а не сотрудника — это оставляет нишу личного учёта. Готовность платить по найденным следам оценить нельзя, поэтому сигнал исключён из итога.',
        coverage: { snippets: 6, sources: ['reddit', 'hn'], measured_signals: 4, cited_unique: 6, stats: { 'reddit:all': { requests: 2, items: 4, codes: [200] }, 'reddit:r/nursing': { requests: 1, items: 1, codes: [200] }, 'hn': { requests: 1, items: 1, codes: [200] } } },
        signals: {
          demand: { score: 72, measured: true, evidence_idx: [0, 1], comment: 'Люди регулярно заводят обсуждения про график и учёт часов, ищут инструменты и описывают самодельные решения в заметках.' },
          unresolved_pain: { score: 81, measured: true, evidence_idx: [1, 2], comment: 'Прямые свидетельства провала текущих решений: переработки не подтвердить, планировщики не учитывают ночные смены и отдых.' },
          willingness_to_pay: { score: 0, measured: false, evidence_idx: [], comment: 'В найденных следах нет разговоров о цене личных трекеров и жалоб на платные тарифы. Сигнал не измерен и исключён из итога.' },
          competition: { score: 58, measured: true, evidence_idx: [3, 4], comment: 'Прямые конкуренты — общие календари и таблицы. Специализированные продукты продаются клиникам, личный сегмент занят слабо.' },
          audience_reach: { score: 88, measured: true, evidence_idx: [0, 5], comment: 'Аудитория сконцентрирована в одном крупном сообществе, темы про график стабильно в топе — канал дистрибуции очевиден.' }
        },
        competitors: [
          { name: 'Общие календари и таблицы', type: 'indirect', positioning: 'Бесплатно, гибко, уже установлены', weakness: 'Нет правил ночных смен и отдыха, часы приходится сводить вручную', evidence_idx: [3] },
          { name: 'Планировщики для клиник', type: 'direct', positioning: 'B2B-подписка, продаётся администрации', weakness: 'Не решает задачу личного доказательства переработок сотрудником', evidence_idx: [4] }
        ],
        trends: [
          { trend: 'Личный учёт часов вместо корпоративного', opportunity: 'Отчёт, который сотрудник приносит в бухгалтерию сам, — незанятая позиция между календарём и HR-системой.', evidence_idx: [1] },
          { trend: 'Обсуждения выгорания через график', opportunity: 'Напоминание об отдыхе между сменами воспринимается как забота, а не как ещё одна таблица.', evidence_idx: [0, 5] }
        ],
        base_segments: [
          { name: 'Медсёстры со сменным графиком в найме', pain: 'Переработки есть, а доказать их нечем', habitats: ['r/nursing', 'профильные чаты отделений'], offer_hypothesis: 'Один экран: часы за месяц и кнопка «выгрузить отчёт».', evidence_idx: [1, 5] },
          { name: 'Старшие смены, ведущие график вручную', pain: 'Правки графика теряются, конфликты с командой', habitats: ['r/NursePractitioner'], offer_hypothesis: 'История изменений графика с отметкой, кто и когда поставил смену.', evidence_idx: [0, 2] }
        ]
      }
    };
  }
  var DEMO_SEGMENTS = [
    { name: 'Медсёстры стационара', pain_quote: 'двойная смена появляется в графике за день до выхода', habitats: ['r/nursing'], offer_hypothesis: 'Пуш при изменении графика и счётчик часов отдыха.' },
    { name: 'Те, кто спорит с бухгалтерией', pain_quote: 'за квартал набежало 40 часов, которые никто не подтвердил', habitats: ['r/nursing'], offer_hypothesis: 'PDF-отчёт за период с разбивкой по сменам.' }
  ];

  // ---------- рендер ----------
  function evChips(idx, sn) {
    return (idx || []).map(function (i) {
      var s = sn[i], u = s && safeUrl(s.link);
      return u
        ? '<a class="ev" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer" title="' + esc(s.title) + '">[' + (i + 1) + ']</a>'
        : '<span class="ev dead">[' + (i + 1) + ']</span>';
    }).join('');
  }

  function coverageCard(cov) {
    if (!cov) return '';
    var st = cov.stats || {}, rows = '';
    Object.keys(st).forEach(function (k) {
      var v = st[k] || {};
      var items = typeof v === 'number' ? v : v.items;
      var req = typeof v === 'number' ? '—' : v.requests;
      var codes = (v.codes || []).map(function (c) {
        return '<span class="' + (c === 200 ? 'code-ok' : 'code-bad') + '">' + esc(c) + '</span>';
      }).join(', ') || '—';
      rows += '<tr><td>' + esc(k) + '</td><td>' + esc(items) + '</td><td>' + esc(req) + '</td><td>' + codes + '</td></tr>';
    });
    return '<section class="card"><h3>Откуда данные</h3>' +
      '<p class="dim" style="font-size:13.5px">Найдено следов: <b class="mono">' + esc(cov.snippets) + '</b>' +
      (cov.cited_unique != null ? ', использовано в выводах: <b class="mono">' + esc(cov.cited_unique) + '</b>' : '') +
      (cov.measured_signals != null ? ', измерено сигналов: <b class="mono">' + esc(cov.measured_signals) + ' из 5</b>' : '') +
      (cov.sources && cov.sources.length ? ' · источники: ' + esc(cov.sources.join(', ')) : '') + '</p>' +
      (rows ? '<table class="cov"><thead><tr><th>источник</th><th>следов</th><th>запросов</th><th>ответ</th></tr></thead><tbody>' + rows + '</tbody></table>' : '') +
      '</section>';
  }

  function renderEmpty() {
    state.current = null; state.demo = false;
    $('exportBtn').disabled = true; $('copyBtn').disabled = true;
    $('result').innerHTML =
      '<section class="card empty-hero"><div class="ring"><span style="font-size:30px">📡</span></div>' +
      '<h2>Здесь появится отчёт</h2>' +
      '<p>Заполните бриф слева и запустите анализ. Или откройте пример — он показывает все состояния отчёта и не тратит пакет.</p>' +
      '<button class="btn primary" type="button" id="demoBtn">Показать пример отчёта</button>' +
      '<div class="grid2" style="margin-top:26px;text-align:left">' +
      '<div class="mini"><b>Пять сигналов</b>Спрос, нерешённая боль, готовность платить, слабость конкурентов, доступность аудитории — каждый со ссылкой на источник.</div>' +
      '<div class="mini"><b>Честное покрытие</b>Видно, сколько следов дал каждый источник и сколько сигналов реально измерено.</div>' +
      '<div class="mini"><b>Отказ вместо фантазии</b>Если следы не о вашем продукте — «Недостаточно данных», пакет не списан.</div>' +
      '</div></section>';
    $('demoBtn').addEventListener('click', function () { openDemo(); });
  }

  function openDemo() {
    state.demo = true;
    renderReport(demoRun());
    toast('Открыт демо-отчёт. Данные вымышлены для показа интерфейса.', 'info');
  }

  function renderNoData(d) {
    state.current = null; $('exportBtn').disabled = true; $('copyBtn').disabled = true;
    var analyze = d.stage === 'analyze';
    $('result').innerHTML =
      '<section class="card"><div class="notice bad"><b>Недостаточно данных.</b> ' + esc(d.message || 'Оценку дать нельзя.') + '</div>' +
      '<p style="margin-top:13px">' + (analyze
        ? 'Следы найдены, но модель не смогла привязать к ним выводы о вашем продукте. Это честнее, чем выдуманная оценка.'
        : 'Источники не дали достаточно материала по этим формулировкам.') + '</p>' +
      '<p style="margin-top:9px"><b>Что можно изменить:</b> опишите боли словами самой аудитории, добавьте конкретики в описание или уточните категорию. <b>Пакет не списан.</b></p>' +
      (d.summary ? '<p class="dim" style="margin-top:9px">Комментарий модели: ' + esc(d.summary) + '</p>' : '') +
      '</section>' + coverageCard(d.coverage);
    $('result').scrollIntoView({ block: 'start', behavior: prefs.motion ? 'smooth' : 'auto' });
  }

  function renderSkeleton() {
    $('result').innerHTML =
      '<section class="card"><div class="skel" style="height:132px"></div></section>' +
      '<section class="card"><div class="skel" style="height:18px;width:34%;margin-bottom:14px"></div>' +
      [0, 1, 2, 3, 4].map(function () { return '<div class="skel" style="height:44px;margin-bottom:10px"></div>'; }).join('') + '</section>';
  }

  function renderReport(run) {
    state.current = run;
    $('exportBtn').disabled = false; $('copyBtn').disabled = false;
    var rep = run.report || {}, sig = rep.signals || {}, sn = Array.isArray(run.signals) ? run.signals : [], cov = rep.coverage;
    var tone = run.score >= 70 ? 'high' : run.score >= 45 ? 'mid' : 'low';
    var partial = cov && cov.measured_signals != null && cov.measured_signals < 5;

    var cited = new Set();
    SIGNALS.forEach(function (s) { ((sig[s[0]] || {}).evidence_idx || []).forEach(function (i) { cited.add(i); }); });
    ['competitors', 'trends', 'base_segments'].forEach(function (k) {
      (rep[k] || []).forEach(function (x) { (x.evidence_idx || []).forEach(function (i) { cited.add(i); }); });
    });

    var order = SIGNALS.slice();
    if (prefs.sigsort === 'score') order.sort(function (a, b) { return ((sig[b[0]] || {}).score || 0) - ((sig[a[0]] || {}).score || 0); });
    if (prefs.sigsort === 'name') order.sort(function (a, b) { return a[1].localeCompare(b[1], 'ru'); });

    var sigHtml = order.map(function (m) {
      var s = sig[m[0]] || {};
      var ok = s.measured !== false && (s.evidence_idx || []).length > 0;
      if (!ok && !prefs.unmeasured) return '';
      return '<div class="sig' + (ok ? '' : ' no') + '">' +
        '<div><div class="name"><span class="swatch" style="background:' + m[3] + '"></span>' + esc(m[1]) + '</div>' +
        '<div class="hint">' + esc(m[2]) + '</div>' +
        '<div class="micro" style="margin-top:6px">вес ' + m[4].toFixed(2) + '</div></div>' +
        '<div><div class="bar" style="--c:' + m[3] + '"><i style="width:' + (ok ? Math.max(2, s.score || 0) : 100) + '%"></i></div>' +
        '<p style="font-size:13.5px">' + (ok ? '<b class="mono">' + esc(s.score) + '/100.</b> ' : '<b>Нет данных.</b> Сигнал исключён из итога. ') + esc(s.comment || '') + '</p>' +
        (ok ? '<div>' + evChips(s.evidence_idx, sn) + '</div>' : '') + '</div></div>';
    }).join('') || '<p class="dim">Все сигналы скрыты фильтром «показывать неизмеренные».</p>';

    var comp = (rep.competitors || []).map(function (c) {
      return '<div class="mini"><span class="tag' + (c.type === 'indirect' ? ' ind' : '') + '">' + (c.type === 'indirect' ? 'косвенный' : 'прямой') + '</span>' +
        '<b>' + esc(c.name) + '</b>' + esc(c.positioning) +
        '<div class="dim" style="margin-top:6px">Слабое место: ' + esc(c.weakness) + '</div>' +
        '<div>' + evChips(c.evidence_idx, sn) + '</div></div>';
    }).join('');
    var tr = (rep.trends || []).map(function (x) {
      return '<div class="mini"><b>' + esc(x.trend) + '</b>' + esc(x.opportunity) + '<div>' + evChips(x.evidence_idx, sn) + '</div></div>';
    }).join('');
    var seg = (rep.base_segments || []).map(function (x) {
      return '<div class="mini"><b>' + esc(x.name) + '</b>' + esc(x.pain) +
        '<div class="dim" style="margin-top:6px">Где искать: ' + esc((x.habitats || []).join(', ') || '—') + '</div>' +
        '<div style="margin-top:6px">Гипотеза оффера: ' + esc(x.offer_hypothesis) + '</div>' +
        '<div>' + evChips(x.evidence_idx, sn) + '</div></div>';
    }).join('');
    var rs = (rep.segments || []).map(function (x) {
      return '<div class="mini"><b>' + esc(x.name) + '</b>' +
        (x.pain_quote ? '<div class="quote">«' + esc(x.pain_quote) + '»</div>' : '') +
        '<div class="dim">Где искать: ' + esc((x.habitats || []).join(', ') || '—') + '</div>' +
        '<div style="margin-top:6px">' + esc(x.offer_hypothesis) + '</div></div>';
    }).join('');
    var enr = rep.enrich || {};

    var traceItems = sn.map(function (s, i) {
      if (prefs.traces === 'cited' && !cited.has(i)) return '';
      var u = safeUrl(s.link);
      return '<li class="' + (cited.has(i) ? 'cited' : '') + '"><b>[' + (i + 1) + ']</b>' +
        (u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(s.title) + '</a>' : esc(s.title)) +
        '<small>' + esc(s.source) + (cited.has(i) ? ' · использован в выводах' : '') + '</small>' +
        (s.snippet ? '<small>' + esc(s.snippet) + '</small>' : '') + '</li>';
    }).join('') || '<li>Под этот фильтр следов нет.</li>';

    var C = 2 * Math.PI * 52;
    $('result').innerHTML =
      (state.demo ? '<div class="notice demo" style="margin-bottom:14px"><b>Демо-отчёт.</b> Продукт и следы вымышлены, чтобы показать интерфейс. Реальный анализ запускается формой слева и опирается только на найденные источники.</div>' : '') +
      '<section class="card verdict-card tone-' + tone + '"><div class="verdict">' +
      '<div class="dial"><svg width="132" height="132" viewBox="0 0 120 120">' +
      '<circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="9"></circle>' +
      '<circle cx="60" cy="60" r="52" fill="none" stroke="var(--tone)" stroke-width="9" stroke-linecap="round" ' +
      'stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + (C * (1 - Math.max(0, Math.min(100, run.score)) / 100)).toFixed(1) + '"></circle>' +
      '</svg><div class="val"><b>' + esc(run.score) + '</b><small>ИЗ 100</small></div></div>' +
      '<div style="min-width:240px;flex:1"><div class="micro">вердикт</div><h2 style="margin:6px 0 8px">' + esc(run.verdict) + '</h2>' +
      '<p class="dim" style="font-size:13.5px">' + esc((run.brief && run.brief.product_name) || '') + ' · ' + esc(fmtDate(run.created_at)) +
      (run.brief && run.brief.category ? ' · ' + esc(run.brief.category) : '') + '</p>' +
      (rep.summary ? '<p style="margin-top:12px">' + esc(rep.summary) + '</p>' : '') + '</div></div>' +
      (partial ? '<div class="notice" style="margin-top:15px"><b>По неполным данным.</b> Измерено ' + esc(cov.measured_signals) + ' из 5 сигналов: непокрытые не обнулены, а исключены из итога, балл пересчитан по измеренным.</div>' : '') +
      '</section>' +
      '<section class="card"><h3>Сигналы</h3>' + sigHtml + '</section>' +
      (comp ? '<section class="card"><h3>Конкуренты</h3><div class="grid2">' + comp + '</div></section>' : '') +
      (tr ? '<section class="card"><h3>Тренды</h3><div class="grid2">' + tr + '</div></section>' : '') +
      (seg ? '<section class="card"><h3>Сегменты аудитории</h3><div class="grid2">' + seg + '</div></section>' : '') +
      '<section class="card"><h3>Сегменты с цитатами</h3>' +
      (rs ? '<div class="grid2">' + rs + '</div>'
        : '<p class="dim" style="margin-bottom:11px">GigaChat выделит сегменты и дословные цитаты болей из найденных следов. Пакет не тратится.</p>' +
          ((enr.attempts || 0) >= 2
            ? '<div class="notice">Попытки исчерпаны: сегменты выделить не удалось.</div>'
            : '<button type="button" class="btn" id="enrichBtn">Выделить сегменты</button> <span id="enrichSt" class="dim" style="font-size:13.5px"></span>')) +
      '</section>' +
      coverageCard(cov) +
      '<section class="card"><details class="traces"' + (prefs.traces === 'cited' ? ' open' : '') + '><summary>Найденные следы (' + sn.length + ')</summary><ul class="sn">' + traceItems + '</ul></details></section>';

    var eb = $('enrichBtn'); if (eb) eb.addEventListener('click', enrich);
    document.querySelectorAll('#hist button').forEach(function (b) { b.classList.toggle('on', b.dataset.id === run.id); });
    if (!state.demo) $('result').scrollIntoView({ block: 'start', behavior: prefs.motion ? 'smooth' : 'auto' });
  }

  function rerender() { if (state.current) renderReport(state.current); }

  // ---------- enrich ----------
  async function enrich() {
    if (state.demo) {
      var d = state.current; d.report.segments = DEMO_SEGMENTS; renderReport(d);
      toast('Демо-сегменты добавлены.', 'info'); return;
    }
    var btn = $('enrichBtn'), st = $('enrichSt');
    btn.disabled = true; st.textContent = 'Выделяю сегменты…';
    var r = await api('enrich', { method: 'POST', body: { run_id: state.current.id } });
    if (r.status === 200 && r.data && r.data.run) {
      if (r.data.enrich_unavailable) { state.current.report.enrich = { attempts: 2 }; renderReport(state.current); toast('Попытки исчерпаны.', 'warn'); return; }
      var run = r.data.run;
      if (run.report && run.report.segments && run.report.segments.length) { renderReport(run); toast('Сегменты готовы. Пакет не тронут.'); return; }
      state.current.report.enrich = (run.report && run.report.enrich) || { attempts: 1 };
      st.textContent = 'Сегменты выделить не удалось. Можно повторить через минуту.'; btn.disabled = false; return;
    }
    st.textContent = errText(r, 'Повторите позже.'); btn.disabled = false;
  }

  // ---------- история: поиск, фильтр, сортировка, сохранённые виды ----------
  function visibleItems() {
    var q = $('histSearch').value.trim().toLowerCase(), v = $('histVerdict').value, s = $('histSort').value;
    var arr = state.items.filter(function (x) {
      return (!q || String(x.product).toLowerCase().indexOf(q) >= 0) && (!v || String(x.verdict).indexOf(v) === 0);
    });
    if (s === 'score') arr.sort(function (a, b) { return b.score - a.score; });
    else if (s === 'name') arr.sort(function (a, b) { return String(a.product).localeCompare(String(b.product), 'ru'); });
    else arr.sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
    return arr;
  }
  function renderHistory() {
    var items = visibleItems(), ul = $('hist');
    if (!state.items.length) { ul.innerHTML = '<li class="empty">Пока пусто. Первый анализ появится здесь.</li>'; return; }
    if (!items.length) { ul.innerHTML = '<li class="empty">Под этот фильтр ничего нет.</li>'; return; }
    ul.innerHTML = items.map(function (x) {
      return '<li><button type="button" data-id="' + esc(x.id) + '"><b>' + esc(x.product) + '</b>' +
        '<small>' + esc(x.score) + '/100 · ' + esc(x.verdict) + ' · ' + esc(fmtDate(x.created_at)) + '</small></button></li>';
    }).join('');
    ul.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', async function () {
        setStatus('Открываю сохранённый отчёт…', false, true);
        var h = await api('history', { query: '&id=' + encodeURIComponent(b.dataset.id) });
        if (h.status === 200 && h.data && h.data.run) { setStatus(''); state.demo = false; setQuota(h.data.quota); renderReport(h.data.run); }
        else if (h.status === 401) location.replace('index.html');
        else setStatus(errText(h, 'Повторите позже.'), true);
      });
    });
  }
  function renderViews() {
    var box = $('views');
    box.innerHTML = state.views.map(function (v, i) {
      return '<span class="view-chip"><button type="button" data-apply="' + i + '" style="color:inherit;font:inherit;padding:0">' + esc(v.name) + '</button>' +
        '<button type="button" data-del="' + i + '" aria-label="Удалить вид">×</button></span>';
    }).join('');
    box.querySelectorAll('[data-apply]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = state.views[+b.dataset.apply];
        $('histSearch').value = v.q; $('histVerdict').value = v.verdict; $('histSort').value = v.sort;
        renderHistory(); toast('Вид «' + v.name + '» применён.', 'info');
      });
    });
    box.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = +b.dataset.del, removed = state.views.splice(i, 1)[0];
        store.setJson('intel.views', state.views); renderViews();
        toast('Вид «' + removed.name + '» удалён.', 'warn', { label: 'Вернуть', fn: function () { state.views.splice(i, 0, removed); store.setJson('intel.views', state.views); renderViews(); } });
      });
    });
  }
  async function loadHistory() {
    var r = await api('history');
    if (r.status === 401) {
      if (new URLSearchParams(location.search).get('demo') === '1') { setQuota(null); state.items = []; renderHistory(); return; }
      location.replace('index.html'); return;
    }
    if (r.status !== 200 || !r.data) { $('hist').innerHTML = '<li class="empty">' + esc(errText(r, '')) + '</li>'; return; }
    setQuota(r.data.quota);
    state.items = r.data.items || [];
    renderHistory();
  }

  // ---------- запуск ----------
  function readBrief() {
    var v = function (id) { return $(id).value.trim(); };
    return {
      product_name: v('f_name'), description: v('f_desc'), category: v('f_cat'),
      target_geo: $('f_geo').value, price_model: v('f_price'),
      pains: [v('f_p1'), v('f_p2'), v('f_p3')].filter(Boolean)
    };
  }
  async function run(ev) {
    if (ev) ev.preventDefault();
    if (state.busy) return;
    var brief = readBrief();
    if (!brief.product_name || !brief.description) { setStatus('Заполните название и описание продукта.', true); return; }
    if (!brief.pains.length) { setStatus('Добавьте хотя бы одну боль аудитории: по ней строится поиск.', true); return; }
    if ($('runBtn').dataset.empty) { setStatus('Пакет анализов исчерпан. Обратитесь за продлением.', true); return; }

    state.busy = true; state.demo = false;
    $('runBtn').disabled = true; $('exportBtn').disabled = true; $('copyBtn').disabled = true;
    renderSkeleton();
    try {
      setStatus('Составляю план поиска…', false, true);
      var p = await api('plan', { method: 'POST', body: { brief: brief } });
      if (p.status === 401) { location.replace('index.html'); return; }
      var plan = (p.status === 200 && p.data && p.data.plan) ? p.data.plan : null;

      setStatus('Собираю следы и анализирую. Обычно 5–10 секунд…', false, true);
      var r = await api('run', { method: 'POST', body: { brief: brief, plan: plan } });
      if (r.status === 401) { location.replace('index.html'); return; }
      if (r.status === 200 && r.data && r.data.ok === false) { setStatus(''); renderNoData(r.data); toast('Недостаточно данных. Пакет не списан.', 'warn'); return; }
      if (r.status === 200 && r.data && r.data.ok && r.data.run) {
        setStatus('Готово. Списан 1 анализ.');
        setQuota(r.data.quota); renderReport(r.data.run);
        state.items.unshift({ id: r.data.run.id, product: brief.product_name, score: r.data.run.score, verdict: r.data.run.verdict, created_at: r.data.run.created_at });
        renderHistory(); loadHistory();
        toast('Отчёт готов: ' + r.data.run.score + '/100.');
        return;
      }
      setStatus(errText(r, 'Пакет не списан, если счётчик не изменился.'), true);
      renderEmpty();
      if (r.status === 0 || !r.json) loadHistory();
    } finally {
      state.busy = false; $('runBtn').disabled = false;
    }
  }

  // ---------- экспорт ----------
  function exportJson() {
    if (!state.current) return;
    var name = ((state.current.brief && state.current.brief.product_name) || 'report').replace(/[^\wа-яё-]+/gi, '-');
    var blob = new Blob([JSON.stringify(state.current, null, 2)], { type: 'application/json;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'market-intel-' + name + (state.demo ? '-demo' : '') + '.json';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
    toast('Отчёт выгружен в JSON.');
  }
  async function copySummary() {
    if (!state.current) return;
    var r = state.current, rep = r.report || {};
    var lines = [r.brief.product_name + ' — ' + r.score + '/100 · ' + r.verdict, '', rep.summary || ''];
    SIGNALS.forEach(function (m) {
      var s = (rep.signals || {})[m[0]] || {};
      var ok = s.measured !== false && (s.evidence_idx || []).length;
      lines.push('• ' + m[1] + ': ' + (ok ? s.score + '/100' : 'нет данных') + (s.comment ? ' — ' + s.comment : ''));
    });
    var text = lines.join('\n');
    try { await navigator.clipboard.writeText(text); toast('Резюме скопировано.'); }
    catch (e) {
      var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Резюме скопировано.'); } catch (_) { toast('Не удалось скопировать.', 'bad'); }
      ta.remove();
    }
  }

  // ---------- wiring ----------
  $('briefForm').addEventListener('submit', run);
  $('f_desc').addEventListener('input', function () { $('charCount').textContent = this.value.length; });
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  });
  $('logout').addEventListener('click', async function () { await api('logout', { method: 'POST' }); location.replace('index.html'); });

  ['histSearch', 'histVerdict', 'histSort'].forEach(function (id) {
    $(id).addEventListener('input', renderHistory);
    $(id).addEventListener('change', renderHistory);
  });
  $('saveView').addEventListener('click', function () {
    var name = prompt('Название вида:', 'Мой фильтр');
    if (!name) return;
    state.views.push({ name: name.slice(0, 28), q: $('histSearch').value, verdict: $('histVerdict').value, sort: $('histSort').value });
    store.setJson('intel.views', state.views); renderViews(); toast('Вид сохранён.');
  });

  $('v_theme').value = prefs.theme;
  $('v_density').value = prefs.density;
  $('v_sigsort').value = prefs.sigsort;
  $('v_traces').value = prefs.traces;
  $('v_unmeasured').checked = !!prefs.unmeasured;
  $('v_motion').checked = !!prefs.motion;
  $('v_theme').addEventListener('change', function () { prefs.theme = this.value; applyPrefs(); rerender(); });
  $('v_density').addEventListener('change', function () { prefs.density = this.value; applyPrefs(); });
  $('v_sigsort').addEventListener('change', function () { prefs.sigsort = this.value; applyPrefs(); rerender(); });
  $('v_traces').addEventListener('change', function () { prefs.traces = this.value; applyPrefs(); rerender(); });
  $('v_unmeasured').addEventListener('change', function () { prefs.unmeasured = this.checked; applyPrefs(); rerender(); });
  $('v_motion').addEventListener('change', function () { prefs.motion = this.checked; applyPrefs(); });
  $('resetView').addEventListener('click', function () {
    prefs = Object.assign({}, DEF_PREFS); applyPrefs();
    $('v_theme').value = prefs.theme; $('v_density').value = prefs.density; $('v_sigsort').value = prefs.sigsort;
    $('v_traces').value = prefs.traces; $('v_unmeasured').checked = true; $('v_motion').checked = true;
    rerender(); toast('Настройки вида сброшены.', 'info');
  });
  $('exportBtn').addEventListener('click', exportJson);
  $('copyBtn').addEventListener('click', copySummary);

  var label = store.get('intelLabel'); if (label) $('who').textContent = label;
  renderViews();
  renderEmpty();
  loadHistory().then(function () {
    if (new URLSearchParams(location.search).get('demo') === '1') openDemo();
  });
})();