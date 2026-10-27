// 会话自动整理（无感）：① 归档 N 天没活动的会话（归档前备份会话文件）；② 删除长时间没用工作区的注册（先备份记录）。
// 只调用 DSH 的 workspaceController.archiveSession / workspaceRegistry.delete（可逆），不删除任何会话文件。
// 配置在插件详情页里改（保存到 ~/.dsh/session-tidy.json，立即生效）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'dsh-session-tidy';

export const inject = ['sessionQuery', 'workspaceController', 'workspaceRegistry', 'timer', 'webServer'];

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESSIONS_DIR = path.join(HOME, 'sessions');
const REGISTRY = path.join(HOME, 'storages', 'workspace.json');
const LOG_FILE = path.join(HOME, 'session-tidy.log');
const CONFIG_FILE = path.join(HOME, 'session-tidy.json');
const BRIDGE_STATE = process.env.SESSION_TIDY_BRIDGE_STATE || '';

const DEFAULTS = Object.freeze({
  enabled: true,
  days: 30,
  intervalHours: 6,
  runOnStart: true,
  keepPinned: true,
  keepLive: true,
  onlyCwdPrefix: '',
  dryRun: false,
  dedupeTitles: true,
  keepPerTitle: 1,
  workspaceDays: 30,
  keepWorkspaces: '',
  backupEnabled: true,
  backupDir: ''
});

