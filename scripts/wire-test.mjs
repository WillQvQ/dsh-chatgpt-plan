import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../storage.mjs';
import { ChatGPTAuth, PLAN_SCOPE } from '../oauth.mjs';
import { createAdapter, PROVIDER } from '../adapter.mjs';
import { Network } from '../network.mjs';
import { PiAiAdapter, responses, llm, networkAgents } from './runtime.mjs';
const directory = await mkdtemp(join(tmpdir(), 'dsh-native-wire-test-'));
const store = new Store(directory), captured = [];
const originalFetch = globalThis.fetch;
// Action-specific fields must stay optional. Responses normalizes omitted
// `strict` to strict mode, which otherwise forces resume calls to fill them.
const goalParameters = {
  type: 'object',
  properties: {
    goal_id: { type: 'string' },
    revision: { type: 'number' },
    action: { type: 'string', enum: ['edit', 'pause', 'resume', 'complete', 'blocked'] },
    objective: { type: 'string', description: 'Valid only with action edit.' },
    max_goal_rounds: { type: 'number', description: 'Valid only with action edit.' },
    blocked_reason: { type: 'string', description: 'Required only with action blocked.' },
  },
  required: ['goal_id', 'revision', 'action'],
};
let network;
try {
  await store.transact(data => { data.activeProfileId = 'test'; data.profiles = [{ id: 'test', clientId: 'oaiapp_test', access_token: 'fake-for-offline-test', refresh_token: 'fake-refresh', expiresAt: Date.now()+3600000, scopes: [PLAN_SCOPE], models: [{ slug: 'gpt-test', visibility: 'list', context_window: 272000, supported_reasoning_levels: [{ effort: 'low' }] }] }]; });
  globalThis.fetch = async (url, options) => {
    const request = new Request(url, options);
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    const params = JSON.parse(await request.text()); captured.push(params);
    assert.equal(params.store, false); assert.equal(params.stream, true); assert.equal(params.temperature, undefined); assert.equal(params.max_output_tokens, undefined);
    assert.equal(params.tools[0].type, 'namespace'); assert.equal(params.tools[0].tools[0].name, 'echo_probe');
    assert.ok(params.input.every(item => item.role !== 'system'));
    if (captured.length === 1) return new Response('unauthorized', { status: 401 });
    const output = [{ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'WIRE_OK', annotations: [] }] }];
    const events = [
      { type: 'response.created', response: { id: 'resp_test', model: 'gpt-test', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...output[0], status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: 'msg_test', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_test', output_index: 0, content_index: 0, delta: 'WIRE_OK' },
      { type: 'response.output_item.done', output_index: 0, item: output[0] },
      { type: 'response.completed', response: { id: 'resp_test', model: 'gpt-test', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  network = new Network({ directory, env: {}, agents: async () => networkAgents });
  await network.initialize();
  const auth = new ChatGPTAuth({ store, fetcher: network.fetch });
  let refreshes = 0;
  auth.tokenRequest = async params => { assert.equal(params.grant_type, 'refresh_token'); refreshes++; return { access_token: 'rotated-fake', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600, scope: PLAN_SCOPE }; };
  const adapter = createAdapter({ PiAiAdapter, responses, resolveRetryPolicy: llm.resolveRetryPolicy }, auth);
  const messages = [llm.createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })];
  const args = { provider: PROVIDER, model: 'gpt-test', messages, tools: [
    { name: 'echo_probe', description: 'Echo', parameters: { type: 'object', properties: {} } },
    { name: 'update_goal', description: 'Update the current goal.', parameters: goalParameters },
  ], temperature: 0.1, maxTokens: 50, reasoningEffort: 'low' };
  async function check() { let text = '', finish; for await (const chunk of adapter.stream(args)) { if (chunk.type === 'text-delta') text += chunk.text; if (chunk.type === 'finish') finish = chunk; } assert.equal(finish?.reason.kind, 'stop', JSON.stringify(finish?.reason)); assert.equal(text, 'WIRE_OK'); }
  await check(); auth.changed(); await check();
  await store.transact(data => { data.profiles.push({ id: 'second', clientId: 'oaiapp_second', access_token: 'fake-b', refresh_token: 'fake-refresh-b', expiresAt: Date.now()+3600000, scopes: [PLAN_SCOPE], models: [{ slug: 'gpt-test-b', visibility: 'list', context_window: 272000, supported_reasoning_levels: [{ effort: 'low' }] }] }); });
  await auth.select('second'); args.model = 'gpt-test-b'; await check();
  assert.equal(captured.length, 4); assert.equal(refreshes, 1); assert.equal(captured[3].model, 'gpt-test-b');
  for (const params of captured) {
    for (const tool of params.tools[0].tools) assert.equal(tool.strict, false, `${tool.name} must explicitly preserve optional parameters`);
    assert.deepEqual(params.tools[0].tools.find(tool => tool.name === 'update_goal').parameters, goalParameters);
  }
  console.log(JSON.stringify({ success: true, nativeDSHAdapter: true, publicEndpoint: true, namespacedTools: true, optionalToolParameters: true, explicitNonStrictTools: true, forbiddenFieldsRemoved: true, streaming: true, accountGenerationRenewal: true, multiAccountModelSwitch: true, forced401Refresh: true, isolatedNetwork: true, mockedNetwork: true }));
} finally { globalThis.fetch = originalFetch; await network?.close(); await rm(directory, { recursive: true, force: true }); }
