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
  const adapter = createAdapter({ PiAiAdapter, responses }, auth);
  const messages = [llm.createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })];
  const args = { provider: PROVIDER, model: 'gpt-test', messages, tools: [{ name: 'echo_probe', description: 'Echo', parameters: { type: 'object', properties: {} } }], temperature: 0.1, maxTokens: 50, reasoningEffort: 'low' };
  async function check() { let text = '', finish; for await (const chunk of adapter.stream(args)) { if (chunk.type === 'text-delta') text += chunk.text; if (chunk.type === 'finish') finish = chunk; } assert.equal(text, 'WIRE_OK'); assert.equal(finish.reason.kind, 'stop'); }
  await check(); auth.changed(); await check();
  await store.transact(data => { data.profiles.push({ id: 'second', clientId: 'oaiapp_second', access_token: 'fake-b', refresh_token: 'fake-refresh-b', expiresAt: Date.now()+3600000, scopes: [PLAN_SCOPE], models: [{ slug: 'gpt-test-b', visibility: 'list', context_window: 272000, supported_reasoning_levels: [{ effort: 'low' }] }] }); });
  await auth.select('second'); args.model = 'gpt-test-b'; await check();
  assert.equal(captured.length, 4); assert.equal(refreshes, 1); assert.equal(captured[3].model, 'gpt-test-b');
  console.log(JSON.stringify({ success: true, nativeDSHAdapter: true, publicEndpoint: true, namespacedTools: true, forbiddenFieldsRemoved: true, streaming: true, accountGenerationRenewal: true, multiAccountModelSwitch: true, forced401Refresh: true, isolatedNetwork: true, mockedNetwork: true }));
} finally { globalThis.fetch = originalFetch; await network?.close(); await rm(directory, { recursive: true, force: true }); }
