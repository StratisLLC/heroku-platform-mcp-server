import { describe, expect, it } from 'vitest';
import { html, layout, raw, escapeHtml } from '../src/views/layout.js';
import { renderAccessDenied, renderLanding, renderMe, renderAudit } from '../src/views/pages.js';

const baseUser = {
  id: 'u1',
  herokuId: 'h1',
  email: 'alice@example.com',
  defaultTeam: 'eng',
  signedInAt: new Date('2026-05-22T10:00:00Z'),
  lastSeenAt: new Date('2026-05-22T11:00:00Z'),
};

describe('html template helper', () => {
  it('escapes interpolated strings by default', () => {
    const out = html`<p>${'<script>alert(1)</script>'}</p>`.value;
    expect(out).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });
  it('honors raw() to inject HTML verbatim', () => {
    const out = html`<div>${raw('<b>x</b>')}</div>`.value;
    expect(out).toBe('<div><b>x</b></div>');
  });
  it('renders arrays element by element', () => {
    const items = ['a', 'b'].map((s) => html`<li>${s}</li>`);
    const out = html`<ul>
      ${items}
    </ul>`.value;
    // Trim whitespace prettier inserts between the template literals so this
    // asserts the structural shape rather than source-file formatting.
    expect(out.replace(/\s+/g, '')).toBe('<ul><li>a</li><li>b</li></ul>');
  });
  it('drops null / undefined / false', () => {
    const out = html`<p>${null}${undefined}${false}x</p>`.value;
    expect(out).toBe('<p>x</p>');
  });
});

describe('escapeHtml', () => {
  it('escapes ampersand, angle brackets, quotes', () => {
    expect(escapeHtml(`A & B < C > "d" 'e'`)).toBe(
      'A &amp; B &lt; C &gt; &quot;d&quot; &#39;e&#39;',
    );
  });
});

describe('layout', () => {
  it('wraps body in chrome and references the title', () => {
    const out = layout({ title: 'Hello', signedIn: false, admin: false }, html`<p>hi</p>`);
    expect(out).toContain('<title>Hello — Heroku Platform MCP</title>');
    expect(out).toContain('<p>hi</p>');
    expect(out).toContain('Sign in');
  });
  it('marks the active nav link', () => {
    const out = layout({ title: '/me', signedIn: true, admin: false, currentPath: '/me' }, html``);
    expect(out).toContain('href="/me" class="active"');
  });
});

describe('renderLanding', () => {
  it('renders the rebranded hero and sign-in CTA when signed out', () => {
    const out = renderLanding({ signedIn: false, admin: false, currentPath: '/' });
    // New utility classes from the rebrand are present on the landing page.
    expect(out).toContain('class="hero"');
    expect(out).toContain('class="eyebrow"');
    expect(out).toContain('class="platform-tag"');
    expect(out).toContain('section-sub');
    expect(out).toContain('Tagged under Headless 360');
    // Signed-out CTA.
    expect(out).toContain('Sign in with Heroku');
    expect(out).toContain('href="/sign-in"');
  });
  it('shows the account CTA and email when signed in', () => {
    const out = renderLanding(
      { signedIn: true, admin: false, currentPath: '/' },
      'alice@example.com',
    );
    expect(out).toContain('alice@example.com');
    expect(out).toContain('href="/me"');
    expect(out).not.toContain('href="/sign-in"');
  });
});

describe('renderAccessDenied', () => {
  it('includes the admin contact and the masked allowlist', () => {
    const html = renderAccessDenied(
      { signedIn: false, admin: false, currentPath: '/oauth/callback' },
      {
        email: 'eve@evil.com',
        herokuId: 'eve-id',
        teams: ['random'],
        reason: 'your email is not on the allowlist',
        allowedEmailsMasked: ['a***@example.com'],
        allowedTeams: ['eng'],
        adminContact: 'admin@example.com',
      },
    );
    expect(html).toContain('Access denied');
    expect(html).toContain('a***@example.com');
    expect(html).toContain('eng');
    expect(html).toContain('admin@example.com');
    expect(html).toContain('not on the allowlist');
  });
});

describe('renderMe', () => {
  it('renders the new-token block when newToken is provided', () => {
    const out = renderMe(
      { signedIn: true, admin: false, currentPath: '/me' },
      {
        user: baseUser,
        publicUrl: 'https://x.example.com',
        newToken: 'hmcp_abc',
        tokens: [],
      },
    );
    expect(out).toContain('hmcp_abc');
    expect(out).toContain('Claude Desktop config snippet');
    expect(out).toContain('https://x.example.com/mcp');
  });
  it('omits the new-token block when not provided', () => {
    const out = renderMe(
      { signedIn: true, admin: false, currentPath: '/me' },
      { user: baseUser, publicUrl: 'https://x', tokens: [] },
    );
    expect(out).not.toContain('Claude Desktop config snippet');
    expect(out).toContain('No active tokens');
  });
});

describe('renderAudit', () => {
  it('renders empty-state and pagination controls', () => {
    const out = renderAudit(
      { signedIn: true, admin: false, currentPath: '/audit' },
      {
        rows: [],
        total: 0,
        page: 1,
        perPage: 50,
        filters: {},
        exportHref: '/audit/export',
        selfPruneHref: '/audit/prune',
        baseHref: '/audit',
      },
    );
    expect(out).toContain('No entries match');
    expect(out).toContain('Export CSV');
    expect(out).toContain('Filter');
  });
});
