import { expect } from 'vitest';

export const organizationId = '00000000-0000-4000-8000-0000000000a1';
export const clusterId = '00000000-0000-4000-8000-0000000000b1';
export const scope = { organization: organizationId, cluster: clusterId };

export function expectTenantHeaders(
  init: RequestInit | undefined,
  expected: { organization?: string; cluster?: string } = scope,
): void {
  const headers = new Headers(init?.headers);
  expect(headers.get('X-RawTree-Organization-Id')).toBe(
    expected.organization ?? null,
  );
  expect(headers.get('X-RawTree-Cluster-Id')).toBe(expected.cluster ?? null);
}
