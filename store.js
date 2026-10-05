/* Signal / Noise — store.js
   Saved research library (localStorage).
   Stores reports in the report-page shape
   { project, categories, findings } so saved reports
   reopen from storage alone — never from the network.
   Also reads legacy Stage 5 entries
   { report: {...} } and upgrades them on read. */

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

  function normalise(entry) {
    if (!entry) return null;

    if (Array.isArray(entry.findings) && entry.project) {
      return {
        id: entry.id,
        url: entry.url || (entry.project && entry.project.url) || null,
        savedAt: entry.savedAt || null,
        project: entry.project,
        categories: entry.categories,
        findings: entry.findings
      };
    }

    if (entry.report && Array.isArray(entry.report.findings)) {
      return {
        id: entry.id,
        url: entry.url || null,
        savedAt: entry.savedAt || null,
        project: entry.report.project || { name: entry.id },
        categories: entry.report.categories,
        findings: entry.report.findings
      };
    }

    return null;
  }

  function upgradeAll(all) {
    var changed = false;
    var out = [];
    all.forEach(function (e) {
      if (e && Array.isArray(e.findings) && e.project) { out.push(e); return; }
      var n = normalise(e);
      if (n) { out.push(n); changed = true; }
    });
    if (changed) writeAll(out);
    return out;
  }

  window.SNStore = {

    get: function (id) {
      var all = readAll();
      for (var i = 0; i < all.length; i++) {
        if (all[i] && all[i].id === id) return normalise(all[i]);
      }
      return null;
    },

    list: function () {
      return upgradeAll(readAll()).slice().sort(function (a, b) {
        return String(b.savedAt || '').localeCompare(String(a.savedAt || ''));
      });
    },

    save: function (id, report, url) {
      if (!report || !report.project) return null;
      var all = readAll();
      var now = new Date().toISOString();
      var entryUrl = url || report.project.url || null;

      if (entryUrl) {
        for (var i = 0; i < all.length; i++) {
          var n = normalise(all[i]);
          if (n && n.url === entryUrl) {
            all[i] = {
              id: n.id, url: entryUrl, savedAt: now,
              project: report.project,
              categories: report.categories,
              findings: report.findings
            };
            return writeAll(all) ? all[i] : null;
          }
        }
      }

      var entry = {
        id: id || ('r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)),
        url: entryUrl,
        savedAt: now,
        project: report.project,
        categories: report.categories,
        findings: report.findings
      };
      all.push(entry);
      return writeAll(all) ? entry : null;
    },

    remove: function (id) {
      writeAll(readAll().filter(function (e) { return e && e.id !== id; }));
    }
  };

})();
