import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import * as responses from '@earendil-works/pi-ai/api/openai-responses';
import { ChatGPTAuth } from './oauth.mjs';
import { createAdapter, PROVIDER } from './adapter.mjs';
import { startManagement } from './management.mjs';
import { Store, profileStorage } from './storage.mjs';
import { Network } from './network.mjs';
export const name = 'chatgpt-plan';
export const inject = ['llm'];
export async function apply(ctx) {
  const location = profileStorage(ctx.baseUrl);
  const store = new Store(location.directory);
  await store.migrateLegacy(location.legacyDirectory);
  const network = new Network({ directory: location.directory });
  await network.initialize();
  const auth = new ChatGPTAuth({ store, fetcher: network.fetch });
  let management;
  try { management = await startManagement(auth, { network, profile: location.profile }); }
  catch (error) { await network.close(); throw error; }
  ctx.on('dispose', () => { management.close(); void network.close(); });
  const adapter = createAdapter({ PiAiAdapter, responses, resolveImageAttachmentAccess }, auth, ctx);
  const disposeAdapter = ctx.llm.registerAdapter([PROVIDER], adapter);
  // Model-picker clients refresh on the same event as native provider updates.
  auth.onChange = () => disposeAdapter.replace([PROVIDER]);
  ctx.on('webserver/index-inject', table => table.push({ kind: 'global', name: '__DSH_CHATGPT_PLAN__', value: { origin: management.origin, csrf: management.csrf } }));
  ctx.on('dispose', () => disposeAdapter?.());
}
