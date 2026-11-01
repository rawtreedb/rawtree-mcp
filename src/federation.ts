import { z } from 'zod';

const name = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$(?![\s\S])/);
const description = z
  .string()
  .refine(
    (value) =>
      new TextEncoder().encode(value).length <= 2000 && !value.includes('\0'),
    'Use at most 2000 UTF-8 bytes without null characters.',
  )
  .nullable()
  .optional();
const httpsUrl = z
  .url()
  .refine((value) => value.startsWith('https://'), 'Use an HTTPS URL.');
export const issuerConfiguration = z
  .strictObject({
    name,
    description,
    issuer_url: httpsUrl.describe(
      'Exact expected token issuer; do not normalize it.',
    ),
    jwks_source: z.enum(['discovery', 'explicit_url']).default('discovery'),
    jwks_url: httpsUrl
      .nullable()
      .optional()
      .describe('Required for explicit_url; omit or null for discovery.'),
  })
  .refine(
    (value) =>
      value.jwks_source === 'discovery'
        ? value.jwks_url == null
        : value.jwks_url != null,
    'Provide jwks_url only with explicit_url.',
  );

const conditionText = z.string().min(1);
export const ruleConfiguration = z
  .strictObject({
    name,
    description,
    issuer_id: z.uuid(),
    allowed_audiences: z
      .array(z.string().min(1))
      .min(1)
      .max(16)
      .refine(
        (values) => new Set(values).size === values.length,
        'Audiences must be distinct.',
      ),
    claim_conditions: z.record(conditionText, conditionText).refine((value) => {
      const keys = Object.keys(value);
      return (
        keys.length >= 1 &&
        keys.length <= 32 &&
        keys.every(
          (key) => !['iss', 'aud', 'exp', 'nbf', 'iat', 'jti'].includes(key),
        )
      );
    }, 'Provide 1–32 exact string claim conditions; issuer/audience/time/token-ID claims are configured separately.'),
    principal_type: z.enum(['user', 'service_account']),
    principal_id: z
      .uuid()
      .describe(
        'Your own user ID or a service account ID in this organization.',
      ),
    permission: z.enum(['admin', 'read_only', 'read_write']).optional(),
    database_roles: z.array(z.string().min(1)).min(1).optional(),
    database: z
      .string()
      .min(1)
      .describe(
        'Default database for this rule; not inherited from the MCP connection.',
      ),
    enabled: z
      .boolean()
      .describe('Whether this rule permits workload token exchange.'),
  })
  .refine(
    (value) =>
      (value.permission !== undefined) !== (value.database_roles !== undefined),
    'Provide exactly one of permission or database_roles.',
  );

export const federationScope = z.strictObject({
  organization: z.string().min(1),
  cluster: z.string().min(1),
});
export type FederationScope = z.infer<typeof federationScope>;
export type FederationIssuerInput = z.input<typeof issuerConfiguration>;
export type FederationRuleInput = z.infer<typeof ruleConfiguration>;
