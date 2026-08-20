import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const canary = new URL('./check-drift.sh', import.meta.url);
const feeSelector = '0x3d323cd692ad43935b81ce230c47bfc57f69656249c5a33fe5223c17dd32ed2';
const pausedSelector = '0x238d7ea31550fece8f0a8a601e3ae1a7c59cb3b6cc976ceb721e31ebd9c36f9';
const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function runCanary(responses) {
  const directory = await mkdtemp(join(tmpdir(), 'strkworld-drift-test-'));
  directories.push(directory);
  const curl = join(directory, 'curl');
  await writeFile(curl, `#!/usr/bin/env node
const args = process.argv.slice(2);
const bodyIndex = args.indexOf('-d');
if (bodyIndex < 0 || !args[bodyIndex + 1]) process.exit(65);
const request = JSON.parse(args[bodyIndex + 1]);
const responses = JSON.parse(process.env.FAKE_RPC_RESPONSES);
let response;
if (request.method === 'starknet_getClassHashAt') response = responses.classHash;
else if (request.params?.[0]?.entry_point_selector === '${feeSelector}') response = responses.fee;
else if (request.params?.[0]?.entry_point_selector === '${pausedSelector}') response = responses.paused;
else process.exit(65);
process.stdout.write(JSON.stringify(response));
`);
  await chmod(curl, 0o755);

  return new Promise((resolve, reject) => {
    const child = spawn('bash', [fileURLToPath(canary)], {
      env: {
        ...process.env,
        PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
        FAKE_RPC_RESPONSES: JSON.stringify(responses),
        STARKNET_RPC_URL: 'https://rpc.invalid/local-test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    }));
  });
}

const result = (value) => ({ jsonrpc: '2.0', id: 1, result: value });
const callResult = (value) => result([value]);
const error = { jsonrpc: '2.0', id: 1, error: { code: -32_000, message: 'unavailable' } };

describe('STRK20 protocol drift canary', () => {
  it.each([
    {
      label: 'the fee is unreadable',
      fee: error,
      paused: callResult('0x0'),
      output: 'could not read the pool fee',
    },
    {
      label: 'pause state is unreadable',
      fee: callResult('0x53444835ec580000'),
      paused: error,
      output: 'could not read is_paused',
    },
  ])('fails closed when $label even if the other critical reads resolve', async ({ fee, paused, output }) => {
    const run = await runCanary({
      fee,
      paused,
      classHash: result('0xabc'),
    });

    expect(run.signal).toBeNull();
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain(output);
    expect(run.stdout).toContain('Drift detected.');
    expect(run.stdout).not.toContain('unavailable');
    expect(run.stdout).not.toContain('No drift.');
  });

  it.each([
    { label: 'a scalar string', target: 'paused', invalid: result('0x1') },
    { label: 'an object', target: 'fee', invalid: result({ 0: '0x53444835ec580000' }) },
    { label: 'an empty array', target: 'paused', invalid: result([]) },
    { label: 'a multi-value array', target: 'fee', invalid: result(['0x53444835ec580000', '0x0']) },
    { label: 'a non-felt string', target: 'paused', invalid: callResult('not-a-felt') },
    { label: 'a numeric value', target: 'fee', invalid: result([0]) },
    {
      label: 'an out-of-range felt',
      target: 'paused',
      invalid: callResult('0x800000000000011000000000000000000000000000000000000000000000001'),
    },
  ])('fails closed when a starknet_call result is $label', async ({ target, invalid }) => {
    const responses = {
      fee: callResult('0x53444835ec580000'),
      paused: callResult('0x0'),
      classHash: result('0xabc'),
    };
    responses[target] = invalid;
    const run = await runCanary(responses);

    expect(run.code, run.stdout).toBe(1);
    expect(run).toMatchObject({ signal: null, stderr: '' });
    expect(run.stdout).toContain(target === 'fee' ? 'could not read the pool fee' : 'could not read is_paused');
    expect(run.stdout).toContain('Drift detected.');
    expect(run.stdout).not.toContain('No drift.');
  });

  it('passes when every critical read returns the known healthy state', async () => {
    const run = await runCanary({
      fee: callResult('0x53444835ec580000'),
      paused: callResult('0x0'),
      classHash: result('0xabc'),
    });

    expect(run.code, run.stdout).toBe(0);
    expect(run).toMatchObject({ signal: null, stderr: '' });
    expect(run.stdout).toContain('pool fee still 6 STRK');
    expect(run.stdout).toContain('pool not paused');
    expect(run.stdout).toContain('No drift.');
  });

  it.each([
    {
      label: 'the pool fee changes',
      fee: '0x1',
      paused: '0x0',
      output: 'pool fee moved from 6 STRK',
    },
    {
      label: 'the pool is paused',
      fee: '0x53444835ec580000',
      paused: '0x1',
      output: 'pool is PAUSED',
    },
  ])('continues to fail when $label', async ({ fee, paused, output }) => {
    const run = await runCanary({
      fee: callResult(fee),
      paused: callResult(paused),
      classHash: result('0xabc'),
    });

    expect(run.code, run.stdout).toBe(1);
    expect(run).toMatchObject({ signal: null, stderr: '' });
    expect(run.stdout).toContain(output);
    expect(run.stdout).toContain('Drift detected.');
    expect(run.stdout).not.toContain('No drift.');
  });
});
