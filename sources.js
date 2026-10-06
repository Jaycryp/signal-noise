/* Signal / Noise — Source adapters (Stage 6A: deepened GitHub research)
   Detects project URL types and retrieves public repository evidence from
   the GitHub API. Observation only — no interpretation, no scores. */

const SN_SOURCES = (() => {

  const GITHUB_HOSTS = ["github.com", "www.github.com"];

  function normalizeUrl(raw) {
    const trimmed = raw.trim();
    if (!trimmed) throw new Error("Please enter a project URL.");
    const withProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
      ? trimmed : "https://" + trimmed;
    let parsed;
    try { parsed = new URL(withProtocol); }
    catch { throw new Error("That doesn't look like a valid URL. Check it and try again."); }
    if (!/^https?:$/i.test(parsed.protocol))
      throw new Error("Only web (http/https) URLs are supported right now.");
    return parsed.toString();
  }

  function detect(normalizedUrl) {
    const parsed = new URL(normalizedUrl);
    const host = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (GITHUB_HOSTS.includes(host) && segments.length >= 2) {
      const owner = decodeURIComponent(segments[0]);
      const repo = decodeURIComponent(segments[1].replace(/\.git$/i, ""));
      if (owner && repo) return { type: "github-repo", owner, repo };
    }
    return { type: "generic" };
  }

  /* ------------------------- GitHub adapter ------------------------- */

  async function ghFetch(url) {
    let response;
    try {
      response = await fetch(url, {
        headers: { "Accept": "application/vnd.github+json" }
      });
    } catch {
      throw new Error("Network error while contacting GitHub. Check your connection and try again.");
    }
    if (response.status === 404)
      throw new Error("GitHub couldn't find that repository. Check the owner and repository name.");
    if (response.status === 403) {
      const remaining = response.headers.get("X-RateLimit-Remaining");
      const isRateLimit = remaining === "0" ||
        (await response.clone().text()).toLowerCase().includes("rate limit");
      if (isRateLimit)
        throw new Error("GitHub's public request limit has been reached for this connection. Try again in about an hour.");
      throw new Error("GitHub refused this request (HTTP 403). Try again later.");
    }
    if (!response.ok)
      throw new Error("GitHub returned an unexpected response (HTTP " + response.status + "). Try again later.");
    return response;
  }

  /* Endpoints that may legitimately be missing/empty (404 = absent).
     Null is returned and rendered as "Not available from GitHub." */
  async function ghOptional(url) {
    let response;
    try {
      response = await fetch(url, {
        headers: { "Accept": "application/vnd.github+json" }
      });
    } catch { return null; }
    if (!response.ok) return null;
    try { return await response.json(); } catch { return null; }
  }

  function formatDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  }

  function formatNumber(n) {
    return (typeof n === "number") ? n.toLocaleString("en-US") : null;
  }

  /* Decode a base64 README body (handles multi-line base64 + UTF-8). */
  function decodeBase64Utf8(b64) {
    const binary = atob(String(b64).replace(/\n/g, ""));
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  }

  /* Reduce a README to a short readable excerpt — plain observation. */
  function excerptReadme(text) {
    const lines = String(text).split("\n");
    const kept = [];
    for (let raw of lines) {
      const line = raw.trim();
      if (!line) { if (kept.length) kept.push(""); continue; }
      if (/^!\[|\[!\[/.test(line)) continue;                       // badge images
      if (/^<[^>]+>$/.test(line)) continue;                        // raw html tags
      if (/^\[(.*?)\]\((.*?)\)$/.test(line)) continue;             // bare link lines
      let clean = line
        .replace(/^#{1,6}\s*/, "")
        .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")
        .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, "$1")
        .replace(/^>\s?/, "");
      kept.push(clean);
      if (kept.filter(Boolean).length >= 12) break;
    }
    const excerpt = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return excerpt.length > 900 ? excerpt.slice(0, 900).trimEnd() + "…" : excerpt;
  }

  function daysSince(iso) {
    if (!iso) return null;
    const ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms) || ms < 0) return null;
    const days = Math.floor(ms / 86400000);
    return days;
  }

  function daysLabel(days) {
    if (days === null) return null;
    if (days === 0) return "today";
    if (days === 1) return "1 day ago";
    if (days < 30) return days + " days ago";
    const months = Math.round(days / 30.44);
    if (months < 24) return months + (months === 1 ? " month ago" : " months ago");
    const years = Math.round(days / 365.25 * 10) / 10;
    return years + (years === 1 ? " year ago" : " years ago");
  }

  function buildGithubReport(repo, license, readmeText, contributorsCount,
                             commitsCount, commitsLink, releasesCount, latestRelease,
                             normalizedUrl) {
    const project = repo.full_name || (repo.owner && repo.owner.login + "/" + repo.name);
    const repoUrl = repo.html_url || normalizedUrl;
    const ghSource = (label, extra) => Object.assign({
      name: "GitHub", label: label || "GitHub repository",
      url: repoUrl, checked: new Date().toISOString(), detail: ""
    }, extra || {});
    const na = "Not available from GitHub";

    const findings = [];
    const add = (bucket, title, body, sources) =>
      findings.push({ bucket, title, body, sources: sources || [] });

    /* ---- Signal: observations directly reported by GitHub ---- */
    add("signal", "Public GitHub repository",
      "GitHub reports a " + (repo.visibility || "public") + " repository owned by " +
      (repo.owner && repo.owner.login ? repo.owner.login : "unknown owner") +
      ", created " + (formatDate(repo.created_at) || "unknown date") + ".",
      [ghSource()]);

    if (repo.description) {
      add("signal", "Repository description",
        "GitHub description: “" + repo.description + "”",
        [ghSource("Repository metadata")]);
    }

    add("signal", "Repository age",
      "Created " + (formatDate(repo.created_at) || "unknown date") +
      " — " + (daysLabel(daysSince(repo.created_at)) || "age unknown") + ".",
      [ghSource("Repository metadata")]);

    const pushedDays = daysSince(repo.pushed_at);
    add("signal", "Last repository update",
      "Last push reported " + (formatDate(repo.pushed_at) || "unknown date") +
      (pushedDays !== null ? " (" + daysLabel(pushedDays) + ")" : "") + ".",
      [ghSource("Repository metadata")]);

    const stars = formatNumber(repo.stargazers_count);
    const forks = formatNumber(repo.forks_count);
    if (stars !== null || forks !== null) {
      add("signal", "Community interest",
        "GitHub reports " + (stars !== null ? stars + " stars" : "no star count") +
        " and " + (forks !== null ? forks + " forks" : "no fork count") + ".",
        [ghSource("Repository metadata")]);
    }

    if (repo.language) {
      add("signal", "Primary language",
        "Primary language: " + repo.language + ".",
        [ghSource("Repository metadata")]);
    }

    if (license && license.license && license.license.spdx_id && license.license.spdx_id !== "NOASSERTION") {
      add("signal", "License",
        "License: " + license.license.spdx_id +
        (license.license.name ? " — " + license.license.name : "") + ".",
        [ghSource("GitHub license endpoint", { url: repoUrl + "/blob/HEAD/LICENSE" })]);
    }

    if (contributorsCount !== null) {
      add("signal", "Contributors",
        "GitHub reports " + contributorsCount.toLocaleString("en-US") +
        " contributor" + (contributorsCount === 1 ? "" : "s") + ".",
        [ghSource("GitHub contributors endpoint", { url: repoUrl + "/graphs/contributors" })]);
    }

    if (commitsCount !== null) {
      add("signal", "Recent commit activity",
        commitsCount.toLocaleString("en-US") +
        " commit" + (commitsCount === 1 ? "" : "s") +
        " on the default branch in the last 30 days.",
        [ghSource("GitHub commits endpoint", { url: commitsLink })]);
    }

    if (releasesCount !== null && releasesCount > 0 && latestRelease) {
      add("signal", "Releases",
        releasesCount.toLocaleString("en-US") +
        " release" + (releasesCount === 1 ? "" : "s") + " published. Latest: " +
        (latestRelease.tag_name || latestRelease.name || "untagged") +
        (latestRelease.published_at ? " (" + formatDate(latestRelease.published_at) + ")" : "") + ".",
        [ghSource("GitHub releases endpoint", { url: latestRelease.html_url || (repoUrl + "/releases") })]);
    }

    if (readmeText !== null) {
      add("signal", "README available",
        "GitHub reports a README file for this repository. An excerpt is shown in the README section below.",
        [ghSource("GitHub README endpoint", { url: repoUrl + "#readme" })]);
    }

    /* ---- Unknown: what GitHub could not tell us ---- */
    const addUnknown = (title, body) =>
      add("unknown", title, body, []);

    if (!license || !license.license) {
      addUnknown("License", "No license information reported by GitHub.");
    }
    if (contributorsCount === null) {
      addUnknown("Contributors", "Contributor data was not returned by GitHub for this repository.");
    }
    if (commitsCount === null) {
      addUnknown("Recent commit activity", "Commit activity for the last 30 days was not returned by GitHub.");
    }
    if (releasesCount === null) {
      addUnknown("Releases", "Release information was not returned by GitHub.");
    } else if (releasesCount === 0) {
      addUnknown("Releases", "No public release found.");
    }
    if (readmeText === null) {
      addUnknown("README", "No README was reported by GitHub for this repository.");
    }
    addUnknown("Team information", "No team information has been established by the current data sources.");
    addUnknown("Funding and backers", "No funding or investor information has been established by the current data sources.");
    addUnknown("Token & on-chain activity", "No on-chain data sources are connected yet.");
    addUnknown("Security posture", "No security audit information has been established by the current data sources.");

    const dossier = {
      sourceLabel: "Live research · GitHub",
      description: repo.description || null,
      rows: [
        ["Owner", (repo.owner && repo.owner.login) || na],
        ["Visibility", repo.visibility || na],
        ["Created", formatDate(repo.created_at) || na],
        ["Last updated", formatDate(repo.updated_at) || na],
        ["Last push", formatDate(repo.pushed_at) || na],
        ["Default branch", repo.default_branch || na],
        ["Primary language", repo.language || na],
        ["License", (license && license.license && license.license.spdx_id && license.license.spdx_id !== "NOASSERTION")
          ? license.license.spdx_id : na],
        ["Stars", stars !== null ? stars : na],
        ["Forks", forks !== null ? forks : na],
        ["Open issues", formatNumber(repo.open_issues_count) !== null ? formatNumber(repo.open_issues_count) : na],
        ["Contributors", contributorsCount !== null ? contributorsCount.toLocaleString("en-US") : na],
        ["Commits · last 30 days", commitsCount !== null ? commitsCount.toLocaleString("en-US") : na],
        ["Releases", releasesCount !== null
          ? releasesCount.toLocaleString("en-US") +
            (latestRelease && latestRelease.tag_name ? " · latest " + latestRelease.tag_name : "")
          : na]
      ],
      readme: readmeText !== null ? {
        excerpt: excerptReadme(readmeText),
        url: repoUrl + "#readme"
      } : null
    };

    return {
      kind: "github",
      project, url: normalizedUrl,
      sourceLabel: "Live research · GitHub",
      checkedAt: new Date().toISOString(),
      findings, dossier
    };
  }

  async function researchGithubRepo(owner, repo, normalizedUrl) {
    const base = "https://api.github.com/repos/" +
      encodeURIComponent(owner) + "/" + encodeURIComponent(repo);

    /* Required metadata — errors here are user-facing. */
    const repoData = await (await ghFetch(base)).json();

    /* Optional endpoints — absence is data, not an error. */
    const perPage = n => "?per_page=" + n;

    const [licenseData, readmeData, contributors, commits, releases] = await Promise.all([
      ghOptional(base + "/license"),
      ghOptional(base + "/readme"),
      ghOptional(base + "/contributors" + perPage(100)),
            ghOptional(base + "/commits?since=" +
        new Date(Date.now() - 30 * 86400000).toISOString() + "&per_page=100"),
      ghOptional(base + "/releases" + perPage(10))
    ]);

    const contributorsCount = Array.isArray(contributors) ? contributors.length : null;
    const commitsCount = Array.isArray(commits) ? commits.length : null;
    const commitsLink = (repoData.html_url || normalizedUrl) + "/commits";
    const releasesCount = Array.isArray(releases) ? releases.length : null;
    const latestRelease = (Array.isArray(releases) && releases.length) ? releases[0] : null;

    let readmeText = null;
    if (readmeData && readmeData.content && readmeData.encoding === "base64") {
      try { readmeText = decodeBase64Utf8(readmeData.content); }
      catch { readmeText = null; }
    }

    return buildGithubReport(repoData, licenseData, readmeText, contributorsCount,
      commitsCount, commitsLink, releasesCount, latestRelease, normalizedUrl);
  }

  /* ------------------------- Generic fallback ------------------------- */

  function buildBasicRecord(normalizedUrl) {
    const parsed = new URL(normalizedUrl);
    const host = parsed.hostname;
    const isGithub = GITHUB_HOSTS.includes(host.toLowerCase());
    return {
      kind: "basic",
      project: host, url: normalizedUrl,
      sourceLabel: "Research record",
      checkedAt: new Date().toISOString(),
      findings: [
        { bucket: "signal", title: "Research record created",
          body: "A research record was opened for " + host + ".",
          sources: [{ name: host, label: "User-submitted URL",
                      url: normalizedUrl, checked: new Date().toISOString(),
                      detail: "The submitted URL was recorded. No external sources have been queried for this URL type." }] },
        { bucket: "unknown", title: "Source coverage",
          body: isGithub
            ? "This GitHub URL points to a profile or page, not a repository. Provide a repository URL (github.com/owner/repository) to retrieve public repository data."
            : "Automated source discovery for this URL is not available yet.",
          sources: [] },
        { bucket: "unknown", title: "Team information",
          body: "No team information has been established by the current data sources.", sources: [] },
        { bucket: "unknown", title: "Funding and backers",
          body: "No funding or investor information has been established by the current data sources.", sources: [] },
        { bucket: "unknown", title: "Token & on-chain activity",
          body: "No on-chain data sources are connected yet.", sources: [] },
        { bucket: "unknown", title: "Security posture",
          body: "No security audit information has been established by the current data sources.", sources: [] }
      ]
    };
  }

  /* ------------------------- Public API ------------------------- */

  async function research(rawUrl) {
    const normalized = normalizeUrl(rawUrl);
    const detected = detect(normalized);
    if (detected.type === "github-repo")
      return researchGithubRepo(detected.owner, detected.repo, normalized);
    return buildBasicRecord(normalized);
  }

  return { research };
})();
