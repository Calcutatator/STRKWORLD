import type { BackendConfig, PreparedArtifact, PrivateRoute } from './types.js';

const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

export class ApiFailure extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiFailure';
  }
}

export function requireRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiFailure(400, 'Request body must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    throw new ApiFailure(400, 'Request contains an unknown field.');
  }
  return record;
}

export function requireVersion(record: Record<string, unknown>): void {
  if (record.v !== 1) throw new ApiFailure(400, 'Unsupported request version.');
}

export function requireFelt(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isFelt(value)) {
    throw new ApiFailure(400, `Invalid ${label}.`);
  }
  return value;
}

export function isFelt(value: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value) && BigInt(value) < STARK_FIELD_PRIME;
}

export function requireRoute(value: unknown): PrivateRoute {
  if (value !== 'transfer' && value !== 'unshield' && value !== 'swap') {
    throw new ApiFailure(400, 'Unknown private route.');
  }
  return value;
}

export function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ApiFailure(400, `Invalid ${label}.`);
  }
  return value;
}

export function validateArtifact(value: unknown, config: BackendConfig): PreparedArtifact {
  const root = requireRecord(value, ['call', 'proof']);
  const call = requireRecord(root.call, ['contract_address', 'entry_point', 'calldata']);
  const proof = requireRecord(root.proof, ['data', 'output', 'proof_facts']);
  const contractAddress = requireFelt(call.contract_address, 'submission target');
  if (!sameAddress(contractAddress, config.poolAddress)) {
    throw new ApiFailure(400, 'Submission target is not the configured privacy pool.');
  }
  if (call.entry_point !== 'apply_actions') {
    throw new ApiFailure(400, 'Submission entry point is not allowlisted.');
  }
  const calldata = requireFeltArray(call.calldata, 'call calldata', config.maxCalldataItems, false);
  if (typeof proof.data !== 'string' || proof.data.length === 0) {
    throw new ApiFailure(400, 'Prepared proof is empty.');
  }
  if (new TextEncoder().encode(proof.data).byteLength > config.maxProofBytes) {
    throw new ApiFailure(413, 'Prepared proof is too large.');
  }
  const output = requireFeltArray(
    proof.output,
    'proof output',
    config.maxCalldataItems + 1,
    false,
  );
  const proofFacts = requireFeltArray(proof.proof_facts, 'proof facts', 64, false);
  return {
    call: { contract_address: contractAddress, entry_point: 'apply_actions', calldata },
    proof: { data: proof.data, output, proof_facts: proofFacts },
  };
}

function requireFeltArray(
  value: unknown,
  label: string,
  max: number,
  allowEmpty: boolean,
): string[] {
  if (!Array.isArray(value) || value.length > max || (!allowEmpty && value.length === 0)) {
    throw new ApiFailure(400, `Invalid ${label}.`);
  }
  return value.map((item) => requireFelt(item, label));
}

export function sameAddress(a: string, b: string): boolean {
  try { return BigInt(a) === BigInt(b); } catch { return false; }
}
