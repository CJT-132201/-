import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// 可写数据目录(打包后 asar 只读,所以放到用户目录)
const DATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '桌面智能助手');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
// 新项目默认存放位置
const DEFAULT_PROJECTS_DIR = path.join(DATA_DIR, 'projects');
// 项目注册表:记录每个项目真实的存放目录(id -> {id,name,dir,createdAt,updatedAt})
const PROJECTS_INDEX_PATH = path.join(DATA_DIR, 'projects-index.json');

const DEFAULT = { apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', allowShell: true, requireConfirm: true, historyTurns: 6, toolResultLimit: 600, reasoningEffort: 'low', enabledTools: [], docRoots: [] };

let current = { ...DEFAULT };
let currentProjectId = null;
let projectIndex = {};

// 单个项目的实际目录
function projectDir(id) {
  const e = projectIndex[id];
  return e && e.dir ? e.dir : path.join(DEFAULT_PROJECTS_DIR, id || 'default');
}
export function getWorkdir(id = currentProjectId) { return path.join(projectDir(id), 'work'); }

async function saveState() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify({ currentProject: currentProjectId }, null, 2));
}
async function projectExists(id) {
  return !!projectIndex[id] || await fs.access(projectDir(id)).then(() => true).catch(() => false);
}
function sanitizeName(name) { return String(name || '').trim() || '未命名项目'; }

async function saveIndex() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(PROJECTS_INDEX_PATH, JSON.stringify(projectIndex, null, 2));
}
async function loadIndex() {
  try {
    projectIndex = JSON.parse(await fs.readFile(PROJECTS_INDEX_PATH, 'utf8'));
  } catch {
    // 首次运行:扫描默认目录里已有的项目,登记到注册表
    projectIndex = {};
    let names = [];
    try { names = await fs.readdir(DEFAULT_PROJECTS_DIR); } catch {}
    for (const n of names) {
      try {
        const meta = JSON.parse(await fs.readFile(path.join(DEFAULT_PROJECTS_DIR, n, 'project.json'), 'utf8'));
        projectIndex[meta.id] = { ...meta, dir: path.join(DEFAULT_PROJECTS_DIR, meta.id) };
      } catch {}
    }
    await saveIndex();
  }
}

// 初始化:创建目录、读配置、登记项目、确定当前项目
export async function init() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    current = { ...DEFAULT, ...JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8')) };
  } catch {
    try {
      const legacy = path.join(process.cwd(), 'config.json');
      current = { ...DEFAULT, ...JSON.parse(await fs.readFile(legacy, 'utf8')) };
      await fs.writeFile(CONFIG_PATH, JSON.stringify(current, null, 2));
    } catch {
      await fs.writeFile(CONFIG_PATH, JSON.stringify(current, null, 2));
    }
  }

  await loadIndex();
  await fs.mkdir(DEFAULT_PROJECTS_DIR, { recursive: true });

  try {
    const s = JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
    currentProjectId = s.currentProject || null;
  } catch { currentProjectId = null; }

  if (!currentProjectId || !(await projectExists(currentProjectId))) {
    const list = await listProjects();
    if (list.length) currentProjectId = list[0].id;
    else { const p = await createProject('默认项目'); currentProjectId = p.id; }
    await saveState();
  }
}

export function getConfig() { return current; }
export function getCurrentProjectId() { return currentProjectId; }
export function getCurrentProjectName() { return currentProjectId || ''; }

export async function saveConfig(patch) {
  current = { ...current, ...patch };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(current, null, 2));
  return current;
}

// 列出所有项目(含各自的存放目录)
export async function listProjects() {
  await loadIndex();
  const out = Object.values(projectIndex).map(e => ({ id: e.id, name: e.name, createdAt: e.createdAt, updatedAt: e.updatedAt, dir: e.dir, docRoots: e.docRoots || [] }));
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

export async function createProject(name) {
  const id = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dir = path.join(DEFAULT_PROJECTS_DIR, id);
  await loadIndex();
  await fs.mkdir(dir, { recursive: true });
  const meta = { id, name: sanitizeName(name), createdAt: Date.now(), updatedAt: Date.now(), dir, docRoots: [], stats: { input: 0, output: 0, total: 0, cost: 0, tasks: 0 } };
  projectIndex[id] = meta;
  await fs.mkdir(getWorkdir(id), { recursive: true });
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta, null, 2));
  await fs.writeFile(path.join(dir, 'chat.json'), '[]');
  await saveIndex();
  return meta;
}

export async function setCurrentProject(id) {
  if (!(await projectExists(id))) throw new Error('项目不存在');
  currentProjectId = id;
  await saveState();
}

