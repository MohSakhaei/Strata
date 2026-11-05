// A reload in the middle of a planning turn must not lose the plan card. The host replays the words, the thinking and the tool cards of
// the running turn to the page that comes back (agent-bridge's turn.reattach) - and it does not replay the plan itself. So the card has
// to come from the two other ways a plan reaches a window: the page asking for the chat's plan when it opens it (GET /api/plan, what
// usePlan does) and the whole plan in a frame on the chat stream. This test pins all three, including what reattach deliberately does
// not send, so the next person who touches one of those routes sees which one the card depends on. That the host tells every window
// about every plan change is measured in agent-plan-two-windows.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatStore } from '../server/chat-store.mjs';
import { installFakeHostFetch } from './helpers/fake-host-chats.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

/** One module for the store and the plan library together: two bundles of the same file would hold two different plan lists. */
async function bundlePage(plugins) {
  const result = await build({
    stdin: {
      contents: [
        "export * from './src/lib/store.ts';",
        "export { applyPlanFrame, planOf, loadPlan } from './src/lib/plan.ts';",
      ].join('\n'),
      resolveDir: here('..'), loader: 'ts',
    },
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
    alias: { react: here('./helpers/react-stub.mjs') }, loader: { '.json': 'json' }, plugins,
  });
  return import(`data:text/javascript;base64,${Buffer.from(`${result.outputFiles[0].text}
// ${Math.random()}`).toString('base64')}`);
}

const NETWORK = 'Network error. Try sending the message again.';
const PLAN_TEXT = 'I looked at the folder first.\n\n## The pagoda plan\n\n1. Read the folder\n2. Write pagoda.html\n3. Check the page\n';
const planOfHost = (id) => ({
  id: 'plan-1', chatId: id, title: 'The pagoda plan', source: 'plan', state: 'proposed',
  request: 'A page of the pagoda at night.', context: 'I looked at the folder first.',
  steps: [{ id: 's1', text: 'Read the folder', detail: '', state: 'pending', summary: null },
    { id: 's2', text: 'Write pagoda.html', detail: '', state: 'pending', summary: null },
    { id: 's3', text: 'Check the page', detail: '', state: 'pending', summary: null }],
  file: '.strata/plans/the-pagoda-plan.md',
});

const chatWithCutOffPlanTurn = (id, requestId) => ({
  id, title: `Chat ${id}`, createdAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:01:00.000Z', workspace: 'C:/w', tokensIn: 0, tokensOut: 0,
  messages: [
    { id: `${id}-u`, role: 'user', content: '/plan a pagoda page', at: '2026-11-05T10:00:00.000Z' },
    { id: `${id}-a`, role: 'assistant', content: 'I looked at the folder first.', at: '2026-11-05T10:00:05.000Z', requestId, streaming: false, error: NETWORK },
  ],
});

async function pageOn(chatStore, { active, plan, attach }) {
  const fake = installFakeHostFetch(chatStore);
  globalThis.window ??= globalThis;
  globalThis.document ??= { addEventListener() {}, hasFocus: () => true, visibilityState: 'visible', documentElement: { dataset: {}, style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } } };
  const memory = new Map();
  globalThis.localStorage = { get length() { return memory.size; }, key: (i) => [...memory.keys()][i] ?? null, getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v); }, removeItem: (k) => memory.delete(k) };
  globalThis.navigator ??= { language: 'en' };
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  globalThis.__attach = attach;
  globalThis.__active = active;
  globalThis.__plan = plan;
  globalThis.__planCalls = 0;
  globalThis.__attachCalls = [];
  globalThis.__frames = [];
  globalThis.__hub = null;
  const mockClient = {
    name: 'mock-client',
    setup(b) {
      b.onResolve({ filter: /\/client$/ }, () => ({ path: 'mock-client', namespace: 'mock' }));
      b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ loader: 'js', contents: `
        export class ApiError extends Error { constructor(m, status, body) { super(m); this.status = status; this.body = body; } }
        const reject = async () => { throw new Error('offline'); };
        export const api = {
          get: async (path) => {
            if (path === '/api/chat/active') return { turns: globalThis.__active };
            if (path.startsWith('/api/agent/pending')) return { pending: [] };
            if (path.startsWith('/api/plan?')) { globalThis.__planCalls += 1; return { plan: globalThis.__plan }; }
            if (path.startsWith('/api/chat/queue?')) return { queue: [] };
            return {};
          },
          post: async () => ({}), put: reject, patch: reject, del: reject, delete: reject,
        };
        export function onEvent(handler) { globalThis.__hub = handler; return () => {}; }
        export async function streamPost(path, body, onFrame, signal) {
          globalThis.__attachCalls.push({ path, body });
          if (path !== '/api/chat/attach') return;
          await globalThis.__attach(body, (f) => { globalThis.__frames.push(f); onFrame(f); }, signal, ApiError);
        }` }));
    },
  };
  return { store: await bundlePage([mockClient]), fake };
}

const until = async (check, what) => { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 10)); } assert.fail(`timed out waiting for ${what}`); };

