/* Tests for claims.js extraction + assessment (Node's built-in test runner).
   Run: node --test tests/ */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SNClaims = require('../claims.js');

function payload(text, links) {
  return {
    text: text,
    links: links || [],
    finalUrl: 'https://example.com/',
    retrievedAt: '2026-10-13T00:00:00.000Z'
  };
}

test('extracts a claim and categorises it', () => {
  const { claims } = SNClaims.extractClaims(payload(
    'Northstar Protocol completed a security audit with CertiK last quarter.'
  ));
  assert.equal(claims.length, 1);
  assert.equal(claims[0].category, 'audit-security');
});

test('tags every claim with method + provenance', () => {
  const { claims } = SNClaims.extractClaims(payload(
    'Our token has a total supply of one million and staking is now live.'
  ));
  assert.equal(claims[0].method, 'keyword-match:v1');
  assert.equal(claims[0].sourceUrl, 'https://example.com/');
  assert.equal(claims[0].retrievedAt, '2026-10-13T00:00:00.000Z');
});

test('skips boilerplate even when it contains keywords', () => {
  const { claims } = SNClaims.extractClaims(payload(
    'Subscribe to our newsletter for audit updates and partnership news.'
  ));
  assert.equal(claims.length, 0);
});

test('dedupes identical claims', () => {
  const s = 'The protocol completed a security audit in March. ';
  const { claims } = SNClaims.extractClaims(payload(s + s));
  assert.equal(claims.length, 1);
});

test('caps claims per category at 10', () => {
  const lines = [];
  for (let i = 0; i < 15; i++) {
    lines.push('Audit number ' + i + ' was completed by security audit partners.');
  }
  const { claims, capped } = SNClaims.extractClaims(payload(lines.join('\n')));
  assert.equal(claims.length, 10);
  assert.equal(capped, true);
});

test('sentence splitter filters fragments by length', () => {
  const s = SNClaims._splitSentences(
    'Short. This is a properly sized sentence for testing purposes.'
  );
  assert.deepEqual(s, ['This is a properly sized sentence for testing purposes.']);
});

test('assessment: verified CoinGecko ticker supports a $TICKER claim', () => {
  const result = SNClaims.extractClaims(payload(
    'The $NSTAR token powers staking and rewards across the whole protocol.'
  ));
  const report = {
    kind: 'basic', url: 'https://example.com',
    sources: {
      coingecko: {
        label: 'CoinGecko', status: 'available',
        note: 'CoinGecko lists this exact homepage for this project.',
        rows: [{ label: 'Symbol', value: 'NSTAR' }]
      }
    }
  };
  SNClaims.assess(result, report);
  assert.equal(result.claims[0].assessment.status, 'supported');
});

test('assessment: CoinGecko-listing claim contradicted by not-matched', () => {
  const result = SNClaims.extractClaims(payload(
    'Our token is listed on CoinGecko and tracked by thousands of users.'
  ));
  const report = {
    kind: 'basic', url: 'https://example.com',
    sources: { coingecko: { label: 'CoinGecko', status: 'not-matched', note: 'No match.' } }
  };
  SNClaims.assess(result, report);
  assert.equal(result.claims[0].assessment.status, 'contradicted');
});

test('assessment: no completed sources means observed, never verified', () => {
  const result = SNClaims.extractClaims(payload(
    'We raised seed funding backed by leading venture capital investors.'
  ));
  SNClaims.assess(result, { kind: 'basic', url: 'https://x.example', sources: {} });
  assert.equal(result.claims[0].assessment.status, 'observed');
});
