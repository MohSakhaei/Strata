// Two windows on one chat that has a plan. What must stay true: the checklist file in the chat's folder always says exactly what the
// plan card says (never half-ticked, never a second file), a window holding an older copy of the plan cannot leave the file behind or
// corrupt it, a window cannot act on a plan id that is not this chat's, and every change a window is told about carries the whole plan
// with the same file name, so any window can rebuild its card from the last message it received.
// The part through the Harness needs a built Harness (STRATA_HARNESS_DIR) and skips loudly without it, like agent-plan-md.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startScriptedWorker } from './helpers/scripted-worker.mjs';
import { createAgentBridge } from '../server/agent/agent-bridge.mjs';
import { resolveHarness } from '../server/agent/harness-runtime.mjs';
import { PLAN_DIR, planMarkdown } from '../server/agent/plan-md.mjs';

const skip = !process.env.STRATA_HARNESS_DIR || !resolveHarness({ env: process.env }).ok ? 'STRATA_HARNESS_DIR is not set to a built Harness' : false;

/** A chat folder, a scripted model, and a bridge that records what a window would be told about the plan. */
async function rig(t) {
  const worker = await startScriptedWorker({});
  const dir = mkdtempSync(join(tmpdir(), 'strata-plan2w-'));
  const ws = join(dir, 'ws');
  mkdirSync(ws, { recursive: true });
  const told = [];
  const bridge = createAgentBridge({
    dataDir: dir,
    localInstances: () => [{ id: 'inst-1', label: 'Scripted', baseUrl: worker.url, modelId: 'scripted-model', context: 32768, slots: 2 }],
    connections: () => [], env: process.env, startTimeoutMs: 90_000,
    reportPlan: (chatId, event, plan) => told.push({ chatId, event, plan }),
  });
  t.after(async () => {
    await bridge.close(); await worker.close();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
  });
  const planTurn = (chatId) => bridge.runTurn({ chatId, workspacePath: ws, mode: 'plan', onFrame: () => {}, message: 'SCRIPT:planreply' });
  return { bridge, ws, told, planTurn, read: (plan) => readFileSync(join(ws, plan.file), 'utf8') };
}

const boxes = md => ({ ticked: (md.match(/^- \[x\] \d\. /gm) ?? []).length, open: (md.match(/^- \[ \] \d\. /gm) ?? []).length });
const filesIn = (ws) => readdirSync(join(ws, PLAN_DIR));
const base = (plan) => plan.file.split(/[\\/]/).pop();

test('one window ticks every step and the file ticks with it: three boxes closed, one file, same name', { skip }, async (t) => {
  const r = await rig(t);
  await r.planTurn('w1');
  const plan = r.bridge.planState('w1');
  assert.ok(plan?.file, 'the plan came with its checklist file');
  assert.equal(boxes(r.read(plan)).open, 3, 'the file starts with three open boxes');

  r.bridge.planControl({ chatId: 'w1', planId: plan.id, action: 'approve' });
  await r.bridge.planGoal({ chatId: 'w1', workspacePath: r.ws, mode: 'bypass', planId: plan.id, onFrame: () => {} });

  const after = r.bridge.planState('w1');
  assert.deepEqual(boxes(r.read(after)), { ticked: 3, open: 0 }, 'every step is ticked in the file');
  assert.match(r.read(after), /done · 3 of 3 steps done/);
  assert.equal(after.file, plan.file, 'running the plan did not move or rename the file');
  assert.deepEqual(filesIn(r.ws), [base(plan)], 'and it did not make a second one');
});

