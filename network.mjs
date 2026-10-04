import { join } from 'node:path';
import { readPrivateFile, writePrivateFile } from './storage.mjs';

export function validateNetwork(value = {}) {
  const mode = value.mode || 'system';
  if (!['system', 'direct', 'proxy'].includes(mode)) throw new Error('网络模式必须是 system、direct 或 proxy。');
  if (mode !== 'proxy') return { mode };
  let url;
  try { url = new URL(value.proxyUrl); } catch { throw new Error('请输入完整的 HTTP(S) 代理地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('代理地址仅支持 HTTP(S) 主机与端口；请勿包含账号、密码、路径或查询参数。');
  }
  return { mode, proxyUrl: url.origin };
}

/** A dispatcher owned by this plugin; never changes the process-wide fetch. */
export class Network {
  constructor({ directory, fetcher = fetch, env = process.env, agents = () => import('undici') } = {}) {
    this.path = join(directory, 'network.json'); this.fetcher = fetcher; this.env = env; this.agents = agents;
    this.config = { mode: 'system' }; this.retired = []; this.pendingDispatcher = null;
  }
  async initialize() {
    const text = await readPrivateFile(this.path);
    if (text !== undefined) this.config = validateNetwork(JSON.parse(text));
  }
  status() { return { ...this.config }; }
  async configure(value) {
    const next = validateNetwork(value);
    await writePrivateFile(this.path, JSON.stringify(next));
    if (this.pendingDispatcher) this.retired.push(this.pendingDispatcher);
    this.pendingDispatcher = null; this.config = next;
    // close() drains active requests before releasing an old agent.
    for (const pending of this.retired.splice(0)) void pending.then(a => a?.close()).catch(() => {});
    return this.status();
  }
  async dispatcher() {
    const env = this.env;
    if (!this.pendingDispatcher) {
      const config = this.config;
      const pending = this.agents().then(({ Agent, ProxyAgent, EnvHttpProxyAgent }) => config.mode === 'direct' ? new Agent() : config.mode === 'proxy'
        ? new ProxyAgent(config.proxyUrl)
        : new EnvHttpProxyAgent({ httpProxy: env.http_proxy || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY || '',
          httpsProxy: env.https_proxy || env.HTTPS_PROXY || env.all_proxy || env.ALL_PROXY || '',
          noProxy: env.no_proxy || env.NO_PROXY || '' }));
      this.pendingDispatcher = pending;
      pending.catch(() => { if (this.pendingDispatcher === pending) this.pendingDispatcher = null; });
    }
    return this.pendingDispatcher;
  }
  fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    try {
      const dispatcher = loopback ? undefined : await this.dispatcher();
      return await this.fetcher(input, { ...init, ...(dispatcher ? { dispatcher } : {}), redirect: 'error' });
    }
    catch (error) {
      if (init.signal?.aborted || (input instanceof Request && input.signal.aborted)) throw error;
      throw new Error('连接 OpenAI 失败，请检查网络或插件代理设置。');
    }
  };
  async close() {
    const pending = [...this.retired, this.pendingDispatcher].filter(Boolean);
    this.retired = []; this.pendingDispatcher = null;
    await Promise.allSettled(pending.map(async p => (await p)?.close()));
  }
}
