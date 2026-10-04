import { readPrivateFileSync } from './storage.mjs';
import { PLAN_SCOPE, RESOURCE } from './oauth.mjs';
export const PROVIDER = 'chatgpt-plan';
export const DISPLAY_NAME = 'ChatGPT 套餐（独立授权）';
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const UNSUPPORTED = ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'prompt_cache_options', 'service_tier', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id'];

/** Enforce the documented direct-plan route contract after pi-ai builds a request. */
export function planPayload(input) {
  const out = { ...input, store: false, stream: true };
  for (const key of UNSUPPORTED) delete out[key];
  if (!Array.isArray(out.input)) throw new Error('ChatGPT 套餐请求必须携带完整消息数组。');
  out.input = out.input.map(item => item.role === 'system' ? { ...item, role: 'developer' } : item);
  if (out.tools?.length) {
    const functions = [], rest = [];
    for (const tool of out.tools) {
      if (tool.type === 'function' || tool.type === 'custom') functions.push(tool);
      else if (tool.type === 'namespace' && tool.tools?.every(t => ['function', 'custom'].includes(t.type))) rest.push(tool);
      else throw new Error(`ChatGPT 套餐不支持工具类型 ${String(tool.type)}。`);
    }
    out.tools = [...rest, ...(functions.length ? [{ type: 'namespace', name: 'dsh', description: 'Local DeepSeek Harness tools', tools: functions }] : [])];
  }
  return out;
}

export function catalogModels(entries) {
  return entries.filter(m => m.visibility === 'list').map(entry => {
    const levels = new Set((entry.supported_reasoning_levels || []).map(x => x.effort));
    return { id: entry.slug, name: entry.display_name || entry.slug, provider: PROVIDER, api: 'openai-responses', baseUrl: RESOURCE,
      contextWindow: Number.isSafeInteger(entry.context_window) && entry.context_window > 0 ? entry.context_window : 128000,
      maxTokens: 32000, input: entry.input_modalities?.includes('image') ? ['text', 'image'] : ['text'],
      reasoning: levels.size > 0, thinkingLevelMap: Object.fromEntries(LEVELS.map(level => [level, levels.has(level) ? level : null])),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // Allow pi-ai to emit its default `strict: false`. Disabling this
      // capability omits the flag; Responses then normalizes optional tool
      // parameters into required ones (e.g. edit-only fields on goal resume).
      compat: { supportsDeveloperRole: true, supportsMaxOutputTokens: false, supportsLongCacheRetention: false, supportsStrictMode: true, supportsToolSearch: false, supportsAdditionalTools: false },
    };
  });
}

export function createAdapter({ PiAiAdapter, responses, resolveImageAttachmentAccess }, auth, ctx) {
  let fingerprint, profiles;
  const getProfiles = () => {
    let account;
    try { const data = JSON.parse(readPrivateFileSync(auth.store.path)); account = data.profiles.find(p => p.id === data.activeProfileId); } catch {}
    const entries = account?.access_token && account.scopes?.includes(PLAN_SCOPE) ? account.models || [] : [];
    const stamp = JSON.stringify([auth.generation, account?.id, entries]);
    if (profiles && fingerprint === stamp) return profiles;
    const profileId = account?.id;
    const sessionSignal = auth.requestController.signal;
    const models = catalogModels(entries);
    const optionsFor = options => ({ ...options,
      signal: options?.signal ? AbortSignal.any([options.signal, sessionSignal]) : sessionSignal,
      onPayload: planPayload,
      fetch: (input, init) => auth.fetchInference(profileId, input, { ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, sessionSignal]) : sessionSignal }),
    });
    const provider = { id: PROVIDER, name: DISPLAY_NAME, getModels: () => models,
      auth: { apiKey: { name: 'Sign in with ChatGPT', resolve: async () => ({ auth: { apiKey: (await auth.access(profileId)).token }, source: 'DSH independent ChatGPT authorization' }) } },
      stream: (model, context, options) => responses.stream(model, context, optionsFor(options)),
      streamSimple: (model, context, options) => responses.streamSimple(model, context, optionsFor(options)),
    };
    profiles = new Map([[PROVIDER, { provider: PROVIDER, displayName: DISPLAY_NAME, piProvider: provider,
      transport: 'sse', streamIdleTimeoutMs: 300000, maxRequestImageBytes: 20971520, requestImagePixelBudget: 4194304, requestImageMaxBytes: 1048576,
      configuredMaxTokens: new Map(), modelErrors: new Map(), retryPolicy: { mode: 'normal', maxRetries: 2 },
    }]]);
    fingerprint = stamp;
    return profiles;
  };
  return new PiAiAdapter({ profiles: getProfiles, resolveApiKey: async () => undefined,
    resolveAttachments: () => ctx?.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess?.(attachments, ref, path => ctx?.get('fs')?.processPathFromHostPath(path)),
  });
}
