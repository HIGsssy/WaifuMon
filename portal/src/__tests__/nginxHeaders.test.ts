/**
 * The production Nginx header and diagnostics contract, asserted against the
 * config that actually ships.
 *
 * These are static assertions over `nginx.conf.template`, not a running server.
 * That is a real limit — nginx is not in this test environment — but the three
 * rules below are the ones that were actually broken in review, and each failed
 * silently: no error, no warning, just a response missing a header or carrying
 * two conflicting ones. A parse-level guard is what catches the reintroduction.
 *
 * The behaviour they stand in for was verified by hand against nginx:1.27-alpine
 * with the rendered template and a helmet-mimicking upstream.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PORTAL_DIR = path.resolve(__dirname, '..', '..');
const template = fs.readFileSync(path.join(PORTAL_DIR, 'nginx.conf.template'), 'utf8');
const snippet = fs.readFileSync(path.join(PORTAL_DIR, 'security-headers.conf'), 'utf8');

/** The four browser headers Nginx owns outright. */
const OWNED_HEADERS = [
  'X-Content-Type-Options',
  'X-Frame-Options',
  'Referrer-Policy',
  'Permissions-Policy',
];

/** The three of those that `@fastify/helmet` also sends on proxied responses. */
const HELMET_DUPLICATES = ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy'];

/**
 * Splits the server block into `location … { … }` bodies. Deliberately a small
 * brace matcher rather than a regex: location bodies nest, and a lazy regex
 * would stop at the first `}` and quietly assert nothing.
 */
function locations(config: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  // Comments first. The word "location" occurs in the explanatory prose above
  // several rules, and without this the opener below happily matches a
  // sentence and reports the following block under a garbage selector — a
  // silent mis-parse that makes assertions pass against nothing.
  const stripped = config.replace(/#[^\n]*/g, '');
  const opener = /location\s+([^{]+?)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(stripped))) {
    let depth = 1;
    let i = opener.lastIndex;
    while (i < stripped.length && depth > 0) {
      if (stripped[i] === '{') depth++;
      else if (stripped[i] === '}') depth--;
      i++;
    }
    out.push({ selector: match[1]!.trim(), body: stripped.slice(opener.lastIndex, i - 1) });
  }
  return out;
}

const blocks = locations(template);
/** Locations that emit a body a browser renders or reads. */
const contentBlocks = blocks.filter(
  (b) => b.body.includes('proxy_pass') || b.body.includes('try_files'),
);

describe('security headers are defined once and applied everywhere', () => {
  it('declares all four headers in the shared snippet', () => {
    for (const header of OWNED_HEADERS) {
      expect(snippet).toContain(`add_header ${header} `);
    }
  });

  it('sets no add_header at server level, where inheritance would be lost', () => {
    // nginx inherits `add_header` only into locations that declare none of
    // their own. Every content location below declares a Cache-Control or
    // includes the snippet, so a server-level set would reach almost nothing —
    // which is exactly how the SPA document ended up with no headers at all.
    const serverLevel = template.replace(/location\s+[^{]+?\s*\{[\s\S]*?\n {2}\}/g, '');
    expect(serverLevel).not.toMatch(/^\s*add_header/m);
  });

  it.each(contentBlocks.map((b) => [b.selector, b] as const))(
    'location %s includes the shared header snippet',
    (_selector, block) => {
      expect(block.body).toContain('include /etc/nginx/security-headers.conf;');
    },
  );

  it('never re-declares an owned header outside the snippet', () => {
    // A second `add_header X-Frame-Options` anywhere would stack rather than
    // replace — nginx appends, it does not overwrite.
    for (const header of OWNED_HEADERS) {
      expect(template).not.toContain(`add_header ${header}`);
    }
  });
});

describe('proxied responses carry exactly one copy of each header', () => {
  const proxied = blocks.filter((b) => b.body.includes('proxy_pass'));

  it('proxies the two endpoints it should, and no others', () => {
    expect(proxied.map((b) => b.selector).sort()).toEqual(['= /health', '^~ /api']);
  });

  it.each(proxied.map((b) => [b.selector, b] as const))(
    'location %s hides the upstream copies helmet sends',
    (_selector, block) => {
      // Without these, the browser receives both values and resolves the
      // conflict by its own rules: helmet's SAMEORIGIN against our DENY, and
      // its no-referrer against our strict-origin-when-cross-origin.
      for (const header of HELMET_DUPLICATES) {
        expect(block.body).toContain(`proxy_hide_header ${header};`);
      }
    },
  );
});

describe('the API documentation surface is not exposed at the public edge', () => {
  const openapi = blocks.find((b) => b.selector === '= /api/v1/openapi.json');
  const docs = blocks.find((b) => b.selector === '^~ /api/v1/docs');

  it('blocks both the spec and the Swagger UI subtree', () => {
    expect(openapi).toBeDefined();
    expect(docs).toBeDefined();
    for (const block of [openapi!, docs!]) {
      expect(block.body).toContain('return 404;');
      expect(block.body).not.toContain('proxy_pass');
    }
  });

  it('uses selectors that outrank the catch-all /api proxy', () => {
    // `location ^~ /api` suppresses regex-location evaluation for everything
    // beneath it, so a `~` rule here would never be consulted. These two win on
    // nginx's own precedence instead: an exact `=` beats every prefix, and
    // `^~ /api/v1/docs` is a longer prefix than `^~ /api`. Asserting the
    // selectors is asserting the reachability.
    expect(openapi!.selector.startsWith('= ')).toBe(true);
    expect(docs!.selector.startsWith('^~ ')).toBe(true);
    expect(docs!.selector.length).toBeGreaterThan('^~ /api'.length);
  });

  it('declares them before the /api proxy in the file', () => {
    // Order is not what decides an exact or longer-prefix match, but keeping
    // them above the rule they override is what makes the intent readable.
    const apiAt = template.indexOf('location ^~ /api {');
    expect(template.indexOf('location = /api/v1/openapi.json')).toBeLessThan(apiAt);
    expect(template.indexOf('location ^~ /api/v1/docs')).toBeLessThan(apiAt);
  });

  it('still carries the shared security headers', () => {
    for (const block of [openapi!, docs!]) {
      expect(block.body).toContain('include /etc/nginx/security-headers.conf;');
    }
  });
});

describe('/ready is not exposed at the public edge', () => {
  const ready = blocks.find((b) => b.selector === '= /ready');

  it('has an explicit block rather than falling through to the SPA', () => {
    // A fallthrough would serve index.html with a 200 and make a broken probe
    // look like a healthy one.
    expect(ready).toBeDefined();
  });

  it('returns 404 and never proxies', () => {
    expect(ready!.body).toContain('return 404;');
    expect(ready!.body).not.toContain('proxy_pass');
  });

  it('is not referenced by any production Portal source file', () => {
    // The only consumer is the dev-only diagnostics page, which reaches it
    // through Vite's proxy. `verify:bundle` separately asserts that page is
    // absent from a production build.
    const allowed = new Set([
      path.join('src', 'api', 'system.ts'),
      path.join('src', 'features', 'diagnostics', 'DiagnosticsPage.tsx'),
    ]);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const rel = path.relative(PORTAL_DIR, full);
        if (allowed.has(rel) || rel.includes('__tests__')) continue;
        if (/['"`]\/ready['"`]/.test(fs.readFileSync(full, 'utf8'))) offenders.push(rel);
      }
    };
    walk(path.join(PORTAL_DIR, 'src'));
    expect(offenders).toEqual([]);
  });
});
