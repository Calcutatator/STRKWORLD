#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LineCounter, isAlias, isMap, isSeq, parseDocument } from 'yaml';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIRECTORY = join(REPOSITORY_ROOT, '.github', 'workflows');
const IMMUTABLE_REMOTE_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/;
const INVALID_YAML = '<invalid workflow yaml>';
const INVALID_REFERENCE = '<non-string uses reference>';
const YAML_MERGE_KEY = '<yaml merge key>';

export function scanWorkflowText(file, text) {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, {
    lineCounter,
    prettyErrors: false,
    uniqueKeys: false,
  });
  if (document.errors.length > 0) {
    return document.errors.map((error) => ({
      file,
      line: error.linePos?.[0].line
        ?? lineCounter.linePos(error.pos?.[0] ?? 0).line,
      reference: INVALID_YAML,
    }));
  }

  const violations = [];
  for (const jobsPair of mapPairs(document.contents, 'jobs', document)) {
    const jobs = resolveNode(jobsPair.value, document);
    if (!isMap(jobs)) continue;
    validateMergeKeys(jobs, document, lineCounter, file, violations);
    for (const jobPair of jobs.items) {
      if (yamlValue(jobPair.key, document) === '<<') continue;
      const job = resolveNode(jobPair.value, document);
      if (!isMap(job)) continue;
      validateMergeKeys(job, document, lineCounter, file, violations);
      for (const usesPair of mapPairs(job, 'uses', document)) {
        validateUsesPair(usesPair, document, lineCounter, file, violations);
      }
      for (const stepsPair of mapPairs(job, 'steps', document)) {
        const steps = resolveNode(stepsPair.value, document);
        if (!isSeq(steps)) continue;
        for (const stepNode of steps.items) {
          const step = resolveNode(stepNode, document);
          if (!isMap(step)) continue;
          validateMergeKeys(step, document, lineCounter, file, violations);
          for (const usesPair of mapPairs(step, 'uses', document)) {
            validateUsesPair(usesPair, document, lineCounter, file, violations);
          }
        }
      }
    }
  }
  return violations;
}

export function scanWorkflowDirectory(directory = WORKFLOW_DIRECTORY) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ['.yml', '.yaml'].includes(extname(entry.name).toLowerCase()))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return scanWorkflowText(relative(REPOSITORY_ROOT, path), readFileSync(path, 'utf8'));
    });
}

function validateUsesPair(pair, document, lineCounter, file, violations) {
  const line = lineCounter.linePos(pair.key?.range?.[0] ?? 0).line;
  const value = yamlValue(pair.value, document);
  const reference = typeof value === 'string' ? value : INVALID_REFERENCE;
  if (reference.startsWith('./')) return;
  if (reference.startsWith('docker://')) {
    violations.push({ file, line, reference });
    return;
  }
  if (IMMUTABLE_REMOTE_ACTION.test(reference)) return;
  violations.push({ file, line, reference });
}

function validateMergeKeys(mapping, document, lineCounter, file, violations) {
  for (const pair of mapPairs(mapping, '<<', document)) {
    const line = lineCounter.linePos(pair.key?.range?.[0] ?? 0).line;
    violations.push({ file, line, reference: YAML_MERGE_KEY });
  }
}

function mapPairs(node, key, document) {
  const mapping = resolveNode(node, document);
  if (!isMap(mapping)) return [];
  return mapping.items.filter((pair) => yamlValue(pair.key, document) === key);
}

function resolveNode(node, document) {
  return isAlias(node) ? node.resolve(document) : node;
}

function yamlValue(node, document) {
  if (!node) return undefined;
  const resolved = resolveNode(node, document);
  return resolved?.toJSON();
}

function main() {
  const violations = scanWorkflowDirectory();
  if (violations.length === 0) {
    console.log('GitHub Actions supply-chain pins: pass');
    return;
  }
  console.error('GitHub Actions supply-chain pins: fail');
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} workflow action seam violates the immutable-reference policy: ${violation.reference}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
