// lib/doc_search.js —— 通用本地文档检索(纯本地全文搜索,零 API 费用)
// 适用任意软件/框架的手册、教程等文档;支持多目录、多种文件格式:
//   html/htm、txt、md/markdown、docx(zip 解析)、pdf(需安装 pdf-parse)
// 索引缓存放在应用数据目录(避免污染用户文档目录),按「文件 mtime 签名」判断新鲜度,
// 并提供进程级内存缓存;单次检索按字符预算输出,附完整文件路径便于模型深读原文。
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';

const FILE_RE = /\.(html?|txt|md|markdown|docx|pdf)$/i;
// 单次检索返回的字符预算(防止把海量文档一次性塞进上下文、被外部截断浪费)
const MAX_OUT_CHARS = 4000;

// 索引缓存统一放在应用数据目录(与主程序一致),避免污染用户文档目录
const DATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '桌面智能助手');
const DOC_INDEX_DIR = path.join(DATA_DIR, 'docindex');
const CACHE_VERSION = 2;

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '\u2014').replace(/&ndash;/g, '\u2013').replace(/&hellip;/g, '\u2026').replace(/&copy;/g, '\u00A9').replace(/&reg;/g, '\u00AE')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n')
    .trim();
}

// 从不同格式提取纯文本(尽力而为,失败则忽略该文件)
async function extractText(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html' || ext === '.htm') {
    try { return stripHtml(await fs.readFile(file, 'utf8')); } catch (e) { return ''; }
  }
  if (ext === '.txt' || ext === '.md' || ext === '.markdown') {
    try { return (await fs.readFile(file, 'utf8')).replace(/\s+/g, ' ').trim(); } catch (e) { return ''; }
  }
  if (ext === '.docx') {
    try {
      const zip = new AdmZip(file);
      const entry = zip.getEntry('word/document.xml');
      if (!entry) return '';
      const xml = entry.getData().toString('utf8');
      return xml
        .replace(/<w:p[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n')
        .trim();
    } catch (e) { return ''; }
  }
  if (ext === '.pdf') {
    try {
      const mod = await import('pdf-parse');
      const buf = await fs.readFile(file);
      const d = await mod.default(buf);
      return (d.text || '').replace(/\s+/g, ' ').trim();
    } catch (e) { return ''; } // 未安装 pdf-parse 或解析失败
  }
  return '';
}

async function collectFiles(dir, out = []) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!e.name.startsWith('.') && e.name !== '_static' && e.name !== '_sources' && e.name !== '_images') await collectFiles(full, out);
    } else if (FILE_RE.test(e.name)) { out.push(full); }
  }
  return out;
}

// 检测目录下是否存在 .pdf 文件(用于未安装 pdf-parse 时的提示)
async function hasPdf(dir) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return false; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!e.name.startsWith('.') && e.name !== '_static' && e.name !== '_sources' && e.name !== '_images') { if (await hasPdf(full)) return true; }
    } else if (/\.pdf$/i.test(e.name)) { return true; }
  }
  return false;
}

// 收集全部可检索文件的「相对路径 + mtime + 大小」,用于计算内容签名
async function collectFilesMeta(dir, out = [], base = '') {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (!e.name.startsWith('.') && e.name !== '_static' && e.name !== '_sources' && e.name !== '_images') await collectFilesMeta(full, out, rel);
    } else if (FILE_RE.test(e.name)) {
      try { const st = await fs.stat(full); out.push(`${rel}\u0000${st.mtimeMs}\u0000${st.size}`); } catch (e) { }
    }
  }
  return out;
}

// 基于「相对路径+mtime+大小」的签名:文件内容/增删改变都会导致签名变化
async function fileSig(rootPath) {
  try {
    const metas = await collectFilesMeta(rootPath);
    const h = crypto.createHash('sha1');
    for (const m of metas) { h.update(m); h.update('\u0001'); }
    return metas.length + ':' + h.digest('hex');
  } catch (e) { return null; }
}

