window.__ModuleLoader__.load({ id: 'dsh-chatgpt-plan', factory: require => {
  const React = require('react'), h = React.createElement;
  function Panel() {
    const config = globalThis.__DSH_CHATGPT_PLAN__;
    const [state, setState] = React.useState(null), [error, setError] = React.useState('');
    React.useEffect(() => {
      let active = true;
      const refresh = async () => { try {
        const res = await fetch(config.origin + '/api/status', { headers: { 'X-DSH-CSRF': config.csrf } });
        if (!res.ok) throw Error('无法读取登录状态');
        const data = await res.json(); if (active) { setState(data); setError(''); }
      } catch { if (active) setError('请打开账号管理页查看登录状态。'); } };
      refresh(); const timer = setInterval(refresh, 5000);
      return () => { active = false; clearInterval(timer); };
    }, []);
    const current = state?.profiles.find(p => p.id === state.activeProfileId);
    const linkStyle = { display: 'inline-block', padding: '9px 15px', marginRight: 12, marginTop: 12, border: '1px solid #aaa7', borderRadius: 8, textDecoration: 'none', color: 'inherit' };
    return h('section', { style: { maxWidth: 700, lineHeight: 1.7 } },
      h('h2', null, 'ChatGPT 套餐'),
      h('p', null, '通过 Sign in with ChatGPT 为 DeepSeek Harness 独立授权。'),
      h('p', { role: 'status' }, current?.planEnabled ? `正在使用 ChatGPT 套餐 · ${current.label || current.email || '已连接账号'} · ${current.models.length} 个模型` : '尚未连接 ChatGPT 套餐'),
      state && h('p', null, `已保存 ${state.profiles.length} 个账号注册 · 当前配置：${state.profile || 'local'}`),
      current && h('p', { style: { fontSize: 12, opacity: .7 } }, '应用注册：' + current.clientId),
      error && h('p', null, error),
      state?.notice && h('p', null, state.notice),
      h('a', { href: config?.origin, target: '_blank', rel: 'noreferrer', style: linkStyle }, current?.connected ? '添加 / 切换账号与网络设置' : 'Continue with ChatGPT'),
      h('a', { href: 'https://chatgpt.com/settings/usage', target: '_blank', rel: 'noreferrer', style: linkStyle }, '管理用量与额度'),
      h('p', { style: { fontSize: 12, opacity: .7 } }, '在账号管理页完成浏览器授权后，回到会话模型菜单选择“ChatGPT 套餐（独立授权）”。')
    );
  }
  return { inject: ['slots'], apply(ctx) {
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'chatgpt-plan', order: 11, label: () => 'ChatGPT 套餐' }, Panel));
  } };
} });
