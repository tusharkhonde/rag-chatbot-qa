import { createHash } from 'node:crypto';
import type { Scope } from './tokens.js';

/**
 * Server-rendered pages for the authorization endpoint: sign-in, consent and errors.
 *
 * No JavaScript at all, so the Content-Security-Policy can be `default-src 'none'`. The one inline
 * stylesheet is allowed by its hash, not by 'unsafe-inline'. Everything interpolated is escaped.
 * `form-action` lists the client's redirect origin because browsers apply it to the redirect that
 * follows a form submission, and the consent form's response is a redirect to the client.
 */

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--panel:#fff;--text:#1c2330;--muted:#667085;--border:#e3e6eb;--accent:#2f5bd3;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--panel:#1a1f26;--text:#e6e9ee;--muted:#98a2b3;--border:#2b323c;--accent:#6d8ff0;--err:#f97066}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:16px}
main{width:100%;max-width:400px;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:28px}
h1{font-size:1.25rem;margin:0 0 4px}p{margin:8px 0}.muted{color:var(--muted);font-size:.9em}
label{display:block;margin:14px 0 4px;font-weight:500}input{width:100%;padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:transparent;color:inherit;font:inherit}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:10px 14px;border-radius:8px;font:inherit;font-weight:600;cursor:pointer;border:1px solid var(--border);background:transparent;color:inherit}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}ul{padding-left:20px;margin:8px 0}.error{color:var(--err);margin-top:12px}
code{font-size:.9em}`;

const STYLE_HASH = `'sha256-${createHash('sha256').update(STYLE).digest('base64')}'`;

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Security headers for every authorization page. */
export function pageHeaders(formTargets: string[] = []): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': [
      "default-src 'none'",
      `style-src ${STYLE_HASH}`,
      `form-action 'self' ${formTargets.join(' ')}`.trim(),
      "frame-ancestors 'none'", // clickjacking: the consent button must never be framed
      "base-uri 'none'",
    ].join('; '),
    'x-frame-options': 'DENY',
    'cache-control': 'no-store', // pages carry one-time CSRF tokens
    // Never send the URL (state, code_challenge) to other sites. Not 'no-referrer': under it Chrome
    // sends `Origin: null` on our own form posts, which defeats the same-origin check on them.
    'referrer-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
  };
}

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

const SCOPE_TEXT: Record<Scope, string> = {
  query: 'Search your organization’s document collections and ask questions about them',
  'documents:write': 'Create collections and upload or delete documents',
};

export function loginPage(opts: { requestId: string; csrf: string; clientName: string; email?: string; error?: string }): string {
  return layout(
    'Sign in',
    `<h1>Sign in</h1>
<p class="muted"><strong>${escapeHtml(opts.clientName)}</strong> wants to access the document service on your behalf.
Sign in with your web app account to continue.</p>
<form method="post" action="/oauth/authorize/login">
<input type="hidden" name="request_id" value="${escapeHtml(opts.requestId)}">
<input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(opts.email ?? '')}">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
${opts.error ? `<p class="error" role="alert">${escapeHtml(opts.error)}</p>` : ''}
<div class="row"><button class="primary" type="submit">Sign in</button></div>
</form>`,
  );
}

export function consentPage(opts: {
  requestId: string;
  csrf: string;
  clientName: string;
  userEmail: string;
  scopes: Scope[];
  resource: string;
  redirectHost: string;
}): string {
  return layout(
    'Authorize access',
    `<h1>Authorize ${escapeHtml(opts.clientName)}?</h1>
<p class="muted">Signed in as ${escapeHtml(opts.userEmail)}</p>
<p>It will be able to:</p>
<ul>${opts.scopes.map((s) => `<li>${escapeHtml(SCOPE_TEXT[s])}</li>`).join('')}</ul>
<p class="muted">Access goes to <code>${escapeHtml(opts.resource)}</code>, and you'll be sent back to
<code>${escapeHtml(opts.redirectHost)}</code>. Access lasts until the application signs out or 30 days pass.</p>
<form method="post" action="/oauth/authorize/decision">
<input type="hidden" name="request_id" value="${escapeHtml(opts.requestId)}">
<input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}">
<div class="row"><button type="submit" name="decision" value="deny">Deny</button>
<button class="primary" type="submit" name="decision" value="allow">Allow</button></div>
</form>`,
  );
}

export function errorPage(message: string): string {
  return layout(
    'Authorization error',
    `<h1>Can't continue</h1><p class="error">${escapeHtml(message)}</p>
<p class="muted">Return to the application and start again.</p>`,
  );
}
