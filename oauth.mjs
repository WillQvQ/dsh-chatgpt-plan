import { randomBytes, createHash, createPublicKey, verify, timingSafeEqual } from 'node:crypto';
import { Store } from './storage.mjs';
export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
export const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
export const USAGE_URL = 'https://chatgpt.com/settings/usage';
const random = () => randomBytes(32).toString('base64url');
export const equalSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const field = (value, label) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`OpenAI 登录响应缺少 ${label}。`); return value; };
const terminalRefresh = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
const clearTokens = profile => { for (const key of ['access_token', 'refresh_token', 'id_token', 'expiresAt', 'earliestRefreshAt', 'scopes']) delete profile[key]; profile.models = []; };

export function validateIdToken(jwt, { jwks, clientId, nonce, now = Date.now() }) {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new Error();
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    if (!['RS256', 'ES256'].includes(header.alg) || typeof header.kid !== 'string') throw new Error();
    const matches = jwks.keys.filter(key => key.kid === header.kid && (!key.alg || key.alg === header.alg) && (!key.use || key.use === 'sig'));
    if (matches.length !== 1 || matches[0].kty !== (header.alg === 'RS256' ? 'RSA' : 'EC')) throw new Error();
    const key = createPublicKey({ key: matches[0], format: 'jwk' });
    const options = header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key;
    if (!verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), options, Buffer.from(parts[2], 'base64url'))) throw new Error();
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== ISSUER || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId) || (claims.azp && claims.azp !== clientId)) throw new Error();
    if (typeof claims.sub !== 'string' || !claims.sub || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now) throw new Error();
    if (Number.isFinite(claims.nbf) && claims.nbf * 1000 > now + 60000) throw new Error();
    if (nonce !== undefined && !equalSecret(claims.nonce, nonce)) throw new Error();
    return { issuer: claims.iss, subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : undefined };
  } catch { const error = new Error('OpenAI 身份验证失败（签名、账号、有效期或 nonce 不匹配），未保存登录凭证。'); error.integrity = true; throw error; }
}

