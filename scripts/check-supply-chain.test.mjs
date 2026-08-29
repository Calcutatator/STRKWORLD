import { describe, expect, it } from 'vitest';
import { scanWorkflowText } from './check-supply-chain.mjs';

describe('GitHub Actions supply-chain pins', () => {
  it('only treats job and step uses fields as action references', () => {
    const workflow = [
      'env:',
      '  uses: root documentation',
      'jobs:',
      '  build:',
      '    env:',
      '      uses: job documentation',
      '    steps:',
      '      - uses: actions/checkout@v7',
      '        with:',
      '          uses: action input',
      '        env:',
      '          uses: step documentation',
      '  reusable:',
      '    uses: owner/repository/.github/workflows/reusable.yml@main',
    ].join('\n');

    expect(scanWorkflowText('.github/workflows/schema.yml', workflow)).toEqual([
      {
        file: '.github/workflows/schema.yml',
        line: 8,
        reference: 'actions/checkout@v7',
      },
      {
        file: '.github/workflows/schema.yml',
        line: 14,
        reference: 'owner/repository/.github/workflows/reusable.yml@main',
      },
    ]);
  });

  it('rejects mutable remote refs while accepting commit pins and local actions', () => {
    const workflow = [
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/checkout@v7',
      '      - uses: owner/action@main',
      '      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
      '      - uses: ./actions/local',
    ].join('\n');

    expect(scanWorkflowText('.github/workflows/ci.yml', workflow)).toEqual([
      {
        file: '.github/workflows/ci.yml',
        line: 4,
        reference: 'actions/checkout@v7',
      },
      {
        file: '.github/workflows/ci.yml',
        line: 5,
        reference: 'owner/action@main',
      },
    ]);
  });

  it('requires a real owner/repository action path before the commit SHA', () => {
    const sha = '3d3c42e5aac5ba805825da76410c181273ba90b1';
    const workflow = [
      'jobs:',
      '  build:',
      '    steps:',
      `      - uses: not-an-action@${sha}`,
      `      - uses: owner/repository/subdirectory@${sha}`,
      `      - uses: "owner/repository@${sha}" # readable release comment`,
    ].join('\n');

    expect(scanWorkflowText('.github/workflows/extra.yaml', workflow)).toEqual([
      {
        file: '.github/workflows/extra.yaml',
        line: 4,
        reference: `not-an-action@${sha}`,
      },
    ]);
  });

  it('rejects malformed remote action path characters before the commit SHA', () => {
    const sha = '3d3c42e5aac5ba805825da76410c181273ba90b1';
    const workflow = [
      'jobs:',
      '  build:',
      '    steps:',
      `      - uses: "owner/repository?query@${sha}"`,
      `      - uses: "owner/repository#fragment@${sha}"`,
      `      - uses: "owner\\\\repository/action@${sha}"`,
    ].join('\n');

    expect(scanWorkflowText('.github/workflows/malformed-paths.yml', workflow)).toEqual([
      {
        file: '.github/workflows/malformed-paths.yml',
        line: 4,
        reference: `owner/repository?query@${sha}`,
      },
      {
        file: '.github/workflows/malformed-paths.yml',
        line: 5,
        reference: `owner/repository#fragment@${sha}`,
      },
      {
        file: '.github/workflows/malformed-paths.yml',
        line: 6,
        reference: `owner\\repository/action@${sha}`,
      },
    ]);
  });

  it('rejects every docker step reference, including digest pins', () => {
    const digest = 'a'.repeat(64);
    const workflow = [
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: docker://alpine:3.20',
      `      - uses: docker://alpine@sha256:${digest}`,
    ].join('\n');

    expect(scanWorkflowText('.github/workflows/docker.yml', workflow)).toEqual([
      {
        file: '.github/workflows/docker.yml',
        line: 4,
        reference: 'docker://alpine:3.20',
      },
      {
        file: '.github/workflows/docker.yml',
        line: 5,
        reference: `docker://alpine@sha256:${digest}`,
      },
    ]);
  });

  it('rejects YAML merge keys in the jobs collection, job maps, and step maps', () => {
    const sha = '3d3c42e5aac5ba805825da76410c181273ba90b1';
    const workflow = [
      'jobs-template: &jobs-template',
      '  inherited:',
      `    uses: owner/repository/.github/workflows/reusable.yml@${sha}`,
      'job-template: &job-template',
      `  uses: owner/repository/.github/workflows/reusable.yml@${sha}`,
      'step-template: &step-template',
      `  uses: owner/repository/action@${sha}`,
      'jobs:',
      '  <<: *jobs-template',
      '  build:',
      '    <<: *job-template',
      '    steps:',
      '      - <<: *step-template',
    ].join('\n');

    expect(scanWorkflowText('.github/workflows/merge-keys.yml', workflow)).toEqual([
      {
        file: '.github/workflows/merge-keys.yml',
        line: 9,
        reference: '<yaml merge key>',
      },
      {
        file: '.github/workflows/merge-keys.yml',
        line: 11,
        reference: '<yaml merge key>',
      },
      {
        file: '.github/workflows/merge-keys.yml',
        line: 13,
        reference: '<yaml merge key>',
      },
    ]);
  });

  it('inspects alternate YAML uses-key syntax structurally', () => {
    const sha = '3d3c42e5aac5ba805825da76410c181273ba90b1';
    const workflow = [
      'jobs:',
      '  build:',
      '    steps:',
      '      - { uses: actions/checkout@v7 }',
      `      - 'uses': owner/repository@${sha}`,
      `      - "uses": ./actions/local`,
    ].join('\n');

    expect(scanWorkflowText('.github/workflows/alternate.yml', workflow)).toEqual([
      {
        file: '.github/workflows/alternate.yml',
        line: 4,
        reference: 'actions/checkout@v7',
      },
    ]);
  });

  it('decodes explicit and escaped uses keys before validation', () => {
    const workflow = [
      'jobs:',
      '  build:',
      '    steps:',
      '      - ? uses',
      '        : actions/checkout@v7',
      '      - "u\\u0073es": owner/action@main',
    ].join('\n');

    expect(scanWorkflowText('.github/workflows/encoded.yml', workflow)).toEqual([
      {
        file: '.github/workflows/encoded.yml',
        line: 4,
        reference: 'actions/checkout@v7',
      },
      {
        file: '.github/workflows/encoded.yml',
        line: 6,
        reference: 'owner/action@main',
      },
    ]);
  });

  it('ignores uses text that is not a YAML mapping key', () => {
    const workflow = [
      '# uses: actions/checkout@v7',
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: |',
      '          echo "uses: example"',
      '        env: { NOTE: "uses: example" }',
      '        x-uses: actions/checkout@v7',
    ].join('\n');

    expect(scanWorkflowText('.github/workflows/benign.yml', workflow)).toEqual([]);
  });

  it('resolves aliases used as action keys or references', () => {
    const workflow = [
      'uses-key: &uses-key uses',
      'mutable: &mutable actions/setup-node@v7',
      'jobs:',
      '  build:',
      '    steps:',
      '      - ? *uses-key',
      '        : actions/checkout@v7',
      '      - uses: *mutable',
    ].join('\n');

    expect(scanWorkflowText('.github/workflows/aliases.yml', workflow)).toEqual([
      {
        file: '.github/workflows/aliases.yml',
        line: 6,
        reference: 'actions/checkout@v7',
      },
      {
        file: '.github/workflows/aliases.yml',
        line: 8,
        reference: 'actions/setup-node@v7',
      },
    ]);
  });

  it('validates an aliased step map at its action location', () => {
    const workflow = [
      'action: &action',
      '  uses: actions/checkout@v7',
      'jobs:',
      '  build:',
      '    steps:',
      '      - *action',
    ].join('\n');

    expect(scanWorkflowText('.github/workflows/step-alias.yml', workflow)).toEqual([
      {
        file: '.github/workflows/step-alias.yml',
        line: 2,
        reference: 'actions/checkout@v7',
      },
    ]);
  });

  it('fails closed when the workflow is not valid YAML', () => {
    const workflow = [
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: [actions/checkout@v7',
    ].join('\n');

    expect(scanWorkflowText('.github/workflows/invalid.yml', workflow)).toEqual([
      {
        file: '.github/workflows/invalid.yml',
        line: 4,
        reference: '<invalid workflow yaml>',
      },
    ]);
  });

  it('fails closed when a uses value is not a string', () => {
    const workflow = [
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses:',
      '          action: actions/checkout@v7',
    ].join('\n');

    expect(scanWorkflowText('.github/workflows/non-string.yml', workflow)).toEqual([
      {
        file: '.github/workflows/non-string.yml',
        line: 4,
        reference: '<non-string uses reference>',
      },
    ]);
  });
});
