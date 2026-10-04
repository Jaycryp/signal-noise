/* ============================================================
   Signal / Noise — store.js
   Saved research library (localStorage).
   Stage 6: stores full research objects with provenance.
   ============================================================ */

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
    localStorage.setItem(KEY, JSON.stringify(list));
  }

  function makeId() {
    return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function countsFor(r) {
    return {
      signal: (r.signal || []).length,
      noise: (r.noise || []).length,
      unknown: (r.unknown || []).length
    };
  }

  window.SNStore = {
    list: function () {
      return readAll().slice().sort(function (a, b) {
        return String(b.savedAt || '').localeCompare(String(a.savedAt || ''));
      });
    },

    get: function (id) {
      var all = readAll();
      for (var i = 0; i < all.length; i++) {
        if (all[i].id === id) return all[i];
      }
      return null;
    },

    isSaved: function (url) {
      var all = readAll();
      for (var i = 0; i < all.length; i++) {
        if (all[i].url === url) return true;
      }
      return false;
    },

    /* Dedupes by project URL: re-saving refreshes the existing entry. */
    saveResearch: function (research) {
      var all = readAll();
      var url = research.project.url;
      var now = new Date().toISOString();

      for (var i = 0; i < all.length; i++) {
        if (all[i].url === url) {
          all[i].name = research.project.name;
          all[i].kind = research.kind;
          all[i].savedAt = now;
          all[i].retrievedAt = research.retrievedAt || null;
          all[i].counts = countsFor(research);
          all[i].data = research;
          writeAll(all);
          return all[i];
        }
      }

      var entry = {
        id: makeId(),
        kind: research.kind,
        name: research.project.name,
        url: url,
        savedAt: now,
        retrievedAt: research.retrievedAt || null,
        counts: countsFor(research),
        data: research
      };
      all.push(entry);
      writeAll(all);
      return entry;
    },

    remove: function (id) {
      writeAll(readAll().filter(function (e) { return e.id !== id; }));
    }
  };

})();
