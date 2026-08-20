import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const flyScript = new URL('./fly/smoke-image.sh', import.meta.url);
const backendScript = new URL('./backend/smoke-image.sh', import.meta.url);
const workflow = new URL('../.github/workflows/ci.yml', import.meta.url);
const containerId = 'a'.repeat(64);

const fakeDockerSource = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\\n');
const id = '${containerId}';
const statePath = process.env.FAKE_DOCKER_STATE;
const readState = () => {
  try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; }
};
const output = (value) => process.stdout.write(String(value) + '\\n');

if (args[0] === 'image' && args[1] === 'inspect') {
  output(process.env.FAKE_DOCKER_IMAGE_USER || 'node');
} else if (args[0] === 'container' && args[1] === 'create') {
  const nameIndex = args.indexOf('--name');
  writeFileSync(statePath, JSON.stringify({
    name: args[nameIndex + 1],
    adversarial: args.includes('FLY_BUILT_LOBBY_URL=wss://mismatch.example.com'),
  }));
  output(id);
} else if (args[0] === 'container' && args[1] === 'start') {
  // The fake container is immediately ready.
} else if (args[0] === 'exec') {
  if (args.includes('/proc/1/status')) output(process.env.FAKE_DOCKER_UID || '1000');
  else if (args.includes('/app/build-metadata/lobby-url')) output('0:0:644');
  else if (process.env.FAKE_DOCKER_PROBE_FAIL === '1') process.exit(1);
} else if (args[0] === 'inspect') {
  const format = args[args.indexOf('--format') + 1];
  const state = readState();
  if (format === '{{.State.Running}}') output(state.adversarial ? 'false' : 'true');
  else if (format === '{{.State.ExitCode}}') output(state.adversarial ? '1' : (process.env.FAKE_DOCKER_EXIT_CODE || '0'));
  else if (format === '{{.Id}} {{.Name}}') output(id + ' /' + (process.env.FAKE_DOCKER_INSPECT_NAME || state.name));
  else process.exit(65);
} else if (args[0] === 'container' && args[1] === 'stop') {
  // Graceful and immediate in the fake.
} else if (args[0] === 'container' && args[1] === 'ls') {
  output(process.env.FAKE_DOCKER_LIST_ID || id);
} else if (args[0] === 'container' && args[1] === 'rm') {
  // Removal is recorded above.
} else {
  process.stderr.write('unexpected fake docker invocation: ' + JSON.stringify(args) + '\\n');
  process.exit(65);
}
`;

const fakeDateSource = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');

if (process.argv[2] !== '+%s') process.exit(65);
const values = (process.env.FAKE_DATE_VALUES || '100,100').split(',');
let index = 0;
try { index = Number(readFileSync(process.env.FAKE_DATE_STATE, 'utf8')); } catch {}
process.stdout.write((values[index] || values.at(-1)) + '\\n');
writeFileSync(process.env.FAKE_DATE_STATE, String(index + 1));
`;

async function runSmoke(script, args = [], overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'strkworld-smoke-test-'));
  const docker = join(directory, 'docker');
  const date = join(directory, 'date');
  const log = join(directory, 'docker.jsonl');
  const state = join(directory, 'state.json');
  const dateState = join(directory, 'date-state');
  await writeFile(docker, fakeDockerSource);
  await writeFile(date, fakeDateSource);
  await chmod(docker, 0o755);
  await chmod(date, 0o755);

  let result;
  let error;
  try {
    result = await execute('bash', [fileURLToPath(script), ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '4',
        FAKE_DOCKER_LOG: log,
        FAKE_DOCKER_STATE: state,
        FAKE_DATE_STATE: dateState,
        ...overrides,
      },
    });
  } catch (caught) {
    error = caught;
  }

  let calls = [];
  try {
    calls = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    // Argument validation can intentionally exit before Docker is invoked.
  }
  await rm(directory, { recursive: true, force: true });
  return { calls, error, result };
}

function callStarting(calls, ...prefix) {
  const call = calls.find((candidate) => prefix.every((value, index) => candidate[index] === value));
  expect(call, `missing Docker call ${prefix.join(' ')}`).toBeDefined();
  return call;
}

function optionValue(call, option) {
  const index = call.indexOf(option);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(call[index + 1]).toBeDefined();
  return call[index + 1];
}