function appendLog(line) {
  try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`); } catch {}
}

function readFileConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function sanitizeConfig(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  const num = (v, min, max, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  if (patch.enabled !== undefined) out.enabled = patch.enabled === true;
  if (patch.days !== undefined) out.days = num(patch.days, 1, 3650, DEFAULTS.days);
  if (patch.intervalHours !== undefined) out.intervalHours = num(patch.intervalHours, 1, 720, DEFAULTS.intervalHours);
  if (patch.runOnStart !== undefined) out.runOnStart = patch.runOnStart === true;
  if (patch.keepPinned !== undefined) out.keepPinned = patch.keepPinned === true;
  if (patch.keepLive !== undefined) out.keepLive = patch.keepLive === true;
  if (patch.dryRun !== undefined) out.dryRun = patch.dryRun === true;
  if (patch.onlyCwdPrefix !== undefined) out.onlyCwdPrefix = String(patch.onlyCwdPrefix ?? '').slice(0, 260);
  if (patch.dedupeTitles !== undefined) out.dedupeTitles = patch.dedupeTitles === true;
  if (patch.keepPerTitle !== undefined) out.keepPerTitle = num(patch.keepPerTitle, 1, 20, DEFAULTS.keepPerTitle);
  if (patch.workspaceDays !== undefined) out.workspaceDays = num(patch.workspaceDays, 0, 3650, DEFAULTS.workspaceDays);
  if (patch.keepWorkspaces !== undefined) out.keepWorkspaces = String(patch.keepWorkspaces ?? '').slice(0, 600);
  if (patch.backupEnabled !== undefined) out.backupEnabled = patch.backupEnabled === true;
  if (patch.backupDir !== undefined) out.backupDir = String(patch.backupDir ?? '').slice(0, 260);
  return out;
}

function readRegistry() {
  try {
    const s = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    return {
      archived: new Set(s.global?.archivedSessionIds ?? []),
      pinned: new Set(s.global?.pinnedSessionIds ?? [])
    };
  } catch {
    return { archived: new Set(), pinned: new Set() };
  }
}

function bridgeActiveSessions() {
  if (!BRIDGE_STATE) return new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(BRIDGE_STATE, 'utf8'));
    const set = new Set();
    for (const v of Object.values(raw.sessions || raw || {})) if (typeof v === 'string') set.add(v);
    return set;
  } catch {
    return new Set();
  }
}

const PROJCACHE = path.join(HOME, 'storages', 'session_projcache', 'sessions');

function readSessionTitle(sessionId) {
  try {
    const f = path.join(PROJCACHE, sessionId + '.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const rows = j?.record?.rows ?? j?.rows ?? {};
    const v = rows.title?.val ?? rows.title?.value ?? '';
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

function scanSessionIndex() {  const map = new Map();
  let entries;
  try { entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }); } catch { return map; }
  for (const ws of entries) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(SESSIONS_DIR, ws.name);
    let subs;
    try { subs = fs.readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const sub of subs) {
      if (!sub.isDirectory() || !/^session-[0-9a-f-]{36}$/i.test(sub.name)) continue;
      const dir = path.join(wsDir, sub.name);
      let mtime = 0;
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!/^session\.v\d+\.jsonl\.zstd$/.test(f)) continue;
          const st = fs.statSync(path.join(dir, f));
          if (st.mtimeMs > mtime) mtime = st.mtimeMs;
        }
      } catch { continue; }
      if (!map.has(sub.name)) map.set(sub.name, { dir, mtime });
    }
  }
  return map;
}

function backupSession(dir, backupRoot, sessionId, dateTag) {
  const target = path.join(backupRoot, dateTag, sessionId);
  try {
    fs.mkdirSync(target, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      const src = path.join(dir, f);
      if (!fs.statSync(src).isFile()) continue;
      fs.copyFileSync(src, path.join(target, f));
    }
    return target;
  } catch (error) {
    return 'ERR ' + String(error?.message ?? error);
  }
}

export function apply(ctx, patchConfig) {
  let lastRun = 0;
  let busy = false;

  function effective() {
    return { ...DEFAULTS, ...(patchConfig ?? {}), ...readFileConfig() };
  }

  function log(level, msg) {
    appendLog(`[${level}] ${msg}`);
    try { (console[level] ?? console.log).call(console, msg); } catch {}
  }

  async function sweep(reason, cfg) {
    if (busy || cfg.enabled === false) return;
    busy = true;
    try {
      const now = Date.now();
      const dateTag = new Date(now).toISOString().slice(0, 10);
      const backupRoot = cfg.backupDir || path.join(HOME, 'session-tidy-backup');
      const sessionIdx = scanSessionIndex();
      const { archived, pinned } = readRegistry();
      const bridgeActive = bridgeActiveSessions();
      const records = await ctx.sessionQuery.listSessions();

      // ── 0) 同标题去重：同一个会话（标题前缀相同）只留最新 keepPerTitle 个 ──
      if (cfg.dedupeTitles !== false) {
        const keepN = Math.max(1, Number(cfg.keepPerTitle) || 1);
        const titleGroups = new Map();
        for (const rec of records) {
          const id = String(rec?.header?.id ?? '');
          if (!/^session-[0-9a-f-]{36}$/i.test(id)) continue;
          if (archived.has(id)) continue;
          if (cfg.keepLive !== false && rec.live) continue;
          if (cfg.keepPinned !== false && pinned.has(id)) continue;
          if (bridgeActive.has(id)) continue;
          const title = readSessionTitle(id);
          const m = /^(.*?)\s+\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}$/.exec(title);
          if (!m) continue;
          const key = m[1];
          if (!titleGroups.has(key)) titleGroups.set(key, []);
          titleGroups.get(key).push({ id, at: Number(rec?.header?.createdAt) || sessionIdx.get(id)?.mtime || 0 });
        }
        let dupOk = 0;
        let dupFail = 0;
        const dupErrors = [];
        for (const [, arr] of titleGroups) {
          if (arr.length <= keepN) continue;
          arr.sort((a, b) => b.at - a.at);
          for (const c of arr.slice(keepN)) {
            if (cfg.dryRun) continue;
            if (cfg.backupEnabled !== false) {
              const hit = sessionIdx.get(c.id);
              if (hit?.dir) {
                const target = backupSession(hit.dir, backupRoot, c.id, dateTag);
                if (String(target).startsWith('ERR')) {
                  dupFail++;
                  if (dupErrors.length < 3) dupErrors.push(`backup ${c.id.slice(0, 18)} ${target}`);
                  continue;
                }
              }
            }
            try {
              await ctx.workspaceController.archiveSession({ sessionId: c.id });
              archived.add(c.id);
              dupOk++;
            } catch (error) {
              dupFail++;
              if (dupErrors.length < 5) dupErrors.push(`${c.id.slice(0, 18)}: ${String(error?.message ?? error)}`);
            }
          }
        }
        if (dupOk || dupFail) {
          log(dupFail ? 'warn' : 'info', `[${reason}] 同标题去重：归档 ${dupOk} 个旧版本，失败 ${dupFail} 个（每组保留 ${keepN} 个）${dupErrors.length ? '；错误示例：' + dupErrors.join(' | ') : ''}`);
        }
      }

      // ── 1) 会话归档（先备份文件，再归档）────────────────────────────────
      const days = Math.max(1, Number(cfg.days) || 30);
      const cutoff = now - days * 86400000;
      const candidates = [];
      for (const rec of records) {
        const id = String(rec?.header?.id ?? '');
        if (!/^session-[0-9a-f-]{36}$/i.test(id)) continue;
        if (archived.has(id)) continue;
        if (cfg.keepLive !== false && rec.live) continue;
        if (cfg.keepPinned !== false && pinned.has(id)) continue;
        if (bridgeActive.has(id)) continue;
        const cwd = String(rec?.header?.cwd ?? '');
        if (cfg.onlyCwdPrefix && !cwd.startsWith(cfg.onlyCwdPrefix)) continue;
        const mtime = sessionIdx.get(id)?.mtime || Number(rec?.header?.createdAt) || 0;
        if (!mtime || mtime >= cutoff) continue;
        candidates.push({ id });
      }
      let archivedOk = 0;
      let archivedFail = 0;
      const archiveErrors = [];
      for (const c of candidates) {
        if (cfg.dryRun) continue;
        if (cfg.backupEnabled !== false) {
          const hit = sessionIdx.get(c.id);
          if (hit?.dir) {
            const target = backupSession(hit.dir, backupRoot, c.id, dateTag);
            if (String(target).startsWith('ERR')) {
              archivedFail++;
              if (archiveErrors.length < 3) archiveErrors.push(`backup ${c.id.slice(0, 18)} ${target}`);
              continue;
            }
          }
        }
        try {
          await ctx.workspaceController.archiveSession({ sessionId: c.id });
          archivedOk++;
        } catch (error) {
          archivedFail++;
          if (archiveErrors.length < 5) archiveErrors.push(`${c.id.slice(0, 18)}: ${String(error?.message ?? error)}`);
        }
      }
      log(archivedFail ? 'warn' : 'info', `[${reason}] 会话归档：归档 ${archivedOk} 个，失败 ${archivedFail} 个（阈值 ${days} 天，扫描 ${records.length} 个，候选 ${candidates.length} 个）${archiveErrors.length ? '；错误示例：' + archiveErrors.join(' | ') : ''}`);

      // ── 2) 工作区清理（闲置 N 天的注册删除，先备份记录）─────────────────
      const wsDays = Number(cfg.workspaceDays) || 0;
      if (wsDays > 0) {
        const keep = String(cfg.keepWorkspaces || '').split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
        const workspaces = typeof ctx.workspaceRegistry?.list === 'function' ? ctx.workspaceRegistry.list() : [];
        const removed = [];
        for (const ws of workspaces) {
          const wsPath = String(ws.path || '');
          if (keep.some(k => wsPath.toLowerCase().startsWith(k.toLowerCase()))) continue;
          const ids = Array.from(ws.sessionIds || []).map(String);
          if (ids.some(id => bridgeActive.has(id))) continue;
          const newest = ids.reduce((max, id) => {
            const m = sessionIdx.get(id)?.mtime || 0;
            return m > max ? m : max;
          }, 0);
          const lastActive = newest || Date.parse(ws.updatedAt || ws.createdAt || '') || 0;
          if (!lastActive || now - lastActive < wsDays * 86400000) continue;
          removed.push({ id: ws.id, path: wsPath, title: ws.title, sessions: ids.length, lastActive });
        }
        if (removed.length) {
          const wsBackupRoot = cfg.backupDir ? path.dirname(cfg.backupDir) : path.join(HOME, 'session-tidy-backup');
          const backupFile = path.join(wsBackupRoot, 'workflows', `${dateTag}-workspaces.json`);
          try {
            fs.mkdirSync(path.dirname(backupFile), { recursive: true });
            fs.writeFileSync(backupFile, JSON.stringify({ at: new Date().toISOString(), reason, workspaces: removed }, null, 2), 'utf8');
          } catch (error) {
            log('warn', `[${reason}] 工作区备份写入失败：${String(error?.message ?? error)}`);
          }
          let wsOk = 0;
          let wsFail = 0;
          for (const ws of removed) {
            if (cfg.dryRun) { wsOk++; continue; }
            try {
              await ctx.workspaceRegistry.delete(ws.id);
              wsOk++;
            } catch (error) {
              wsFail++;
              log('warn', `[${reason}] 工作区删除失败 ${ws.path}: ${String(error?.message ?? error)}`);
            }
          }
          log(wsFail ? 'warn' : 'info', `[${reason}] 工作区清理：删除 ${wsOk} 个闲置工作区注册（失败 ${wsFail}），备份在 ${backupFile}；明细：${removed.map(w => `${w.title || w.path}(${w.sessions})`).join(', ')}`);
        } else {
          log('info', `[${reason}] 没有需要清理的闲置工作区（阈值 ${wsDays} 天）`);
        }
      }
    } catch (error) {
      log('warn', `[${reason}] 整理失败：${String(error?.message ?? error)}`);
    } finally {
      busy = false;
    }
  }

  ctx.effect(() => ctx.interval(() => {
    const cfg = effective();
    if (cfg.enabled === false) return;
    const hours = Math.max(1, Number(cfg.intervalHours) || 6);
    if (Date.now() - lastRun < hours * 3600000) return;
    lastRun = Date.now();
    void sweep('定时', cfg);
  }, 60000));

  ctx.effect(() => ctx.timeout(() => {
    const cfg = effective();
    if (cfg.enabled === false || cfg.runOnStart === false) return;
    lastRun = Date.now();
    void sweep('启动', cfg);
  }, 45000));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/session-tidy/config',
    handler: async (req, res) => {
      const json = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET') return json(200, { ok: true, config: effective(), defaults: DEFAULTS });
      if (req.method === 'POST') {
        try {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const patch = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const clean = sanitizeConfig(patch);
          const next = { ...readFileConfig(), ...clean };
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
          log('info', `配置已更新：${JSON.stringify(clean)}`);
          return json(200, { ok: true, config: effective() });
        } catch (error) {
          return json(400, { ok: false, error: String(error?.message ?? error) });
        }
      }
      return json(405, { ok: false, error: 'method not allowed' });
    }
  }));

  const cfg = effective();
  log('info', `会话自动整理已启动：会话归档 ${cfg.days} 天，工作区闲置 ${cfg.workspaceDays} 天清理（每 ${cfg.intervalHours} 小时）${cfg.dryRun ? '（dryRun）' : ''}`);
}
