// 会话自动整理 · 插件详情页配置面板（client half）
// 注册在 plugins.bundle.config（key = 包名），页面内直接改阈值/规则，走 host 的同源端点。
window.__ModuleLoader__.load({
  id: '@local/dsh-session-tidy',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 },
      row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      label: { width: 190, opacity: 0.8 },
      input: { width: 96, padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', font: 'inherit' },
      inputWide: { flex: '1 1 240px', padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', font: 'inherit' },
      btn: { padding: '5px 16px', borderRadius: 6, border: '1px solid rgba(127,127,127,.4)', background: 'rgba(80,140,255,.16)', color: 'inherit', cursor: 'pointer', font: 'inherit' },
      dim: { opacity: 0.65, lineHeight: 1.6 },
      err: { color: '#e05a5a' },
      ok: { color: '#3fbf7f' },
      card: { border: '1px solid rgba(127,127,127,.25)', borderRadius: 8, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 },
    };

    function NumField(props) {
      return h('div', { style: S.row },
        h('span', { style: S.label }, props.label),
        h('input', {
          type: 'number', style: S.input, value: props.value, min: props.min, max: props.max,
          onChange: (e) => { const n = Number(e.target.value); if (Number.isFinite(n)) props.onChange(n); },
        }),
        props.hint ? h('span', { style: S.dim }, props.hint) : null,
      );
    }

    function Toggle(props) {
      return h('label', { style: S.row },
        h('input', { type: 'checkbox', checked: !!props.value, onChange: (e) => props.onChange(e.target.checked) }),
        h('span', null, props.label),
      );
    }

    function Panel(props) {
      const [cfg, setCfg] = React.useState(null);
      const [msg, setMsg] = React.useState('');
      const [saving, setSaving] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        fetch('/session-tidy/config')
          .then((r) => r.json())
          .then((d) => { if (!alive) return; if (d && d.ok) setCfg(d.config); else setMsg('读取失败：' + ((d && d.error) || '未知')); })
          .catch((e) => { if (alive) setMsg('读取失败：' + e.message); });
        return () => { alive = false; };
      }, []);

      if (props && props.view === 'summary') {
        const text = cfg
          ? `每 ${cfg.intervalHours} 小时：归档 ${cfg.days} 天无活动的会话；工作区闲置 ${cfg.workspaceDays} 天清理${cfg.enabled ? '' : '（已关闭）'}`
          : '读取配置中…';
        return h('div', { style: S.dim }, text);
      }

      if (!cfg) return h('div', { style: S.dim }, msg || '读取配置中…');

      const set = (k, v) => setCfg(Object.assign({}, cfg, { [k]: v }));

      const save = async () => {
        setSaving(true);
        setMsg('');
        try {
          const res = await fetch('/session-tidy/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(cfg),
          });
          const d = await res.json();
          if (d && d.ok) { setCfg(d.config); setMsg('已保存，立即生效'); }
          else setMsg('保存失败：' + ((d && d.error) || ('HTTP ' + res.status)));
        } catch (e) {
          setMsg('保存失败：' + e.message);
        } finally {
          setSaving(false);
        }
      };

      return h('div', { style: S.wrap },
        h('div', { style: S.dim }, '无感运行：按下面的规则定时归档旧会话。只归档、不删除，随时可以在侧边栏或会话管理工具里取消归档。'),
        h('div', { style: S.card },
          h(NumField, { label: '多少天没活动才归档', value: cfg.days, min: 1, max: 3650, hint: '天', onChange: (v) => set('days', v) }),
          h(NumField, { label: '检查间隔', value: cfg.intervalHours, min: 1, max: 720, hint: '小时', onChange: (v) => set('intervalHours', v) }),
          h(Toggle, { label: '启用自动整理', value: cfg.enabled, onChange: (v) => set('enabled', v) }),
          h(Toggle, { label: 'DSH 启动后先检查一次', value: cfg.runOnStart, onChange: (v) => set('runOnStart', v) }),
          h(Toggle, { label: '不碰置顶会话', value: cfg.keepPinned, onChange: (v) => set('keepPinned', v) }),
          h(Toggle, { label: '不碰运行中的会话', value: cfg.keepLive, onChange: (v) => set('keepLive', v) }),
          h(Toggle, { label: '只记日志、不真归档（dryRun）', value: cfg.dryRun, onChange: (v) => set('dryRun', v) }),
          h('div', { style: Object.assign({}, S.dim, { marginTop: 6 }) }, '同会话去重（桥轮换留下的旧版本）'),
          h(Toggle, { label: '同一会话只保留最新几个，旧版自动归档', value: cfg.dedupeTitles, onChange: (v) => set('dedupeTitles', v) }),
          h(NumField, { label: '每组保留最新', value: cfg.keepPerTitle, min: 1, max: 20, hint: '个', onChange: (v) => set('keepPerTitle', v) }),
          h('div', { style: Object.assign({}, S.dim, { marginTop: 6 }) }, '工作区整理'),
          h(NumField, { label: '工作区闲置多少天后清理', value: cfg.workspaceDays, min: 0, max: 3650, hint: '天，0 = 不清理', onChange: (v) => set('workspaceDays', v) }),
          h('div', { style: S.row },
            h('span', { style: S.label }, '保留这些工作区'),
            h('input', {
              style: S.inputWide, value: cfg.keepWorkspaces || '', placeholder: '路径前缀，逗号分隔',
              onChange: (e) => set('keepWorkspaces', e.target.value),
            }),
          ),
          h('div', { style: Object.assign({}, S.dim, { marginTop: 6 }) }, '归档与清理前备份'),
          h(Toggle, { label: '归档前备份会话文件', value: cfg.backupEnabled, onChange: (v) => set('backupEnabled', v) }),
          h('div', { style: S.row },
            h('span', { style: S.label }, '备份目录'),
            h('input', {
              style: S.inputWide, value: cfg.backupDir || '',
              onChange: (e) => set('backupDir', e.target.value),
            }),
          ),
          h('div', { style: S.row },
            h('span', { style: S.label }, '只整理这个工作区'),
            h('input', {
              style: S.inputWide, value: cfg.onlyCwdPrefix || '', placeholder: '留空 = 全部工作区；填路径前缀只整理该目录下的会话',
              onChange: (e) => set('onlyCwdPrefix', e.target.value),
            }),
          ),
        ),
        h('div', { style: S.row },
          h('button', { style: S.btn, disabled: saving, onClick: save }, saving ? '保存中…' : '保存'),
          msg ? h('span', { style: msg.indexOf('已保存') === 0 ? S.ok : S.err }, msg) : null,
        ),
        h('div', { style: S.dim }, '配置存在 ~/.dsh/session-tidy.json（本页保存即生效，不用改配置文件、不用重启）；运行日志在 ~/.dsh/session-tidy.log。'),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: '@local/dsh-session-tidy',
        }, Panel));
      },
    };
  },
});