function environmentValues(create) {
  const values = [];
  for (let index = 0; index < create.length; index += 1) {
    if (create[index] === '--env') values.push(create[index + 1]);
  }
  return values;
}

function expectQuarantinedCreate(calls, expectedImage) {
  const create = callStarting(calls, 'container', 'create');
  const name = optionValue(create, '--name');
  expect(name).toMatch(/^strkworld-(?:fly|backend)-smoke-123-4-[0-9]+$/);
  expect(optionValue(create, '--network')).toBe('none');
  expect(create.at(-1)).toBe(expectedImage);
  for (const forbidden of [
    '--publish', '--publish-all', '-p', '-P', '--volume', '-v', '--mount', '--env-file', '--expose',
  ]) {
    expect(create).not.toContain(forbidden);
  }
  expect(calls.some((call) => call[0] === 'network')).toBe(false);
  expect(calls.some((call) => call[0] === 'logs' || (call[0] === 'container' && call[1] === 'logs'))).toBe(false);
  return { create, name };
}

function expectInertFinancialEnvironment(create) {
  const env = environmentValues(create);
  expect(env).toEqual(expect.arrayContaining([
    'STARKNET_RPC_URL=https://rpc.invalid/ci',
    'AVNU_PAYMASTER_API_KEY=inert',
    `FEE_AUTHORIZATION_SECRET=${'0'.repeat(32)}`,
    'BACKEND_GLOBAL_ENABLED=false',
    'BACKEND_SPONSORSHIP_MAX_FEE_AMOUNT=0',
    'BACKEND_QUEUE_MAX_QUEUED=0',
    'BACKEND_ROUTE_TRANSFER_ENABLED=false',
    'BACKEND_ROUTE_TRANSFER_MAX_RELAY_FEE=0',
    'BACKEND_ROUTE_UNSHIELD_ENABLED=false',
    'BACKEND_ROUTE_UNSHIELD_MAX_RELAY_FEE=0',
    'BACKEND_ROUTE_SWAP_ENABLED=false',
    'BACKEND_ROUTE_SWAP_MAX_RELAY_FEE=0',
  ]));
}

function expectSafeLifecycle(calls, name, stopGraceSeconds) {
  expect(callStarting(calls, 'container', 'start')).toEqual(['container', 'start', containerId]);
  expect(callStarting(calls, 'container', 'stop')).toEqual([
    'container', 'stop', '--time', String(stopGraceSeconds), containerId,
  ]);
  expect(calls).toContainEqual(['inspect', '--type', 'container', '--format', '{{.State.ExitCode}}', containerId]);
  expect(calls).toContainEqual([
    'container', 'ls', '--all', '--no-trunc', '--quiet', '--filter', `name=^/${name}$`,
  ]);
  expect(calls).toContainEqual(['inspect', '--type', 'container', '--format', '{{.Id}} {{.Name}}', containerId]);
  expect(calls).toContainEqual(['container', 'rm', '--force', '--', containerId]);
}

