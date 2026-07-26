import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startOrderFixture } from '../fixtures/order-flow/server.mjs';
import { startMcpClient } from './helpers/mcp-client.mjs';

function fixtureCliOutput() {
  return new Promise((resolve, reject) => {
    const fixtureScript = fileURLToPath(new URL('../fixtures/order-flow/server.mjs', import.meta.url));
    const child = spawn(process.execPath, [path.relative(process.cwd(), fixtureScript), '--port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => finish(new Error('order fixture did not print its origin')), 3_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('\n')) finish(null, output);
    });
    child.once('error', finish);
    child.once('exit', () => {
      if (!output.includes('\n')) finish(new Error('order fixture exited before printing its origin'));
    });
  });
}

async function setup(t) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'fast-browser-e2e-'));
  const fixture = await startOrderFixture();
  const browser = await startMcpClient({ outputDir });
  t.after(async () => {
    await browser.close();
    await fixture.close();
  });
  return { browser, fixture, outputDir };
}

test('prints one local origin JSON line when started with --port 0', async () => {
  assert.match(await fixtureCliOutput(), /^\{"origin":"http:\/\/127\.0\.0\.1:\d+"\}\n$/);
});

test('completes the order flow in no more than three browser calls', async (t) => {
  const { browser, fixture } = await setup(t);

  await browser.callTool('browser_navigate', { url: fixture.origin });
  await browser.callTool('browser_snapshot', {});
  const result = await browser.callTool('browser_run_code_unsafe', {
    code: `async page => {
      await page.getByRole('button', { name: 'Start order' }).click();
      await page.getByRole('textbox', { name: 'Customer name' }).fill('Ada');
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('combobox', { name: 'Plan' }).selectOption('team');
      await page.getByRole('spinbutton', { name: 'Seats' }).fill('7');
      await page.getByRole('button', { name: 'Review order' }).click();
      await page.getByRole('button', { name: 'Place order' }).click();
      await page.getByRole('heading', { name: 'Order complete' }).waitFor();
      return {
        heading: await page.getByRole('heading').innerText(),
        orderId: await page.getByTestId('order-id').innerText(),
      };
    }`,
  });
  assert.deepEqual(result, {
    heading: 'Order complete',
    orderId: 'ADA-TEAM-7',
  });
  const metrics = browser.metrics();
  assert.ok(metrics.calls <= 8);
  assert.ok(metrics.calls <= 3);
  t.diagnostic(`fast flow metrics: ${JSON.stringify(metrics)}`);
});

test('runs the reusable order macro in exactly one browser call', async (t) => {
  const { browser, fixture, outputDir } = await setup(t);
  await browser.callTool('browser_navigate', { url: fixture.origin });
  await writeFile(path.join(outputDir, 'order-flow.js'), `async (page, args) => {
  await page.getByRole('button', { name: 'Start order' }).click();
  await page.getByRole('textbox', { name: 'Customer name' }).fill(args.customer);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('combobox', { name: 'Plan' }).selectOption(args.plan);
  await page.getByRole('spinbutton', { name: 'Seats' }).fill(String(args.seats));
  await page.getByRole('button', { name: 'Review order' }).click();
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.getByRole('heading', { name: 'Order complete' }).waitFor();
  return {
    heading: await page.getByRole('heading').innerText(),
    orderId: await page.getByTestId('order-id').innerText(),
  };
}
`);

  const callsBefore = browser.metrics().calls;
  const result = await browser.callTool('browser_run_code_unsafe', {
    filename: 'order-flow.js',
    args: { customer: 'Grace', plan: 'scale', seats: 12 },
  });

  const metrics = browser.metrics();
  assert.equal(metrics.calls - callsBefore, 1);
  assert.deepEqual(result, {
    heading: 'Order complete',
    orderId: 'GRACE-SCALE-12',
  });
  t.diagnostic(`macro flow metrics: ${JSON.stringify(metrics)}`);
});
