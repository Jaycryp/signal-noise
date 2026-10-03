// ================================================
// Signal / Noise — local storage module
// Shared by report.html and projects.html.
//
// All saved research lives under one key:
//   "signal-noise.research.v1"
// Shape: { version: 1, items: [ ...savedReports ] }
//
// Each item mirrors the report data model:
//   { id, url, savedAt, report: { project, categories, findings } }
//
// Every read is guarded: malformed or missing data
// returns an empty store instead of crashing.
// ================================================

const SNStore = (function () {
  const KEY = 'signal-noise.research.v1';
  const VERSION = 1;

  function emptyStore() {
    return { version: VERSION, items: [] };
  }

  function read() {
    let raw;
    try {
      raw = window.localStorage.getItem(KEY);
    } catch (e) {
      return emptyStore();
    }
    if (!raw) return emptyStore();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return emptyStore();
    }

    if (!parsed || !Array.isArray(parsed.items)) return emptyStore();
    return parsed;
  }

  function write(store) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(store));
      return true;
    } catch (e) {
      return false; // storage full or unavailable
    }
  }

  function normalizeId(idOrUrl) {
    return String(idOrUrl || '').trim().toLowerCase();
  }

  function list() {
    // Newest first.
    return read().items.slice().sort(function (a, b) {
      return String(b.savedAt).localeCompare(String(a.savedAt));
    });
  }

  function get(idOrUrl) {
    const id = normalizeId(idOrUrl);
    return read().items.find(function (item) {
      return item.id === id;
    }) || null;
  }

  // Insert or update. Returns the saved item, or null on failure.
  function save(idOrUrl, report, url) {
    const id = normalizeId(idOrUrl);
    const store = read();
    const existing = store.items.find(function (item) {
      return item.id === id;
    });

    if (existing) {
      existing.savedAt = new Date().toISOString();
      existing.url = url || existing.url;
      existing.report = report;
      return write(store) ? existing : null;
    }

    const item = {
      id: id,
      url: url || null,
      savedAt: new Date().toISOString(),
      report: report
    };
    store.items.push(item);
    return write(store) ? item : null;
  }

  function remove(idOrUrl) {
    const id = normalizeId(idOrUrl);
    const store = read();
    store.items = store.items.filter(function (item) {
      return item.id !== id;
    });
    return write(store);
  }

  return {
    KEY: KEY,
    list: list,
    get: get,
    save: save,
    remove: remove
  };
})();