test('the other window may not change the steps once the plan has run: it is refused, and the finished file keeps its ticks', { skip }, async (t) => {
  const r = await rig(t);
  await r.planTurn('w1');
  const old = r.bridge.planState('w1');            // the copy a window is holding: nothing ticked yet
  r.bridge.planControl({ chatId: 'w1', planId: old.id, action: 'approve' });
  await r.bridge.planGoal({ chatId: 'w1', workspacePath: r.ws, mode: 'bypass', planId: old.id, onFrame: () => {} });
  assert.deepEqual(boxes(r.read(r.bridge.planState('w1'))), { ticked: 3, open: 0 }, 'the other window saw the steps finish');

  let refused = null;
  try {
    r.bridge.planControl({ chatId: 'w1', planId: old.id, action: 'edit', steps: old.steps.map((s) => s.text) });
  } catch (e) { refused = e.code; }
  assert.equal(refused, 'plan-used', 'the host says this plan has already been used instead of quietly writing an older list over the ticks');

  const stored = r.bridge.planState('w1');
  assert.deepEqual(boxes(r.read(stored)), { ticked: 3, open: 0 }, 'so the finished file is left exactly as it was');
  assert.deepEqual(filesIn(r.ws), [base(old)], 'one file, unchanged');
});

test('an edit that is allowed, before the plan runs, moves the store, the card and the file together and leaves a whole file', { skip }, async (t) => {
  const r = await rig(t);
  await r.planTurn('w1');
  const old = r.bridge.planState('w1');
  r.bridge.planControl({ chatId: 'w1', planId: old.id, action: 'approve' });
  const edited = r.bridge.planControl({ chatId: 'w1', planId: old.id, action: 'edit', steps: old.steps.map((s) => s.text) });

  const stored = r.bridge.planState('w1');
  assert.equal(edited.plan.state, 'proposed');
  assert.deepEqual(stored.steps.map((s) => s.state), ['pending', 'pending', 'pending'], 'an edit starts the steps again, for every window');
  assert.equal(stored.file, old.file, 'in the same file, not a new one');

  const md = r.read(stored);
  assert.deepEqual(boxes(md), { ticked: 0, open: 3 }, 'the file says the same: no tick left behind, none invented');
  assert.match(md, /waiting for you · 0 of 3 steps done/, 'and the words in the file match the card');
  assert.equal(md.split('\n')[0], `<!-- Strata plan ${stored.id} -->`, 'the marker is the first line');
  assert.match(md, /^## Steps$/m, 'the steps are there');
  assert.equal(md, planMarkdown(stored), 'the file is exactly what the plan describes, so nothing was half-written');
  assert.deepEqual(filesIn(r.ws), [base(old)], 'and still exactly one plan file');
});

test('a window cannot act on a plan that is not this chat\'s: the wrong id is refused and the file is not touched', { skip }, async (t) => {
  const r = await rig(t);
  await r.planTurn('w1');
  const plan = r.bridge.planState('w1');
  const before = r.read(plan);
  assert.throws(() => r.bridge.planControl({ chatId: 'w1', planId: 'not-this-plan', action: 'approve' }), 'a stale plan id must not be accepted');
  assert.throws(() => r.bridge.planControl({ chatId: 'w1', planId: 'not-this-plan', action: 'edit', steps: ['one', 'two'] }), 'nor an edit under a stale id');
  assert.equal(r.read(r.bridge.planState('w1')), before, 'the file is exactly as it was');
  assert.deepEqual(filesIn(r.ws), [base(plan)], 'and no other file appeared');
});

test('every plan message a window gets carries the whole plan and its file, so a card can be rebuilt from the last one', { skip }, async (t) => {
  const r = await rig(t);
  await r.planTurn('w1');
  const plan = r.bridge.planState('w1');
  r.bridge.planControl({ chatId: 'w1', planId: plan.id, action: 'approve' });
  r.bridge.planControl({ chatId: 'w1', planId: plan.id, action: 'edit', steps: plan.steps.map((s) => s.text) });
  await r.bridge.planGoal({ chatId: 'w1', workspacePath: r.ws, mode: 'bypass', planId: plan.id, onFrame: () => {} });

  const mine = r.told.filter((x) => x.chatId === 'w1');
  assert.ok(mine.length >= 4, `the windows were told about each change: ${mine.map((x) => x.event).join(', ') || 'nothing'}`);
  for (const m of mine) {
    assert.equal(m.plan.steps.length, 3, 'each message carries every step, not a piece of them');
    assert.equal(m.plan.file, plan.file, 'and the same file name every time');
  }
  assert.equal(planMarkdown(mine.at(-1).plan), r.read(r.bridge.planState('w1')), 'what the last message says is what the file on disk says');
});
