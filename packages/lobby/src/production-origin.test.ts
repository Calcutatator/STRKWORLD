import { describe, expect, it } from 'vitest';
import { isProductionHostname } from './production-origin';

describe('production hostname policy', () => {
  it.each([
    '127.0.0.1',
    '127.1',
    '127.0.1',
    '2130706433',
    '0x7f000002',
    '017700000002',
    '::1',
    '[::1]',
    '::ffff:127.0.0.2',
    '[::ffff:7f00:2]',
    'localhost',
    'player.localhost',
    'nested.player.localhost',
    'example.invalid',
    'placeholder.example',
    'replace.example',
    'replace-host.example',
    'replace_host.example',
    'replace-this.example',
    'replace_this.example',
    'replace-me.example',
    'replace_me.example',
    'replace-with-host.example',
    'replace_with_hostname.example',
    'replace-with-me.example',
    'replace_with_me.example',
    'replacewithme.example',
    'replace.with.host.example',
    'yourhost.example',
    'your_host.example',
    'your-host.example',
    'yourhostname.example',
    'your_hostname.example',
    'yourdomain.example',
    'your-domain.example',
    'your.host.example',
  ])('rejects %s', (hostname) => {
    expect(isProductionHostname(hostname)).toBe(false);
  });

  it.each([
    'your-company.com',
    'replaceable.example.com',
    'placeholdertech.com',
    'game.example',
  ])('accepts legitimate hostname %s', (hostname) => {
    expect(isProductionHostname(hostname)).toBe(true);
  });
});
