import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeUrlPattern, patternSlug } from '../../lib/sites/patterns.mjs';

test('numeric segments collapse to :id', () => {
  assert.equal(normalizeUrlPattern('https://shop.example/orders/12345'), '/orders/:id');
});

test('UUID segments collapse to :id', () => {
  assert.equal(
    normalizeUrlPattern('https://shop.example/users/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'),
    '/users/:id',
  );
});

test('case-insensitive UUID segments collapse to :id', () => {
  assert.equal(
    normalizeUrlPattern('https://shop.example/users/9B1DEB4D-3B7D-4BAD-9BDD-2B0D7B3DCB6D'),
    '/users/:id',
  );
});

test('high-entropy segments (16+, letters and digits, url-safe chars) collapse to :id', () => {
  assert.equal(
    normalizeUrlPattern('https://shop.example/reset/eyJhbGciOiJIUzI1NiJ9'),
    '/reset/:id',
  );
});

test('short or purely-alphabetic segments are left alone', () => {
  assert.equal(normalizeUrlPattern('https://shop.example/cart'), '/cart');
  // Below the 16-char high-entropy floor even though it mixes letters/digits.
  assert.equal(normalizeUrlPattern('https://shop.example/item/a1b2c3'), '/item/a1b2c3');
  // 16+ chars but letters only -- a real word, not a token.
  assert.equal(
    normalizeUrlPattern('https://shop.example/pages/aaaaaaaaaaaaaaaaaaaa'),
    '/pages/aaaaaaaaaaaaaaaaaaaa',
  );
});

test('query string and hash are stripped', () => {
  assert.equal(
    normalizeUrlPattern('https://shop.example/cart?ref=email&utm=1#top'),
    '/cart',
  );
});

test('root path normalizes to /', () => {
  assert.equal(normalizeUrlPattern('https://shop.example/'), '/');
  assert.equal(normalizeUrlPattern('https://shop.example'), '/');
});

test('non-http(s) and unparseable urls return null', () => {
  assert.equal(normalizeUrlPattern('about:blank'), null);
  assert.equal(normalizeUrlPattern('not a url'), null);
  assert.equal(normalizeUrlPattern('ftp://files.example/a'), null);
  assert.equal(normalizeUrlPattern('data:text/plain,hi'), null);
});

test('patternSlug: root is the literal "root"', () => {
  assert.equal(patternSlug('/'), 'root');
});

test('patternSlug: :id segments and path separators produce the documented slug', () => {
  assert.equal(patternSlug('/orders/:id'), 'orders-_id');
});

test('patternSlug: distinct patterns produce distinct slugs, including hyphen-ambiguous ones', () => {
  const patterns = [
    '/',
    '/cart',
    '/orders/:id',
    '/orders/:id/items',
    '/orders/:id/items/:id',
    '/a-b/c',
    '/a/b-c',
    '/users/:id',
  ];
  const slugs = patterns.map(patternSlug);
  assert.equal(new Set(slugs).size, patterns.length, 'expected every slug to be unique');
});

test('patternSlug: every slug is a single filesystem-safe path component', () => {
  for (const pattern of ['/', '/cart', '/orders/:id', '/a-b/c/:id']) {
    const slug = patternSlug(pattern);
    assert.match(slug, /^[A-Za-z0-9_-]+$/, `slug for ${pattern} must be filesystem-safe: ${slug}`);
  }
});
