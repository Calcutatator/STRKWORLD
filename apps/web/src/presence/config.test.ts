import { describe, expect, it } from 'vitest';
import { parseLobbyEndpoint } from './config.js';

describe('parseLobbyEndpoint', () => {
  it.each([undefined, '', '   ', 'not a url', 'http://localhost:2567', 'https://localhost:2567'])(
    'rejects %s', (value) => expect(parseLobbyEndpoint(value)).toBeUndefined(),
  );
  it.each([
    ['ws://localhost:2567/', 'ws://localhost:2567'],
    ['wss://presence.example/game/', 'wss://presence.example/game'],
  ])('normalizes %s', (value, expected) => expect(parseLobbyEndpoint(value)).toBe(expected));
});
