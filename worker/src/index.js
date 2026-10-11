// Signal / Noise — Stage 8 fetch worker.
// Fetches one publicly accessible homepage; returns cleaned text + metadata.
// No JavaScript execution (HTMLRewriter only). No DB, no auth, no AI.

import { validateTarget, normalizeHostname, isBlockedIP } from './validate.js';

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 10000;
const DOH_TIMEOUT_MS = 4000;
const MAX_BYTES = 1000000;       // 1 MB hard cap on downloaded HTML
const MAX_TEXT_CHARS = 120000;   // cap on extracted text returned
const MAX_LINKS = 150;
const ALLOWED_CONTENT = ['text/html', 'application/xhtml+xml'];
const USER_AGENT = 'SignalNoiseResearch/1.0 (claim-extraction research tool)';
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

const SKIP_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'iframe',
  'nav', 'footer', 'header', 'aside', 'form', 'select', 'button'];
const BLOCK_TAGS = ['p', 'div', 'section', 'article', 'li', 'ul', 'ol', 'main',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'blockquote'];

function fail(code, message, extra) {
  return { ok: false, error: Object.assign({ code, message }, extra || {}) };
}

function json(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }, corsHeaders)
  });
}

function corsFor(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!origin) return { allowed: true, headers: {} }; // non-browser client
  if (allowed.includes(origin)) {
    return { allowed: true, headers: { 'access-control-allow-origin': origin, 'vary': 'Origin' } };
  }
  return { allowed: false, headers: {} };
}

// Resolve via DNS-over-HTTPS and reject private/reserved answers.
// Fails CLOSED: if resolution cannot complete safely, the fetch is refused.
async function resolveAndCheck(host, cache) {
  if (cache.has(host)) return cache.get(host);
  let out = null;
  try {
    const ips = [];
    for (const type of ['A', 'AAAA']) {
      const r = await fetch(
        DOH_ENDPOINT + '?name=' + encodeURIComponent(host) + '&type=' + type,
        { headers: { 'accept': 'application/dns-json' }, signal: AbortSignal.timeout(DOH_TIMEOUT_MS) }
      );
      if (!r.ok) throw new Error('DoH HTTP ' + r.status);
      const j = await r.json();
      if (j.Status === 3) {
        out = { ok: false, code: 'DNS_FAILED', message: 'The domain name did not resolve.' };
        break;
      }
      (j.Answer || []).forEach(a => {
        if (a.type === 1 || a.type === 28) ips.push(normalizeHostname(a.data));
      });
    }
    if (!out) {
      if (!ips.length) {
        out = { ok: false, code: 'DNS_FAILED', message: 'No A/AAAA records found for this hostname.' };
      } else {
        const blocked = ips.find(isBlockedIP);
        out = blocked
          ? { ok: false, code: 'PRIVATE_DESTINATION', message: 'The hostname resolves to a private, loopback, or reserved address.' }
          : { ok: true };
      }
    }
  } catch (e) {
    out = { ok: false, code: 'DNS_FAILED', message: 'Name resolution could not be completed safely.' };
  }
  cache.set(host, out);
  return out;
}

async function readBodyWithCap(resp) {
  if (!resp.body) return { text: '', bytes: 0, truncated: false };
  const reader = resp.body.getReader();
  const chunks = [];
  let bytes = 0, truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { truncated = true; try { await reader.cancel(); } catch (e) {} break; }
      chunks.push(value);
    }
  } catch (e) { truncated = true; }
  const cap = Math.min(bytes, MAX_BYTES);
  const merged = new Uint8Array(cap);
  let off = 0;
  for (const c of chunks) {
    if (off >= cap) break;
    const slice = c.subarray(0, Math.min(c.byteLength, cap - off));
    merged.set(slice, off);
    off += slice.byteLength;
  }
  return { text: new TextDecoder().decode(merged), bytes, truncated };
}

