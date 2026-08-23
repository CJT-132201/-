import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import os from 'os';
import { dialog } from 'electron';
import { execTool, TOOLS, OPTIONAL_TOOLS } from './lib/tools.js';
import { init, getConfig, saveConfig, getWorkdir, getCurrentProjectId, listProjects, createProject, setCurrentProject, setProjectDir, setProjectDocRoots, deleteProject, getProject, loadChat, saveChat, addProjectStats, getProjectStats } from './lib/config.js';
import { pathToFileURL, fileURLToPath } from 'url';

const app = express();
app.use(express.json({ limit: '50mb' }));
const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(BASE_DIR, 'public')));

const PORT = process.env.PORT || 3000;
const MAX_ROUNDS = parseInt(process.env.MAX_TOOL_ROUNDS || '15', 10);

// ── 模型计费表(官方中文文档,单位: 人民币元/1M tokens;按峰谷分时) ──
// 来源: https://api-docs.deepseek.com/zh-cn/quick_start/pricing (2026-08 实时抓取)
// deepseek-v4-flash: miss 1.5元 / hit 0.05元 / out 4.5元(空闲);高峰翻倍(3.0/0.10/9.0)
// deepseek-v4-pro:   miss 4.5元 / hit 0.15元 / out 13.5元(空闲);高峰翻倍(9.0/0.30/27.0)
const MODEL_PRICING = {
  'deepseek-v4-flash': { miss: 1.5, hit: 0.05, out: 4.5, peakMiss: 3.0, peakHit: 0.10, peakOut: 9.0 },
  'deepseek-v4-pro':   { miss: 4.5, hit: 0.15, out: 13.5, peakMiss: 9.0, peakHit: 0.30, peakOut: 27.0 },
  'deepseek-v4':       { miss: 4.5, hit: 0.15, out: 13.5, peakMiss: 9.0, peakHit: 0.30, peakOut: 27.0 },
  'deepseek':          { miss: 1.5, hit: 0.05, out: 4.5, peakMiss: 3.0, peakHit: 0.10, peakOut: 9.0 },
};
const PRICE_KEYS = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);
function priceFor(model) {
  const key = (model || '').toLowerCase();
  for (const k of PRICE_KEYS) { if (key.includes(k)) return MODEL_PRICING[k]; }
  return MODEL_PRICING['deepseek'];
}
// 峰谷判断:高峰 = UTC 01:00-04:00 与 06:00-10:00;周末(北京时间)全天按空闲(低谷)价
function isPeakNow() {
  const d = new Date();
  const h = d.getUTCHours();
  const cstDay = (d.getUTCDay() + 1) % 7; // 北京时间星期几(0=周日)
  if (cstDay === 0 || cstDay === 6) return false; // 周末全天空闲
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}
function calcCost(model, inTok, outTok, cacheHit = 0) {
  const p = priceFor(model);
  const hit = Math.max(0, Math.min(cacheHit || 0, inTok));
  const miss = inTok - hit;
  const peak = isPeakNow();
  // 官方中文版直接以人民币计价,无需汇率换算
  return (miss / 1e6) * (peak ? p.peakMiss : p.miss)
       + (hit / 1e6) * (peak ? p.peakHit : p.hit)
       + (outTok / 1e6) * (peak ? p.peakOut : p.out);
}

await init();
let conversation = await loadChat();

const SYSTEM_PROMPT = `你是桌面智能助手,用工具操作 Windows。规则:能用工具就调用;路径基于工作目录;cmd 语法;简短中文汇报;被拦截先分析再重试。`;

function systemPrompt() {
  const base = getConfig().allowShell ? SYSTEM_PROMPT : SYSTEM_PROMPT + `

# 注意
出于安全考虑,当前已禁用 shell 命令执行。你只能使用 list_dir / read_file / write_file 来完成任务。
`;
  return base;
}

// ── 任务状态存储 ───────────────────────────────────
const tasks = new Map();

// ── 局域网实时共享房间 ──
const shareRooms = new Map(); // code -> { projectId, clients:Set }
function lanIP(){
  try {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) for (const i of ifs[name]||[]) if (i.family==='IPv4' && !i.internal) return i.address;
  } catch {}
  return '127.0.0.1';
}
function broadcastToProject(pid, obj){
  const payload = `data: ${JSON.stringify(obj)}

`;
  for (const room of shareRooms.values()) if (room && room.projectId===pid){
    for (const c of room.clients){ try{ c.write(payload); }catch{} }
  }
}

