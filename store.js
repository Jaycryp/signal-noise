/* Signal / Noise — store.js
   Saved research library (localStorage). */

(function () {
  'use strict';

  var KEY = 'sn.projects.v1';

  function readAll() {
    try {
      var raw = localStorage.getItem(KEY);
      var v = raw ? JSON.parse(raw) : [];
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  function writeAll(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); return true; }
    catch (e) { return false; }
  }

  /* Convert any entry (new or legacy) into one canonical shape. */
  function toReport(entry) {
    if (!entry) return null;
    var r = (entry.report && Array.isArray(entry.report.findings)) ? entry.report : entry;
    if (!Array.isArray(r.findings)) return null;
    return {
      id: entry.id || null,
      savedAt: entry.savedAt || null,
      kind: r.kind || 'basic',
      project: (typeof r.project === 'string')
        ? r.project
        : (r.project && (r.project.name || r.project.url)) || 'Research report',
      url: r.url || entry.url || (r.project && r.project.url) || '',
      sourceLabel: r.sourceLabel || null,
      checkedAt: r.checkedAt || entry.savedAt || null,
      findings: r.findings,
      categories: r.categories || null,
      dossier: r.dossier || null,
      from: 'saved'
    };
  }

  window.SNStore = {

    save: function (report) {
      if (!report || !Array.isArray(report.findings)) return null;
      var all = readAll();
      var now = new Date().toISOString();
      var url = report.url || null;

      var entry = {
        id: 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        url: url,
        savedAt: now,
        kind: report.kind || 'basic',
        project: report.project,
        sourceLabel: report.sourceLabel || null,
        checkedAt: report.checkedAt || now,
        findings: report.findings,
        categories: report.categories || null,
        dossier: report.dossier || null
      };

      /* Same URL saved again → update the existing entry. */
      if (url) {
        for (var i = 0; i < all.length; i++) {
          var ex = toReport(all[i]);
          if (ex && ex.url === url) {
            entry.id = all[i].id || entry.id;
            all[i] = entry;
            return writeAll(all) ? entry : null;
          }
        }
      }

      all.push(entry);
      return writeAll(all) ? entry : null;
    },

    get: function (id) {
      var all = readAll();
      for (var i = 0; i < all.length; i++) {
        if (all[i] && all[i].id === id) return toReport(all[i]);
      }
      return null;
    },

    findByUrl: function (url) {
      if (!url) return null;
      var all = readAll();
      for (var i = all.length - 1; i >= 0; i--) {
        var r = toReport(all[i]);
        if (r && r.url === url) return r;
      }
      return null;
    },

    list: function () {
      return readAll().map(toReport).filter(Boolean).sort(function (a, b) {
        return String(b.savedAt || '').localeCompare(String(a.savedAt || ''));
      });
    },

    remove: function (id) {
      writeAll(readAll().filter(function (e) { return e && e.id !== id; }));
    }
  };

})();
