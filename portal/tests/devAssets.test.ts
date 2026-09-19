/**
 * `/dev-assets` containment. Real temporary directories and real symlinks: the
 * property under test is what the filesystem resolves to, which a mock cannot
 * speak for.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDevAssetsHandler, isPathInside, resolveContainedFile } from '../vite/devAssets';

const SECRET = 'OUTSIDE-SECRET-BYTES-do-not-serve';
const INSIDE = 'inside-artwork-bytes';

let base: string;
let root: string;
let outside: string;

/** Symlink creation needs a privilege on Windows; skip those cases there. */
let symlinksWork = true;

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'dev-assets-'));
  root = path.join(base, 'assets');
  outside = path.join(base, 'outside');
  mkdirSync(path.join(root, 'waifumon', 'neko'), { recursive: true });
  mkdirSync(path.join(root, '.thumbnails', '512', 'waifumon', 'neko'), { recursive: true });
  mkdirSync(path.join(root, 'nested', 'deeper'), { recursive: true });
  mkdirSync(path.join(outside, 'dir'), { recursive: true });

  writeFileSync(path.join(root, 'banner.png'), INSIDE);
  writeFileSync(path.join(root, 'waifumon', 'neko', 'standard.png'), INSIDE);
  writeFileSync(path.join(root, 'nested', 'deeper', 'art.webp'), INSIDE);
  writeFileSync(
    path.join(root, '.thumbnails', '512', 'waifumon', 'neko', 'standard.webp'),
    'thumb',
  );
  writeFileSync(path.join(outside, 'secret.png'), SECRET);
  writeFileSync(path.join(outside, 'dir', 'secret.png'), SECRET);
  // A sibling whose name shares the root's prefix: `/assets2` is not `/assets`.
  mkdirSync(path.join(base, 'assets2'));
  writeFileSync(path.join(base, 'assets2', 'x.png'), SECRET);

  try {
    // Symlinked file → outside.
    symlinkSync(path.join(outside, 'secret.png'), path.join(root, 'leak.png'));
    // Symlinked directory → outside.
    symlinkSync(path.join(outside, 'dir'), path.join(root, 'linkdir'), 'dir');
    // Chain: inside link → inside link → outside file.
    symlinkSync(path.join(outside, 'secret.png'), path.join(root, 'nested', 'hop2.png'));
    symlinkSync(path.join(root, 'nested', 'hop2.png'), path.join(root, 'hop1.png'));
    // Extensionless artwork whose preferred `.webp` escapes but `.png` is real.
    mkdirSync(path.join(root, 'waifumon', 'mixed'));
    symlinkSync(
      path.join(outside, 'secret.png'),
      path.join(root, 'waifumon', 'mixed', 'standard.webp'),
    );
    writeFileSync(path.join(root, 'waifumon', 'mixed', 'standard.png'), INSIDE);
    // Extensionless artwork whose only candidate escapes.
    mkdirSync(path.join(root, 'waifumon', 'evil'));
    symlinkSync(
      path.join(outside, 'secret.png'),
      path.join(root, 'waifumon', 'evil', 'standard.png'),
    );
    // Thumbnail that escapes.
    mkdirSync(path.join(root, '.thumbnails', '512', 'waifumon', 'evil'), { recursive: true });
    symlinkSync(
      path.join(outside, 'secret.png'),
      path.join(root, '.thumbnails', '512', 'waifumon', 'evil', 'standard.webp'),
    );
    // Link that stays inside the root — allowed, as in production.
    symlinkSync(path.join(root, 'banner.png'), path.join(root, 'alias.png'));
    symlinkSync(path.join(root, 'nested'), path.join(root, 'alias-dir'), 'dir');
  } catch {
    symlinksWork = false;
  }
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

interface Result {
  status: number;
  body: string;
  headers: Record<string, string>;
  passedToNext: boolean;
}

/** Drives the connect handler with a minimal request/response pair. */
function request(url: string, headers: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve) => {
    const handler = createDevAssetsHandler(root);
    const req = { url, headers } as unknown as IncomingMessage;
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    const out: Record<string, string> = {};
    let finished = false;
    const finish = (passedToNext: boolean) => {
      if (finished) return;
      finished = true;
      resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: out,
        passedToNext,
      });
    };
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));
    sink.on('end', () => finish(false));
    const res = Object.assign(sink, {
      statusCode: 200,
      headersSent: false,
      setHeader(name: string, value: string) {
        out[name.toLowerCase()] = value;
      },
    }) as unknown as ServerResponse & PassThrough;
    handler(req, res, () => finish(true));
  });
}

function expectRefused(result: Result): void {
  expect(result.body).not.toContain(SECRET);
  if (!result.passedToNext) {
    expect(result.status).toBe(403);
    expect(result.body).toBe('Forbidden');
  }
  // Nothing about the filesystem reaches the browser.
  expect(result.body).not.toContain(base);
  expect(result.body).not.toContain('outside');
}

describe('isPathInside', () => {
  it('compares whole segments, not string prefixes', () => {
    expect(isPathInside(root, path.join(root, 'a.png'))).toBe(true);
    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(root, path.join(base, 'assets2', 'x.png'))).toBe(false);
    expect(isPathInside(root, path.join(root, '..', 'outside'))).toBe(false);
  });
});

