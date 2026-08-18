import { describe, expect, it } from 'vitest';
import config from './vite.config';

describe('web environment lookup', () => {
  it('sets the repository root as the env directory named by the setup guide', () => {
    expect(config).toMatchObject({ envDir: '../..' });
  });
});
