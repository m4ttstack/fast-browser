import assert from 'node:assert/strict';
import test from 'node:test';

import {
  removeManagedBlock,
  upsertManagedBlock,
} from '../../lib/hosts/managed-block.mjs';

const options = {
  id: 'routing-v1',
  body: 'Use Fast Browser first.\nDelegate multi-step work.',
};

test('inserts a managed block and removal restores the exact surrounding bytes', () => {
  const original = '# User instructions\nKeep this byte-for-byte.';

  const installed = upsertManagedBlock(original, options);

  assert.equal(
    installed,
    `${original}\n<!-- fast-browser:start routing-v1 -->\n`
      + 'Use Fast Browser first.\nDelegate multi-step work.\n'
      + '<!-- fast-browser:end routing-v1 -->',
  );
  assert.equal(removeManagedBlock(installed, 'routing-v1'), original);
});

test('replaces only the owned block and is idempotent', () => {
  const original = [
    'before',
    '<!-- fast-browser:start routing-v1 -->',
    'old body',
    '<!-- fast-browser:end routing-v1 -->',
    'after',
  ].join('\n');
  const expected = [
    'before',
    '<!-- fast-browser:start routing-v1 -->',
    'Use Fast Browser first.',
    'Delegate multi-step work.',
    '<!-- fast-browser:end routing-v1 -->',
    'after',
  ].join('\n');

  const installed = upsertManagedBlock(original, options);

  assert.equal(installed, expected);
  assert.equal(upsertManagedBlock(installed, options), expected);
  assert.equal(removeManagedBlock(installed, 'routing-v1'), 'before\nafter');
});

test('preserves CRLF style and unrelated bytes during insertion, replacement, and removal', () => {
  const original = 'alpha\r\nbeta\r\n';
  const first = upsertManagedBlock(original, options);
  const replacement = upsertManagedBlock(first, {
    id: 'routing-v1',
    body: 'replacement\nbody',
  });

  assert.equal(
    first,
    `${original}\r\n<!-- fast-browser:start routing-v1 -->\r\n`
      + 'Use Fast Browser first.\r\nDelegate multi-step work.\r\n'
      + '<!-- fast-browser:end routing-v1 -->',
  );
  assert.equal(
    replacement,
    `${original}\r\n<!-- fast-browser:start routing-v1 -->\r\n`
      + 'replacement\r\nbody\r\n'
      + '<!-- fast-browser:end routing-v1 -->',
  );
  assert.equal(removeManagedBlock(replacement, 'routing-v1'), original);
  assert.doesNotMatch(replacement, /(^|[^\r])\n/);
});

test('rejects duplicate, overlapping, and malformed managed markers', () => {
  const cases = [
    [
      '<!-- fast-browser:start routing-v1 -->\n'
        + '<!-- fast-browser:end routing-v1 -->\n'
        + '<!-- fast-browser:start routing-v1 -->\n'
        + '<!-- fast-browser:end routing-v1 -->',
      /duplicate/i,
    ],
    [
      '<!-- fast-browser:start routing-v1 -->\n'
        + '<!-- fast-browser:start other-v1 -->\n'
        + '<!-- fast-browser:end routing-v1 -->\n'
        + '<!-- fast-browser:end other-v1 -->',
      /overlap/i,
    ],
    ['<!-- fast-browser:start routing-v1 -->\nmissing end', /malformed/i],
    ['<!-- fast-browser:end routing-v1 -->', /malformed/i],
  ];

  for (const [text, expectedError] of cases) {
    assert.throws(() => upsertManagedBlock(text, options), expectedError);
    assert.throws(
      () => removeManagedBlock(text, 'routing-v1'),
      expectedError,
    );
  }
});
