import { describe, expect, it } from 'vitest';
import { normalizeUiUrl } from '../../src/client/http.js';

describe('normalizeUiUrl', () => {
  it.each([
    ['https://api.rawtree.com', 'https://rawtree.com'],
    ['https://api.us-east-1.aws.rawtree.com', 'https://rawtree.com'],
    ['https://api.rawtree.dev', 'https://rawtree.dev'],
    ['https://notrawtree.com', 'https://notrawtree.com'],
    ['http://localhost:8082', 'http://localhost:8082'],
    ['https://api.example.com/rawtree', 'https://api.example.com'],
    ['not a url', 'https://rawtree.com'],
  ])('derives the UI URL from API URL %s', (apiUrl, uiUrl) => {
    expect(normalizeUiUrl(undefined, apiUrl)).toBe(uiUrl);
  });

  it('prefers an explicit UI URL', () => {
    expect(
      normalizeUiUrl(' http://localhost:3000/ ', 'http://localhost:8082'),
    ).toBe('http://localhost:3000');
  });
});
