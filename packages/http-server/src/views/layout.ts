/**
 * Tiny HTML layout helpers. No template engine — just tagged-template escaping
 * + a layout() that wraps a body string.
 *
 * The `html` tagged template auto-escapes interpolated values. Wrap a value in
 * `raw(...)` to insert pre-rendered HTML (e.g. a fragment you composed
 * elsewhere). All values are escaped by default — opt-in, not opt-out.
 */

import { STYLES } from './styles.js';

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(input: unknown): string {
  if (input === null || input === undefined) return '';
  // `String(x)` may fall through to `[object Object]` for plain objects, which
  // is fine for our diagnostic surfaces (we treat anything non-primitive as
  // already-rendered text the caller chose to interpolate).
  const s =
    typeof input === 'string'
      ? input
      : typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint'
        ? input.toString()
        : // eslint-disable-next-line @typescript-eslint/no-base-to-string
          String(input);
  return s.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c);
}

/** Mark a string as already-escaped raw HTML. */
export class SafeHtml {
  constructor(public readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function raw(s: string | SafeHtml): SafeHtml {
  return s instanceof SafeHtml ? s : new SafeHtml(s);
}

/** Tagged template that escapes interpolations and concatenates SafeHtml as
 *  raw. Returns a SafeHtml so nested `html` calls compose without double-
 *  escaping. */
export function html(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null | undefined | SafeHtml | (string | SafeHtml)[])[]
): SafeHtml {
  let out = '';
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i];
    if (i < values.length) {
      const v = values[i];
      if (v === null || v === undefined || v === false) continue;
      if (v instanceof SafeHtml) {
        out += v.value;
      } else if (Array.isArray(v)) {
        for (const item of v) {
          out += item instanceof SafeHtml ? item.value : escapeHtml(item);
        }
      } else {
        out += escapeHtml(v);
      }
    }
  }
  return new SafeHtml(out);
}

export interface LayoutOptions {
  title: string;
  /** True when a user is signed in — controls header nav. */
  signedIn: boolean;
  /** True iff the signed-in user is an admin. */
  admin: boolean;
  /** Path the user is on; used to mark the current nav link. */
  currentPath?: string;
  /** Optional banner above the main content. */
  banner?: SafeHtml;
}

export function layout(opts: LayoutOptions, body: SafeHtml): string {
  const navLinks = buildNav(opts);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.title)} — Heroku Platform MCP</title>
<style>${STYLES}</style>
</head>
<body>
<header class="site-header">
  <div class="header-inner">
    <a class="brand" href="/">Heroku Platform MCP</a>
    <nav class="site-nav">${navLinks}</nav>
  </div>
</header>
<main class="site-main">
${opts.banner ? opts.banner.value : ''}
${body.value}
</main>
<footer class="site-footer">
  <div class="footer-inner">
    <div class="footer-credit">
      Published by <strong>Stratis, LLC</strong> · Apache-2.0 License
    </div>
    <div class="footer-attribution">
      Salesforce and the Salesforce logo are trademarks of Salesforce, Inc. Heroku and the Heroku logo are trademarks of Salesforce, Inc. This is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Salesforce.
    </div>
  </div>
</footer>
${COPY_SCRIPT}
</body>
</html>`;
}

function buildNav(opts: LayoutOptions): string {
  if (!opts.signedIn) {
    return navLink('/sign-in', 'Sign in', opts.currentPath);
  }
  const links: string[] = [
    navLink('/me', 'My account', opts.currentPath),
    navLink('/audit', 'My audit log', opts.currentPath),
  ];
  if (opts.admin) {
    links.push(navLink('/admin/users', 'Users', opts.currentPath, '/admin'));
    links.push(navLink('/admin/audit', 'All audit', opts.currentPath));
    links.push(navLink('/admin/status', 'Status', opts.currentPath));
  }
  links.push(`<form class="inline" method="post" action="/sign-out">
    <button type="submit" class="btn btn-small">Sign out</button>
  </form>`);
  return links.join('');
}

function navLink(href: string, label: string, currentPath?: string, prefix?: string): string {
  const active =
    currentPath === href || (prefix !== undefined && currentPath?.startsWith(prefix) === true);
  const cls = active ? ' class="active"' : '';
  return `<a href="${escapeHtml(href)}"${cls}>${escapeHtml(label)}</a>`;
}

const COPY_SCRIPT = `<script>
document.addEventListener('click', function(e){
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (!t.classList.contains('copy')) return;
  const sel = t.getAttribute('data-target');
  if (!sel) return;
  const src = document.querySelector(sel);
  if (!src) return;
  const text = src.textContent || '';
  navigator.clipboard.writeText(text).then(function(){
    const original = t.textContent;
    t.textContent = 'Copied';
    setTimeout(function(){ t.textContent = original; }, 1500);
  });
});
</script>`;