// 把单个项目迁移到用户选择的父目录
export async function setProjectDir(id, newDir) {
  await loadIndex();
  const entry = projectIndex[id];
  if (!entry) throw new Error('项目不存在');
  const target = newDir && String(newDir).trim() ? path.resolve(String(newDir).trim()) : DEFAULT_PROJECTS_DIR;
  const old = entry.dir || path.join(DEFAULT_PROJECTS_DIR, id);
  if (path.resolve(target).toLowerCase() !== path.resolve(old).toLowerCase()) {
    await fs.mkdir(target, { recursive: true });
    const dst = path.join(target, id);
    if (await fs.stat(dst).then(() => true).catch(() => false)) throw new Error('目标位置已有同名项目文件夹');
    await fs.cp(old, dst, { recursive: true });
    await fs.rm(old, { recursive: true, force: true });
    entry.dir = dst;
    projectIndex[id] = entry;
    await saveIndex();
  }
  return { dir: projectIndex[id].dir };
}

// 设置某项目的文档目录(供「查本地文档」工具按需检索)
export async function setProjectDocRoots(id, docs) {
  await loadIndex();
  const e = projectIndex[id];
  if (!e) throw new Error('项目不存在');
  const clean = Array.isArray(docs) ? docs.filter(d => d && typeof d.path === 'string' && d.path.trim()).map(d => ({ path: d.path.trim(), name: d.name ? String(d.name).trim() : '' })) : [];
  e.docRoots = clean;
  projectIndex[id] = e;
  await saveIndex();
  try {
    const pj = JSON.parse(await fs.readFile(path.join(e.dir, 'project.json'), 'utf8'));
    pj.docRoots = clean;
    await fs.writeFile(path.join(e.dir, 'project.json'), JSON.stringify(pj, null, 2));
  } catch (e2) {}
  return { docRoots: clean };
}

// 读取某项目的文档目录
export async function getProjectDocRoots(id = currentProjectId) {
  await loadIndex();
  const e = projectIndex[id];
  if (e && Array.isArray(e.docRoots)) return e.docRoots;
  try { const pj = JSON.parse(await fs.readFile(path.join(projectDir(id), 'project.json'), 'utf8')); return Array.isArray(pj.docRoots) ? pj.docRoots : []; }
  catch { return []; }
}

// 删除项目:彻底清除(注册表 + 磁盘文件夹)
export async function deleteProject(id) {
  await loadIndex();
  const entry = projectIndex[id];
  const dir = (entry && entry.dir) ? entry.dir : path.join(DEFAULT_PROJECTS_DIR, id);
  if (entry || await fs.stat(dir).then(() => true).catch(() => false)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  delete projectIndex[id];
  await saveIndex();
  // 删的是当前项目则切换到另一个(没有就新建)
  if (currentProjectId === id) {
    const list = await listProjects();
    currentProjectId = list.length ? list[0].id : null;
    if (!currentProjectId) { const p = await createProject('默认项目'); currentProjectId = p.id; }
    await saveState();
  }
  return { ok: true, dir };
}

export async function getProject(id) {
  await loadIndex();
  const e = projectIndex[id];
  if (!e) return null;
  try { return JSON.parse(await fs.readFile(path.join(e.dir, 'project.json'), 'utf8')); }
  catch { return { id: e.id, name: e.name, createdAt: e.createdAt, updatedAt: e.updatedAt, dir: e.dir }; }
}

export async function loadChat(id = currentProjectId) {
  try { return JSON.parse(await fs.readFile(path.join(projectDir(id), 'chat.json'), 'utf8')); }
  catch { return []; }
}

export async function saveChat(messages, id = currentProjectId) {
  const dir = projectDir(id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'chat.json'), JSON.stringify(messages, null, 2));
  try {
    const pj = JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8'));
    pj.updatedAt = Date.now();
    await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(pj, null, 2));
  } catch {}
}

// ── 项目累计统计(tokens / 金额RMB / 任务数) ──
function defaultStats() { return { input: 0, output: 0, total: 0, cost: 0, tasks: 0 }; }
export function getProjectStats(id) {
  return projectIndex[id] && projectIndex[id].stats ? projectIndex[id].stats : defaultStats();
}
export async function addProjectStats(id, u) {
  await loadIndex();
  const e = projectIndex[id];
  if (!e) return;
  const s = e.stats || defaultStats();
  s.input += u.input || 0;
  s.output += u.output || 0;
  s.total += u.total || 0;
  s.cost += u.cost || 0;
  s.tasks += 1;
  e.stats = s;
  projectIndex[id] = e;
  await saveIndex();
  try {
    const pj = JSON.parse(await fs.readFile(path.join(e.dir, 'project.json'), 'utf8'));
    pj.stats = s;
    pj.updatedAt = Date.now();
    await fs.writeFile(path.join(e.dir, 'project.json'), JSON.stringify(pj, null, 2));
  } catch {}
  return s;
}
