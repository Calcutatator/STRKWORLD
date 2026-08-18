/** Parse configured lobby URLs; malformed values fail closed to solo play. */
export function parseLobbyEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:' ? parsed.toString().replace(/\/$/, '') : undefined;
  } catch { return undefined; }
}

/** Vite-only configuration read; the parser remains independently testable. */
export function lobbyEndpoint(): string | undefined {
  const value = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env?.VITE_LOBBY_URL;
  return parseLobbyEndpoint(value);
}