describe('/dev-assets — served', () => {
  it('serves a normal file inside the root', async () => {
    const result = await request('/banner.png');
    expect(result.status).toBe(200);
    expect(result.body).toBe(INSIDE);
    expect(result.headers['content-type']).toBe('image/png');
    expect(result.headers.etag).toMatch(/^W\//);
  });

  it('serves a nested file inside the root', async () => {
    const result = await request('/nested/deeper/art.webp');
    expect(result.status).toBe(200);
    expect(result.body).toBe(INSIDE);
    expect(result.headers['content-type']).toBe('image/webp');
  });

  it('resolves extensionless artwork and serves size renditions, as before', async () => {
    const original = await request('/waifumon/neko/standard');
    expect(original.body).toBe(INSIDE);
    expect(original.headers['content-type']).toBe('image/png');

    const thumb = await request('/t/512/waifumon/neko/standard');
    expect(thumb.body).toBe('thumb');
    expect(thumb.headers['content-type']).toBe('image/webp');

    // No rendition generated → falls back to the original.
    const fallback = await request('/t/256/waifumon/neko/standard');
    expect(fallback.body).toBe(INSIDE);
  });

  it('answers a matching validator with 304', async () => {
    const first = await request('/banner.png');
    const second = await request('/banner.png', { 'if-none-match': first.headers.etag! });
    expect(second.status).toBe(304);
    expect(second.body).toBe('');
  });

  it('ignores the query string', async () => {
    expect((await request('/banner.png?v=2')).body).toBe(INSIDE);
  });
});

describe('/dev-assets — not served', () => {
  it('passes a missing file to the next middleware', async () => {
    const result = await request('/nope.png');
    expect(result.passedToNext).toBe(true);
  });

  it('does not treat a directory as a file', async () => {
    expect((await request('/nested')).passedToNext).toBe(true);
    expect((await request('/nested/')).passedToNext).toBe(true);
  });

  it('refuses ../ traversal', async () => {
    const result = await request('/../outside/secret.png');
    expect(result.passedToNext).toBe(false);
    expectRefused(result);
  });

  it('refuses percent-encoded traversal', async () => {
    for (const url of [
      '/%2e%2e/outside/secret.png',
      '/%2E%2E%2Foutside%2Fsecret.png',
      '/waifumon/..%2f..%2f..%2foutside%2fsecret.png',
      '/t/512/..%2f..%2f..%2f..%2foutside%2fsecret',
    ]) {
      const result = await request(url);
      expect(result.passedToNext, url).toBe(false);
      expectRefused(result);
    }
  });

  it('does not reach a sibling directory sharing the root name as a prefix', async () => {
    const result = await request('/../assets2/x.png');
    expect(result.passedToNext).toBe(false);
    expectRefused(result);
  });

  it('rejects a malformed percent-encoding without throwing', async () => {
    const result = await request('/%E0%A4%A.png');
    expect(result.status).toBe(400);
    expect(result.body).toBe('Bad Request');
  });

  it('does not serve a NUL-byte path', async () => {
    const result = await request('/banner.png%00.txt');
    expect(result.passedToNext).toBe(true);
  });
});

describe('/dev-assets — symlinks', () => {
  it.runIf(symlinksWork)('refuses a symlinked file pointing outside the root', async () => {
    const result = await request('/leak.png');
    expect(result.passedToNext).toBe(false);
    expectRefused(result);
  });

  it.runIf(symlinksWork)('refuses a file reached through a symlinked directory', async () => {
    const result = await request('/linkdir/secret.png');
    expect(result.passedToNext).toBe(false);
    expectRefused(result);
  });

  it.runIf(symlinksWork)('refuses a nested symlink chain that ends outside', async () => {
    const result = await request('/hop1.png');
    expect(result.passedToNext).toBe(false);
    expectRefused(result);
  });

  it.runIf(symlinksWork)('refuses escaping extensionless artwork and thumbnails', async () => {
    expectRefused(await request('/waifumon/evil/standard'));
    expect((await request('/waifumon/evil/standard')).status).toBe(403);

    // The escaping rendition is skipped; with no safe original, still refused.
    const thumb = await request('/t/512/waifumon/evil/standard');
    expect(thumb.status).toBe(403);
    expectRefused(thumb);
  });

  it.runIf(symlinksWork)(
    'skips an escaping preferred format and serves the safe fallback',
    async () => {
      const result = await request('/waifumon/mixed/standard');
      expect(result.status).toBe(200);
      expect(result.body).toBe(INSIDE);
      expect(result.headers['content-type']).toBe('image/png');
    },
  );

  it.runIf(symlinksWork)('serves a symlink whose real target stays inside the root', async () => {
    expect((await request('/alias.png')).body).toBe(INSIDE);
    expect((await request('/alias-dir/deeper/art.webp')).body).toBe(INSIDE);
  });

  it.runIf(symlinksWork)('serves when the assets root itself is reached through a link', () => {
    const linkedRoot = path.join(base, 'root-link');
    symlinkSync(root, linkedRoot, 'dir');
    const found = resolveContainedFile(linkedRoot, path.join(linkedRoot, 'banner.png'));
    expect(found.status).toBe('available');
    expect(resolveContainedFile(linkedRoot, path.join(linkedRoot, 'leak.png')).status).toBe(
      'unsafe',
    );
  });
});