// 并发读取 + 提取文本(单次最多 CONC 个文件,避免一次性吃满内存)
const CONC = 8;
async function buildRootIndex(rootPath) {
  const files = await collectFiles(rootPath);
  const pages = [];
  for (let i = 0; i < files.length; i += CONC) {
    const batch = files.slice(i, i + CONC);
    const texts = await Promise.all(batch.map(f => extractText(f)));
    batch.forEach((f, j) => {
      const text = texts[j];
      if (!text) return;
      pages.push({
        file: path.relative(rootPath, f).replace(/\\/g, '/'),
        title: path.basename(f).replace(FILE_RE, ''),
        abs: path.resolve(f), // 绝对路径,便于 AI 用 read_file 深读原文
        text
      });
    });
  }
  return pages;
}

// 缓存文件按「目标目录」的哈希命名,放在应用数据目录
const cachePathFor = (rootPath) => path.join(DOC_INDEX_DIR, crypto.createHash('sha1').update(rootPath).digest('hex').slice(0, 24) + '.json');

// 进程级内存缓存:root -> { sig, pages, ts };ts 用于短窗口内免重扫文件系统
const memCache = new Map();
const MEM_MAX = 20;
const FRESH_MS = 1500; // 1.5 秒内视为新鲜,直接返回内存页(兼顾提速与感知)

// 读取某个文档集的页(优先内存 -> 磁盘缓存 -> 重建)
async function getPages(rootPath) {
  const now = Date.now();
  const m = memCache.get(rootPath);
  if (m && m.pages && now - m.ts < FRESH_MS) return m.pages; // 新窗口命中,零磁盘/零扫描

  const sig = await fileSig(rootPath);
  if (m && m.pages && sig !== null && m.sig === sig) { m.ts = now; return m.pages; } // 签名未变,只用内存页

  let pages = null;
  const cacheP = cachePathFor(rootPath);
  try {
    const cached = JSON.parse(await fs.readFile(cacheP, 'utf8'));
    if (sig !== null && cached.sig === sig && cached.v === CACHE_VERSION) pages = cached.pages; // 磁盘缓存仍新鲜
  } catch (e) { /* 缓存缺失/损坏/旧版本 */ }

  if (!pages) {
    pages = await buildRootIndex(rootPath); // 重建
    try {
      await fs.mkdir(DOC_INDEX_DIR, { recursive: true });
      await fs.writeFile(cacheP, JSON.stringify({ sig, v: CACHE_VERSION, pages }), 'utf8');
    } catch (e) { }
  }

  if (memCache.size >= MEM_MAX) memCache.clear(); // 防膨胀
  memCache.set(rootPath, { sig, pages, ts: now });
  return pages;
}

function tokenize(q) { return (q || '').toLowerCase().split(/[\s,;:+\-_.\/]+/).filter(Boolean); }
function countOccurs(s, t) { let n = 0, i = s.indexOf(t); while (i !== -1) { n++; i = s.indexOf(t, i + t.length); } return n; }

