import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  nodeFileTransactionIo,
  prepareFileTransaction,
} from '../../lib/hosts/file-transaction.mjs';

async function temporaryHome(t, name = '') {
  const home = await mkdtemp(path.join(os.tmpdir(), `fast-browser-transaction-${name}`));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

async function snapshot(target) {
  try {
    return { exists: true, bytes: await readFile(target) };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, bytes: null };
    throw error;
  }
}

async function snapshotAll(paths) {
  return Promise.all(paths.map(snapshot));
}

async function fixture(t, name = '') {
  const home = await temporaryHome(t, name);
  const paths = [
    path.join(home, 'one.txt'),
    path.join(home, 'two.txt'),
    path.join(home, 'nested', 'three.txt'),
  ];
  await writeFile(paths[0], 'before-one');
  await writeFile(paths[1], 'before-two');
  const beforeSnapshots = await snapshotAll(paths);
  const afterSnapshots = [
    { exists: true, bytes: Buffer.from('after-one') },
    { exists: false, bytes: null },
    { exists: true, bytes: Buffer.from('after-three') },
  ];
  const changes = paths.map((target, index) => ({
    path: target,
    before: beforeSnapshots[index],
    after: afterSnapshots[index],
  }));
  return { home, paths, beforeSnapshots, afterSnapshots, changes };
}

function assertRedacted(error, paths, contents) {
  for (const target of paths) assert.equal(error.message.includes(target), false);
  for (const content of contents) assert.equal(error.message.includes(content), false);
  return true;
}

test('apply preflights every target before the first mutation', async (t) => {
  const {
    home,
    paths,
    changes,
  } = await fixture(t, 'preflight-');
  const prepared = prepareFileTransaction({ home, changes });
  await writeFile(paths[1], Buffer.from('external'));

  await assert.rejects(
    prepared.apply(),
    /routing transaction preflight failed/i,
  );
  assert.equal(await readFile(paths[0], 'utf8'), 'before-one');
  assert.equal(await readFile(paths[1], 'utf8'), 'external');
});

test('apply reverses its prefix when a later target drifts before mutation', async (t) => {
  const home = await temporaryHome(t, 'inter-mutation-drift-');
  const firstPath = path.join(home, 'a.txt');
  const secondPath = path.join(home, 'b.txt');
  await writeFile(firstPath, 'before-a');
  await writeFile(secondPath, 'before-b');
  let drifted = false;
  const io = {
    ...nodeFileTransactionIo,
    async mutate(change) {
      await nodeFileTransactionIo.mutate(change);
      if (!drifted && change.path === firstPath) {
        drifted = true;
        await writeFile(secondPath, 'external-b');
      }
    },
  };
  const prepared = prepareFileTransaction({
    home,
    changes: [
      {
        path: firstPath,
        before: { exists: true, bytes: Buffer.from('before-a') },
        after: { exists: true, bytes: Buffer.from('after-a') },
      },
      {
        path: secondPath,
        before: { exists: true, bytes: Buffer.from('before-b') },
        after: { exists: true, bytes: Buffer.from('after-b') },
      },
    ],
    io,
  });

  const error = await prepared.apply().then(
    () => assert.fail('transaction must reject inter-mutation drift'),
    (caught) => caught,
  );

  assert.equal(await readFile(firstPath, 'utf8'), 'before-a');
  assert.equal(await readFile(secondPath, 'utf8'), 'external-b');
  assert.equal(error.message, 'routing transaction apply failed');
});

test('apply automatically reverses each possible partial mutation failure', async (t) => {
  for (let failAt = 0; failAt < 3; failAt += 1) {
    const {
      home,
      paths,
      beforeSnapshots,
      changes,
    } = await fixture(t, `failure-${failAt}-`);
    let mutationIndex = 0;
    const io = {
      ...nodeFileTransactionIo,
      async mutate(change) {
        if (mutationIndex++ === failAt) {
          throw new Error('injected mutation failure');
        }
        return nodeFileTransactionIo.mutate(change);
      },
    };

    await assert.rejects(
      prepareFileTransaction({ home, changes, io }).apply(),
      /routing transaction apply failed/i,
    );
    assert.deepEqual(await snapshotAll(paths), beforeSnapshots);
  }
});

test('rollback is guarded and reciprocal', async (t) => {
  const {
    home,
    paths,
    beforeSnapshots,
    afterSnapshots,
    changes,
  } = await fixture(t, 'reciprocal-');
  const receipt = await prepareFileTransaction({ home, changes }).apply();
  assert.deepEqual(await snapshotAll(paths), afterSnapshots);

  const redo = await receipt.rollback();
  assert.deepEqual(await snapshotAll(paths), beforeSnapshots);
  await (await redo.rollback()).rollback();
  assert.deepEqual(await snapshotAll(paths), beforeSnapshots);

  await assert.rejects(
    receipt.rollback(),
    /routing transaction already consumed/i,
  );
});