export class ChatGPTAuth {
  constructor({ store = new Store(), fetcher = fetch, now = Date.now, onChange = () => {} } = {}) {
    this.store = store; this.fetcher = fetcher; this.now = now; this.onChange = onChange; this.pending = null;
    this.requestController = new AbortController(); this.notice = ''; this.generation = 0; this.loginRevision = 0;
    this.refreshes = new Map(); this.refreshFailures = new Map(); this.preemptMs = 300000;
  }
  changed() { this.requestController.abort(); this.requestController = new AbortController(); this.generation++; this.onChange(); }
  async request(url, options = {}) {
    try { return await this.fetcher(url, { ...options, redirect: 'error', signal: options.signal || AbortSignal.timeout(25000) }); }
    catch (error) {
      if (options.signal?.aborted || (url instanceof Request && url.signal.aborted)) throw error;
      throw new Error('连接 OpenAI 失败，请检查网络后重试；现有登录已保留。');
    }
  }
  async metadata() {
    if (!this.discovery) {
      const res = await this.request(`${ISSUER}/.well-known/openid-configuration`);
      if (!res.ok) throw new Error('无法获取 OpenAI 身份验证配置。');
      const data = await res.json();
      if (data.issuer !== ISSUER || new URL(data.jwks_uri).origin !== ISSUER || new URL(data.revocation_endpoint).origin !== ISSUER) throw new Error('OpenAI 身份验证地址不符合预期。');
      this.discovery = data;
    }
    return this.discovery;
  }
  async identity(token, clientId, nonce) {
    const meta = await this.metadata();
    const res = await this.request(meta.jwks_uri);
    if (!res.ok) throw new Error('无法获取 OpenAI 签名公钥。');
    return validateIdToken(field(token, 'id_token'), { jwks: await res.json(), clientId, nonce, now: this.now() });
  }
  async tokenRequest(params) {
    const res = await this.request(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    let data; try { data = await res.json(); } catch { throw new Error(`OpenAI 登录服务返回无效响应（${res.status}）。`); }
    if (!res.ok) {
      const rawCode = typeof data.error === 'string' ? data.error : data.error?.code;
      const code = typeof rawCode === 'string' && /^[a-z_]{1,80}$/.test(rawCode) ? rawCode : 'oauth_request_failed';
      const error = new Error(`OpenAI 登录请求失败（${res.status}, ${code}）。请重试登录。`); error.code = code; throw error;
    }
    return data;
  }
  credentials(token, previous) {
    const expires = token.expires_in;
    const scopes = typeof token.scope === 'string' ? token.scope.split(/\s+/).filter(Boolean) : previous?.scopes;
    if (!Array.isArray(scopes)) throw new Error('OpenAI 登录响应缺少授权权限。');
    // Identity-only consent is still a valid sign-in, but must never enable inference.
    if (!scopes.includes(PLAN_SCOPE)) return {
      scopes, id_token: token.id_token || previous?.id_token,
      ...(typeof token.access_token === 'string' ? { access_token: token.access_token } : {}),
      ...(typeof token.refresh_token === 'string' ? { refresh_token: token.refresh_token } : {}),
      expiresAt: Number.isFinite(expires) && expires > 0 ? this.now() + expires * 1000 : 0,
    };
    if (!Number.isFinite(expires) || expires <= 0 || token.token_type?.toLowerCase() !== 'bearer') throw new Error('OpenAI 登录响应的有效期或 token_type 无效。');
    const earliest = typeof token.earliest_refresh_at === 'number' ? token.earliest_refresh_at * 1000 : Date.parse(token.earliest_refresh_at);
    return { access_token: field(token.access_token, 'access_token'), refresh_token: field(token.refresh_token, 'refresh_token'), id_token: token.id_token || previous?.id_token,
      expiresAt: this.now() + expires * 1000, earliestRefreshAt: Number.isFinite(earliest) ? earliest : 0, scopes, token_type: 'Bearer' };
  }
  async initialize() { await this.store.transact(() => {}); }
  async status() {
    const data = await this.store.load();
    return { activeProfileId: data.activeProfileId, pending: !!this.pending && this.pending.expiresAt > this.now(), notice: this.notice,
      profiles: data.profiles.map(p => ({ id: p.id, clientId: p.clientId, label: p.label || '', email: p.email, connected: !!(p.id_token || p.access_token), planEnabled: !!p.access_token && !!p.scopes?.includes(PLAN_SCOPE), models: (p.models || []).map(m => ({ slug: m.slug, display_name: m.display_name })), expiresAt: p.expiresAt,
        refreshWarning: this.refreshFailures.has(p.id) ? (p.expiresAt > this.now() ? '暂时无法续期；仍有效的登录可继续使用，稍后会重试。' : '登录已到期，续期暂时失败；请检查网络后重试。') : '' })) };
  }
  async begin({ redirectUri, profileId, newProfile = false, enablePlan = false } = {}) {
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || redirect.pathname !== '/auth/callback') throw new Error('登录回调必须使用 127.0.0.1。');
    if (this.pending && this.pending.expiresAt > this.now()) throw new Error('已有登录等待浏览器确认，请完成或取消后重试。');
    const data = await this.store.load();
    const profile = newProfile ? null : data.profiles.find(p => p.id === (profileId || data.activeProfileId));
    if (profileId && !profile) throw new Error('所选登录记录不存在。');
    const attempt = { state: random(), nonce: random(), verifier: random(), redirectUri, profileId: profile?.id, clientId: profile?.clientId,
      hostId: data.hostId, expiresAt: this.now() + 10 * 60000, revision: ++this.loginRevision };
    const params = new URLSearchParams({ client_id: profile?.clientId || 'dynamic_agent_client', ext_agent_host_id: data.hostId, response_type: 'code', redirect_uri: redirectUri,
      resource: RESOURCE, scope: SCOPES, state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url') });
    if (!profile) params.set('agent_name_hint', 'DeepSeek Harness');
    if (profile?.id_token) params.set('id_token_hint', profile.id_token);
    if (profile?.email) params.set('login_hint', profile.email);
    if (enablePlan && profile) params.set('prompt', 'consent');
    this.pending = attempt; this.notice = '';
    return `${AUTHORIZE}?${params}`;
  }
  cancel() { this.pending = null; this.loginRevision++; }
  async callback(url) {
    const attempt = this.pending;
    if (!attempt || attempt.expiresAt <= this.now() || url.searchParams.getAll('state').length !== 1 || !equalSecret(url.searchParams.get('state'), attempt.state)) throw new Error('登录请求已过期或 state 不匹配，请重新开始登录。');
    this.pending = null;
    if (url.searchParams.has('error')) throw new Error('你取消了 OpenAI 授权，未更改当前账号。');
    const supplied = url.searchParams.get('client_id');
    const clientId = attempt.clientId || supplied;
    if (url.searchParams.getAll('client_id').length > 1 || !clientId || !/^oaiapp_[A-Za-z0-9_-]{1,190}$/.test(clientId) || (attempt.clientId && supplied && supplied !== attempt.clientId)) throw new Error('OpenAI 回调的应用身份不匹配。');
    if (url.searchParams.getAll('code').length !== 1) throw new Error('OpenAI 返回了重复或缺失的授权码。');
    const code = field(url.searchParams.get('code'), 'authorization code');
    const id = createHash('sha256').update(clientId).digest('hex').slice(0,24);
    // Retain the issued registration even if code exchange fails. No tokens are saved yet.
    await this.store.transact(data => {
      if (!data.profiles.some(p => p.clientId === clientId)) data.profiles.push({ id, clientId, models: [] });
    });
    const token = await this.tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE });
    const identity = await this.identity(token.id_token, clientId, attempt.nonce);
    const credentials = this.credentials(token);
    await this.store.transact(data => {
      if (attempt.revision !== this.loginRevision) throw new Error('登录已取消或账号已切换，未替换当前登录。');
      const profile = data.profiles.find(p => p.clientId === clientId);
      if (profile.subject && (profile.subject !== identity.subject || profile.issuer !== identity.issuer)) throw new Error('重新登录的账号与已保存注册不一致，未替换原凭证。');
      clearTokens(profile);
      Object.assign(profile, identity, credentials, { models: [] }); data.activeProfileId = profile.id;
    });
    this.refreshFailures.delete(id); this.changed();
    if (credentials.scopes.includes(PLAN_SCOPE)) {
      try { await this.refreshModels(); this.notice = '已连接 ChatGPT 套餐。可以返回 DeepSeek Harness 选择模型。'; }
      catch (error) { this.notice = `登录成功，但模型列表获取失败。${error.message}`; }
    } else this.notice = '已登录，但尚未允许使用 ChatGPT 套餐。请点击“授权套餐使用”。';
  }
  async current(profileId) {
    const data = await this.store.load();
    const profile = data.profiles.find(p => p.id === (profileId || data.activeProfileId));
    if (!profile?.access_token || !profile.scopes?.includes(PLAN_SCOPE)) throw new Error('请在 DSH 设置 → ChatGPT 套餐中登录并允许使用套餐。');
    return profile;
  }
  result(profile) {
    if (!profile?.access_token || !profile.scopes?.includes(PLAN_SCOPE)) throw new Error('ChatGPT 套餐权限未启用，请重新授权。');
    if (profile.expiresAt <= this.now()) throw new Error('ChatGPT 登录已到期，请稍后重试或重新登录。');
    return { token: profile.access_token, profileId: profile.id };
  }
  async refresh(profileId, { force = false, failedToken } = {}) {
    if (this.refreshes.has(profileId)) return this.refreshes.get(profileId);
    const work = this.store.transact(async data => {
      const profile = data.profiles.find(p => p.id === profileId);
      if (!profile?.access_token || !profile.scopes?.includes(PLAN_SCOPE)) return { error: '请重新登录并允许使用 ChatGPT 套餐。', terminal: true };
      // Another process may already have rotated the token while we waited for the lock.
      if ((force && failedToken && failedToken !== profile.access_token) || (!force && profile.expiresAt > this.now() + this.preemptMs)) return { ...profile };
      if (profile.earliestRefreshAt > this.now()) {
        if (force || profile.expiresAt <= this.now()) return { error: 'OpenAI 尚未允许续期，请稍后重试。' };
        return { ...profile };
      }
        try {
          const token = await this.tokenRequest({ grant_type: 'refresh_token', client_id: profile.clientId, refresh_token: profile.refresh_token, resource: RESOURCE });
          if (token.id_token) {
            const identity = await this.identity(token.id_token, profile.clientId);
            if (identity.subject !== profile.subject || identity.issuer !== profile.issuer) { const e = new Error('刷新返回了不同账号，已拒绝更新。'); e.integrity = true; throw e; }
          }
          Object.assign(profile, this.credentials(token, profile));
        } catch (error) {
          if (terminalRefresh.has(error.code)) { clearTokens(profile); if (data.activeProfileId === profile.id) this.changed(); return { error: 'ChatGPT 授权已失效，请重新登录 DSH。', terminal: true }; }
          throw error;
        }
      if (!profile.scopes?.includes(PLAN_SCOPE)) { profile.models = []; if (data.activeProfileId === profile.id) this.changed(); return { error: 'ChatGPT 套餐权限未启用，请重新授权。', terminal: true }; }
      return { ...profile };
    }).then(value => {
      if (value.error) { const error = new Error(value.error); error.terminal = value.terminal; throw error; }
      this.refreshFailures.delete(profileId); return value;
    }).catch(error => {
      if (!error.terminal && !error.integrity) this.refreshFailures.set(profileId, { until: this.now() + 60000, error });
      throw error;
    }).finally(() => { if (this.refreshes.get(profileId) === work) this.refreshes.delete(profileId); });
    this.refreshes.set(profileId, work);
    return work;
  }
  async access(profileId, options = {}) {
    const profile = await this.current(profileId), remaining = profile.expiresAt - this.now();
    if (!options.force) {
      if (remaining > this.preemptMs || (remaining > 0 && profile.earliestRefreshAt > this.now())) return this.result(profile);
      const failed = this.refreshFailures.get(profile.id);
      if (failed?.until > this.now()) {
        if (remaining > 0) return this.result(profile);
        throw failed.error;
      }
      if (remaining > 30000) { void this.refresh(profile.id).catch(() => {}); return this.result(profile); }
    }
    try { return this.result(await this.refresh(profile.id, options)); }
    catch (error) {
      if (!options.force && !error.terminal && !error.integrity) {
        const current = await this.current(profile.id);
        if (current.expiresAt > this.now()) return this.result(current);
      }
      throw error;
    }
  }
  /** Retry a rejected request once after refresh; never replay a started stream. */
  async fetchInference(profileId, input, init) {
    const template = new Request(input, init);
    template.signal.throwIfAborted();
    if (template.url !== `${RESOURCE}/responses`) throw new Error('ChatGPT 套餐请求地址不符合预期。');
    const send = async token => {
      template.signal.throwIfAborted();
      const headers = new Headers(template.headers); headers.set('authorization', `Bearer ${token}`);
      return this.request(new Request(template.clone(), { headers }), { signal: template.signal });
    };
    const access = await this.access(profileId);
    const response = await send(access.token);
    if (response.status !== 401) return response;
    template.signal.throwIfAborted();
    let rotated;
    try { rotated = await this.access(profileId, { force: true, failedToken: access.token }); }
    catch { return response; }
    await response.body?.cancel();
    return send(rotated.token);
  }
  async refreshModels() {
    const access = await this.access();
    const res = await this.request(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${access.token}` } });
    if (!res.ok) throw new Error(`OpenAI 模型列表请求失败（${res.status}）。`);
    const data = await res.json();
    if (!Array.isArray(data.models)) throw new Error('OpenAI 模型目录格式不符合套餐接口。');
    const models = data.models.filter(m => m.visibility === 'list' && typeof m.slug === 'string').map(m => ({ slug: m.slug, display_name: m.display_name, visibility: 'list', context_window: m.context_window, input_modalities: m.input_modalities, supported_reasoning_levels: m.supported_reasoning_levels }));
    await this.store.transact(state => { const p = state.profiles.find(p => p.id === access.profileId); if (p?.access_token) p.models = models; });
    this.onChange(); return models;
  }
  async select(id) {
    await this.store.transact(data => { if (!data.profiles.some(p => p.id === id)) throw new Error('登录记录不存在。'); data.activeProfileId = id; });
    this.cancel(); this.changed();
  }
  async rename(id, label) {
    if (typeof label !== 'string' || label.length > 64 || /[\x00-\x1f\x7f]/.test(label)) throw new Error('账号备注最多 64 个字符，不能包含控制字符。');
    await this.store.transact(data => { const p = data.profiles.find(p => p.id === id); if (!p) throw new Error('登录记录不存在。'); p.label = label.trim(); });
    this.onChange();
  }
  async signOut(id) {
    this.cancel(); this.changed();
    let revoked = true;
    await this.store.transact(async data => {
      const profile = data.profiles.find(p => p.id === id);
      if (!profile) throw new Error('登录记录不存在。');
      if (profile.refresh_token) {
        revoked = false;
        try {
          const meta = await this.metadata();
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const res = await this.request(meta.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: profile.refresh_token, token_type_hint: 'refresh_token', client_id: profile.clientId }), signal: AbortSignal.timeout(5000) });
              if (res.status === 200) { revoked = true; break; }
              if (res.status < 500) break;
            } catch {}
            await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
          }
        } catch {}
      }
      clearTokens(profile);
    });
    this.refreshFailures.delete(id);
    this.notice = revoked ? '已退出登录，保留应用注册供以后登录使用。' : '已清除本地登录；远程撤销未确认，请在 ChatGPT 设置中断开此应用。';
    this.onChange(); return { revoked };
  }
}
