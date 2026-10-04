import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { equalSecret, USAGE_URL } from './oauth.mjs';
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsonForScript = value => JSON.stringify(value).replaceAll('<', '\\u003c');
export function managementHtml(config, message = '') {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>DeepSeek Harness · ChatGPT 套餐</title>
<style>body{font:15px/1.65 -apple-system,BlinkMacSystemFont,sans-serif;color:#222;background:#f5f6f8;margin:0;padding:48px 24px}main{max-width:740px;margin:auto;background:white;border:1px solid #e4e7eb;border-radius:20px;padding:32px}h1{font-size:25px;margin:0 0 8px}p{color:#555}button,a{font:inherit}button{border:1px solid #ccd1d9;border-radius:8px;padding:9px 14px;margin:5px;background:white;cursor:pointer}button.primary{background:#111;color:white;border-color:#111}button:disabled{opacity:.5}article{border:1px solid #dde2e9;border-radius:12px;padding:16px;margin:14px 0}small{color:#667;display:block}#message{white-space:pre-wrap;color:#305c45}a{color:#235cb5}footer{margin-top:24px;color:#777;font-size:12px}</style>
<main><h1>DeepSeek Harness · ChatGPT 套餐</h1><p>连接你自己的 ChatGPT 账号，允许 DeepSeek Harness 使用套餐额度。你可以在 ChatGPT 设置中查看用量、限制额度或断开授权。</p><p id="message" role="status">${escape(message)}</p><div id="accounts"></div><button class="primary" id="connect">Continue with ChatGPT</button><button id="cancel">取消等待中的登录</button><p><a href="${USAGE_URL}" target="_blank" rel="noreferrer">管理 ChatGPT 用量与额度 ↗</a></p><section id="network" hidden><h2>网络连接</h2><p>网络设置仅用于本插件。</p><select id="network-mode"><option value="system">使用环境代理设置</option><option value="direct">直接连接</option><option value="proxy">指定 HTTP(S) 代理</option></select><input id="proxy-url" type="url" placeholder="http://127.0.0.1:7890" aria-label="代理地址"><button id="save-network">保存网络设置</button></section><footer>凭证仅保存在本机 DSH 配置中。此插件为本地独立接入，不代表 OpenAI 或 DeepSeek 官方发布。</footer></main>
<script nonce="${config.nonce}">
const config=${jsonForScript({ csrf: config.csrf })};
let networkInitialized=false;
async function api(path,data){const r=await fetch(path,{method:data?'POST':'GET',headers:{'X-DSH-CSRF':config.csrf,...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});const j=await r.json();if(!r.ok)throw Error(j.error||'操作失败');return j;}
function button(label,run){const b=document.createElement('button');b.textContent=label;b.onclick=async()=>{b.disabled=true;try{await run();await refresh();}catch(e){document.querySelector('#message').textContent=e.message;}finally{b.disabled=false;}};return b;}
function login(id,enablePlan=false){const f=document.createElement('form');f.method='POST';f.action='/oauth/start';for(const [name,value] of Object.entries({csrf:config.csrf,profileId:id||'',newProfile:id?'false':'true',enablePlan:String(enablePlan)})){const i=document.createElement('input');i.type='hidden';i.name=name;i.value=value;f.append(i);}document.body.append(f);f.submit();}
async function refresh(){const s=await api('/api/status');if(s.network&&!networkInitialized){networkInitialized=true;document.querySelector('#network').hidden=false;document.querySelector('#network-mode').value=s.network.mode;document.querySelector('#proxy-url').value=s.network.proxyUrl||'';networkInputs();}const area=document.querySelector('#accounts');area.replaceChildren();if(s.notice)document.querySelector('#message').textContent=s.notice;for(const p of s.profiles){const a=document.createElement('article');const title=document.createElement('strong');title.textContent=(p.label?p.label+' · ':'')+(p.email||'待完成的应用注册')+(p.id===s.activeProfileId?' · 当前账号':'');const detail=document.createElement('small');detail.textContent=p.clientId+' · '+(p.planEnabled?'正在使用 ChatGPT 套餐 · '+p.models.length+' 个模型':p.connected?'已登录，套餐未授权':'已退出登录');a.append(title,detail);if(p.refreshWarning){const warning=document.createElement('small');warning.textContent=p.refreshWarning;a.append(warning);}a.append(button('修改备注',async()=>{const label=prompt('账号备注，例如：个人 Pro / 工作账号',p.label||'');if(label!==null)await api('/api/rename',{id:p.id,label});}));if(p.id!==s.activeProfileId)a.append(button('切换到此账号',()=>api('/api/select',{id:p.id})));a.append(button(p.connected?'重新登录':'Continue with ChatGPT',()=>login(p.id)));if(p.connected&&!p.planEnabled)a.append(button('授权套餐使用',()=>login(p.id,true)));if(p.planEnabled&&p.id===s.activeProfileId)a.append(button('刷新模型列表',()=>api('/api/models',{})));if(p.connected)a.append(button('退出登录',()=>api('/api/signout',{id:p.id})));area.append(a);}document.querySelector('#cancel').hidden=!s.pending;document.querySelector('#connect').textContent=s.profiles.length?'添加账号 · Continue with ChatGPT':'Continue with ChatGPT';}
function networkInputs(){document.querySelector('#proxy-url').disabled=document.querySelector('#network-mode').value!=='proxy';}
document.querySelector('#network-mode').onchange=networkInputs;document.querySelector('#save-network').onclick=async()=>{try{await api('/api/network',{mode:document.querySelector('#network-mode').value,proxyUrl:document.querySelector('#proxy-url').value});await refresh();}catch(e){document.querySelector('#message').textContent=e.message;}};
document.querySelector('#connect').onclick=()=>login();document.querySelector('#cancel').onclick=async()=>{await api('/api/cancel',{});await refresh();};refresh().catch(e=>document.querySelector('#message').textContent=e.message);
</script></html>`;
}

export async function startManagement(auth, { port = 18762, network, profile = 'local' } = {}) {
  await auth.initialize();
  const csrf = randomBytes(32).toString('base64url'), nonce = randomBytes(24).toString('base64url');
  let origin;
  const status = async () => ({ ...await auth.status(), network: network?.status(), profile });
  const server = createServer(async (req, res) => {
    const security = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self' https://auth.openai.com; frame-ancestors 'none'; base-uri 'none'` };
    const allowedOrigin = req.headers.origin === origin || req.headers.origin === 'dsh-app://app';
    if (allowedOrigin) Object.assign(security, { 'access-control-allow-origin': req.headers.origin, 'access-control-allow-headers': 'Content-Type, X-DSH-CSRF', 'access-control-allow-methods': 'GET, POST, OPTIONS', vary: 'Origin' });
    const send = (status, body, type = 'application/json') => { res.writeHead(status, { ...security, 'content-type': `${type}; charset=utf-8` }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
    try {
      if (req.headers.host !== new URL(origin).host) return send(403, { error: 'Invalid Host' });
      const url = new URL(req.url, origin);
      if (req.method === 'OPTIONS') return allowedOrigin ? send(204, '') : send(403, { error: 'Invalid Origin' });
      if (req.method === 'GET' && url.pathname === '/') return send(200, managementHtml({ csrf, nonce }), 'text/html');
      if (req.method === 'GET' && url.pathname === '/auth/callback') {
        try { await auth.callback(url); }
        catch (error) { auth.notice = error.message; }
        // Remove the one-use code and state from browser history before rendering any assets.
        res.writeHead(303, { ...security, location: '/' }); return res.end();
      }
      let data;
      if (req.method === 'POST') {
        if (!allowedOrigin) return send(403, { error: 'Invalid Origin' });
        let body = '';
        for await (const part of req) { body += part; if (body.length > 8192) return send(413, { error: 'Request too large' }); }
        data = req.headers['content-type']?.startsWith('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body || '{}');
      }
      if (!equalSecret(req.headers['x-dsh-csrf'] || data?.csrf, csrf)) return send(403, { error: 'Invalid CSRF token' });
      if (req.method === 'GET' && url.pathname === '/api/status') return send(200, await status());
      if (req.method !== 'POST') return send(404, { error: 'Not found' });
      if (url.pathname === '/oauth/start') {
        const location = await auth.begin({ redirectUri: `${origin}/auth/callback`, profileId: data.profileId || undefined, newProfile: data.newProfile === 'true', enablePlan: data.enablePlan === 'true' });
        res.writeHead(303, { ...security, location }); return res.end();
      }
      if (url.pathname === '/api/select') await auth.select(data.id);
      else if (url.pathname === '/api/rename') await auth.rename(data.id, data.label);
      else if (url.pathname === '/api/network') { if (!network) throw new Error('网络设置不可用。'); await network.configure(data); auth.changed(); auth.notice = '网络设置已保存。'; }
      else if (url.pathname === '/api/signout') await auth.signOut(data.id);
      else if (url.pathname === '/api/cancel') auth.cancel();
      else if (url.pathname === '/api/models') await auth.refreshModels();
      else return send(404, { error: 'Not found' });
      return send(200, await status());
    } catch (error) { send(400, { error: error instanceof SyntaxError ? 'Invalid request' : error.message }); }
  });
  const listen = value => new Promise((resolve, reject) => {
    const fail = error => { server.removeListener('listening', ready); reject(error); };
    const ready = () => { server.removeListener('error', fail); resolve(); };
    server.once('error', fail); server.once('listening', ready); server.listen(value, '127.0.0.1');
  });
  try { await listen(port); } catch (error) { if (error.code !== 'EADDRINUSE' || port === 0) throw error; await listen(0); }
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, csrf, close: () => { auth.cancel(); auth.requestController.abort(); server.close(); server.closeAllConnections(); } };
}
