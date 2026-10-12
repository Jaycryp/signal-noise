/* Signal / Noise — Stage 8: website claim extraction + evidence assessment.
   Extraction is deterministic keyword matching ("keyword-match:v1") — NOT
   semantic understanding. A claim found on the project's own website is
   self-reported; it is never treated as verified on that basis. */
(function () {
  'use strict';

  var MAX_CLAIMS = 30;
  var PER_CATEGORY = 10;
  var EXCERPT_MAX = 300;
  var CONTEXT_MAX = 600;
  var MIN_SENTENCE = 25;
  var MAX_SENTENCE = 500;
  var FRONTEND_TIMEOUT_MS = 30000;
  var METHOD = 'keyword-match:v1';

  var BOILERPLATE = /cookie|consent|newsletter|subscribe|all rights reserved|privacy policy|terms of (service|use)|copyright|sign up for/i;

  var CATEGORIES = [
    { key: 'audit-security', label: 'Audit & security',
      re: /\b(audit(ed|s|ing)?|security audit|smart contract audit|penetration test|bug bounty|certik|trail of bits|quantstamp|hacken|peckshield|slowmist|openzeppelin|consensys diligence|immunefi)\b/i },
    { key: 'team-founders', label: 'Team & founders',
      re: /\b(found(er|ers|ed|ing)\b|co-?founder|our team|team of|ceo\b|cto\b|coo\b|lead developer|core (team|contributors?)|founded by|built by)\b/i },
    { key: 'investors-funding', label: 'Investors & funding',
      re: /\b(raised|funding round|seed (round|funding)?|series [a-e]\b|backed by|led by|investors?|venture capital|strategic invest(ment|ors?)|grant from|valuation)\b/i },
    { key: 'partnerships', label: 'Partnerships',
      re: /\b(partner(ship|ed|s|ing)?\b|in partnership with|collaborat(e|ed|ion|ing) with|teamed up with|strategic alliance)\b/i },
    { key: 'integrations', label: 'Integrations',
      re: /\b(integrat(e|es|ed|ion|ing|ions)\b|built on|powered by|deployed on|compatible with|available on)\b/i },
    { key: 'mainnet-testnet', label: 'Mainnet / testnet',
      re: /\b(mainnet|testnet|devnet|now live|live on|public beta|open beta)\b/i },
    { key: 'tokens-contracts', label: 'Tokens & contracts',
      re: /(\$[A-Z]{2,10}\b|\b(tokens?|ticker|contract address|0x[a-fA-F0-9]{10,}|presale|airdrop|staking|total supply|coingecko|coinmarketcap)\b)/i },
    { key: 'governance', label: 'Governance',
      re: /\b(governance|dao\b|voting|proposals?|snapshot|multisig|timelock|quorum|delegates?)\b/i }
  ];

  var DEFAULT_NOTES = {
    'audit-security': 'No audit-verification source is connected (e.g. auditor publications or an audit registry). This claim is self-reported by the project website.',
    'team-founders': 'No team-data source is connected. GitHub shows code contributors, not team members. This claim is self-reported.',
    'investors-funding': 'No funding-data source is connected. This claim is self-reported by the project website.',
    'partnerships': 'No partnership-verification source is connected. This claim is self-reported by the project website.',
    'integrations': 'No integration-verification source is connected. This claim is self-reported by the project website.',
    'mainnet-testnet': 'No on-chain source is connected to confirm network availability. This claim is self-reported.',
    'tokens-contracts': 'Checked against CoinGecko where a verified match exists; no on-chain contract source is connected. Self-reported unless marked otherwise.',
    'governance': 'No governance-data source is connected. This claim is self-reported by the project website.'
  };

  var STATE_LABEL = {
    'found': 'Claims found', 'none': 'No relevant claims',
    'skipped': 'Not applicable', 'not-configured': 'Not configured',
    'blocked': 'Request blocked', 'timeout': 'Timed out',
    'inaccessible': 'Website inaccessible', 'unsupported': 'Unsupported content',
    'empty': 'No readable content', 'rate-limited': 'Rate limited',
    'worker-unavailable': 'Worker unavailable', 'error': 'Error'
  };

  var ASSESS_LABEL = {
    'observed': 'Observed — self-reported',
    'supported': 'Supporting evidence',
    'contradicted': 'Contradictory evidence',
    'not-established': 'Not established'
  };

  /* ---------------- helpers ---------------- */

  function getEndpoint() {
    if (typeof document === 'undefined') return null;
    var meta = document.querySelector('meta[name="sn-worker-endpoint"]');
    var ep = meta && meta.content ? meta.content.trim() : '';
    if (!ep || ep.indexOf('YOUR-SUBDOMAIN') !== -1) return null;
    return ep.replace(/\/+$/, '');
  }

  function nowIso() { try { return new Date().toISOString(); } catch (e) { return ''; } }

  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return pad2(d.getUTCDate()) + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear() +
      ', ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ' UTC';
  }

  function truncate(s, n) { return s.length <= n ? s : s.slice(0, n - 1).trim() + '\u2026'; }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function httpsOnly(u) { return String(u || '').replace(/^http:\/\//i, 'https://'); }

  function dossierWebsite(report) {
    var rows = report && report.dossier && report.dossier.rows;
    if (Array.isArray(rows)) {
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i][0]).toLowerCase() === 'website' && /^https?:\/\//i.test(String(rows[i][1]).trim())) {
          return String(rows[i][1]).trim();
        }
      }
    }
    return null;
  }

  function siteUrlFor(report) {
    if (!report || !report.url) return null;
    if (/github\.com/i.test(report.url)) {
      var h = report.homepage || dossierWebsite(report);
      return h ? httpsOnly(h) : null;
    }
    return httpsOnly(report.url);
  }

  /* ---------------- extraction ---------------- */

  function splitSentences(text) {
    var out = [];
    String(text || '').split(/\n+/).forEach(function (line) {
      line.replace(/([.!?])\s+/g, '$1').split(/[\n]+/)
        .map(function (s) { return s.replace(/\s+/g, ' ').trim(); })
        .forEach(function (s) {
          if (s.length >= MIN_SENTENCE && s.length <= MAX_SENTENCE) out.push(s);
        });
    });
    return out;
  }

  function dedupeKey(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, ''); }

  function findReferences(sentence, links) {
    var refs = [];
    var inline = sentence.match(/https?:\/\/[^\s)"']+/g) || [];
    inline.forEach(function (u) { refs.push({ href: u.replace(/[.,;]+$/, ''), text: 'Link in claim text' }); });
    (links || []).forEach(function (l) {
      if (refs.length >= 3 || !l.text || l.text.length < 3) return;
      if (sentence.toLowerCase().indexOf(l.text.toLowerCase()) !== -1 &&
          /github\.com|etherscan\.io|docs\.|\.pdf/i.test(l.href)) {
        refs.push({ href: l.href, text: truncate(l.text, 80) });
      }
    });
    return refs.slice(0, 3);
  }

  function extractClaims(payload) {
    var sentences = splitSentences(payload.text);
    var seen = new Set();
    var claims = [];
    var perCat = {};
    var capped = false;

    for (var i = 0; i < sentences.length; i++) {
      var s = sentences[i];
      if (BOILERPLATE.test(s)) continue;
      for (var c = 0; c < CATEGORIES.length; c++) {
        var cat = CATEGORIES[c];
        if (!cat.re.test(s)) continue;
        var key = cat.key + '|' + dedupeKey(s);
        if (seen.has(key)) break;
        if ((perCat[cat.key] || 0) >= PER_CATEGORY) { capped = true; break; }
        if (claims.length >= MAX_CLAIMS) { capped = true; break; }
        seen.add(key);
        perCat[cat.key] = (perCat[cat.key] || 0) + 1;
        var ctx = [sentences[i - 1], s, sentences[i + 1]].filter(Boolean).join(' ');
        claims.push({
          id: 'c' + (claims.length + 1),
          category: cat.key,
          categoryLabel: cat.label,
          excerpt: truncate(s, EXCERPT_MAX),
          context: truncate(ctx, CONTEXT_MAX),
          sourceUrl: payload.finalUrl,
          retrievedAt: payload.retrievedAt,
          method: METHOD,
          references: findReferences(s, payload.links),
          assessment: null
        });
        break; // first matching category wins
      }
      if (claims.length >= MAX_CLAIMS) break;
    }

    var byCategory = {};
    claims.forEach(function (cl) { byCategory[cl.category] = (byCategory[cl.category] || 0) + 1; });
    return { claims: claims, byCategory: byCategory, capped: capped };
  }

  /* ---------------- worker call ---------------- */

  function fetchViaWorker(endpoint, siteUrl) {
    return fetch(endpoint + '/?url=' + encodeURIComponent(siteUrl), {
      signal: AbortSignal.timeout(FRONTEND_TIMEOUT_MS)
    }).then(function (resp) {
      return resp.json();
    }).then(function (json) {
      if (json && json.ok === true) return { ok: true, payload: json };
      return {
        ok: false,
        code: json && json.error && json.error.code ? json.error.code : 'FETCH_FAILED',
        message: json && json.error && json.error.message ? json.error.message : 'The website could not be fetched.'
      };
    }).catch(function (e) {
      var timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return {
        ok: false,
        code: timeout ? 'TIMEOUT' : 'WORKER_UNREACHABLE',
        message: timeout
          ? 'The fetch worker did not respond in time.'
          : 'The fetch worker could not be reached. It may be undeployed, misconfigured, or blocked.'
      };
    });
  }

  var CODE_TO_STATE = {
    TIMEOUT: 'timeout',
    UNSUPPORTED_CONTENT_TYPE: 'unsupported',
    PRIVATE_DESTINATION: 'blocked', BLOCKED_DESTINATION: 'blocked',
    UNSUPPORTED_SCHEME: 'blocked', CREDENTIALS_REJECTED: 'blocked',
    UNSUPPORTED_PORT: 'blocked', INVALID_URL: 'blocked',
    RATE_LIMITED: 'rate-limited', ORIGIN_FORBIDDEN: 'worker-unavailable',
    WORKER_UNREACHABLE: 'worker-unavailable'
  };

  function buildResult(fetched, siteUrl) {
    if (!fetched.ok) {
      return {
        status: CODE_TO_STATE[fetched.code] || 'inaccessible',
        reason: fetched.message, errorCode: fetched.code,
        siteUrl: siteUrl, finalUrl: null, retrievedAt: nowIso(),
        pageTitle: null, textChars: 0, truncated: false, limitation: null,
        method: METHOD, claims: [], byCategory: {}
      };
    }
    var p = fetched.payload;
    if (!p.text || p.text.trim().length < 40) {
      return {
        status: 'empty',
        reason: 'No readable text could be extracted. The page may be JavaScript-rendered, blocked to fetchers, or empty.',
        siteUrl: siteUrl, finalUrl: p.finalUrl, retrievedAt: p.retrievedAt || nowIso(),
        pageTitle: p.title || null, textChars: p.textChars || 0, truncated: false,
        limitation: null, method: METHOD, claims: [], byCategory: {}
      };
    }
    var ex = extractClaims(p);
    var truncated = !!(p.bodyTruncated || p.textTruncated || ex.capped);
    return {
      status: ex.claims.length ? 'found' : 'none',
      reason: null,
      siteUrl: siteUrl, finalUrl: p.finalUrl, retrievedAt: p.retrievedAt || nowIso(),
      pageTitle: p.title || null, textChars: p.textChars || 0, truncated: truncated,
      limitation: truncated ? 'Extraction was truncated (size, text, or claim limits were reached).' : null,
      method: METHOD, claims: ex.claims, byCategory: ex.byCategory
    };
  }

  /* ---------------- evidence assessment ---------------- */

  function rowVal(source, label) {
    if (!source || !source.rows) return null;
    for (var i = 0; i < source.rows.length; i++) {
      if (source.rows[i].label === label) return String(source.rows[i].value);
    }
    return null;
  }

  function assess(result, report) {
    if (!result || !result.claims || !result.claims.length) return result;

    var sources = (report && report.sources) || {};
    var cg = sources.coingecko;
    var checked = [];
    if (report && report.kind === 'github' && report.dossier) checked.push('GitHub');
    ['coingecko', 'rdap', 'wayback'].forEach(function (k) {
      var s = sources[k];
      if (s && (s.status === 'available' || s.status === 'not-matched')) checked.push(s.label);
    });

    var cgVerified = !!(cg && cg.status === 'available' && /lists this exact/i.test(cg.note || ''));
    var cgSymbol = cgVerified ? rowVal(cg, 'Symbol') : null;
    var reportRepo = null;
    if (report && report.kind === 'github') {
      var m = String(report.url || '').match(/github\.com\/([^/]+\/[^/]+)/i);
      if (m) reportRepo = m[1].replace(/\/$/, '').toLowerCase();
    }

    result.claims.forEach(function (c) {
      var a = {
        status: 'not-established',
        note: DEFAULT_NOTES[c.category] || 'This claim is self-reported by the project website.',
        evidenceChecked: checked.slice()
      };

      if (!checked.length) {
        a.status = 'observed';
        a.note = 'No independent source checks completed this session. This claim is unverified website content.';
      }

      // Token ticker corroboration via homepage-verified CoinGecko match
      if (c.category === 'tokens-contracts' && cgVerified && cgSymbol) {
        var sym = escRe(cgSymbol);
        var dollar = new RegExp('\\$' + sym + '\\b').test(c.excerpt);
        var wordy = cgSymbol.length >= 3 && new RegExp('\\b' + sym + '\\b', 'i').test(c.excerpt) &&
          /token|coin|contract|supply|staking/i.test(c.excerpt);
        if (dollar || wordy) {
          a.status = 'supported';
          a.note = 'CoinGecko (match verified by listed homepage) lists ticker ' + cgSymbol +
            ' for this project. This supports the token\u2019s existence; it does not verify the full claim.';
        }
      }

      // Contract address corroboration via verified CoinGecko contract rows
      if (c.category === 'tokens-contracts' && cgVerified && cg && cg.rows) {
        var addr = c.excerpt.match(/0x[0-9a-fA-F]{20,}/);
        if (addr) {
          var hit = null;
          cg.rows.forEach(function (r) {
            if (!hit && /^Contract \(/.test(r.label) &&
                String(r.value).toLowerCase() === addr[0].toLowerCase()) hit = r;
          });
          if (hit) {
            a.status = 'supported';
            a.note = 'The contract address in this claim matches the ' + hit.label +
              ' address listed by CoinGecko (match verified by listed homepage).';
          }
        }
      }

      // "Listed on CoinGecko" vs an actual not-matched result this session
      if (/coingecko/i.test(c.excerpt) && cg && cg.status === 'not-matched') {
        a.status = 'contradicted';
        a.note = 'A CoinGecko search for this project\u2019s name and website returned no match at research time. ' +
          'Listings can lag or use different names; absence is not proof the claim is false.';
      }

      // GitHub repo referenced in claim matches the researched subject
      if (reportRepo) {
        var ref = c.excerpt.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i);
        if (ref && ref[1].replace(/\/$/, '').toLowerCase() === reportRepo) {
          a.status = 'supported';
          a.note = 'The referenced repository matches the GitHub subject researched in this report.';
        }
      }

      c.assessment = a;
    });

    return result;
  }

  /* ---------------- attach (research flow) ---------------- */

  function attach(report, statusEl) {
    var li = null;
    function setStatus(state, text) {
      if (!statusEl) return;
      if (!li) {
        li = document.createElement('li');
        li.className = 'load-src';
        statusEl.appendChild(li);
      }
      li.setAttribute('data-state', state);
      li.textContent = text;
    }
    return Promise.resolve().then(function () {
      try {
        var siteUrl = siteUrlFor(report);
        if (!siteUrl) {
          report.claims = {
            status: 'skipped',
            reason: 'No official website on record for this research subject.',
            siteUrl: null, finalUrl: null, retrievedAt: nowIso(),
            pageTitle: null, textChars: 0, truncated: false, limitation: null,
            method: METHOD, claims: [], byCategory: {}
          };
          setStatus('done', 'Website content — not applicable');
          return report;
        }
        var endpoint = getEndpoint();
        if (!endpoint) {
          report.claims = {
            status: 'not-configured',
            reason: 'The fetch worker endpoint is not configured on this deployment.',
            siteUrl: siteUrl, finalUrl: null, retrievedAt: nowIso(),
            pageTitle: null, textChars: 0, truncated: false, limitation: null,
            method: METHOD, claims: [], byCategory: {}
          };
          setStatus('error', 'Website content — not configured');
          return report;
        }
        setStatus('checking', 'Website content — checking\u2026');
        return fetchViaWorker(endpoint, siteUrl).then(function (fetched) {
          var built = buildResult(fetched, siteUrl);
          assess(built, report);
          report.claims = built;
          var state = (built.status === 'found' || built.status === 'none' || built.status === 'empty') ? 'done' : 'error';
          var label = built.status === 'found'
            ? 'Website content — ' + built.claims.length + (built.claims.length === 1 ? ' claim' : ' claims')
            : 'Website content — ' + (STATE_LABEL[built.status] || built.status).toLowerCase();
          setStatus(state, label);
          return report;
        });
      } catch (e) {
        report.claims = {
          status: 'error', reason: 'Unexpected claims failure. Other report sections are unaffected.',
          siteUrl: null, finalUrl: null, retrievedAt: nowIso(),
          pageTitle: null, textChars: 0, truncated: false, limitation: null,
          method: METHOD, claims: [], byCategory: {}
        };
        setStatus('error', 'Website content — unavailable');
        return report;
      }
    });
  }

  /* ---------------- rendering (report page) ---------------- */

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function linkEl(href, text) {
    var a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'source-link';
    a.textContent = text;
    return a;
  }

  function claimCard(c, i) {
    var a = c.assessment || { status: 'not-established', note: '', evidenceChecked: [] };
    var bodyId = 'claim-' + i;

    var card = el('article', 'claim');
    card.setAttribute('data-expanded', 'false');

    var head = el('button', 'claim-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    head.setAttribute('aria-controls', bodyId);
    head.appendChild(el('span', 'claim-cat', c.categoryLabel));
    head.appendChild(el('span', 'claim-excerpt', truncate(c.excerpt, 180)));
    head.appendChild(el('span', 'claim-pill pill-' + a.status, ASSESS_LABEL[a.status] || a.status));
    head.appendChild(el('span', 'claim-toggle', '+'));

    var detail = el('div', 'claim-detail');
    detail.id = bodyId;
    detail.hidden = true;

    if (c.context && c.context !== c.excerpt) {
      var ctxWrap = el('div', 'claim-block');
      ctxWrap.appendChild(el('p', 'claim-k', 'Context'));
      ctxWrap.appendChild(el('p', 'claim-v', c.context));
      detail.appendChild(ctxWrap);
    }

    var assessWrap = el('div', 'claim-block');
    assessWrap.appendChild(el('p', 'claim-k', 'Assessment'));
    assessWrap.appendChild(el('p', 'claim-v', a.note || 'No assessment note.'));
    var checkedText = a.evidenceChecked && a.evidenceChecked.length
      ? 'Sources actually checked: ' + a.evidenceChecked.join(', ') +
        '. No other sources were searched; this is not an exhaustive verification.'
      : 'No independent sources were checked for this claim.';
    assessWrap.appendChild(el('p', 'claim-v claim-muted', checkedText));
    detail.appendChild(assessWrap);

    if (c.references && c.references.length) {
      var refWrap = el('div', 'claim-block');
      refWrap.appendChild(el('p', 'claim-k', 'Links found in or near this claim'));
      c.references.forEach(function (r) { refWrap.appendChild(linkEl(r.href, (r.text || r.href) + ' \u2197')); });
      detail.appendChild(refWrap);
    }

    var metaWrap = el('div', 'claim-block');
    metaWrap.appendChild(el('p', 'claim-k', 'Provenance'));
    metaWrap.appendChild(el('p', 'claim-v claim-muted',
      'Extraction method: ' + c.method + ' (keyword matching, not semantic understanding)' +
      (c.retrievedAt && fmtDateTime(c.retrievedAt) ? ' · Retrieved ' + fmtDateTime(c.retrievedAt) : '')));
    if (c.sourceUrl) metaWrap.appendChild(linkEl(c.sourceUrl, 'Open source page \u2197'));
    detail.appendChild(metaWrap);

    head.addEventListener('click', function () {
      var expanded = card.getAttribute('data-expanded') === 'true';
      card.setAttribute('data-expanded', String(!expanded));
      head.setAttribute('aria-expanded', String(!expanded));
      detail.hidden = expanded;
      head.querySelector('.claim-toggle').textContent = expanded ? '+' : '\u2212';
    });

    card.appendChild(head);
    card.appendChild(detail);
    return card;
  }

  function renderClaimsSection(report) {
    var data = report && report.claims;
    if (!data || !data.status) return null;

    var section = el('section', 'claims-section');
    section.setAttribute('aria-label', 'Website claims');
    section.appendChild(el('h2', 'claims-title', 'Website claims'));
    section.appendChild(el('p', 'claims-sub',
      'Statements found on the project\u2019s own website via deterministic keyword matching (' + (data.method || METHOD) +
      '). A website claim is self-reported \u2014 appearing here is not verification.'));

    if (data.status !== 'found' && data.status !== 'none') {
      var box = el('div', 'claims-status');
      box.appendChild(el('span', 'claim-pill pill-state', STATE_LABEL[data.status] || data.status));
      box.appendChild(el('p', 'claims-status-msg', data.reason || 'Website content could not be checked.'));
      if (data.siteUrl) box.appendChild(linkEl(data.siteUrl, 'Open website \u2197'));
      section.appendChild(box);
      return section;
    }

    var meta = el('p', 'claims-meta');
    meta.appendChild(document.createTextNode('Checked '));
    meta.appendChild(linkEl(data.finalUrl || data.siteUrl, data.finalUrl || data.siteUrl));
    var bits = [];
    if (data.textChars) bits.push(data.textChars.toLocaleString('en-US') + ' characters read');
    if (data.retrievedAt && fmtDateTime(data.retrievedAt)) bits.push('retrieved ' + fmtDateTime(data.retrievedAt));
    if (data.truncated) bits.push('extraction truncated');
    if (bits.length) meta.appendChild(document.createTextNode(' \u00b7 ' + bits.join(' \u00b7 ')));
    section.appendChild(meta);

    if (data.status === 'none') {
      section.appendChild(el('p', 'claims-empty',
        'No relevant claims were found in the extracted page text. Absence of claims on the checked page does not by itself indicate anything about the project.'));
      return section;
    }

    section.appendChild(el('p', 'claims-count',
      data.claims.length + (data.claims.length === 1 ? ' statement' : ' statements') + ' extracted' +
      (data.limitation ? ' \u2014 ' + data.limitation : '')));

    var list = el('div', 'claims-list');
    data.claims.forEach(function (c, i) { list.appendChild(claimCard(c, i)); });
    section.appendChild(list);
    return section;
  }

  var api = {
    attach: attach,
    renderClaimsSection: renderClaimsSection,
    extractClaims: extractClaims,
    assess: assess,
    _splitSentences: splitSentences
  };

  if (typeof window !== 'undefined') window.SNClaims = api;
  if (typeof globalThis !== 'undefined') globalThis.SNClaims = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
