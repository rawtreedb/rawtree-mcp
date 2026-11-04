import { describe, expect, it } from 'vitest';
import { normalizeAppUrl } from '../../src/client/http.js';

describe('normalizeAppUrl', () => {
  it.each([
    ['https://api.rawtree.com', 'https://rawtree.com'],
    ['https://api.us-east-1.aws.rawtree.com', 'https://rawtree.com'],
    ['https://api.rawtree.dev', 'https://rawtree.dev'],
    ['https://notrawtree.com', 'https://notrawtree.com'],
    ['http://localhost:8082', 'http://localhost:8082'],
    ['https://api.example.com/rawtree', 'https://api.example.com'],
    ['not a url', 'https://rawtree.com'],
  ])('derives the app URL from API URL %s', (apiUrl, appUrl) => {
    expect(normalizeAppUrl(undefined, apiUrl)).toBe(appUrl);
  });

  it('prefers an explicit app URL', () => {
    expect(
      normalizeAppUrl(' http://localhost:3000/ ', 'http://localhost:8082'),
    ).toBe('http://localhost:3000');
  });
});