async function parseHtml(html, baseUrl) {
  const state = {
    title: '', metas: { description: '', ogTitle: '', ogDescription: '' },
    parts: [], len: 0, truncated: false, depth: 0,
    links: [], linkSeen: new Set()
  };
  const pushText = s => {
    if (state.len >= MAX_TEXT_CHARS) { state.truncated = true; return; }
    state.parts.push(s); state.len += s.length;
  };

  await new HTMLRewriter()
    .on('title', { text(t) { if (state.title.length < 300) state.title += t.text; } })
    .on('meta', {
      element(el) {
        const name = (el.getAttribute('name') || '').toLowerCase();
        const prop = (el.getAttribute('property') || '').toLowerCase();
        const content = (el.getAttribute('content') || '').slice(0, 500);
        if (name === 'description' && !state.metas.description) state.metas.description = content;
        if (prop === 'og:title' && !state.metas.ogTitle) state.metas.ogTitle = content;
        if (prop === 'og:description' && !state.metas.ogDescription) state.metas.ogDescription = content;
      }
    })
    .on('a[href]', {
      element(el) {
        try {
          const href = new URL(el.getAttribute('href'), baseUrl).toString();
          if (!/^https:/.test(href) || state.linkSeen.has(href) || state.links.length >= MAX_LINKS) return;
          state.linkSeen.add(href);
          state.links.push({ href, text: '' });
        } catch (e) {}
      },
      text(t) { // fires only for text inside the matched <a>
        const l = state.links[state.links.length - 1];
        if (l && l.text.length < 120) l.text += t.text;
      }
    })
    .on(SKIP_TAGS.join(','), {
      element(el) { state.depth++; el.onEndTag(() => { state.depth--; }); }
    })
    .on('br', { element() { pushText('\n'); } })
    .on(BLOCK_TAGS.join(','), {
      element(el) { el.onEndTag(() => pushText('\n')); }
    })
    .on('body', {
      text(t) {
        if (state.depth > 0 || state.truncated) return;
        if (t.text && t.text.trim()) pushText(t.text);
      }
    })
    .transform(new Response(html))
    .text();

  const text = state.parts.join('')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_CHARS);

  return {
    title: state.title.replace(/\s+/g, ' ').trim().slice(0, 300),
    description: (state.metas.description || state.metas.ogDescription || '').replace(/\s+/g, ' ').trim(),
    text,
    textChars: text.length,
    textTruncated: state.truncated || state.len > MAX_TEXT_CHARS,
    links: state.links.map(l => ({
      href: l.href,
      text: l.text.replace(/\s+/g, ' ').trim().slice(0, 120)
    }))
  };
}

async function fetchSite(target) {
  let current = target;
  const dnsCache = new Map();
  let redirects = 0;

  for (let hop = 0; ; hop++) {
    const v = validateTarget(current);
    if (!v.ok) return { status: 403, body: fail(v.code, v.message) };

    const dns = await resolveAndCheck(v.host, dnsCache);
    if (!dns.ok) return { status: dns.code === 'DNS_FAILED' ? 502 : 403, body: fail(dns.code, dns.message) };

    let resp;
    try {
      resp = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': USER_AGENT, 'accept': ALLOWED_CONTENT.join(',') }
      });
    } catch (e) {
      const to = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return {
        status: to ? 504 : 502,
        body: fail(to ? 'TIMEOUT' : 'FETCH_FAILED',
          to ? 'The website did not respond within the time limit.' : 'The website could not be reached.')
      };
    }

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      try { if (resp.body) await resp.body.cancel(); } catch (e) {}
      if (!loc) return { status: 502, body: fail('HTTP_ERROR', 'Redirect without a Location header.', { upstreamStatus: resp.status }) };
      if (hop >= MAX_REDIRECTS) return { status: 502, body: fail('TOO_MANY_REDIRECTS', 'The site redirected too many times.') };
      current = new URL(loc, current).toString(); // fully re-validated next loop
      redirects++;
      continue;
    }

    if (!resp.ok) {
      try { if (resp.body) await resp.body.cancel(); } catch (e) {}
      return { status: 502, body: fail('HTTP_ERROR', 'The website returned HTTP ' + resp.status + '.', { upstreamStatus: resp.status }) };
    }

    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (!ALLOWED_CONTENT.some(t => ct.startsWith(t))) {
      try { if (resp.body) await resp.body.cancel(); } catch (e) {}
      return { status: 415, body: fail('UNSUPPORTED_CONTENT_TYPE', 'The response is not an HTML page (' + (ct.split(';')[0] || 'unknown') + ').') };
    }

    const read = await readBodyWithCap(resp);
    const parsed = await parseHtml(read.text, current);

    return {
      status: 200,
      body: Object.assign({
        ok: true,
        requestedUrl: target,
        finalUrl: current,
        httpStatus: resp.status,
        redirects,
        retrievedAt: new Date().toISOString(),
        contentType: ct,
        bytesRead: read.bytes,
        bodyTruncated: read.truncated
      }, parsed)
    };
  }
}

export default {
  async fetch(request, env) {
    const cors = corsFor(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: Object.assign({}, cors.headers, {
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400'
        })
      });
    }
    if (!cors.allowed) {
      return json(fail('ORIGIN_FORBIDDEN', 'This origin is not allowed to use the fetch service.'), 403, cors.headers);
    }
    if (request.method !== 'GET') {
      return json(fail('METHOD_NOT_ALLOWED', 'Use GET with a url query parameter.'), 405, cors.headers);
    }
    if (env.RATE_LIMITER) {
      try {
        const key = request.headers.get('Origin') || request.headers.get('CF-Connecting-IP') || 'anonymous';
        const { success } = await env.RATE_LIMITER.limit({ key });
        if (!success) return json(fail('RATE_LIMITED', 'Too many requests. Try again shortly.'), 429, cors.headers);
      } catch (e) { /* limiter binding unavailable — proceed rather than break the feature */ }
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');
    if (!target) return json(fail('INVALID_URL', 'Provide a url query parameter.'), 400, cors.headers);

    const result = await fetchSite(target);
    return json(result.body, result.status, cors.headers);
  }
};
