import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtemp, rm, stat, readFile, writeFile, chmod, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Network, validateNetwork } from '../network.mjs';
import { Script } from 'node:vm';
import { request } from 'node:http';
import { Store, readPrivateFile, profileStorage } from '../storage.mjs';
import { ChatGPTAuth, validateIdToken, ISSUER, RESOURCE, TOKEN, SCOPES, PLAN_SCOPE } from '../oauth.mjs';
import { planPayload, catalogModels } from '../adapter.mjs';
import { startManagement, managementHtml } from '../management.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const NOW = 1800000000000;
function jwt(clientId, nonce, extra = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: ISSUER, sub: 'account-one', email: 'test@example.invalid', aud: clientId, nonce, exp: NOW / 1000 + 3600, ...extra })).toString('base64url');
  const input = `${header}.${claims}`;
  return `${input}.${sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-siwc-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory), calls = [];
  let lastNonce, currentId = 'oaiapp_test', scopes = SCOPES, refreshes = 0, failRefresh, now = NOW;
  let identity = { sub: 'account-one', email: 'test@example.invalid' }, modelName = 'gpt-test';
  const fetcher = async (url, options = {}) => {
    calls.push({ url, body: options.body, headers: options.headers });
    if (url.endsWith('openid-configuration')) return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, revocation_endpoint: `${ISSUER}/revoke` });
    if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] });
    if (url === TOKEN) {
      const params = new URLSearchParams(options.body);
      assert.equal(params.get('client_id'), currentId); assert.equal(params.get('resource'), RESOURCE);
      if (params.get('grant_type') === 'refresh_token') {
        refreshes++; await new Promise(r => setTimeout(r, 20));
        if (failRefresh) return Response.json({ error: failRefresh }, { status: 400 });
      }
      return Response.json({ access_token: 'private-access-' + refreshes, refresh_token: 'private-refresh-' + refreshes, id_token: jwt(currentId, lastNonce, identity), token_type: 'Bearer', expires_in: 3600, scope: scopes });
    }
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: modelName, display_name: 'Test', visibility: 'list', context_window: 272000, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }], input_modalities: ['text','image'] }, { slug: 'hidden', visibility: 'hidden' }] });
    if (url.endsWith('/revoke')) return new Response(null, { status: 200 });
    throw new Error('Unexpected endpoint');
  };
  const auth = new ChatGPTAuth({ store, fetcher, now: () => now }); await auth.initialize();
  async function begin(options = {}) { const url = new URL(await auth.begin({ redirectUri: 'http://127.0.0.1:18762/auth/callback', ...options })); lastNonce = url.searchParams.get('nonce'); return url; }
  async function finish(url, override = {}) { const callback = new URL('http://127.0.0.1:18762/auth/callback'); callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'one-use-code', client_id: currentId, ...override }); await auth.callback(callback); return callback; }
  return { store, auth, calls, fetcher, begin, finish, setNow: value => now = value, setIdentity: value => identity = value, setModel: value => modelName = value, setScopes: value => scopes = value, setClient: value => currentId = value, setRefreshError: value => failRefresh = value, refreshes: () => refreshes };
}

test('independent registration uses PKCE, persistent host and issued client; owner-only credentials', async t => {
  const f = await fixture(t), url = await f.begin();
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('agent_name_hint'), 'DeepSeek Harness');
  const host = url.searchParams.get('ext_agent_host_id'); assert.match(host, /^urn:uuid:/);
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(f.auth.pending.verifier).digest('base64url'));
  await f.finish(url);
  const data = await f.store.load(), p = data.profiles[0];
  assert.equal(data.hostId, host); assert.equal(p.clientId, 'oaiapp_test'); assert.equal(p.subject, 'account-one'); assert.equal(p.models.length, 1);
  assert.equal((await stat(f.store.path)).mode & 0o777, 0o600);
  assert.equal((await stat(f.store.directory)).mode & 0o777, 0o700);
  const status = JSON.stringify(await f.auth.status()); assert.ok(!status.includes('private-access')); assert.ok(!status.includes('private-refresh')); assert.ok(!status.includes('id_token'));
  const again = await f.begin(); assert.equal(again.searchParams.get('client_id'), p.clientId); assert.equal(again.searchParams.get('ext_agent_host_id'), host); assert.equal(again.searchParams.has('agent_name_hint'), false);
});
test('callback verifies state before denial, rejects client substitution and consumes a code once', async t => {
  const f = await fixture(t), url = await f.begin();
  await assert.rejects(f.auth.callback(new URL('http://127.0.0.1:18762/auth/callback?state=wrong&error=access_denied')), /state/);
  assert.ok(f.auth.pending); const callback = await f.finish(url);
  await assert.rejects(f.auth.callback(callback), /state/);
  const again = await f.begin(); await assert.rejects(f.finish(again, { client_id: 'oaiapp_impostor' }), /身份/);
  assert.equal((await f.store.load()).profiles[0].clientId, 'oaiapp_test');
});
test('ID token signature, issuer, audience, nonce, expiry and identity are enforced', () => {
  const options = { jwks: { keys: [jwk] }, clientId: 'oaiapp_test', nonce: 'nonce', now: NOW };
  assert.equal(validateIdToken(jwt('oaiapp_test', 'nonce'), options).subject, 'account-one');
  for (const token of [jwt('other','nonce'), jwt('oaiapp_test','wrong'), jwt('oaiapp_test','nonce',{ iss: 'https://evil.invalid' }), jwt('oaiapp_test','nonce',{ exp: 1 }), jwt('oaiapp_test','nonce') + 'tampered']) assert.throws(() => validateIdToken(token, options), /身份验证失败/);
});
test('declining plan permission retains identity but prevents inference and model requests', async t => {
  const f = await fixture(t); f.setScopes('openid profile email offline_access'); await f.finish(await f.begin());
  assert.equal((await f.auth.status()).profiles[0].connected, true); assert.equal((await f.auth.status()).profiles[0].planEnabled, false);
  await assert.rejects(f.auth.access(), /允许使用套餐/); assert.ok(!f.calls.some(c => c.url.endsWith('/models')));
});
test('identity-only login without access or refresh tokens is retained and disabled for inference', async t => {
  const f = await fixture(t);
  f.auth.tokenRequest = async () => ({ id_token: jwt('oaiapp_test', f.auth.savedTestNonce), scope: 'openid email profile' });
  const url = await f.begin(); f.auth.savedTestNonce = url.searchParams.get('nonce'); await f.finish(url);
  const status = await f.auth.status(); assert.equal(status.profiles[0].connected, true); assert.equal(status.profiles[0].planEnabled, false);
  await assert.rejects(f.auth.access(), /允许使用套餐/);
});
test('multiple registrations stay separate and reauthorization rejects a different verified subject', async t => {
  const f = await fixture(t); await f.finish(await f.begin());
  const first = (await f.store.load()).profiles[0]; f.setClient('oaiapp_second'); await f.finish(await f.begin({ newProfile: true }));
  const state = await f.store.load(); assert.equal(state.profiles.length, 2); assert.notEqual(state.activeProfileId, first.id);
  await f.auth.select(first.id); assert.equal((await f.store.load()).activeProfileId, first.id);
  f.setClient(first.clientId); const url = await f.begin();
  const original = f.auth.identity.bind(f.auth); f.auth.identity = async (...args) => ({ ...await original(...args), subject: 'different-user' });
  await assert.rejects(f.finish(url), /账号与已保存/); assert.equal((await f.store.load()).profiles[0].subject, 'account-one');
});
test('two auth instances serialize rotating refresh and preserve credentials on transient failure', async t => {
  const f = await fixture(t); await f.finish(await f.begin());
  await f.store.transact(data => { data.profiles[0].expiresAt = NOW + 1000; });
  const second = new ChatGPTAuth({ store: new Store(f.store.directory), fetcher: f.fetcher, now: () => NOW });
  const values = await Promise.all([f.auth.access(), second.access(), f.auth.access()]);
  assert.equal(f.refreshes(), 1); assert.ok(values.every(v => v.token === 'private-access-1'));
  await f.store.transact(data => { data.profiles[0].expiresAt = NOW + 1000; }); f.setRefreshError('temporarily_unavailable');
  assert.equal((await f.auth.access()).token, 'private-access-1'); assert.equal((await f.store.load()).profiles[0].refresh_token, 'private-refresh-1');
  f.auth.refreshFailures.clear(); f.setRefreshError('invalid_grant'); await assert.rejects(f.auth.access(), /授权已失效/); assert.equal((await f.store.load()).profiles[0].access_token, undefined);
});
test('sign out revokes DSH refresh token, aborts streams and preserves reusable client registration', async t => {
  const f = await fixture(t); await f.finish(await f.begin()); const before = await f.store.load(); const signal = f.auth.requestController.signal;
  const result = await f.auth.signOut(before.activeProfileId); assert.equal(result.revoked, true); assert.equal(signal.aborted, true);
  const profile = (await f.store.load()).profiles[0]; assert.equal(profile.clientId, 'oaiapp_test'); assert.equal(profile.access_token, undefined); assert.equal(profile.id_token, undefined);
  const revoke = f.calls.find(c => c.url.endsWith('/revoke')); assert.equal(new URLSearchParams(revoke.body).get('client_id'), 'oaiapp_test');
});
test('public Responses payload omits unsupported fields and namespaces local tools', () => {
  const payload = planPayload({ input: [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'hello' }], store: true, stream: false,
    max_output_tokens: 512, temperature: 0.5, previous_response_id: 'old', tools: [{ type: 'function', name: 'echo', parameters: { type: 'object' } }] });
  assert.equal(payload.store, false); assert.equal(payload.stream, true); assert.equal(payload.input[0].role, 'developer');
  assert.equal('max_output_tokens' in payload, false); assert.equal('temperature' in payload, false); assert.equal('previous_response_id' in payload, false);
  assert.equal(payload.tools[0].type, 'namespace'); assert.equal(payload.tools[0].tools[0].name, 'echo');
  assert.throws(() => planPayload({ input: [], tools: [{ type: 'tool_search' }] }), /不支持工具/);
  const model = catalogModels([{ slug: 'visible', visibility: 'list', supported_reasoning_levels: [{ effort: 'xhigh' }] }])[0];
  assert.equal(model.baseUrl, RESOURCE); assert.equal(model.api, 'openai-responses'); assert.equal(model.thinkingLevelMap.xhigh, 'xhigh'); assert.equal(model.thinkingLevelMap.max, null);
});
test('management endpoint blocks cross-origin mutations, missing CSRF and malicious Host', async t => {
  const f = await fixture(t), manager = await startManagement(f.auth, { port: 0 }); t.after(() => manager.close());
  const r = await fetch(manager.origin); assert.equal(r.status, 200); assert.ok((await r.text()).includes('Continue with ChatGPT'));
  assert.equal((await fetch(manager.origin + '/api/status')).status, 403);
  assert.equal((await fetch(manager.origin + '/api/status', { headers: { 'X-DSH-CSRF': manager.csrf } })).status, 200);
  assert.equal((await fetch(manager.origin + '/api/cancel', { method: 'POST', headers: { Origin: 'https://evil.invalid', 'X-DSH-CSRF': manager.csrf }, body: '{}' })).status, 403);
  assert.equal((await fetch(manager.origin + '/api/cancel', { method: 'POST', headers: { Origin: manager.origin }, body: '{}' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => { const r = request(manager.origin + '/api/status', { headers: { Host: 'evil.invalid', 'X-DSH-CSRF': manager.csrf } }, res => { res.resume(); resolve(res.statusCode); }); r.on('error', reject); r.end(); });
  assert.equal(hostStatus, 403);
  const result = await fetch(manager.origin + '/oauth/start', { method: 'POST', redirect: 'manual', headers: { Origin: manager.origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: manager.csrf, newProfile: 'true' }) });
  assert.equal(result.status, 303); assert.equal(new URL(result.headers.get('location')).hostname, 'auth.openai.com');
});

test('two different ChatGPT identities retain separate models and labels; sign-out never falls back to another account', async t => {
  const f = await fixture(t); await f.finish(await f.begin());
  const first = (await f.store.load()).profiles[0];
  f.setClient('oaiapp_second'); f.setIdentity({ sub: 'account-two', email: 'second@example.invalid' }); f.setModel('second-model');
  await f.finish(await f.begin({ newProfile: true }));
  const second = (await f.store.load()).profiles[1];
  assert.notEqual(first.subject, second.subject); assert.notEqual(first.email, second.email);
  assert.equal(first.models[0].slug, 'gpt-test'); assert.equal(second.models[0].slug, 'second-model');
  await f.auth.rename(first.id, '个人 Pro'); await f.auth.rename(second.id, '工作账号');
  const signal = f.auth.requestController.signal;
  await f.auth.select(first.id); assert.equal(signal.aborted, true);
  assert.equal((await f.auth.access()).profileId, first.id);
  assert.equal((await f.auth.status()).profiles[1].label, '工作账号');
  await f.auth.signOut(first.id);
  await assert.rejects(f.auth.access(), /登录/);
  assert.equal((await f.auth.access(second.id)).profileId, second.id);
  assert.equal((await f.store.load()).profiles[1].clientId, 'oaiapp_second');
  await f.auth.select(second.id);
  assert.equal((await f.auth.access()).profileId, second.id);
  const reloaded = new ChatGPTAuth({ store: new Store(f.store.directory), fetcher: f.fetcher, now: () => NOW });
  assert.equal((await reloaded.status()).profiles.length, 2);
  assert.equal((await reloaded.status()).profiles[0].label, '个人 Pro');
});

test('repeated client ids are rejected before exchanging a code', async t => {
  const f = await fixture(t), url = await f.begin();
  const callback = new URL('http://127.0.0.1:18762/auth/callback');
  callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'one-use', client_id: 'oaiapp_test' });
  callback.searchParams.append('client_id', 'oaiapp_other');
  await assert.rejects(f.auth.callback(callback), /身份/);
  assert.ok(!f.calls.some(c => c.url === TOKEN));
});

test('near-expiry requests keep running while a single background refresh rotates credentials', async t => {
  const f = await fixture(t); await f.finish(await f.begin());
  await f.store.transact(data => { data.profiles[0].expiresAt = NOW + 180000; });
  let release, started;
  const reached = new Promise(r => started = r), gate = new Promise(r => release = r);
  const original = f.auth.tokenRequest.bind(f.auth);
  f.auth.tokenRequest = async params => { started(); await gate; return original(params); };
  const results = await Promise.all([f.auth.access(), f.auth.access(), f.auth.access()]);
  assert.ok(results.every(r => r.token === 'private-access-0'));
  await reached; const work = [...f.auth.refreshes.values()]; release(); await Promise.all(work);
  assert.equal(f.refreshes(), 1);
  assert.equal((await f.auth.access()).token, 'private-access-1');
});

test('transient refresh backoff never serves an expired token and recovers after retry delay', async t => {
  const f = await fixture(t); await f.finish(await f.begin());
  await f.store.transact(data => { data.profiles[0].expiresAt = NOW + 1000; });
  f.setRefreshError('temporarily_unavailable');
  assert.equal((await f.auth.access()).token, 'private-access-0');
  assert.equal((await f.auth.access()).token, 'private-access-0'); assert.equal(f.refreshes(), 1);
  f.setNow(NOW + 2000); await assert.rejects(f.auth.access(), /temporarily_unavailable/);
  f.setRefreshError(undefined); f.setNow(NOW + 61000);
  assert.equal((await f.auth.access()).token, 'private-access-2');
  assert.equal(f.auth.refreshFailures.size, 0);
});

test('earliest_refresh_at prevents premature forced renewal', async t => {
  const f = await fixture(t); await f.finish(await f.begin());
  await f.store.transact(data => { data.profiles[0].expiresAt = NOW + 1000; data.profiles[0].earliestRefreshAt = NOW + 500; });
  assert.equal((await f.auth.access()).token, 'private-access-0');
  await assert.rejects(f.auth.access(undefined, { force: true }), /尚未允许/);
  assert.equal(f.refreshes(), 0);
});

test('an inference 401 forces one refresh and replays the same body exactly once', async t => {
  const f = await fixture(t); await f.finish(await f.begin());
  const id = (await f.store.load()).activeProfileId, calls = [];
  f.auth.fetcher = async (input, init) => {
    if (!(input instanceof Request)) return f.fetcher(input, init);
    calls.push({ authorization: input.headers.get('authorization'), body: await input.text(), url: input.url });
    return new Response(calls.length === 1 ? 'unauthorized' : 'stream', { status: calls.length === 1 ? 401 : 200 });
  };
  const body = JSON.stringify({ model: 'gpt-test', input: [], stream: true });
  const response = await f.auth.fetchInference(id, `${RESOURCE}/responses`, { method: 'POST', body });
  assert.equal(response.status, 200); assert.equal(calls.length, 2); assert.equal(f.refreshes(), 1);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].authorization, 'Bearer private-access-0'); assert.equal(calls[1].authorization, 'Bearer private-access-1');
  calls.length = 0;
  f.auth.fetcher = async (input, init) => {
    if (!(input instanceof Request)) return f.fetcher(input, init);
    calls.push(input.url); return new Response('unauthorized', { status: 401 });
  };
  assert.equal((await f.auth.fetchInference(id, `${RESOURCE}/responses`, { method: 'POST', body })).status, 401);
  assert.equal(calls.length, 2);
});

test('quota and successful stream responses are never replayed by auth', async t => {
  const f = await fixture(t); await f.finish(await f.begin());
  const id = (await f.store.load()).activeProfileId;
  for (const status of [200, 429, 500]) {
    let calls = 0;
    f.auth.fetcher = async () => { calls++; return new Response('response', { status }); };
    const response = await f.auth.fetchInference(id, `${RESOURCE}/responses`, { method: 'POST', body: '{}' });
    assert.equal(response.status, status); assert.equal(calls, 1);
  }
});

test('cancel while authorization is exchanging cannot reactivate an account', async t => {
  const f = await fixture(t), url = await f.begin();
  const original = f.auth.tokenRequest.bind(f.auth);
  f.auth.tokenRequest = async params => { const token = await original(params); f.auth.cancel(); return token; };
  await assert.rejects(f.finish(url), /取消/);
  const state = await f.store.load();
  assert.equal(state.activeProfileId, null); assert.equal(state.profiles[0].access_token, undefined);
});

test('private storage rejects symlinks, broad permissions and non-file credentials', async t => {
  const f = await fixture(t), target = join(f.store.directory, 'target.json');
  const original = await readFile(f.store.path, 'utf8'); await writeFile(target, original, { mode: 0o600 });
  await rm(f.store.path); await symlink(target, f.store.path);
  await assert.rejects(f.store.load(), /安全读取/);
  await rm(f.store.path); await writeFile(f.store.path, original, { mode: 0o600 }); await chmod(f.store.path, 0o644);
  await assert.rejects(f.store.load(), /独占/); await chmod(f.store.path, 0o600);
  await rm(f.store.path); await mkdir(f.store.path);
  await assert.rejects(f.store.load(), /普通文件/);
});

test('profile isolation and one-time desktop migration move rather than duplicate credentials', async t => {
  const f = await fixture(t); await f.finish(await f.begin());
  const root = join(f.store.directory, 'profiles');
  const desktop = profileStorage(new URL(`file://${root}/desktop/`).href, f.store.directory);
  const web = profileStorage(new URL(`file://${root}/web/`).href, f.store.directory);
  assert.notEqual(desktop.directory, web.directory); assert.equal(web.legacyDirectory, undefined);
  const destination = new Store(desktop.directory), source = await f.store.load();
  assert.equal(await destination.migrateLegacy(desktop.legacyDirectory), true);
  assert.equal(await readPrivateFile(f.store.path), undefined);
  assert.equal((await destination.load()).hostId, source.hostId);
  assert.equal((await destination.load()).profiles[0].refresh_token, source.profiles[0].refresh_token);
  assert.equal(await destination.migrateLegacy(desktop.legacyDirectory), false);
  const other = new Store(web.directory); await other.transact(() => {});
  assert.equal((await other.load()).profiles.length, 0); assert.notEqual((await other.load()).hostId, source.hostId);
});

