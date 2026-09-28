import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { forwardDebugLines, forwardsDebugLines, MAX_DEBUG_LINE_CHARS } from './debug-lines';

/** D-069: only whole `[debug] ` lines from the backend child reach the container's stdout. */

function forwarder() {
  const stream = new PassThrough();
  const lines: string[] = [];
  forwardDebugLines(stream, (line) => lines.push(line));
  const write = (chunk: string | Buffer) => new Promise<void>((resolve) => {
    stream.write(chunk, () => setImmediate(resolve));
  });
  return { stream, lines, write };
}

describe('the backend debug-line forwarder', () => {
  it('forwards whole debug lines and discards everything else the backend prints', async () => {
    const { lines, write } = forwarder();
    await write([
      'starknet.js: some library notice',
      '[debug] a1b2c3d4 2026-09-28T16:00:00.000Z info connect.state connected',
      '  [debug] indented, so not a debug line',
      '[DEBUG] wrong case',
      '[debug]no-space',
      '[debug] a1b2c3d4 2026-09-28T16:00:01.000Z error privacy.operation kind=not-registered code=118 NOT_REGISTERED',
      '',
    ].join('\n'));
    expect(lines).toEqual([
      '[debug] a1b2c3d4 2026-09-28T16:00:00.000Z info connect.state connected',
      '[debug] a1b2c3d4 2026-09-28T16:00:01.000Z error privacy.operation kind=not-registered code=118 NOT_REGISTERED',
    ]);
  });

  it('reassembles a line split across chunks, including inside a multibyte character', async () => {
    const { lines, write } = forwarder();
    const line = '[debug] a1b2c3d4 2026-09-28T16:00:00.000Z info test.event 5 € sent';
    const bytes = Buffer.from(`${line}\n`, 'utf8');
    const euro = bytes.indexOf(0xe2);
    await write(bytes.subarray(0, 12));
    await write(bytes.subarray(12, euro + 1));
    expect(lines).toEqual([]);
    await write(bytes.subarray(euro + 1));
    expect(lines).toEqual([line]);
  });

  it('holds an unterminated line back until its newline arrives', async () => {
    const { lines, write } = forwarder();
    await write('[debug] a1b2c3d4 2026-09-28T16:00:00.000Z info test.event half');
    expect(lines).toEqual([]);
    await write(' done\n');
    expect(lines).toEqual(['[debug] a1b2c3d4 2026-09-28T16:00:00.000Z info test.event half done']);
  });

  it('drops an overlong line whole, however it arrives, and recovers on the next line', async () => {
    const { lines, write } = forwarder();
    const huge = `[debug] a1b2c3d4 2026-09-28T16:00:00.000Z info test.event ${'x'.repeat(MAX_DEBUG_LINE_CHARS)}`;
    await write(`${huge}\n`);
    await write(huge.slice(0, 5_000));
    await write(huge.slice(5_000));
    await write('\n[debug] a1b2c3d4 2026-09-28T16:00:02.000Z info test.event after\n');
    expect(lines).toEqual(['[debug] a1b2c3d4 2026-09-28T16:00:02.000Z info test.event after']);
  });

  it('survives a writer that throws and a stream that errors', async () => {
    const stream = new PassThrough();
    forwardDebugLines(stream, () => { throw new Error('EPIPE'); });
    await new Promise<void>((resolve) => stream.write('[debug] a1b2c3d4 2026-09-28T16:00:00.000Z info t.e x\n', () => resolve()));
    expect(() => stream.destroy(new Error('read failed'))).not.toThrow();
  });

  it('is on only when BACKEND_DEBUG_LOGS_ENABLED is exactly true', () => {
    expect(forwardsDebugLines({})).toBe(false);
    expect(forwardsDebugLines({ BACKEND_DEBUG_LOGS_ENABLED: '' })).toBe(false);
    expect(forwardsDebugLines({ BACKEND_DEBUG_LOGS_ENABLED: 'false' })).toBe(false);
    expect(forwardsDebugLines({ BACKEND_DEBUG_LOGS_ENABLED: 'TRUE' })).toBe(false);
    expect(forwardsDebugLines({ BACKEND_DEBUG_LOGS_ENABLED: 'true' })).toBe(true);
  });
});