function makeSnippet(text, terms) {
  const lowerText = text.toLowerCase();
  const words = terms.filter(t => lowerText.includes(t));
  if (!words.length) return text.slice(0, 700);
  const lens = 900;
  const len = text.length;
  const step = Math.max(50, Math.floor(lens / 2));
  let best = 0, bestScore = -1;
  for (let s = 0; s - lens < len; s += step) {
    const seg = lowerText.slice(s, s + lens);
    let sc = 0; for (const t of words) if (seg.includes(t)) sc++;
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  const start = Math.max(0, best);
  return (start > 0 ? '…' : '') + text.slice(start, start + lens) + (start + lens < len ? '…' : '');
}

// 未配置目录时,自动兼容旧的 <用户目录>/GodotDocs/<版本> 布局
async function defaultRoots() {
  const gd = path.join(os.homedir(), 'GodotDocs');
  const roots = [];
  try {
    const ds = await fs.readdir(gd, { withFileTypes: true });
    for (const d of ds) if (d.isDirectory()) roots.push({ path: path.join(gd, d.name), name: d.name });
  } catch (e) { }
  return roots;
}

// 打分:标题命中加权 + 全词命中加权 + 文件名(类名)贴近加权
function scoreFor(p, queryRaw, terms) {
  const lower = p.text.toLowerCase();
  const titleLower = p.title.toLowerCase();
  const stem = path.basename(p.file).replace(FILE_RE, '').toLowerCase();
  let score = 0, allHit = true;
  for (const t of terms) {
    const c = countOccurs(lower, t);
    if (c > 0) score += 1 + Math.min(c, 8);
    else allHit = false;
    if (titleLower.includes(t)) score += 15;
  }
  if (allHit && terms.length > 1) score += 20;
  const q = queryRaw.toLowerCase().trim();
  if (stem === q) score += 30;
  else if (terms.every(t => stem.includes(t))) score += 10;
  return score;
}

const noConfigMsg = `尚未配置本地文档目录。

请在【📁 项目 → 项目卡片 → 📄 文档】点「＋ 添加目录」选择本地文档文件夹。
支持格式:html / txt / md / docx(pdf 需另装 pdf-parse)。
AI 会在写代码、不确定某个 API/类/函数用法时按需检索,平时零 token 开销。`;

export async function searchDocs(query, options = {}) {
  // roots: [{path, name}];filterName 可只搜某个文档集
  let roots = (options.roots || []).filter(r => r && r.path);
  if (!roots.length) roots = await defaultRoots();
  const filterName = (options.filterName || '').trim();
  const effectiveRoots = filterName ? roots.filter(r => (r.name || '') === filterName) : roots;

  if (!effectiveRoots.length) {
    return filterName
      ? `未找到名称为 \`${filterName}\` 的文档集。当前配置:${roots.map(r => r.name || r.path).join(', ')}`
      : noConfigMsg;
  }

  const terms = tokenize(query);
  if (!terms.length) return '请提供检索关键词,如 node、sprite2d、api、shader。';

  let pages = [];
  for (const r of effectiveRoots) {
    const rp = r.path;
    try {
      const st = await fs.stat(rp);
      if (!st.isDirectory()) continue;
      const rpages = await getPages(rp);
      for (const p of rpages) pages.push({ ...p, rootName: r.name || '' });
    } catch (e) { continue; }
  }

  if (!pages.length) {
    let pdfHint = '';
    try {
      for (const r of effectiveRoots) { if (await hasPdf(r.path)) { pdfHint = '\n\n⚠️ 目录中发现 PDF 文件,但本工具可能未安装 pdf-parse,已被跳过。如需解析请先安装 pdf-parse。'; break; } }
    } catch (e) { }
    return `文档目录中未找到可检索的文件。\n\n请确认已把文档放进配置的目录,且是受支持格式(html / txt / md / docx / pdf):\n${effectiveRoots.map(r => r.path).join('\n')}` + pdfHint;
  }

  const results = [];
  for (const p of pages) {
    const score = scoreFor(p, query, terms);
    if (score > 0) results.push({ score, p });
  }

  if (!results.length) {
    return `在本地文档中未找到 \`${query}\`。文档多为英文,建议用关键词(如类名、方法名)。`;
  }

  results.sort((a, b) => b.score - a.score);
  const labelFor = ({ score, p }) => `### ${p.title}\n(来源: ${p.rootName ? p.rootName + '/' + p.file : p.file} | 匹配度 ${score})\n  文件: ${p.abs || '(未知)'}\n\n`;
  const SEP = '\n\n---\n\n';
  const out = [];
  let used = 0;
  for (const r of results.slice(0, 12)) {
    const head = labelFor(r);
    let body = makeSnippet(r.p.text, terms);
    const sepLen = out.length ? SEP.length : 0;
    let block = head + body;
    if (out.length && used + sepLen + block.length > MAX_OUT_CHARS) break; // 越过预算即停
    if (!out.length && block.length > MAX_OUT_CHARS) {
      const budget = Math.max(0, MAX_OUT_CHARS - head.length - 1);
      body = budget > 0 ? body.slice(0, budget) + '…' : body.slice(0, budget);
      block = head + body;
    }
    out.push(block);
    used += sepLen + block.length;
  }
  if (!out.length && results.length) {
    const r = results[0];
    out.push(labelFor(r) + makeSnippet(r.p.text, terms));
  }
  const hint = out.length ? '\n\n(若片段不够,可用 read_file 读取上面列出的「文件」路径看完整内容。)' : '';
  return `共命中 ${results.length} 页,按需显示最相关 ${out.length} 页(省 token):\n\n` + out.join(SEP) + hint;
}
