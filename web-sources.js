/* ============================================================
   Signal / Noise — Stage 7: multi-source research adapters
   CoinGecko + RDAP + Wayback Machine.
   Does NOT touch the Stage 6 GitHub engine (sources.js).

   Every adapter returns the same normalized result:
   { key, label, status, sourceName, sourceUrl, retrievedAt,
     note, rows[], candidates[], fieldsUnavailable[], error }

   status: available | not-matched | unavailable | error | skipped
   ============================================================ */

window.SNWebSources = (function () {
  'use strict';

  var FETCH_TIMEOUT = 12000;
  var NAME_MATCH_MAX_RANK = 300;

  var GITHUB_NONREPO = [
    'features', 'pricing', 'login', 'signup', 'explore', 'topics',
    'settings', 'marketplace', 'orgs', 'users', 'search', 'about',
    'security', 'customer-stories', 'readme', 'sponsors'
  ];

  /* Common second-level TLDs for registrable-domain reduction. */
  var COMMON_SLD = [
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au',
    'co.jp', 'com.br', 'com.cn', 'co.in', 'co.nz', 'com.sg', 'com.mx',
    'com.tr', 'co.za', 'com.hk', 'com.tw', 'com.ar', 'co.kr'
  ];

  /* Fallback map if the IANA bootstrap file is unreachable. */
  var FALLBACK_RDAP = {
    com: 'https://rdap.verisign.com/com/v1/',
    net: 'https://rdap.verisign.com/net/v1/',
    org: 'https://rdap.publicinterestregistry.org/rdap/',
    io:  'https://rdap.identitydigital.services/rdap/',
    network: 'https://rdap.identitydigital.services/rdap/',
    info:'https://rdap.afilias.net/rdap/info/',
    biz: 'https://rdap.afilias.net/rdap/biz/',
    pro: 'https://rdap.afilias.net/rdap/pro/',
    co:  'https://rdap.nic.co/',
    me:  'https://rdap.nic.me/',
    dev: 'https://rdap.nic.google/',
    app: 'https://rdap.nic.google/',
    ai:  'https://rdap.nic.ai/',
    xyz: 'https://rdap.centralnic.com/xyz/',
    cc:  'https://rdap.nic.cc/',
    tv:  'https://rdap.nic.tv/',
    de:  'https://rdap.denic.de/',
    nl:  'https://rdap.sidn.nl/',
    uk:  'https://rdap.nominet.uk/uk/'
  };

  var rdapBootstrapPromise = null;

  /* ---------------- shared helpers ---------------- */

  function fetchJson(url, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs || FETCH_TIMEOUT);
    return fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
      .then(function (resp) {
        clearTimeout(timer);
        if (!resp.ok) {
          var err = new Error('HTTP ' + resp.status);
          err.status = resp.status;
          throw err;
        }
        return resp.json().then(function (data) {
          return { data: data, finalUrl: resp.url || url };
        });
      })
      .catch(function (e) { clearTimeout(timer); throw e; });
  }

  /* JSONP transport — bypasses CORS for endpoints that support
     a callback parameter (the Wayback availability API does).
     Used only as a fallback after a normal fetch fails. */
  function jsonp(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var cbName = 'snwbp' + Math.random().toString(36).slice(2);
      var script = document.createElement('script');
      var timer = setTimeout(function () {
        cleanup();
        var err = new Error('timeout');
        err.name = 'AbortError';
        reject(err);
      }, timeoutMs || 20000);
      function cleanup() {
        clearTimeout(timer);
        try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      window[cbName] = function (data) { cleanup(); resolve(data); };
      script.onerror = function () { cleanup(); reject(new Error('jsonp failed')); };
      script.src = url + (url.indexOf('?') === -1 ? '?' : '&') + 'callback=' + cbName;
      document.head.appendChild(script);
    });
  }

  /* Tells the user WHAT failed without needing a console:
     timeout vs HTTP status vs blocked/unreachable (CORS-style). */
  function describeFailure(e, host) {
    if (e && e.name === 'AbortError') return 'Request to ' + host + ' timed out.';
    if (e && e.status) return host + ' responded with HTTP ' + e.status + '.';
    return 'Request to ' + host + ' was blocked or unreachable (browser security policy or network).';
  }

  function attempt(promise) {
    return promise.then(
      function (v) { return { v: v }; },
      function (e) { return { e: e }; }
    );
  }

  function nowIso() { return new Date().toISOString(); }

  function baseResult(key, label) {
    return {
      key: key, label: label, status: 'available',
      sourceName: label, sourceUrl: null, retrievedAt: nowIso(),
      note: null, rows: [], candidates: [], fieldsUnavailable: [], error: null
    };
  }

  function errorResult(key, label, message) {
    var r = baseResult(key, label);
    r.status = 'error';
    r.error = message || 'Request failed.';
    r.note = r.error;
    return r;
  }

  function labelFor(key) {
    return { coingecko: 'CoinGecko', rdap: 'Domain / RDAP', wayback: 'Web history / Wayback' }[key] || key;
  }

  function hostOf(u) {
    try { return new URL(u).hostname; } catch (e) { return u; }
  }

  function normalizeDomain(input) {
    if (!input) return null;
    var s = String(input).trim();
    if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    try {
      var h = new URL(s).hostname.toLowerCase();
      return h.replace(/^www\./, '') || null;
    } catch (e) { return null; }
  }

  /* RDAP only answers for the registered domain, so a subdomain
     like app.example.network must be reduced to example.network. */
  function registrableDomain(host) {
    if (!host) return null;
    var parts = host.split('.').filter(Boolean);
    if (parts.length <= 2) return host;
    var last2 = parts.slice(-2).join('.');
    if (COMMON_SLD.indexOf(last2) !== -1 && parts.length >= 3) {
      return parts.slice(-3).join('.');
    }
    return last2;
  }

  function homepageFromReport(report) {
    if (!report) return null;
    if (report.homepage) return normalizeDomain(report.homepage);
    var rows = report.dossier && report.dossier.rows;
    if (Array.isArray(rows)) {
      for (var i = 0; i < rows.length; i++) {
        var pair = rows[i];
        if (!pair) continue;
        var k = String(pair[0] || '').toLowerCase();
        var v = String(pair[1] || '').trim();
        if ((k === 'website' || k === 'homepage') && /^https?:\/\//i.test(v)) {
          return normalizeDomain(v);
        }
      }
    }
    return null;
  }

  function contextFromUrl(url, report) {
    report = report || {};
    var s = String(url || '').trim();
    if (s && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    var ctx = { kind: 'website', domain: null, owner: null, repo: null };
    var u = null;
    try { u = new URL(s); } catch (e) { u = null; }
    if (u) {
      var host = u.hostname.toLowerCase().replace(/^www\./, '');
      var parts = u.pathname.split('/').filter(Boolean);
      if (host === 'github.com' && parts.length >= 2 &&
          GITHUB_NONREPO.indexOf(parts[0].toLowerCase()) === -1) {
        ctx.kind = 'github';
        ctx.owner = parts[0];
        ctx.repo = parts[1];
        ctx.domain = homepageFromReport(report);
        return ctx;
      }
      ctx.domain = host;
    }
    return ctx;
  }

  function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function pad2(n) { return String(n).padStart(2, '0'); }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return pad2(d.getUTCDate()) + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  function fmtDateTime(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return fmtDate(iso) + ', ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ' UTC';
  }

  function fmtMoney(n, decimals) {
    if (n === null || n === undefined || isNaN(n)) return null;
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD', maximumFractionDigits: decimals
    }).format(n);
  }

  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(n)) return null;
    return new Intl.NumberFormat('en-US').format(n);
  }

  function fmtPct(n) {
    if (n === null || n === undefined || isNaN(n)) return null;
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  function stripHtml(s) {
    var div = document.createElement('div');
    div.innerHTML = String(s || '');
    return (div.textContent || div.innerText || '').trim();
  }

  /* ============================================================
     1. COINGECKO — unchanged identification tiers
     ============================================================ */

  function cgSearch(query) {
    return fetchJson('https://api.coingecko.com/api/v3/search?query=' + encodeURIComponent(query))
      .then(function (r) { return (r.data && r.data.coins) || []; });
  }

  function cgCoinDetail(id) {
    var url = 'https://api.coingecko.com/api/v3/coins/' + encodeURIComponent(id) +
      '?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false';
    return fetchJson(url).then(function (r) { return r.data; });
  }

  function cgIsExact(coin, query) {
    var q = String(query).toLowerCase();
    return (coin.name && coin.name.toLowerCase() === q) ||
           (coin.id && coin.id.toLowerCase() === slugify(query)) ||
           (coin.api_symbol && coin.api_symbol.toLowerCase() === slugify(query));
  }

  function cgVerify(detail, ctx) {
    var links = (detail && detail.links) || {};
    if (ctx.kind === 'github' && ctx.owner && ctx.repo) {
      var target = ('github.com/' + ctx.owner + '/' + ctx.repo).toLowerCase();
      var repos = (links.repos_url && links.repos_url.github) || [];
      for (var i = 0; i < repos.length; i++) {
        var u = String(repos[i] || '').toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
        if (u.indexOf(target) !== -1) {
          return { verified: true, via: 'CoinGecko lists this exact GitHub repository.' };
        }
      }
    }
    if (ctx.domain) {
      var homes = links.homepage || [];
      for (var j = 0; j < homes.length; j++) {
        if (normalizeDomain(homes[j]) === ctx.domain) {
          return { verified: true, via: 'CoinGecko lists this exact website as the official homepage.' };
        }
      }
    }
    return { verified: false };
  }

  function cgErrorStatus(err) {
    if (err && err.status === 429) {
      return 'CoinGecko rate limit reached. Wait about a minute, then run the research again.';
    }
    return describeFailure(err, 'api.coingecko.com') + ' Other sources are unaffected.';
  }

  function researchCoinGecko(ctx) {
    var res = baseResult('coingecko', 'CoinGecko');
    res.sourceUrl = 'https://www.coingecko.com/';

    var queries = [];
    if (ctx.kind === 'github') {
      if (ctx.repo) queries.push(ctx.repo);
      if (ctx.owner && slugify(ctx.owner) !== slugify(ctx.repo || '')) queries.push(ctx.owner);
    } else if (ctx.domain) {
      queries.push(ctx.domain.split('.')[0]);
    }
    queries = queries.filter(function (q) { return q && q.length >= 2; }).slice(0, 2);

    if (!queries.length) {
      res.status = 'skipped';
      res.note = 'No usable project name to search for.';
      return Promise.resolve(res);
    }

    var exact = [];
    var searchFailed = null;

    function tryQuery(i) {
      if (i >= queries.length || exact.length) return Promise.resolve();
      return cgSearch(queries[i]).then(function (coins) {
        exact = coins.filter(function (c) { return cgIsExact(c, queries[i]); });
      }).catch(function (e) { searchFailed = e; });
    }

    return tryQuery(0).then(function () { return tryQuery(1); }).then(function () {
      if (!exact.length && searchFailed) {
        res.status = 'error';
        res.error = cgErrorStatus(searchFailed);
        res.note = res.error;
        return res;
      }
      if (!exact.length) {
        res.status = 'not-matched';
        res.note = 'CoinGecko match not established.';
        return res;
      }

      var toCheck = exact.slice(0, 2);
      var checked = [];

      function checkNext(i) {
        if (i >= toCheck.length) return Promise.resolve();
        return cgCoinDetail(toCheck[i].id).then(function (detail) {
          checked.push({ coin: toCheck[i], detail: detail, verify: cgVerify(detail, ctx) });
        }).catch(function (e) { searchFailed = e; })
          .then(function () { return checkNext(i + 1); });
      }

      return checkNext(0).then(function () {
        var verified = checked.filter(function (c) { return c.verify.verified; });

        if (verified.length === 1) {
          fillCoinRows(res, verified[0].detail);
          res.note = verified[0].verify.via;
          return res;
        }

        if (!checked.length && searchFailed) {
          res.status = 'error';
          res.error = cgErrorStatus(searchFailed);
          res.note = res.error;
          return res;
        }

        if (exact.length > 1) {
          res.status = 'not-matched';
          res.note = 'CoinGecko match not established — multiple tokens share this exact name. Identification unresolved.';
          res.candidates = exact.slice(0, 5).map(function (c) {
            return { name: c.name, symbol: (c.symbol || '').toUpperCase(), rank: c.market_cap_rank, id: c.id };
          });
          return res;
        }

        var only = checked[0];
        var rank = only && only.detail && only.detail.market_cap_rank;
        if (only && rank !== null && rank !== undefined && rank <= NAME_MATCH_MAX_RANK) {
          fillCoinRows(res, only.detail);
          res.note = 'Match based on exact name only (rank #' + rank + '). Relationship to the researched ' +
            (ctx.kind === 'github' ? 'repository' : 'website') + ' was not independently verified.';
          return res;
        }

        res.status = 'not-matched';
        res.note = 'CoinGecko match not established — name matched but confidence is insufficient. No data attached.';
        res.candidates = exact.slice(0, 5).map(function (c) {
          return { name: c.name, symbol: (c.symbol || '').toUpperCase(), rank: c.market_cap_rank, id: c.id };
        });
        return res;
      });
    });
  }

  function cgRow(res, label, value, href) {
    if (value === null || value === undefined || value === '') {
      res.fieldsUnavailable.push(label);
      res.rows.push({ label: label, value: 'Not available from CoinGecko.' });
    } else {
      res.rows.push({ label: label, value: String(value), href: href || null });
    }
  }

  function fillCoinRows(res, d) {
    var md = d.market_data || {};
    res.sourceUrl = 'https://www.coingecko.com/en/coins/' + d.id;

    cgRow(res, 'CoinGecko ID', d.id);
    cgRow(res, 'Name', d.name);
    cgRow(res, 'Symbol', d.symbol ? d.symbol.toUpperCase() : null);
    cgRow(res, 'Price (USD)', fmtMoney(md.current_price && md.current_price.usd, 6));
    cgRow(res, 'Market cap', fmtMoney(md.market_cap && md.market_cap.usd, 0));
    cgRow(res, 'Market cap rank', d.market_cap_rank ? '#' + d.market_cap_rank : null);
    cgRow(res, '24h volume', fmtMoney(md.total_volume && md.total_volume.usd, 0));
    cgRow(res, '24h change', fmtPct(md.price_change_percentage_24h));
    cgRow(res, 'Circulating supply', fmtNum(md.circulating_supply));
    cgRow(res, 'Total supply', fmtNum(md.total_supply));
    cgRow(res, 'Max supply', fmtNum(md.max_supply));
    cgRow(res, 'Genesis date', d.genesis_date ? fmtDate(d.genesis_date) : null);

    var home = (d.links && d.links.homepage || []).filter(Boolean)[0];
    cgRow(res, 'Official website', home, home);
    var tw = d.links && d.links.twitter_screen_name;
    cgRow(res, 'Twitter / X', tw ? '@' + tw : null, tw ? 'https://x.com/' + tw : null);
    cgRow(res, 'Platform', d.asset_platform_id || null);

    var platforms = d.platforms || {};
    var keys = Object.keys(platforms).filter(function (k) { return platforms[k]; });
    keys.slice(0, 3).forEach(function (k) {
      res.rows.push({ label: 'Contract (' + k + ')', value: platforms[k], href: null });
    });
    if (keys.length > 3) {
      res.rows.push({ label: 'Further contracts', value: (keys.length - 3) + ' more listed on CoinGecko', href: null });
    }

    var desc = stripHtml(d.description && d.description.en);
    if (desc) {
      if (desc.length > 260) desc = desc.slice(0, 260).replace(/\s+\S*$/, '') + '…';
      res.rows.push({ label: 'Description (excerpt)', value: desc, href: null });
    }
  }

  /* ============================================================
     2. DOMAIN / RDAP — registrable domain + failure detail
     ============================================================ */

  function rdapBaseFor(tld) {
    if (!rdapBootstrapPromise) {
      rdapBootstrapPromise = fetchJson('https://data.iana.org/rdap/dns.json')
        .then(function (r) { return r.data; })
        .catch(function () { return null; });
    }
    return rdapBootstrapPromise.then(function (boot) {
      if (boot && boot.services) {
        for (var i = 0; i < boot.services.length; i++) {
          var tlds = boot.services[i][0] || [];
          var urls = boot.services[i][1] || [];
          if (tlds.indexOf(tld) !== -1 && urls.length) {
            var base = urls[0];
            if (base.indexOf('http://') === 0) base = 'https://' + base.slice(7);
            return base.replace(/\/?$/, '/');
          }
        }
      }
      return FALLBACK_RDAP[tld] || null;
    });
  }

  function parseRdap(res, data, finalUrl) {
    res.sourceUrl = finalUrl;

    function row(label, value, href) {
      if (value === null || value === undefined || value === '') {
        res.fieldsUnavailable.push(label);
        res.rows.push({ label: label, value: 'Not available from RDAP.' });
      } else {
        res.rows.push({ label: label, value: String(value), href: href || null });
      }
    }

    var events = {};
    (data.events || []).forEach(function (e) {
      if (e && e.eventAction) events[e.eventAction] = e.eventDate;
    });

    var registrar = null;
    (data.entities || []).forEach(function (ent) {
      if (registrar) return;
      if ((ent.roles || []).indexOf('registrar') === -1) return;
      var v = (ent.vcardArray && ent.vcardArray[1]) || [];
      for (var i = 0; i < v.length; i++) {
        if (v[i][0] === 'fn') { registrar = v[i][3]; break; }
      }
      if (!registrar && ent.handle) registrar = 'Handle ' + ent.handle;
    });

    var ns = (data.nameservers || []).map(function (n) { return n.ldhName; }).filter(Boolean);
    var nsText = ns.length
      ? ns.slice(0, 4).join(', ') + (ns.length > 4 ? ' +' + (ns.length - 4) + ' more' : '')
      : null;

    var dnssec = null;
    if (data.secureDNS && data.secureDNS.delegationSigned === true) dnssec = 'Delegation signed';
    else if (data.secureDNS && data.secureDNS.delegationSigned === false) dnssec = 'Not signed';

    row('Domain', data.ldhName || data.unicodeName || null);
    row('Registered', fmtDate(events['registration']));
    row('Expires', fmtDate(events['expiration']));
    row('Last changed', fmtDate(events['last changed'] || events['last update of RDAP database']));
    row('Registrar', registrar);
    row('Status', (data.status || []).join(', ') || null);
    row('Nameservers', nsText);
    row('DNSSEC', dnssec);
  }

  function researchRdap(ctx) {
    var res = baseResult('rdap', 'Domain / RDAP');

    if (!ctx.domain) {
      res.status = 'skipped';
      res.note = 'No official website on record for this research subject.';
      return Promise.resolve(res);
    }

    var regDomain = registrableDomain(ctx.domain) || ctx.domain;
    var tld = regDomain.split('.').pop();
    var subNote = (regDomain !== ctx.domain)
      ? 'Subdomain entered — registrable domain "' + regDomain + '" was checked.'
      : null;

    return rdapBaseFor(tld).then(function (base) {
      var attempts = [];
      if (base) attempts.push(base + 'domain/' + regDomain);
      attempts.push('https://rdap.org/domain/' + regDomain);

      function tryNext(i, lastErr) {
        if (i >= attempts.length) {
          if (lastErr && lastErr.status === 404) {
            res.status = 'unavailable';
            res.note = (subNote ? subNote + ' ' : '') + 'RDAP data unavailable for this domain.';
          } else {
            res.status = 'error';
            res.error = describeFailure(lastErr, hostOf(attempts[attempts.length - 1])) +
              ' Other sources are unaffected.';
            res.note = res.error;
          }
          return res;
        }
        return fetchJson(attempts[i]).then(function (r) {
          res.status = 'available';
          parseRdap(res, r.data, r.finalUrl);
          if (subNote) res.note = subNote;
          return res;
        }).catch(function (e) { return tryNext(i + 1, e); });
      }
      return tryNext(0, null);
    });
  }

  /* ============================================================
     3. WAYBACK — JSONP fallback when plain fetch is blocked
     ============================================================ */

  function wbParse(data, domain) {
    var s = data && data.archived_snapshots && data.archived_snapshots.closest;
    if (s && s.available && s.timestamp) {
      var link = s.url
        ? String(s.url).replace(/^http:\/\//, 'https://')
        : 'https://web.archive.org/web/' + s.timestamp + '/' + domain;
      return { timestamp: s.timestamp, url: link };
    }
    return null;
  }

  function wbFetch(domain, timestamp) {
    var url = 'https://archive.org/wayback/available?url=' + encodeURIComponent(domain) +
      (timestamp ? '&timestamp=' + timestamp : '');
    return fetchJson(url, 15000)
      .then(function (r) { return wbParse(r.data, domain); })
      .catch(function (e1) {
        return jsonp(url, 20000)
          .then(function (data) { return wbParse(data, domain); })
          .catch(function () { throw e1; });
      });
  }

  function fmtWbTs(ts) {
    if (!ts || ts.length < 8) return null;
    return fmtDate(ts.slice(0, 4) + '-' + ts.slice(4, 6) + '-' + ts.slice(6, 8));
  }

  function researchWayback(ctx) {
    var res = baseResult('wayback', 'Web history / Wayback');

    if (!ctx.domain) {
      res.status = 'skipped';
      res.note = 'No official website on record for this research subject.';
      return Promise.resolve(res);
    }

    var domain = ctx.domain;
    res.sourceUrl = 'https://web.archive.org/web/*/' + domain;

    return Promise.all([
      attempt(wbFetch(domain, '1995')),
      attempt(wbFetch(domain, ''))
    ]).then(function (results) {
      var first = results[0].v, last = results[1].v;
      var failed = results[0].e && results[1].e;

      if (failed) {
        res.status = 'error';
        res.error = describeFailure(results[0].e, 'archive.org') + ' Other sources are unaffected.';
        res.note = res.error;
        return res;
      }

      if (!first && !last) {
        res.status = 'available';
        res.note = 'No historical captures found. This does not by itself indicate anything about the project.';
        res.rows.push({ label: 'Search the archive', value: 'web.archive.org', href: res.sourceUrl });
        return res;
      }

      if (first) {
        res.rows.push({ label: 'Earliest capture', value: fmtWbTs(first.timestamp) || first.timestamp, href: first.url });
      }
      if (last && (!first || last.timestamp !== first.timestamp)) {
        res.rows.push({ label: 'Most recent capture', value: fmtWbTs(last.timestamp) || last.timestamp, href: last.url });
      }
      res.rows.push({ label: 'Browse all captures', value: 'web.archive.org', href: res.sourceUrl });
      return res;
    });
  }

  /* ============================================================
     Orchestrator + integration — unchanged
     ============================================================ */

  function runAll(ctx, onStatus) {
    var jobs = [
      ['coingecko', researchCoinGecko],
      ['rdap', researchRdap],
      ['wayback', researchWayback]
    ];
    var out = {};
    return Promise.all(jobs.map(function (j) {
      var key = j[0], fn = j[1];
      if (onStatus) onStatus(key, 'checking');
      return fn(ctx).then(function (r) {
        out[key] = r;
        if (onStatus) onStatus(key, r.status);
      }).catch(function () {
        out[key] = errorResult(key, labelFor(key), 'Unexpected adapter failure.');
        if (onStatus) onStatus(key, 'error');
      });
    })).then(function () { return out; });
  }

  function attach(report, statusEl) {
    var cb = null;
    if (statusEl) {
      var items = {};
      var STATE_TEXT = {
        checking: 'checking…',
        available: 'done',
        'not-matched': 'done — no match',
        unavailable: 'done — no data',
        skipped: 'not applicable',
        error: 'unavailable'
      };
      cb = function (key, state) {
        var li = items[key];
        if (!li) {
          li = document.createElement('li');
          li.className = 'load-src';
          statusEl.appendChild(li);
          items[key] = li;
        }
        li.setAttribute('data-state', state === 'checking' ? 'checking' : (state === 'error' ? 'error' : 'done'));
        li.textContent = labelFor(key) + ' — ' + (STATE_TEXT[state] || state);
      };
    }
    var ctx = contextFromUrl(report.url, report);
    return runAll(ctx, cb).then(function (sources) {
      report.sources = sources;
      return report;
    }).catch(function () { return report; });
  }

  /* ============================================================
     Report rendering — unchanged
     ============================================================ */

  var STATUS_TEXT = {
    available: 'Available',
    'not-matched': 'Not matched',
    unavailable: 'Unavailable',
    error: 'Error',
    skipped: 'Not applicable'
  };

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function sourceBlock(r) {
    var block = el('div', 'src-block');
    block.setAttribute('data-status', r.status);

    var head = el('div', 'src-head');
    head.appendChild(el('span', 'src-name', r.label));
    head.appendChild(el('span', 'src-status is-' + r.status, STATUS_TEXT[r.status] || r.status));
    block.appendChild(head);

    if (r.note) block.appendChild(el('p', 'src-note', r.note));

    if (r.candidates && r.candidates.length) {
      var ul = el('ul', 'src-cands');
      r.candidates.forEach(function (c) {
        var rank = c.rank ? ' — rank #' + c.rank : ' — unranked';
        ul.appendChild(el('li', null, c.name + ' (' + c.symbol + ')' + rank + ' — id: ' + c.id));
      });
      block.appendChild(ul);
    }

    if (r.rows && r.rows.length) {
      var rows = el('div', 'src-rows');
      r.rows.forEach(function (row) {
        var line = el('div', 'src-row');
        line.appendChild(el('span', 'src-label', row.label));
        var val;
        if (row.href) {
          val = document.createElement('a');
          val.className = 'src-value src-link';
          val.href = row.href;
          val.target = '_blank';
          val.rel = 'noopener noreferrer';
          val.textContent = row.value;
        } else {
          val = el('span', 'src-value', row.value);
        }
        line.appendChild(val);
        rows.appendChild(line);
      });
      block.appendChild(rows);
    }

    if (r.sourceUrl) {
      var foot = el('p', 'src-foot');
      foot.appendChild(document.createTextNode('Source: '));
      var a = document.createElement('a');
      a.href = r.sourceUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = r.sourceName;
      foot.appendChild(a);
      var when = fmtDateTime(r.retrievedAt);
      if (when) foot.appendChild(document.createTextNode(' · Retrieved ' + when));
      block.appendChild(foot);
    }

    return block;
  }

  function renderSourcesSection(report) {
    if (!report || !report.sources) return null;

    var section = el('section', 'src-section');
    section.setAttribute('aria-label', 'Research sources');
    section.appendChild(el('h2', 'src-section-title', 'Sources'));

    var isGithub = report.kind === 'github' || /github\.com/i.test(report.url || '');
    var hasGhData = !!(report.dossier &&
      ((Array.isArray(report.dossier.rows) && report.dossier.rows.length) || report.dossier.readme));
    var ghStatus, ghNote;
    if (isGithub && hasGhData) {
      ghStatus = 'available';
      ghNote = 'Repository provided by user; ownership relationship not independently verified.';
    } else if (isGithub) {
      ghStatus = 'error';
      ghNote = 'GitHub data is not present in this record.';
    } else {
      ghStatus = 'skipped';
      ghNote = 'No repository in this research subject.';
    }
    section.appendChild(sourceBlock({
      key: 'github', label: 'GitHub', status: ghStatus,
      sourceName: 'GitHub', sourceUrl: isGithub ? report.url : null,
      retrievedAt: report.checkedAt || null,
      note: ghNote, rows: [], candidates: []
    }));

    ['coingecko', 'rdap', 'wayback'].forEach(function (key) {
      if (report.sources[key]) section.appendChild(sourceBlock(report.sources[key]));
    });

    return section;
  }

  return {
    attach: attach,
    runAll: runAll,
    contextFromUrl: contextFromUrl,
    normalizeDomain: normalizeDomain,
    renderSourcesSection: renderSourcesSection
  };
})();
