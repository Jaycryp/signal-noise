/* Signal / Noise — sources.js
   Stage 6: source detection + GitHub adapter.
   GitHub is the ONLY live external source in this stage.
   Adapters return RAW data; report.html translates it.
   No trust scores. No fabricated fields. */

(function () {
  'use strict';

  function ResearchError(code, userMessage) {
    this.code = code;
    this.userMessage = userMessage;
  }
  ResearchError.prototype = Object.create(Error.prototype);

  var MESSAGES = {
    invalid_url: "That doesn't look like a valid URL. Check the address and try again.",
    not_found: "GitHub couldn't find that repository. Check the owner and repository name.",
    rate_limited: "GitHub's public request limit has been reached for this device. Please try again later.",
    api_error: "GitHub couldn't provide repository data right now.",
    network: "Couldn't reach GitHub. Check your connection and try again."
  };

  var GH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  var GH_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

  var GH_RESERVED = ['about', 'collections', 'contact', 'enterprise', 'explore',
    'features', 'join', 'login', 'marketplace', 'notifications', 'orgs', 'pricing',
    'search', 'security', 'settings', 'sponsors', 'team', 'topics', 'trending', 'users'];

  function normaliseUrl(input) {
    var raw = String(input || '').trim();
    if (!raw) return null;
    try { return new URL(raw); } catch (e) {
      try { return new URL('https://' + raw); } catch (e2) { return null; }
    }
  }

  function detectSource(input) {
    var url = normaliseUrl(input);
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      return { type: 'invalid' };
    }

    var host = url.hostname.toLowerCase();

    if (host === 'github.com' || host === 'www.github.com') {
      var parts = url.pathname.split('/').filter(Boolean);

      if (parts.length === 0) {
        return { type: 'github_profile', submittedUrl: url.href, hostname: host };
      }
      if (GH_RESERVED.indexOf(parts[0].toLowerCase()) !== -1) {
        return { type: 'github_profile', submittedUrl: url.href, hostname: host };
      }
      if (parts.length >= 2) {
        var owner = parts[0];
        var repo = parts[1].replace(/\.git$/i, '');
        if (GH_OWNER_RE.test(owner) && GH_REPO_RE.test(repo)) {
          return {
            type: 'github_repo',
            owner: owner,
            repo: repo,
            repoUrl: 'https://github.com/' + owner + '/' + repo,
            submittedUrl: url.href
          };
        }
        return { type: 'invalid' };
      }
      return { type: 'github_profile', submittedUrl: url.href, hostname: host };
    }

    return { type: 'website', hostname: host, submittedUrl: url.href };
  }

  var CACHE_PREFIX = 'sn.cache.';

  function cacheGet(key) {
    try {
      var raw = sessionStorage.getItem(CACHE_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function cacheSet(key, value) {
    try { sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value)); }
    catch (e) { /* best-effort */ }
  }

  var API_BASE = 'https://api.github.com';

  function ghFetch(path) {
    return fetch(API_BASE + path, {
      headers: { 'Accept': 'application/vnd.github+json' }
    }).then(function (res) {
      if (res.status === 404) throw new ResearchError('not_found', MESSAGES.not_found);
      if (res.status === 403 || res.status === 429) {
        var remaining = res.headers.get('X-RateLimit-Remaining');
        if (remaining === '0' || res.status === 429) {
          throw new ResearchError('rate_limited', MESSAGES.rate_limited);
        }
        throw new ResearchError('api_error', MESSAGES.api_error);
      }
      if (!res.ok) throw new ResearchError('api_error', MESSAGES.api_error);
      return res.json().catch(function () {
        throw new ResearchError('api_error', MESSAGES.api_error);
      });
    }, function () {
      throw new ResearchError('network', MESSAGES.network);
    });
  }

  function fetchGithubResearch(detection) {
    var cacheKey = 'github:' + (detection.owner + '/' + detection.repo).toLowerCase();
    var cached = cacheGet(cacheKey);
    if (cached) return Promise.resolve({ research: cached, fromCache: true });

    var repoPath = '/repos/' + encodeURIComponent(detection.owner) + '/' + encodeURIComponent(detection.repo);

    return ghFetch(repoPath).then(function (repo) {
      return ghFetch(repoPath + '/releases/latest').then(function (rel) {
        return { detection: detection, repo: repo, latestRelease: rel, retrievedAt: new Date().toISOString() };
      }, function () {
        return { detection: detection, repo: repo, latestRelease: null, retrievedAt: new Date().toISOString() };
      });
    }).then(function (research) {
      cacheSet(cacheKey, research);
      return { research: research, fromCache: false };
    });
  }

  window.Sources = {
    ResearchError: ResearchError,
    MESSAGES: MESSAGES,
    detectSource: detectSource,
    fetchGithubResearch: fetchGithubResearch
  };

})();
