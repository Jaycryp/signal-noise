/* ============================================================
   Signal / Noise — sources.js
   Stage 6: source detection + source adapters.
   GitHub is the ONLY live external source in this stage.
   Future adapters (docs, explorers) plug in here later.
   ============================================================ */

(function () {
  'use strict';

  /* ---------- Error type: users never see raw API errors ---------- */

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

  /* ---------- URL detection layer ---------- */

  var GH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  var GH_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

  // github.com/<these> are site pages, never user repositories
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
      // Single path segment = profile page, not a repository
      return { type: 'github_profile', submittedUrl: url.href, hostname: host };
    }

    return { type: 'website', hostname: host, submittedUrl: url.href };
  }

  /* ---------- Session cache (best-effort, current tab only) ---------- */

  var CACHE_PREFIX = 'sn.cache.';

  function cacheGet(key) {
    try {
      var raw = sessionStorage.getItem(CACHE_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function cacheSet(key, value) {
    try { sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value)); }
    catch (e) { /* caching is best-effort */ }
  }

  /* ---------- GitHub adapter ---------- */

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

  function fmtDate(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function buildGithubResearch(detection, repo, latestRelease) {
    var repoUrl = repo.html_url || detection.repoUrl;
    var retrievedAt = new Date().toISOString();

    var sources = [{
      id: 'src-repo',
      name: 'GitHub - ' + (repo.full_name || detection.owner + '/' + detection.repo),
      type: 'Code repository',
      url: repoUrl
    }];

    /* SIGNAL: observed information only — every item cites the repo source */
    var signal = [];
    function addSignal(id, title, description) {
      signal.push({ id: id, title: title, description: description, sourceId: 'src-repo' });
    }

    addSignal('sig-public', 'Public repository',
      'The submitted GitHub repository is publicly accessible.');

    var pushed = fmtDate(repo.pushed_at);
    if (pushed) {
      addSignal('sig-activity', 'Repository activity',
        'The repository reports a last-updated timestamp of ' + pushed + '.');
    }

    var created = fmtDate(repo.created_at);
    if (created) {
      addSignal('sig-created', 'Repository age',
        'The repository was created on ' + created + '.');
    }

    if (typeof repo.stargazers_count === 'number' && typeof repo.forks_count === 'number') {
      addSignal('sig-interest', 'Community interest',
        'The repository reports ' + repo.stargazers_count.toLocaleString('en-GB') +
        ' stars and ' + repo.forks_count.toLocaleString('en-GB') + ' forks on GitHub.');
    }

    if (repo.language) {
      addSignal('sig-language', 'Primary language',
        "GitHub reports the repository's primary language as " + repo.language + '.');
    }

    if (repo.license && repo.license.name) {
      addSignal('sig-license', 'License declared',
        'The repository declares a "' + repo.license.name + '" license.');
    }

    if (latestRelease && latestRelease.tag_name) {
      var relDate = fmtDate(latestRelease.published_at);
      addSignal('sig-release', 'Latest release',
        "The repository's latest release is " + latestRelease.tag_name +
        (relDate ? ', published ' + relDate + '.' : '.'));
    }

    /* NOISE: missing information is NOT noise. Nothing unsupported was claimed. */
    var noise = [];

    /* UNKNOWN: honestly labelled as not established */
    var unknown = [];

    if (!repo.license) {
      unknown.push({
        id: 'unk-license', title: 'License',
        description: 'No license was detected in the repository metadata.',
        sourceId: null
      });
    }

    unknown.push(
      { id: 'unk-team', title: 'Team information',
        description: 'No team information has been established by the current data sources.', sourceId: null },
      { id: 'unk-funding', title: 'Funding & backers',
        description: 'No funding or investor information has been established by the current data sources.', sourceId: null },
      { id: 'unk-onchain', title: 'Token & on-chain activity',
        description: 'No on-chain data sources are connected yet.', sourceId: null },
      { id: 'unk-security', title: 'Security posture',
        description: 'No security audit information has been established by the current data sources.', sourceId: null }
    );

    /* Metadata: only fields actually returned by the API */
    var meta = [];
    function addMeta(label, value) {
      if (value !== null && value !== undefined && value !== '') {
        meta.push({ label: label, value: String(value) });
      }
    }
    addMeta('Repository', repo.full_name || (detection.owner + '/' + detection.repo));
    addMeta('Owner', repo.owner && repo.owner.login ? repo.owner.login : detection.owner);
    addMeta('Description', repo.description || null);
    addMeta('Created', created);
    addMeta('Last updated', pushed);
    addMeta('Primary language', repo.language || null);
    addMeta('Stars', typeof repo.stargazers_count === 'number' ? repo.stargazers_count.toLocaleString('en-GB') : null);
    addMeta('Forks', typeof repo.forks_count === 'number' ? repo.forks_count.toLocaleString('en-GB') : null);
    addMeta('Open issues', typeof repo.open_issues_count === 'number' ? repo.open_issues_count.toLocaleString('en-GB') : null);
    addMeta('License', repo.license && repo.license.name ? repo.license.name : null);
    addMeta('Default branch', repo.default_branch || null);
    addMeta('Latest release', latestRelease && latestRelease.tag_name ? latestRelease.tag_name : null);

    return {
      kind: 'github',
      project: {
        name: repo.full_name || (detection.owner + '/' + detection.repo),
        url: repoUrl,
        hostname: 'github.com',
        sourceType: 'Code repository'
      },
      submittedUrl: detection.submittedUrl,
      retrievedAt: retrievedAt,
      signal: signal,
      noise: noise,
      unknown: unknown,
      sources: sources,
      meta: meta,
      provenance: {
        adapter: 'github',
        apiUrl: API_BASE + '/repos/' + detection.owner + '/' + detection.repo,
        retrievedAt: retrievedAt
      }
    };
  }

  function fetchGithubResearch(detection) {
    var cacheKey = 'github:' + (detection.owner + '/' + detection.repo).toLowerCase();
    var cached = cacheGet(cacheKey);
    if (cached) return Promise.resolve({ research: cached, fromCache: true });

    var repoPath = '/repos/' + encodeURIComponent(detection.owner) + '/' + encodeURIComponent(detection.repo);

    return ghFetch(repoPath).then(function (repo) {
      // Latest release is optional; any failure there just means "no release shown".
      return ghFetch(repoPath + '/releases/latest').then(function (rel) {
        return buildGithubResearch(detection, repo, rel);
      }, function () {
        return buildGithubResearch(detection, repo, null);
      });
    }).then(function (research) {
      cacheSet(cacheKey, research);
      return { research: research, fromCache: false };
    });
  }

  /* ---------- Basic record: non-GitHub URLs. No scraping, no pretending. ---------- */

  function buildBasicResearch(detection) {
    var retrievedAt = new Date().toISOString();
    var host = detection.hostname || 'submitted URL';
    var isGhPage = detection.type === 'github_profile';

    var coverageText = isGhPage
      ? 'This URL looks like a GitHub profile or GitHub page, not a repository. Submit a repository URL such as https://github.com/owner/repository to retrieve repository data.'
      : 'Automated source discovery for this URL is not available yet. GitHub repositories are the only live source supported in this version.';

    return {
      kind: 'basic',
      project: {
        name: host,
        url: detection.submittedUrl,
        hostname: host,
        sourceType: isGhPage ? 'GitHub page' : 'Project website'
      },
      submittedUrl: detection.submittedUrl,
      retrievedAt: retrievedAt,
      signal: [{
        id: 'sig-record', title: 'Research record created',
        description: 'A research record was opened for ' + host + '. No external sources have been queried.',
        sourceId: 'src-site'
      }],
      noise: [],
      unknown: [
        { id: 'unk-coverage', title: 'Source coverage', description: coverageText, sourceId: null },
        { id: 'unk-team', title: 'Team information',
          description: 'No team information has been established by the current data sources.', sourceId: null },
        { id: 'unk-funding', title: 'Funding & backers',
          description: 'No funding or investor information has been established by the current data sources.', sourceId: null },
        { id: 'unk-onchain', title: 'Token & on-chain activity',
          description: 'No on-chain data sources are connected yet.', sourceId: null },
        { id: 'unk-security', title: 'Security posture',
          description: 'No security audit information has been established by the current data sources.', sourceId: null }
      ],
      sources: [{ id: 'src-site', name: host, type: isGhPage ? 'GitHub page' : 'Project website', url: detection.submittedUrl }],
      meta: [],
      provenance: { adapter: 'basic', retrievedAt: retrievedAt }
    };
  }

  /* ---------- Public API ---------- */

  window.Sources = {
    ResearchError: ResearchError,
    MESSAGES: MESSAGES,
    detectSource: detectSource,
    fetchGithubResearch: fetchGithubResearch,
    buildBasicResearch: buildBasicResearch
  };

})();