function sse(taskId, obj) {
  const t = tasks.get(taskId);
  if (t && t.sse) t.sse.write(`data: ${JSON.stringify(obj)}\n\n`);
  broadcastToProject(getCurrentProjectId(), obj); // 实时共享给房间订阅者
}

// ── DeepSeek 调用(OpenAI 兼容,读取实时配置) ───────
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
function isVisionModel() { return (getConfig().model || '').toLowerCase().includes('vision'); }

// 带重试与超时的 LLM 请求:429/5xx/网络错误自动退避重试(失败请求不计费)
async function llmFetch(base, path, headers, body) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      if (res.ok) return res;
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`LLM API ${res.status}`);
        await new Promise(r => setTimeout(r, 1000 * (i + 1))); // 退避重试
        continue;
      }
      const text = await res.text();
      throw new Error(`LLM API ${res.status}: ${text.slice(0, 400)}`); // 400等业务错误不重试
    } catch (e) {
      if (e.name === 'AbortError') { lastErr = e; break; }           // 超时不重试
      if (e.message.includes('LLM API')) throw e;                    // 业务错误不重试
      lastErr = e;                                                   // 网络错误
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function callLLM(messages, tools) {
  const cfg = getConfig();
  const base = (cfg.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
  const body = { model: cfg.model || 'deepseek-chat', messages };
  // 核心工具 + 用户勾选的可选工具(默认全关,省钱)
  const toolsList = [...TOOLS];
  for (const name of (cfg.enabledTools || [])) {
    if (OPTIONAL_TOOLS[name]) toolsList.push(OPTIONAL_TOOLS[name]);
  }
  if (cfg.allowShell) body.tools = toolsList;
  // V4 系列模型按官方文档传思考参数(不影响老模型);思考力度可调
  const m = (cfg.model || '').toLowerCase();
  if (m.includes('v4')) {
    body.thinking = { type: 'enabled' };
    const eff = ['low', 'medium', 'high'].includes(cfg.reasoningEffort) ? cfg.reasoningEffort : 'low';
    body.reasoning_effort = eff;
  }
  body.max_tokens = 2048; // 防失控长文(正常回复不触发,零成本保险)

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` };
  const res = await llmFetch(base, '/chat/completions', headers, body);
  const data = await res.json();
  return { message: data.choices?.[0]?.message || null, usage: data.usage || null };
}

// ── 等待人工确认 ───────────────────────────────────
function waitConfirm(taskId, confirmId, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const t = tasks.get(taskId);
    if (!t) return resolve(false);
    const timer = setTimeout(() => { t.confirmWaiters.delete(confirmId); resolve(false); }, timeoutMs);
    t.confirmWaiters.set(confirmId, (decision) => {
      clearTimeout(timer); t.confirmWaiters.delete(confirmId); resolve(decision);
    });
  });
}

// ── Agent 主循环 ───────────────────────────────────
// 多模态内容(数组)保存时只保留其中的文本,避免把 base64 图片写进 chat.json
function normContent(c) {
  if (Array.isArray(c)) {
    const txt = c.map(p => p && p.type === 'text' ? p.text : '').join('').trim();
    return txt || '[图片]';
  }
  return c;
}

async function flushConversation(t) {
  // 只保存纯文本对话(user 和 无 tool_calls 的 assistant),保证下次请求结构合法;轮数可调
  const histTurns = Math.max(1, Math.min(30, parseInt(getConfig().historyTurns, 10) || 6));
  conversation = (t.messages || []).filter(m => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls))
    .slice(-(histTurns * 2))
    .map(m => ({ role: m.role, content: normContent(m.content) }));
  await saveChat(conversation);
}

async function runAgent(taskId, userMessage) {
  const t = tasks.get(taskId);
  if (!t) return;

  const cfg = getConfig();
  // 只保留纯文本对话(丢弃带 tool_calls 的中间消息,避免 API 结构校验报错),轮数可调
  const histTurns = Math.max(1, Math.min(30, parseInt(cfg.historyTurns, 10) || 6));
  const hist = (conversation || []).filter(m => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls)).slice(-(histTurns * 2));
  t.messages = [
    { role: 'system', content: await systemPrompt() },
    ...hist,
    { role: 'user', content: userMessage },
  ];

  let rounds = 0;
  const usageTotal = { input: 0, output: 0, cacheHit: 0 };
  const usageSnapshot = () => {
    const total = usageTotal.input + usageTotal.output;
    return { input: usageTotal.input, output: usageTotal.output, total, cacheHit: usageTotal.cacheHit, cost: calcCost(cfg.model, usageTotal.input, usageTotal.output, usageTotal.cacheHit) };
  };
  try {
    while (rounds < MAX_ROUNDS) {
      rounds++;
      const { message: msg, usage } = await callLLM(t.messages, cfg.allowShell ? TOOLS : TOOLS);

      if (usage) {
        usageTotal.input += usage.prompt_tokens || 0;
        usageTotal.output += usage.completion_tokens || 0;
        usageTotal.cacheHit += usage.prompt_cache_hit_tokens || 0;
        sse(taskId, { type: 'usage', ...usageSnapshot() });
      }

      if (!msg || !msg.tool_calls || msg.tool_calls.length === 0) {
        t.messages.push({ role: 'assistant', content: msg?.content || '' });
        const finalUsage = usageSnapshot();
        sse(taskId, { type: 'final', content: msg?.content || '完成(无文本回复)', usage: finalUsage });
        await addProjectStats(getCurrentProjectId(), finalUsage);
        await flushConversation(t);
        return;
      }

      t.messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
      sse(taskId, { type: 'thinking', content: '正在执行操作…' });

      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      for (const call of calls) {
        const fn = call.function;
        let args = {};
        try { args = JSON.parse(fn.arguments || '{}'); } catch { args = { raw: fn.arguments }; }

        sse(taskId, { type: 'tool_call', name: fn.name, args });
        let result;
        try {
          result = await execTool(fn.name, args, {
            workdir: getWorkdir(),
            requireConfirm: cfg.requireConfirm,
            log: (m) => sse(taskId, { type: 'log', data: m }),
            requestConfirm: async (text) => {
              const confirmId = crypto.randomUUID();
              sse(taskId, { type: 'confirm', id: confirmId, text });
              return waitConfirm(taskId, confirmId);
            },
          });
        } catch (err) {
          result = `❌ 工具执行异常: ${err.message}`;
        }
        sse(taskId, { type: 'tool_result', name: fn.name, content: result.slice(0, 2000) });
        const rl = Math.max(200, parseInt(cfg.toolResultLimit, 10) || 600);
        const storedResult = result.length > rl ? result.slice(0, rl) + ' …(结果过长,已截断)' : result;
        t.messages.push({ role: 'tool', tool_call_id: call.id, content: storedResult });
      }
    }
    const finalUsage = usageSnapshot();
    sse(taskId, { type: 'final', content: `已达到最大工具调用轮数(${MAX_ROUNDS}),请检查后重试。`, usage: finalUsage });
    await addProjectStats(getCurrentProjectId(), finalUsage);
    t.messages.push({ role: 'assistant', content: '已停止(达到轮数上限)' });
    await flushConversation(t);
  } catch (e) {
    sse(taskId, { type: 'error', content: `⚠️ 出错了: ${e.message}` });
  }
}

// ── 路由 ───────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const c = getConfig();
  res.json({ apiKey: c.apiKey ? '已设置(****)' : '', baseUrl: c.baseUrl, model: c.model, allowShell: c.allowShell, requireConfirm: c.requireConfirm, historyTurns: c.historyTurns, toolResultLimit: c.toolResultLimit, reasoningEffort: c.reasoningEffort, enabledTools: c.enabledTools || [], docRoots: c.docRoots || [] });
});

// 打开原生文件夹选择器,返回所选目录
app.post('/api/select-dir', async (req, res) => {
  try {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: '选择项目存放位置' });
    if (r.canceled || !r.filePaths.length) return res.json({ ok: false, canceled: true });
    res.json({ ok: true, path: r.filePaths[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 把某个项目迁移到指定目录
app.post('/api/projects/:id/dir', async (req, res) => {
  try {
    const r = await setProjectDir(req.params.id, req.body.dir);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 设置某项目的文档目录(供「查本地文档」工具按需检索)
app.post('/api/projects/:id/docs', async (req, res) => {
  try {
    const r = await setProjectDocRoots(req.params.id, req.body && req.body.docs);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 彻底删除某个项目(注册表 + 磁盘文件夹)
app.post('/api/projects/:id/delete', async (req, res) => {
  try {
    const r = await deleteProject(req.params.id);
    tasks.clear();
    conversation = await loadChat();
    res.json({ ok: true, ...r, current: getCurrentProjectId() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 查询当前模型的账户余额(DeepSeek 原生支持,其他服务商尽力尝试)
app.get('/api/balance', async (req, res) => {
  try {
    const cfg = getConfig();
    const base = (cfg.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
    if (!cfg.apiKey) return res.json({ ok: false, error: '未设置 API Key' });
    const url = /deepseek/i.test(base) ? `${base}/user/balance` : null;
    if (!url) return res.json({ ok: true, supported: false, message: '当前模型/服务商暂不支持余额查询' });
    const r = await fetch(url, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
    if (!r.ok) {
      const t = await r.text();
      return res.status(r.status).json({ ok: false, error: `余额查询失败(${r.status}): ${t.slice(0, 200)}` });
    }
    res.json({ ok: true, supported: true, data: await r.json() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/project-stats', (req, res) => {
  res.json(getProjectStats(getCurrentProjectId()));
});

app.post('/api/config', async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.apiKey && b.apiKey !== '已设置(****)') patch.apiKey = b.apiKey;
  if (b.baseUrl) patch.baseUrl = b.baseUrl;
  if (b.model) patch.model = b.model;
  if (typeof b.allowShell === 'boolean') patch.allowShell = b.allowShell;
  if (typeof b.requireConfirm === 'boolean') patch.requireConfirm = b.requireConfirm;
  if (b.historyTurns !== undefined) patch.historyTurns = Math.max(1, Math.min(30, parseInt(b.historyTurns, 10) || 6));
  if (b.toolResultLimit !== undefined) patch.toolResultLimit = Math.max(200, Math.min(8000, parseInt(b.toolResultLimit, 10) || 600));
  if (['low', 'medium', 'high'].includes(b.reasoningEffort)) patch.reasoningEffort = b.reasoningEffort;
  if (Array.isArray(b.enabledTools)) patch.enabledTools = b.enabledTools.map(n => n === 'godot_doc' ? 'doc_search' : n).filter(n => OPTIONAL_TOOLS[n]);
  if (Array.isArray(b.docRoots)) patch.docRoots = b.docRoots.filter(r => r && typeof r.path === 'string' && r.path.trim()).map(r => ({ path: r.path.trim(), name: r.name ? String(r.name).trim() : '' }));
  const cfg = await saveConfig(patch);
  res.json({ ok: true, config: cfg });
});

app.post('/api/new-task', (req, res) => {
  const taskId = crypto.randomUUID();
  tasks.set(taskId, { messages: [], sse: null, confirmWaiters: new Map() });
  res.json({ taskId });
});

app.get('/api/stream', (req, res) => {
  const t = tasks.get(req.query.taskId);
  if (!t) return res.status(404).end();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  t.sse = res;
  res.write(`data: ${JSON.stringify({ type: 'ready' })}\n\n`);
  req.on('close', () => { t.sse = null; });
});

// ── 局域网实时共享房间 ──
app.post('/api/share/start', (req, res) => {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const pid = getCurrentProjectId();
  shareRooms.set(code, { projectId: pid, clients: new Set() });
  res.json({ ok: true, code, address: `http://${lanIP()}:${PORT}`, projectId: pid });
});

app.get('/api/share/stream', (req, res) => {
  const room = shareRooms.get(String(req.query.room || '').toUpperCase());
  if (!room) return res.status(404).json({ ok: false, error: '房间不存在或已关闭' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  room.clients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'ready' })}\n\n`);
  req.on('close', () => room.clients.delete(res));
});

app.post('/api/chat', async (req, res) => {
  const { taskId, message } = req.body;
  const t = tasks.get(taskId);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  if (!message) return res.status(400).json({ error: '消息为空' });
  broadcastToProject(getCurrentProjectId(), { type: 'chat', role: 'user', content: String(message) });
  const nl = String.fromCharCode(10);
  let userMsg = String(message);

  // 本会话有已上传的文件:图片转多模态直接给视觉模型,其他文件告知路径供工具读取
  if (t.uploadedFiles && t.uploadedFiles.length) {
    const files = t.uploadedFiles.slice();
    t.uploadedFiles = [];
    const imgParts = [];
    const otherFiles = [];

    if (isVisionModel()) {
      for (const f of files) {
        const mime = IMAGE_MIME[path.extname(f).toLowerCase()];
        if (mime) {
          try {
            const b64 = (await fs.readFile(f)).toString('base64');
            imgParts.push({ type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + b64 } });
          } catch (e) { otherFiles.push(f); }
        } else { otherFiles.push(f); }
      }
    } else { otherFiles.push(...files); }

    if (imgParts.length) {
      let text = userMsg;
      if (otherFiles.length) {
        text = '【用户还上传了以下文件(位于工作目录),可读取或处理】' + nl
          + otherFiles.map(f => ' - ' + f).join(nl) + nl + nl + text;
      }
      runAgent(taskId, [{ type: 'text', text }, ...imgParts]);
    } else {
      runAgent(taskId, '【用户已上传以下文件(位于工作目录),可读取或处理】' + nl
        + otherFiles.map(f => ' - ' + f).join(nl) + nl + nl + userMsg);
    }
    res.json({ ok: true });
    return;
  }

  runAgent(taskId, userMsg);
  res.json({ ok: true });
});

// ── 项目 + 会话持久化 ───────────────────────────────
app.get('/api/projects', async (req, res) => {
  const projects = await listProjects();
  res.json({ projects, current: getCurrentProjectId() });
});

// 导出项目为 zip(含聊天记录 + 全部工作文件),供同伴下载共享
app.get('/api/projects/:id/export', async (req, res) => {
  const meta = await getProject(req.params.id);
  if (!meta || !meta.dir) return res.status(404).json({ ok: false, error: '项目不存在' });
  try {
    const zip = new AdmZip();
    zip.addLocalFolder(meta.dir, '');
    const buf = zip.toBuffer();
    const fname = (meta.name || 'project').replace(/[\\/:*?"<>|]/g, '_') + '.zip';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="project.zip"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.send(buf);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 导入同伴分享的项目 zip,生成一个新项目
app.post('/api/projects/import', async (req, res) => {
  try {
    const b64 = req.body && req.body.data;
    if (!b64) return res.status(400).json({ ok: false, error: '未收到 zip 数据' });
    const zip = new AdmZip(Buffer.from(String(b64), 'base64'));
    let name = '导入项目';
    try { const pj = JSON.parse(zip.readAsText('project.json')); if (pj && pj.name) name = pj.name; } catch {}
    const meta = await createProject(name);
    zip.extractAllTo(meta.dir, true);
    try {
      const pjPath = path.join(meta.dir, 'project.json');
      const pj = JSON.parse(await fs.readFile(pjPath, 'utf8'));
      pj.id = meta.id; pj.name = meta.name; pj.dir = meta.dir;
      pj.updatedAt = Date.now(); pj.stats = meta.stats;
      await fs.writeFile(pjPath, JSON.stringify(pj, null, 2));
    } catch {}
    res.json({ ok: true, id: meta.id, name: meta.name });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/projects', async (req, res) => {
  try {
    const meta = await createProject(req.body && req.body.name);
    await setCurrentProject(meta.id);
    conversation = await loadChat(meta.id);
    tasks.clear();
    res.json({ ok: true, project: meta, conversation });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/projects/select', async (req, res) => {
  try {
    await setCurrentProject(req.body.id);
    conversation = await loadChat(req.body.id);
    tasks.clear();
    res.json({ ok: true, project: await getProject(req.body.id), conversation });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/conversation', async (req, res) => {
  res.json({ project: await getProject(getCurrentProjectId()), conversation });
});

// 文件上传(以原始字节接收,保存到工作目录 uploads/ 下)
app.post('/api/upload', express.raw({ type: 'application/octet-stream', limit: '100mb' }), async (req, res) => {
  try {
    const taskId = req.query.taskId;
    const safeName = path.basename(String(req.query.name || 'upload.bin')).replace(/[\\/:*?"<>|]/g, '_');
    const uploadDir = path.join(getWorkdir(), 'uploads');
    await fs.mkdir(uploadDir, { recursive: true });
    const target = path.join(uploadDir, safeName);
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    await fs.writeFile(target, buf);
    const t = tasks.get(taskId);
    if (t) { t.uploadedFiles = t.uploadedFiles || []; t.uploadedFiles.push(target); }
    res.json({ ok: true, name: safeName, path: target, size: buf.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/confirm', (req, res) => {
  const t = tasks.get(req.body.taskId);
  const waiter = t?.confirmWaiters?.get(req.body.confirmId);
  if (waiter) { waiter(req.body.decision === 'yes'); res.json({ ok: true }); }
  else res.status(404).json({ error: '确认请求不存在或已超时' });
});

setInterval(() => {
  for (const [id, t] of tasks) {
    if (!t.sse && t.messages.length === 0) tasks.delete(id);
  }
}, 60000).unref();

export async function startServer(port = PORT) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      const c = getConfig();
      console.log(`\n  桌面智能助手已启动`);
      console.log(`  ➜  http://localhost:${port}`);
      console.log(`  ➜  模型: ${c.model}`);
      console.log(`  ➜  工作目录: ${getWorkdir()}`);
      console.log(`  ➜  shell: ${c.allowShell ? '开' : '关'} | 高危确认: ${c.requireConfirm ? '开' : '关'}\n`);
      resolve(server);
    });
  });
}

// 直接运行(非 Electron)时自动启动服务
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