test('management instances use different ports when the preferred port is occupied', async t => {
  const first = await fixture(t), second = await fixture(t);
  const a = await startManagement(first.auth, { port: 0, profile: 'desktop' }); t.after(() => a.close());
  const b = await startManagement(second.auth, { port: Number(new URL(a.origin).port), profile: 'web' }); t.after(() => b.close());
  assert.notEqual(a.origin, b.origin);
  const status = await (await fetch(b.origin + '/api/status', { headers: { 'X-DSH-CSRF': b.csrf } })).json();
  assert.equal(status.profile, 'web');
});

test('proxy configuration stays private and uses only plugin-owned dispatchers', async t => {
  const f = await fixture(t), sent = [], agents = [];
  class Agent { constructor(options) { this.options = options; agents.push(this); } async close() { this.closed = true; } }
  const network = new Network({ directory: f.store.directory, env: { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'example.invalid' },
    agents: async () => ({ Agent, ProxyAgent: Agent, EnvHttpProxyAgent: Agent }),
    fetcher: async (url, init) => { sent.push({ url, init }); return new Response('ok'); } });
  t.after(() => network.close()); await network.initialize();
  await network.fetch(`${RESOURCE}/models`);
  assert.equal(sent[0].init.dispatcher.options.httpsProxy, 'http://127.0.0.1:7890');
  assert.equal(sent[0].init.dispatcher.options.noProxy, 'example.invalid');
  await network.configure({ mode: 'proxy', proxyUrl: 'http://127.0.0.1:8888' });
  await network.fetch(`${RESOURCE}/models`); assert.equal(sent[1].init.dispatcher.options, 'http://127.0.0.1:8888');
  await network.configure({ mode: 'direct' }); await network.fetch(`${RESOURCE}/models`);
  assert.equal(sent[2].init.dispatcher.options, undefined);
  await network.fetch('http://127.0.0.1:9876/'); assert.equal(sent[3].init.dispatcher, undefined);
  assert.equal((await stat(network.path)).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(network.status()).includes('7890'), false);
  for (const proxyUrl of ['socks5://localhost:1', 'http://user:secret@localhost:1', 'https://localhost/path']) assert.throws(() => validateNetwork({ mode: 'proxy', proxyUrl }));
  const restored = new Network({ directory: f.store.directory }); await restored.initialize(); assert.equal(restored.status().mode, 'direct');
  const broken = new Network({ directory: f.store.directory, agents: async () => { throw new Error('proxy-password-must-stay-private'); } });
  await assert.rejects(broken.fetch(`${RESOURCE}/models`), error => /检查网络/.test(error.message) && !error.message.includes('proxy-password'));
});

test('account and network management actions require the same local CSRF checks', async t => {
  const f = await fixture(t); await f.finish(await f.begin());
  const network = new Network({ directory: f.store.directory });
  const manager = await startManagement(f.auth, { port: 0, network }); t.after(() => manager.close());
  const post = (path, data, csrf = manager.csrf) => fetch(manager.origin + path, { method: 'POST', headers: { Origin: manager.origin, 'Content-Type': 'application/json', 'X-DSH-CSRF': csrf }, body: JSON.stringify(data) });
  const id = (await f.store.load()).activeProfileId;
  assert.equal((await post('/api/rename', { id, label: 'Personal' })).status, 200);
  assert.equal((await post('/api/network', { mode: 'direct' })).status, 200);
  assert.equal((await post('/api/network', { mode: 'proxy', proxyUrl: 'http://localhost:7890' }, 'wrong')).status, 403);
  assert.equal(network.status().mode, 'direct');
  assert.equal((await f.auth.status()).profiles[0].label, 'Personal');
  const html = managementHtml({ csrf: 'test', nonce: 'test' });
  new Script(html.match(/<script nonce="test">([\s\S]*?)<\/script>/)[1]);
});
