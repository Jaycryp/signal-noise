/* ============================================================
   Signal / Noise — app.js
   Shared UI logic for all pages. Routed by <body data-page>.
   Stage 6: live GitHub research, demo handling, saved reports.
   ============================================================ */

(function () {
  'use strict';

  /* ---------- helpers ---------- */

  function $(sel, root) { return (root || document).querySelector(sel); }

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function setText(sel, text) {
    var n = $(sel);
    if (n) n.textContent = text;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function safeHref(url) {
    var s = String(url || '');
    return (s.indexOf('http://') === 0 || s.indexOf('https://') === 0) ? s : '#';
  }

  var PENDING_KEY = 'sn.pending';

  function setPending(url) {
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ url: url })); } catch (e) {}
  }

  function getPending() {
    try {
      var raw = sessionStorage.getItem(PENDING_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  /* ---------- navigation (all pages) ---------- */

  (function initNav() {
    var toggle = $('#navToggle');
    var nav = $('#siteNav');
    if (toggle && nav) {
      toggle.addEventListener('click', function () {
        var open = nav.classList.toggle('open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }
    var page = document.body.getAttribute('data-page');
    if (page && nav) {
      var links = nav.querySelectorAll('a[data-nav]');
      for (var i = 0; i < links.length; i++) {
        if (links[i].getAttribute('data-nav') === page) links[i].classList.add('active');
      }
    }
  })();

  /* ---------- demo dataset (Northstar) — clearly fictional ---------- */

  function demoResearch() {
    return {
      kind: 'demo',
      project: {
        name: 'Northstar',
        url: 'https://northstar-demo.example',
        hostname: 'northstar-demo.example',
        sourceType: 'Demo dataset',
        lastChecked: '03 Oct 2026'
      },
      submittedUrl: 'https://northstar-demo.example',
      retrievedAt: null,
      signal: [
        { id: 'd-s1', title: 'Public repository',
          description: 'Northstar maintains a public code repository with recent commit activity.', sourceId: 'd-src1' },
        { id: 'd-s2', title: 'Published documentation',
          description: 'The project publishes technical documentation covering protocol behaviour and integration.', sourceId: 'd-src2' },
        { id: 'd-s3', title: 'Consistent release history',
          description: 'Versioned releases are published on a regular cadence.', sourceId: 'd-src1' }
      ],
      noise: [
        { id: 'd-n1', title: 'Unverified partnership claim',
          description: 'A marketing post references an ecosystem partnership that no primary source confirms.', sourceId: 'd-src3' },
        { id: 'd-n2', title: 'Inflated team claims',
          description: 'Community posts claim a core team of twelve; public records show three active contributors.', sourceId: 'd-src3' }
      ],
      unknown: [
        { id: 'd-u1', title: 'Team information',
          description: 'No team information has been established by the current data sources.', sourceId: null },
        { id: 'd-u2', title: 'Funding & backers',
          description: 'No funding or investor information has been established by the current data sources.', sourceId: null },
        { id: 'd-u3', title: 'Token & on-chain activity',
          description: 'No on-chain data sources are connected yet.', sourceId: null },
        { id: 'd-u4', title: 'Security posture',
          description: 'No security audit information has been established by the current data sources.', sourceId: null }
      ],
      sources: [
        { id: 'd-src1', name: 'GitHub - northstar-demo/core', type: 'Code repository', url: 'https://github.com/northstar-demo/core' },
        { id: 'd-src2', name: 'Northstar Docs', type: 'Documentation', url: 'https://northstar-demo.example/docs' },
        { id: 'd-src3', name: '@northstar-demo on X', type: 'Social profile', url: 'https://x.com/northstar-demo' }
      ],
      meta: [],
      provenance: { adapter: 'demo' }
    };
  }

  /* ============================================================
     RESEARCH INPUT PAGE
     ============================================================ */

  function initResearch() {
    var form = $('#researchForm');
    var input = $('#researchInput');
    var hint = $('#inputHint');
    var error = $('#inputError');
    if (!form || !input) return;

    input.addEventListener('input', function () {
      if (error) error.hidden = true;
      var v = input.value.trim();
      if (!hint) return;
      if (!v) { hint.hidden = true; hint.textContent = ''; return; }
      var d = Sources.detectSource(v);
      if (d.type === 'github_repo') {
        hint.textContent = 'GitHub repository detected - public data will be retrieved from the GitHub API.';
        hint.hidden = false;
      } else if (d.type === 'github_profile') {
        hint.textContent = 'That looks like a GitHub page, not a repository. A basic research record will be created.';
        hint.hidden = false;
      } else if (d.type === 'website') {
        hint.textContent = 'A basic research record will be created. Automated source discovery for this URL type is not available yet.';
        hint.hidden = false;
      } else {
        hint.hidden = true;
      }
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value.trim();
      var d = Sources.detectSource(v);
      if (d.type === 'invalid') {
        if (hint) hint.hidden = true;
        if (error) {
          error.textContent = Sources.MESSAGES.invalid_url;
          error.hidden = false;
        }
        input.focus();
        return;
      }
      setPending(v);
      window.location.href = 'report.html';
    });
  }

  /* ============================================================
     REPORT PAGE
     ============================================================ */

  function showReportLoading(msg) {
    var l = $('#reportLoading'), e = $('#reportError'), m = $('#reportMain');
    if (e) e.hidden = true;
    if (m) m.hidden = true;
    if (l) { setText('#loadingMessage', msg); l.hidden = false; }
  }

  function showReportError(title, message) {
    var l = $('#reportLoading'), e = $('#reportError'), m = $('#reportMain');
    if (l) l.hidden = true;
    if (m) m.hidden = true;
    if (e) {
      setText('#errorTitle', title);
      setText('#errorMessage', message);
      e.hidden = false;
    }
  }

  function findSource(sources, id) {
    if (!id || !sources) return null;
    for (var i = 0; i < sources.length; i++) {
      if (sources[i].id === id) return sources[i];
    }
    return null;
  }

  function renderFindings(sel, items, sources, emptyMsg) {
    var list = $(sel);
    if (!list) return;
    list.innerHTML = '';

    if (!items || !items.length) {
      list.appendChild(el('p', 'findings-empty', emptyMsg));
      return;
    }

    items.forEach(function (f) {
      var d = el('details', 'finding');
      var sum = el('summary');
      sum.appendChild(el('span', 'finding-title', f.title));
      var src = findSource(sources, f.sourceId);
      if (src) {
        var label = src.name.length > 30 ? src.name.slice(0, 30) + '...' : src.name;
        sum.appendChild(el('span', 'src-chip', label));
      }
      d.appendChild(sum);

      var body = el('div', 'finding-body');
      body.appendChild(el('p', null, f.description));
      if (src) {
        var p = el('p', 'finding-source');
        p.appendChild(document.createTextNode('Source: '));
        var a = el('a', null, src.name);
        a.href = safeHref(src.url);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        p.appendChild(a);
        p.appendChild(document.createTextNode(' · ' + src.type));
        body.appendChild(p);
      }
      d.appendChild(body);
      list.appendChild(d);
    });
  }

  function renderSources(sources) {
    var list = $('#sourceList');
    if (!list) return;
    list.innerHTML = '';
    (sources || []).forEach(function (s) {
      var card = el('div', 'source-card');
      var top = el('div', 'source-card-top');
      top.appendChild(el('span', 'source-name', s.name));
      top.appendChild(el('span', 'src-chip', s.type));
      card.appendChild(top);
      var a = el('a', 'source-url', s.url);
      a.href = safeHref(s.url);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      card.appendChild(a);
      list.appendChild(card);
    });
  }

  function wireSave(r) {
    var btn = $('#saveBtn');
    var note = $('#saveNote');
    if (!btn) return;

    if (r.kind === 'demo') {
      btn.hidden = true;
      if (note) {
        note.hidden = false;
        note.textContent = 'Demo research is not saved to your library.';
      }
      return;
    }

    btn.hidden = false;

    function paint() {
      var saved = SNStore.isSaved(r.project.url);
      btn.classList.toggle('is-saved', saved);
      btn.textContent = saved ? 'Saved ✓' : 'Save research';
    }

    paint();

    btn.onclick = function () {
      try {
        SNStore.saveResearch(r);
        if (note) note.hidden = true;
      } catch (e) {
        if (note) {
          note.hidden = false;
          note.textContent = 'Could not save. Your browser may be blocking site storage.';
        }
      }
      paint();
    };
  }

  function renderResearch(r) {
    var loading = $('#reportLoading'), errorBox = $('#reportError'), main = $('#reportMain');
    if (loading) loading.hidden = true;
    if (errorBox) errorBox.hidden = true;
    if (!main) return;
    main.hidden = false;

    var banner = $('#demoBanner');
    if (banner) banner.hidden = (r.kind !== 'demo');

    setText('#projectName', r.project.name);

    var link = $('#projectUrl');
    if (link) {
      link.textContent = r.submittedUrl || r.project.url;
      link.href = safeHref(r.project.url);
    }

    setText('#sourceTypeChip', r.project.sourceType || '');

    var subline = r.kind === 'demo'
      ? 'Demo dataset · Last checked ' + (r.project.lastChecked || '')
      : 'Real source data · Retrieved ' + fmtDate(r.retrievedAt);
    setText('#reportSubline', subline);

    var metaSection = $('#metaSection');
    if (metaSection) {
      if (r.meta && r.meta.length) {
        var dl = $('#repoMeta');
        dl.innerHTML = '';
        r.meta.forEach(function (m) {
          dl.appendChild(el('dt', null, m.label));
          dl.appendChild(el('dd', null, m.value));
        });
        metaSection.hidden = false;
      } else {
        metaSection.hidden = true;
      }
    }

    setText('#signalCount', pad2((r.signal || []).length));
    setText('#noiseCount', pad2((r.noise || []).length));
    setText('#unknownCount', pad2((r.unknown || []).length));

    renderFindings('#signalList', r.signal, r.sources, 'No signal findings from the current sources.');
    renderFindings('#noiseList', r.noise, r.sources, 'No unsupported claims identified from the current sources.');
    renderFindings('#unknownList', r.unknown, r.sources, 'No unknown items.');
    renderSources(r.sources);

    wireSave(r);
  }

  /* Tolerate saved entries from older builds */
  function legacyToResearch(entry) {
    if (entry && entry.signal && entry.noise && entry.unknown) {
      return {
        kind: entry.kind || 'demo',
        project: {
          name: entry.name || 'Saved research',
          url: entry.url || '#',
          hostname: '',
          sourceType: 'Saved report'
        },
        submittedUrl: entry.url || '',
        retrievedAt: entry.retrievedAt || null,
        signal: entry.signal,
        noise: entry.noise,
        unknown: entry.unknown,
        sources: entry.sources || [],
        meta: [],
        provenance: { adapter: 'legacy' }
      };
    }
    return null;
  }

  function runLiveResearch(url) {
    var detection = Sources.detectSource(url);

    if (detection.type === 'invalid') {
      showReportError('Invalid URL', Sources.MESSAGES.invalid_url);
      return;
    }

    if (detection.type === 'github_repo') {
      showReportLoading('Retrieving public repository data…');
      Sources.fetchGithubResearch(detection)
        .then(function (result) { renderResearch(result.research); })
        .catch(function (err) {
          var msg = (err && err.userMessage) ? err.userMessage : Sources.MESSAGES.api_error;
          showReportError("Couldn't retrieve repository data", msg);
        });
      return;
    }

    // Websites and GitHub profile pages: honest basic record, no network call
    renderResearch(Sources.buildBasicResearch(detection));
  }

  function initReport() {
    var params = new URLSearchParams(window.location.search);
    var savedId = params.get('id');

    /* Mode 1: saved report — stored data only, NEVER calls GitHub */
    if (savedId) {
      var entry = SNStore.get(savedId);
      if (entry) {
        var data = entry.data || legacyToResearch(entry);
        if (data) { renderResearch(data); return; }
      }
      showReportError('Saved research not found',
        'That saved report could not be found. It may have been deleted.');
      return;
    }

    /* Mode 2: demo report — explicit via ?demo=1, or fallback when nothing pending */
    var pending = getPending();
    if (params.get('demo') === '1' || !pending || !pending.url) {
      renderResearch(demoResearch());
      return;
    }

    /* Mode 3: live research */
    runLiveResearch(pending.url);
  }

  /* ============================================================
     PROJECTS PAGE
     ============================================================ */

  function initProjects() {
    var listEl = $('#projectList');
    if (!listEl) return;
    var emptyEl = $('#emptyState');
    var dialog = $('#confirmDialog');
    var msgEl = $('#confirmMessage');
    var cancelBtn = $('#confirmCancel');
    var deleteBtn = $('#confirmDelete');
    var pendingDeleteId = null;

    function openDialog(id, name) {
      pendingDeleteId = id;
      msgEl.textContent = 'Delete "' + name + '"? This removes it from your saved library.';
      dialog.hidden = false;
    }

    function closeDialog() {
      pendingDeleteId = null;
      dialog.hidden = true;
    }

    cancelBtn.addEventListener('click', closeDialog);
    dialog.addEventListener('click', function (e) {
      if (e.target === dialog) closeDialog();
    });
    deleteBtn.addEventListener('click', function () {
      if (pendingDeleteId) SNStore.remove(pendingDeleteId);
      closeDialog();
      render();
    });

    function render() {
      var entries = SNStore.list();
      listEl.innerHTML = '';

      if (!entries.length) {
        emptyEl.hidden = false;
        return;
      }
      emptyEl.hidden = true;

      entries.forEach(function (en) {
        var row = el('article', 'project-row');

        var main = el('div', 'project-row-main');
        main.appendChild(el('h3', 'project-name', en.name));
        main.appendChild(el('p', 'project-url', en.url));
        var c = en.counts || { signal: 0, noise: 0, unknown: 0 };
        main.appendChild(el('p', 'project-meta',
          'Signal ' + pad2(c.signal) + ' · Noise ' + pad2(c.noise) +
          ' · Unknown ' + pad2(c.unknown) + ' · Saved ' + fmtDate(en.savedAt)));
        row.appendChild(main);

        var actions = el('div', 'project-actions');
        var open = el('a', 'btn btn-secondary btn-sm', 'Open');
        open.href = 'report.html?id=' + encodeURIComponent(en.id);
        var del = el('button', 'btn btn-danger-ghost btn-sm', 'Delete');
        del.type = 'button';
        del.addEventListener('click', function () { openDialog(en.id, en.name); });
        actions.appendChild(open);
        actions.appendChild(del);
        row.appendChild(actions);

        listEl.appendChild(row);
      });
    }

    render();
  }

  /* ---------- page router ---------- */

  var page = document.body.getAttribute('data-page') || '';
  if (page === 'research') initResearch();
  else if (page === 'report') initReport();
  else if (page === 'projects') initProjects();

})();