describe('production image boot-smoke seam', () => {
  it('provides executable, syntax-valid Bash entrypoints that reject extra arguments before Docker', async () => {
    for (const script of [flyScript, backendScript]) {
      const metadata = await stat(script);
      expect(metadata.mode & 0o111).not.toBe(0);
      await expect(execute('bash', ['-n', fileURLToPath(script)])).resolves.toMatchObject({ stderr: '' });
      await expect(readFile(script, 'utf8')).resolves.toMatch(/^#!\/usr\/bin\/env bash\n/);

      const rejected = await runSmoke(script, ['one', 'two']);
      expect(rejected.error).toMatchObject({ code: 64 });
      expect(rejected.calls).toEqual([]);
    }
  });

  it.each([
    ['Fly', flyScript, 'registry.example/strkworld/fly:test'],
    ['backend', backendScript, 'registry.example/strkworld/backend:test'],
  ])('accepts one optional image tag for the %s smoke', async (_label, script, tag) => {
    const smoke = await runSmoke(script, [tag]);
    expect(smoke.error).toBeUndefined();
    expect(callStarting(smoke.calls, 'image', 'inspect').at(-1)).toBe(tag);
    expect(callStarting(smoke.calls, 'container', 'create').at(-1)).toBe(tag);
  }, 10_000);

  it('boots the Fly composition in quarantine and probes only the exact public status trio', async () => {
    const smoke = await runSmoke(flyScript);
    expect(smoke.error).toBeUndefined();
    expect(smoke.result?.stdout).toContain('Fly image smoke passed.');

    expect(callStarting(smoke.calls, 'image', 'inspect')).toEqual([
      'image', 'inspect', '--format', '{{.Config.User}}', 'strkworld-fly:ci',
    ]);
    const { create, name } = expectQuarantinedCreate(smoke.calls, 'strkworld-fly:ci');
    const env = environmentValues(create);
    expect(env).toContain('STARKNET_RPC_URL=https://rpc.invalid/ci');
    expect(env).toContain('AVNU_PAYMASTER_API_KEY=inert');
    expect(env).toContain('BACKEND_GLOBAL_ENABLED=false');
    expect(env).toContain('BACKEND_SPONSORSHIP_MAX_FEE_AMOUNT=0');
    expect(env).toContain('FLY_PUBLIC_ORIGIN=https://ci.example.com');
    expect(env).toContain('LOBBY_ALLOWED_ORIGINS=https://ci.example.com');

    const probe = smoke.calls.find((call) => call[0] === 'exec' && call.includes('node'));
    expect(probe).toBeDefined();
    const probeProgram = probe.at(-1);
    expect(probeProgram).toContain("['/', '/health', '/metrics']");
    expect(probeProgram).toContain('[200, 404, 404]');
    expect(probeProgram).toContain('AbortSignal.timeout(');
    expect(probeProgram).not.toContain('/api');
    expect(smoke.calls.some((call) => call.includes('/proc/1/status'))).toBe(true);
    expect(smoke.calls).toContainEqual([
      'exec', containerId, 'stat', '-c', '%u:%g:%a', '/app/build-metadata/lobby-url',
    ]);
    expectInertFinancialEnvironment(create);
    expectSafeLifecycle(smoke.calls, name, 10);

    const creates = smoke.calls.filter((call) => call[0] === 'container' && call[1] === 'create');
    expect(creates).toHaveLength(2);
    const adversarial = creates[1];
    expect(optionValue(adversarial, '--network')).toBe('none');
    expect(environmentValues(adversarial)).toEqual(expect.arrayContaining([
      'FLY_PUBLIC_ORIGIN=https://mismatch.example.com',
      'LOBBY_ALLOWED_ORIGINS=https://mismatch.example.com',
      'FLY_BUILT_LOBBY_URL=wss://mismatch.example.com',
    ]));
    expect(smoke.calls).toContainEqual(['inspect', '--type', 'container', '--format', '{{.State.Running}}', containerId]);
  }, 10_000);

  it('boots the standalone backend in quarantine and performs only a TCP liveness probe', async () => {
    const smoke = await runSmoke(backendScript);
    expect(smoke.error).toBeUndefined();
    expect(smoke.result?.stdout).toContain('Backend image smoke passed.');

    expect(callStarting(smoke.calls, 'image', 'inspect')).toEqual([
      'image', 'inspect', '--format', '{{.Config.User}}', 'strkworld-backend:ci',
    ]);
    const { create, name } = expectQuarantinedCreate(smoke.calls, 'strkworld-backend:ci');
    const env = environmentValues(create);
    expect(env).toContain('STARKNET_RPC_URL=https://rpc.invalid/ci');
    expect(env).toContain('AVNU_PAYMASTER_API_KEY=inert');
    expect(env).toContain('BACKEND_GLOBAL_ENABLED=false');
    expect(env).toContain('BACKEND_SPONSORSHIP_MAX_FEE_AMOUNT=0');

    const probe = smoke.calls.find((call) => call[0] === 'exec' && call.includes('node'));
    expect(probe).toBeDefined();
    const probeProgram = probe.at(-1);
    expect(probeProgram).toContain("require('node:net')");
    expect(probeProgram).toContain('net.connect');
    expect(probeProgram).not.toMatch(/fetch|https?:|\/api/);
    expect(smoke.calls.some((call) => call.includes('/proc/1/status'))).toBe(true);
    expectInertFinancialEnvironment(create);
    expectSafeLifecycle(smoke.calls, name, 3);
  });

  it.each([
    ['Fly', flyScript],
    ['backend', backendScript],
  ])('refuses to remove a %s container when exact ownership no longer matches', async (_label, script) => {
    const smoke = await runSmoke(script, [], { FAKE_DOCKER_LIST_ID: 'b'.repeat(64) });
    expect(smoke.error).toBeDefined();
    expect(smoke.error?.stderr).toContain('Refusing to clean an unowned');
    expect(smoke.calls.some((call) => call[0] === 'container' && call[1] === 'rm')).toBe(false);
  });

  it.each([
    ['Fly', flyScript],
    ['backend', backendScript],
  ])('refuses to remove a %s container when its inspected name changed', async (_label, script) => {
    const smoke = await runSmoke(script, [], { FAKE_DOCKER_INSPECT_NAME: 'different-container' });
    expect(smoke.error).toBeDefined();
    expect(smoke.error?.stderr).toContain('Refusing to clean a changed');
    expect(smoke.calls.some((call) => call[0] === 'container' && call[1] === 'rm')).toBe(false);
  });

  it.each([
    ['Fly', flyScript, '100,113'],
    ['backend', backendScript, '100,106'],
  ])('rejects a %s stop that exceeds its measured wall-clock bound', async (_label, script, dateValues) => {
    const smoke = await runSmoke(script, [], { FAKE_DATE_VALUES: dateValues });
    expect(smoke.error).toBeDefined();
    expect(smoke.error?.stderr).toContain('bounded');
    expect(smoke.calls).toContainEqual(['container', 'rm', '--force', '--', containerId]);
  });

  it('rejects an unexpected Fly container exit status after the bounded stop', async () => {
    const smoke = await runSmoke(flyScript, [], { FAKE_DOCKER_EXIT_CODE: '143' });
    expect(smoke.error).toBeDefined();
    expect(smoke.error?.stderr).toMatch(/shutdown|SIGTERM/);
    expect(smoke.calls).toContainEqual(['container', 'rm', '--force', '--', containerId]);
  });

  it.each(['1', '137', '255'])(
    'reports only the canonical aggregate backend exit code %s when graceful shutdown fails',
    async (exitCode) => {
      const smoke = await runSmoke(backendScript, [], { FAKE_DOCKER_EXIT_CODE: exitCode });
      expect(smoke.error).toBeDefined();
      expect(smoke.error?.stderr.trim()).toBe(
        `Backend image smoke failed: container exited with aggregate code ${exitCode}`,
      );
      expect(smoke.calls).toContainEqual(['container', 'rm', '--force', '--', containerId]);
    },
  );

  it('rejects a malformed backend exit code without echoing it', async () => {
    const malformed = '137 sensitive-provider-text';
    const smoke = await runSmoke(backendScript, [], { FAKE_DOCKER_EXIT_CODE: malformed });
    expect(smoke.error).toBeDefined();
    expect(smoke.error?.stderr).toContain('invalid aggregate exit code');
    expect(smoke.error?.stderr).not.toContain(malformed);
    expect(smoke.calls).toContainEqual(['container', 'rm', '--force', '--', containerId]);
  });

  it.each([
    ['a zero-padded value', '00'],
    ['an out-of-range value', '256'],
    ['an oversized digit string', '9'.repeat(80)],
  ])('rejects %s as a non-canonical backend exit code without echoing it', async (_label, exitCode) => {
    const smoke = await runSmoke(backendScript, [], { FAKE_DOCKER_EXIT_CODE: exitCode });
    expect(smoke.error).toBeDefined();
    expect(smoke.error?.stderr).toContain('invalid aggregate exit code');
    expect(smoke.error?.stderr).not.toContain(exitCode);
    expect(smoke.calls).toContainEqual(['container', 'rm', '--force', '--', containerId]);
  });

  it('runs each image smoke immediately after its corresponding CI build', async () => {
    const source = await readFile(workflow, 'utf8');
    const flyBuild = source.indexOf('- name: Build Fly composition image');
    const flySmoke = source.indexOf('- name: Smoke Fly composition image');
    const backendBuild = source.indexOf('- name: Build standalone backend image');
    const backendSmoke = source.indexOf('- name: Smoke standalone backend image');

    expect(flyBuild).toBeGreaterThanOrEqual(0);
    expect(flySmoke).toBeGreaterThan(flyBuild);
    expect(source.slice(flySmoke, backendBuild)).toContain('run: deploy/fly/smoke-image.sh strkworld-fly:ci');
    expect(backendBuild).toBeGreaterThan(flySmoke);
    expect(backendSmoke).toBeGreaterThan(backendBuild);
    expect(source.slice(backendSmoke)).toContain('run: deploy/backend/smoke-image.sh strkworld-backend:ci');
  });
});
