import type { PrivacyOperations } from '@strkworld/privacy';

/**
 * Keep the optional demo chunk behind one async boundary. The provider owns the
 * lifecycle around this loader; this module only owns the lazy import itself.
 */
export async function loadDemoOperations(): Promise<PrivacyOperations> {
  const { createDemoOperations } = await import('./demo-operations.js');
  return createDemoOperations();
}