test('rollback preflights every target before reversing any mutation', async (t) => {
  for (let driftAt = 0; driftAt < 3; driftAt += 1) {
    const {
      home,
      paths,
      afterSnapshots,
      changes,
    } = await fixture(t, `rollback-drift-${driftAt}-`);
    const receipt = await prepareFileTransaction({ home, changes }).apply();
    const drift = Buffer.from(`external-drift-${driftAt}`);
    await mkdir(path.dirname(paths[driftAt]), { recursive: true });
    await writeFile(paths[driftAt], drift);

    await assert.rejects(
      receipt.rollback(),
      /routing transaction preflight failed/i,
    );
    const expected = afterSnapshots.map((entry) => ({
      exists: entry.exists,
      bytes: entry.bytes === null ? null : Buffer.from(entry.bytes),
    }));
    expected[driftAt] = { exists: true, bytes: drift };
    assert.deepEqual(await snapshotAll(paths), expected);
  }
});

test('transaction errors never expose target paths or file contents', async (t) => {
  const {
    home,
    paths,
    changes,
  } = await fixture(t, 'maintainer-secret-');
  const contents = [
    'before-one',
    'before-two',
    'after-one',
    'after-three',
    'injected mutation failure',
  ];
  const preflight = prepareFileTransaction({ home, changes });
  await writeFile(paths[1], 'external-secret-content');
  await assert.rejects(preflight.apply(), (error) => {
    assert.equal(error.message, 'routing transaction preflight failed');
    return assertRedacted(error, paths, [...contents, 'external-secret-content']);
  });

  const second = await fixture(t, 'maintainer-secret-apply-');
  let mutationIndex = 0;
  const applyIo = {
    ...nodeFileTransactionIo,
    async mutate(change) {
      if (mutationIndex++ === 1) throw new Error('injected mutation failure');
      return nodeFileTransactionIo.mutate(change);
    },
  };
  await assert.rejects(
    prepareFileTransaction({
      home: second.home,
      changes: second.changes,
      io: applyIo,
    }).apply(),
    (error) => {
      assert.equal(error.message, 'routing transaction apply failed');
      return assertRedacted(error, second.paths, contents);
    },
  );

  const third = await fixture(t, 'maintainer-secret-recovery-');
  let recoveryMutationIndex = 0;
  const recoveryIo = {
    ...nodeFileTransactionIo,
    async mutate(change) {
      const current = recoveryMutationIndex++;
      if (current === 1 || current === 2) {
        throw new Error('injected mutation failure');
      }
      return nodeFileTransactionIo.mutate(change);
    },
  };
  await assert.rejects(
    prepareFileTransaction({
      home: third.home,
      changes: third.changes,
      io: recoveryIo,
    }).apply(),
    (error) => {
      assert.equal(error.message, 'routing transaction recovery required');
      return assertRedacted(error, third.paths, contents);
    },
  );
});

test('prepare clones caller-owned snapshots before apply', async (t) => {
  const home = await temporaryHome(t, 'clones-');
  const target = path.join(home, 'owned.txt');
  await writeFile(target, 'before');
  const before = Buffer.from('before');
  const after = Buffer.from('after');
  const prepared = prepareFileTransaction({
    home,
    changes: [{
      path: target,
      before: { exists: true, bytes: before },
      after: { exists: true, bytes: after },
    }],
  });
  before.fill('x');
  after.fill('y');

  await prepared.apply();
  assert.equal(await readFile(target, 'utf8'), 'after');
});

test('prepare rejects malformed, duplicate, or unconfined changes', async (t) => {
  const home = await temporaryHome(t, 'invalid-');
  const target = path.join(home, 'target.txt');
  const valid = {
    path: target,
    before: { exists: false, bytes: null },
    after: { exists: true, bytes: Buffer.from('after') },
  };
  const invalidCases = [
    [{ ...valid, before: { exists: false, bytes: Buffer.from('wrong') } }],
    [{ ...valid, after: { exists: true, bytes: null } }],
    [valid, valid],
    [{ ...valid, path: path.join(home, '..', 'outside.txt') }],
  ];

  for (const changes of invalidCases) {
    assert.throws(
      () => prepareFileTransaction({ home, changes }),
      /routing transaction preflight failed/i,
    );
  }
});

test('prepare rejects symlinked and non-regular target paths', async (t) => {
  const home = await temporaryHome(t, 'unsafe-');
  const outside = await temporaryHome(t, 'outside-');
  const linkedParent = path.join(home, 'linked-parent');
  const linkedLeaf = path.join(home, 'linked-leaf');
  const directoryLeaf = path.join(home, 'directory-leaf');
  await symlink(outside, linkedParent, 'dir');
  await writeFile(path.join(home, 'ordinary.txt'), 'ordinary');
  await symlink(path.join(home, 'ordinary.txt'), linkedLeaf, 'file');
  await mkdir(directoryLeaf);

  for (const target of [
    path.join(linkedParent, 'target.txt'),
    linkedLeaf,
    directoryLeaf,
  ]) {
    assert.throws(
      () => prepareFileTransaction({
        home,
        changes: [{
          path: target,
          before: { exists: false, bytes: null },
          after: { exists: true, bytes: Buffer.from('after') },
        }],
      }),
      /routing transaction preflight failed/i,
    );
  }
});
