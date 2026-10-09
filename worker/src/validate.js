// Pure destination validation. No Worker APIs — unit-testable in Node.
// WHATWG URL parsing normalizes exotic IPv4 forms ("2130706433", "0x7f000001",
// "127.1") into dotted quads BEFORE we inspect, so checks run post-normalization.

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'broadcasthost', '0'
]);

const BLOCKED_SUFFIXES = [
  '.localhost', '.local', '.internal', '.lan', '.home',
  '.corp', '.localdomain', '.test', '.invalid', '.example'
];

function bad(code, message) { return { ok: false, code, message }; }

export function normalizeHostname(raw) {
  let h = String(raw || '').trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h;
}

export function parseIPv4(host) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  const parts = host.split('.').map(Number);
  return parts.some(p => p > 255) ? null : parts;
}

const IPV4_BLOCKED = [
  [0, 0, 0, 0, 8],        // current network
  [10, 0, 0, 0, 8],       // private
  [100, 64, 0, 0, 10],    // CGNAT
  [127, 0, 0, 0, 8],      // loopback
  [169, 254, 0, 0, 16],   // link-local
  [172, 16, 0, 0, 12],    // private
  [192, 0, 0, 0, 24],     // IETF protocol assignments
  [192, 0, 2, 0, 24],     // TEST-NET-1
  [192, 168, 0, 0, 16],   // private
  [198, 18, 0, 0, 15],    // benchmarking
  [198, 51, 100, 0, 24],  // TEST-NET-2
  [203, 0, 113, 0, 24],   // TEST-NET-3
  [224, 0, 0, 0, 4],      // multicast
  [240, 0, 0, 0, 4]       // reserved / broadcast
];

function inCidrV4(ip, [a, b, c, d, prefix]) {
  const ipN = ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) >>> 0;
  const base = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipN & mask) === (base & mask);
}

export function isBlockedIPv4(host) {
  const ip = parseIPv4(host);
  return !!ip && IPV4_BLOCKED.some(r => inCidrV4(ip, r));
}

export function expandIPv6(host) {
  let s = host.toLowerCase();
  const v4tail = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4tail) {
    const v4 = parseIPv4(v4tail[2]);
    if (!v4) return null;
    s = v4tail[1] + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  if (s.includes('::')) {
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    s = [...left, ...Array(missing).fill('0'), ...right].join(':');
  }
  const parts = s.split(':');
  if (parts.length !== 8) return null;
  const nums = parts.map(p => parseInt(p || '0', 16));
  return nums.some(n => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : nums;
}

export function isBlockedIPv6(host) {
  const h = expandIPv6(host);
  if (!h) return false;
  if (h.slice(0, 5).every(n => n === 0) && h[5] === 0xffff) {
    // IPv4-mapped ::ffff:a.b.c.d — IPv4 rules apply to the embedded address
    return IPV4_BLOCKED.some(r => inCidrV4([h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255], r));
  }
  if (h.every(n => n === 0)) return true;                           // :: unspecified
  if (h.slice(0, 7).every(n => n === 0) && h[7] === 1) return true; // ::1 loopback
  if ((h[0] & 0xffc0) === 0xfe80) return true;                      // fe80::/10 link-local
  if ((h[0] & 0xfe00) === 0xfc00) return true;                      // fc00::/7 unique local
  if ((h[0] & 0xff00) === 0xff00) return true;                      // ff00::/8 multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true;              // documentation
  if (h[0] === 0x2001 && h[1] === 0x0000) return true;              // Teredo
  if (h[0] === 0x0064 && h[1] === 0xff9b) return true;              // NAT64 WKP
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true; // discard
  return false;
}

export function isBlockedIP(host) {
  const h = normalizeHostname(host);
  if (h.includes(':')) return isBlockedIPv6(h);
  if (parseIPv4(h)) return isBlockedIPv4(h);
  return false;
}

// Strict HTTPS-first target validation.
export function validateTarget(urlString) {
  if (typeof urlString !== 'string' || !urlString || urlString.length > 2048) {
    return bad('INVALID_URL', 'The URL is missing or too long.');
  }
  let u;
  try { u = new URL(urlString); } catch { return bad('INVALID_URL', 'The URL could not be parsed.'); }
  if (u.protocol !== 'https:') return bad('UNSUPPORTED_SCHEME', 'Only https:// URLs are accepted.');
  if (u.username || u.password) return bad('CREDENTIALS_REJECTED', 'URLs with embedded credentials are not allowed.');
  if (u.port && u.port !== '443') return bad('UNSUPPORTED_PORT', 'Only the default HTTPS port (443) is allowed.');
  const host = normalizeHostname(u.hostname);
  if (!host) return bad('INVALID_URL', 'The URL has no hostname.');
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some(s => host.endsWith(s))) {
    return bad('BLOCKED_DESTINATION', 'This hostname is not a public website address.');
  }
  if (!host.includes('.') && !host.includes(':')) {
    return bad('BLOCKED_DESTINATION', 'Single-label hostnames are not public website addresses.');
  }
  if (isBlockedIP(host)) {
    return bad('PRIVATE_DESTINATION', 'This address is in a private, loopback, or reserved range.');
  }
  return { ok: true, url: u.toString(), host };
                          }
