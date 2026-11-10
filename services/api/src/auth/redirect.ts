/**
 * Redirect URI matching for the authorization code flow.
 *
 * Exact string comparison against pre-registered URIs: prefix or pattern matching has been the
 * root of many real-world code-theft bugs (an attacker registers ".../callback/../evil" or a
 * subdomain). The one exception is RFC 8252 §7.3: a native app listening on a loopback IP
 * (127.0.0.1 or [::1]) gets an ephemeral port from the OS, so for loopback URIs the port may
 * differ. Scheme, host and path must still match exactly. "localhost" is deliberately not treated
 * as loopback: it can resolve to something else (RFC 8252 §8.3).
 */
const LOOPBACK = new Set(['127.0.0.1', '[::1]']);

export function matchRedirectUri(requested: string, registered: string[]): string | null {
  if (registered.includes(requested)) return requested;
  let url: URL;
  try {
    url = new URL(requested);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.hash) return null;
  for (const candidate of registered) {
    let reg: URL;
    try {
      reg = new URL(candidate);
    } catch {
      continue;
    }
    if (
      reg.protocol === url.protocol &&
      reg.hostname === url.hostname &&
      reg.pathname === url.pathname &&
      reg.search === url.search
    ) {
      return requested;
    }
  }
  return null;
}
