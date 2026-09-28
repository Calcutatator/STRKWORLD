import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = dirname(fileURLToPath(import.meta.url));

function implementationFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return implementationFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('World package boundary', () => {
  it('does not import or name the lobby implementation', () => {
    const source = implementationFiles(sourceRoot)
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');

    expect(source).not.toMatch(/@strkworld\/lobby|packages\/lobby|LobbyClient/);
  });

  it('names no remote URL, so the browser never fetches from a third party', () => {
    // Every image the World shows is bundled with it (the Degen posters, the
    // avatar sheets), so a player's address never reaches a project's CDN. A
    // pattern cannot tell a comment from a string, so the World names none.
    const remote = /\b(?:https?|wss?|ftp):\/\/|["'`]\/\/[\w-]+(?:\.[\w-]+)+/i;
    const hits = implementationFiles(sourceRoot).flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line, index) => (remote.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : [])),
    );

    expect(hits).toEqual([]);
  });

  it('resolves every bundled asset relative to its own module', () => {
    // `new URL('<relative>', import.meta.url)` is what the bundler rewrites to
    // an emitted, same-origin asset; any other literal would be fetched as is.
    const literalUrls = implementationFiles(sourceRoot).flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(/new URL\(\s*(["'`])([^"'`]*)\1?\s*(?:,\s*([^)]*))?\)/g)].map(
        (match) => ({ path, target: match[2]!, base: (match[3] ?? '').trim() }),
      ),
    );

    expect(literalUrls.length).toBeGreaterThan(0);
    for (const { path, target, base } of literalUrls) {
      expect(target, path).toMatch(/^\.\.?\//);
      expect(base, path).toBe('import.meta.url');
    }
  });
});