test('reload while a planning turn runs: the turn is taken over, and the plan card is not lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'strata-plan-reattach-'));
  const chatStore = createChatStore({ dir });
  let page;
  try {
    await chatStore.save('s_plan', JSON.stringify(chatWithCutOffPlanTurn('s_plan', 'req-plan')));
    let release;
    const finished = new Promise((r) => { release = r; });
    page = await pageOn(chatStore, {
      active: [{ chatId: 's_plan', sessionId: 'sess-p', requestId: 'req-plan', mode: 'plan', pending: [] }],
      plan: planOfHost('s_plan'),   // what the host holds for this chat: the plan its window wrote before the page went away
      attach: async (body, onFrame) => {
        assert.deepEqual(body, { sessionId: 's_plan' }, 'the running turn is asked for by chat only');
        // what agent-bridge's turn.reattach sends: the start (planning: true), the words so far, the tool cards as they are now
        onFrame({ type: 'start', model: 'm', contextMax: 8192, agent: true, resumed: true, requestId: 'req-plan', sessionId: 'sess-p', mode: 'plan', planning: true, skills: [] });
        onFrame({ type: 'resync', content: PLAN_TEXT, reasoning: 'looking at the folder' });
        onFrame({ type: 'agent-tool', tool: { id: 'call-read', name: 'read', verb: 'Read', target: 'notes.md', args: {}, state: 'done', result: 'ok' } });
        await finished;
        onFrame({ type: 'done', tokensIn: 5, tokensOut: 40, durationMs: 9000, usageSource: 'reported' });
      },
    });
    const { store } = page;
    await store.loadChatsFromHost();
    await until(() => globalThis.__attachCalls.length === 1, 'the attach request');
    store.selectSession('s_plan');
    const chat = () => store.useStore((s) => s.sessions).find((s) => s.id === 's_plan');
    const reply = () => chat().messages.at(-1);

    // the running planning turn is running again on this window: the Stop button is there, the reply is not a second one
    assert.equal(store.useStore((s) => s.streaming), true, 'the Stop button is there');
    assert.equal(reply().streaming, true, 'the planning reply is running');
    await until(() => reply().content.startsWith('I looked at the folder first.'), 'the catch-up text');
    assert.equal(reply().error, undefined, 'the failure the page wrote when the stream broke is gone');
    assert.equal(chat().messages.length, 2, 'no second reply was added');
    assert.equal(reply().tools.find((t) => t.id === 'call-read').state, 'done', 'the tool card that was there is there');

    // The host replays words, thinking and cards - not the plan. That is what the two other routes are for, so this is pinned.
    assert.equal(globalThis.__frames.filter((f) => f.type === 'plan').length, 0, 'reattach sends no plan frame');

    // the card comes from the page asking for the chat's plan when it opens the chat (usePlan -> GET /api/plan)
    const askedBefore = globalThis.__planCalls;
    await store.loadPlan('s_plan');
    assert.ok(globalThis.__planCalls > askedBefore, 'the page asks the host for this chat\'s plan');
    const card = store.planOf('s_plan');
    assert.ok(card, 'the plan card is back after the reload');
    assert.deepEqual(card.steps.map((s) => s.text), ['Read the folder', 'Write pagoda.html', 'Check the page']);
    assert.equal(card.context, 'I looked at the folder first.', 'and what the turn found by looking comes with it');
    assert.equal(card.file, '.strata/plans/the-pagoda-plan.md', 'and the card still points at the same checklist file');

    // the turn goes on into the same reply and ends whole
    release();
    await until(() => reply().streaming === false, 'the end of the turn');
    assert.ok(reply().content.startsWith('I looked at the folder first.') && reply().content.includes('3. Check the page'), 'the plan words the page had are what is kept');
    assert.equal(store.useStore((s) => s.streaming), false, 'the Stop button goes away');
    await store.flushSessions();
    const saved = JSON.parse(await chatStore.read('s_plan')).session.messages.at(-1);
    assert.ok(saved.content.startsWith('I looked at the folder first.') && saved.content.includes('3. Check the page'), 'and the same text is what is saved');
  } finally { page?.fake.restore(); rmSync(dir, { recursive: true, force: true }); }
});

test('a plan frame on the chat stream puts the card up, and a plan frame with nothing in it takes it away', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'strata-plan-frame-'));
  const chatStore = createChatStore({ dir });
  let page;
  try {
    await chatStore.save('s_two', JSON.stringify(chatWithCutOffPlanTurn('s_two', 'req-two')));
    let release;
    const finished = new Promise((r) => { release = r; });
    page = await pageOn(chatStore, {
      active: [{ chatId: 's_two', sessionId: 'sess-2', requestId: 'req-two', mode: 'plan', pending: [] }],
      attach: async (body, onFrame) => {
        onFrame({ type: 'start', model: 'm', contextMax: 8192, agent: true, resumed: true, requestId: 'req-two', sessionId: 'sess-2', mode: 'plan', planning: true, skills: [] });
        onFrame({ type: 'resync', content: PLAN_TEXT, reasoning: '' });
        // this is how a plan first reaches the window that is watching the turn: one whole plan in the chat stream
        onFrame({ type: 'plan', event: 'proposed', plan: planOfHost('s_two') });
        await finished;
        onFrame({ type: 'done', tokensIn: 5, tokensOut: 40, durationMs: 9000, usageSource: 'reported' });
      },
    });
    const { store } = page;
    await store.loadChatsFromHost();
    await until(() => globalThis.__attachCalls.length === 1, 'the attach request');
    store.selectSession('s_two');
    await until(() => !!store.planOf('s_two'), 'the plan frame');
    const card = store.planOf('s_two');
    assert.equal(card.title, 'The pagoda plan');
    assert.equal(card.steps.length, 3, 'the whole list is there, not a piece of it');
    assert.equal(card.file, '.strata/plans/the-pagoda-plan.md', 'and the card knows the file the host wrote');
    assert.equal(globalThis.__planCalls, 0, 'this window never asked: the frame carried it');
    release();
    await until(() => store.useStore((s) => s.streaming) === false, 'the end of the turn');
    store.applyPlanFrame('s_two', null);
    assert.equal(store.planOf('s_two'), null, 'and a plan the host lets go leaves the card');
  } finally { page?.fake.restore(); rmSync(dir, { recursive: true, force: true }); }
});
