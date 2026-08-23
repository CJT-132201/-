import { exec } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { searchDocs } from './doc_search.js';
import { getConfig, getCurrentProjectId, getProjectDocRoots } from './config.js';

// ── 危险命令黑名单(正则,匹配即拦截) ─────────────────
const BLOCKLIST = [
  /\brm\s+(-rf|-fr|-[rf]{2})/,          // 强制删除
  /\bdel\s+\/s(\s|\/)/i,                 // 系统删除
  /\bformat\b/i,                          // 格式化
  /\bmkfs\b/i,
  /\bdeltree\b/i,
  /\bshutdown\b/i,                        // 关机
  /\breboot\b/i,                          // 重启
  /\b(cmd|powershell|pwsh)\s*(\/c|\-command)/i, // 嵌套命令注入
  /c:\\windows/i,                         // 动系统目录
  /\breg\s+(add|delete|deleteval)/i,      // 改注册表
  /\b(attrib|icacls|cacls)\b.*(-r|\/r)/i, // 批量改权限
  /\bnc\s|ncat\b/i,                        // 网络工具
  /socat/i,
];

// ── 高危命令,需要人工确认 ──────────────────────────
const CONFIRM_LIST = [
  /\bdel\b/i,
  /\brm\b/i,
  /\bmove\b/i,
  /\bcopy\b/i,
  /\bren\b/i,        // rename
  /^(curl|wget)\b/i, // 下载
  /\bpip\s+install/i,
  /\bnpm\s+install/i,
  /git\s+push/i,
  /\bnet\s+user/i,
  /\btaskkill\b/i,
];

function checkCommand(cmd) {
  for (const re of BLOCKLIST) {
    if (re.test(cmd)) return { ok: false, reason: `检测到危险命令: 命中拦截规则 ${re}` };
  }
  for (const re of CONFIRM_LIST) {
    if (re.test(cmd)) return { ok: true, confirm: true, reason: `需要人工确认的高危操作` };
  }
  return { ok: true, confirm: false };
}

// ── 在受限工作目录内运行 shell ─────────────────────
function runShell(cmd, workdir, log) {
  return new Promise((resolve) => {
    exec(cmd, { cwd: workdir, timeout: 60000, shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      log({ type: 'shell', cmd });
      if (err) {
        resolve(`(exit code ${err.code ?? '?'})\nSTDOUT:\n${(stdout || '').slice(0, 2500)}\nSTDERR:\n${(stderr || err.message || '').slice(0, 2500)}`);
      } else {
        resolve(`(ok)\n${(stdout || stderr || '(无输出)').slice(0, 4000)}`);
      }
    });
  });
}

// ── 工具执行器 ─────────────────────────────────────
export async function execTool(name, args, { workdir, requireConfirm, requestConfirm, log }) {
  switch (name) {
    case 'run_shell': {
      const cmd = String(args.command || '').trim();
      if (!cmd) return '错误: command 为空';
      const check = checkCommand(cmd);
      if (!check.ok) return `❌ 已拦截:${check.reason}\n命令: ${cmd}`;
      if (check.confirm && requireConfirm) {
        const ok = await requestConfirm(`运行高危命令?\n\n${cmd}\n\n确认执行请输入 "y",否则输入 "n"。`);
        if (!ok) return `❌ 用户取消执行:\n${cmd}`;
      }
      return runShell(cmd, workdir, log);
    }
    case 'read_file': {
      const p = path.resolve(workdir, String(args.path || ''));
      if (!p.startsWith(workdir)) return `❌ 越界访问被拒绝: ${p}`;
      try {
        const content = await fs.readFile(p, 'utf8');
        log({ type: 'read', path: p });
        return `(文件: ${p})\n${content.slice(0, 4000)}`;
      } catch (e) { return `❌ 读取失败: ${e.message}`; }
    }
    case 'write_file': {
      const p = path.resolve(workdir, String(args.path || ''));
      if (!p.startsWith(workdir)) return `❌ 越界访问被拒绝: ${p}`;
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, String(args.content ?? ''), 'utf8');
      log({ type: 'write', path: p });
      return `已写入 ${p} (${Buffer.byteLength(String(args.content ?? ''))} bytes)`;
    }
    case 'list_dir': {
      const p = path.resolve(workdir, String(args.path || '.'));
      if (!p.startsWith(workdir)) return `❌ 越界访问被拒绝: ${p}`;
      try {
        const items = await fs.readdir(p, { withFileTypes: true });
        log({ type: 'list', path: p });
        return items.map(i => (i.isDirectory() ? `[DIR]  ${i.name}` : `[FILE] ${i.name}`)).join('\n') || '(空目录)';
      } catch (e) { return `❌ 列目录失败: ${e.message}`; }
    }
    case 'open_folder': {
      const p = path.resolve(workdir, String(args.path || '.'));
      if (!p.startsWith(workdir)) return `❌ 越界访问被拒绝: ${p}`;
      exec(`explorer "${p}"`);
      return `已在资源管理器打开: ${p}`;
    }
    case 'get_sysinfo': {
      const totalMem = os.totalmem() / 1024 / 1024 / 1024;
      const freeMem = os.freemem() / 1024 / 1024 / 1024;
      const cpus = os.cpus();
      return `OS: ${os.type()} ${os.release()}
CPU: ${cpus[0] ? cpus[0].model.trim() : '?'} (${cpus.length} 核)
内存: 共 ${totalMem.toFixed(1)}GB,空闲 ${freeMem.toFixed(1)}GB
平台: ${os.platform()} ${os.arch()}`;
    }
    case 'http_get': {
      const url = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return '❌ 只允许 http/https 链接';
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'DesktopAssistant/1.0' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
        const text = await r.text();
        return `(HTTP ${r.status})
${text.slice(0, 3000)}`;
      } catch (e) { return `❌ 请求失败: ${e.message}`; }
    }
    case 'doc_search': {
      const q = String(args.query || '').trim();
      const pid = getCurrentProjectId();
      const docs = await getProjectDocRoots(pid);
      log({ type: 'doc_search', query: q });
      return await searchDocs(q, { roots: docs, filterName: String(args.root || '').trim() });
    }
    default:
      return `❌ 未知工具: ${name}`;
  }
}

// ── 工具 schema(给 DeepSeek 的函数定义) ───────────
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: '执行 cmd 命令(操作文件/运行程序/查信息)',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出目录内容',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文本文件',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入文本文件(覆盖)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  }
];

// ── 可选工具集:默认不发给模型(省钱),用户勾选后才启用 ──
export const OPTIONAL_TOOLS = {
  get_sysinfo: {
    type: 'function',
    function: {
      name: 'get_sysinfo',
      description: '获取系统信息(OS版本/CPU/内存)',
      parameters: { type: 'object', properties: {} }
    }
  },
  http_get: {
    type: 'function',
    function: {
      name: 'http_get',
      description: 'GET 请求网页/接口并返回文本',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url']
      }
    }
  },
  open_folder: {
    type: 'function',
    function: {
      name: 'open_folder',
      description: '在资源管理器打开工作目录下文件夹',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    }
  },
  doc_search: {
    type: 'function',
    function: {
      name: 'doc_search',
      description: '按需检索本地文档(全文搜索,零 API 费)。当需要参考本地安装的软件/框架手册、教程,或不确定某个类/函数/API/方法的用法时使用,只返回最相关的几段内容,省 token。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词,可用类名/函数名/API名(如 sprite2d、Tween、Node)' },
          root: { type: 'string', description: '可选:只搜某个文档集(填设置里给它起的名称)' }
        },
        required: ['query']
      }
    }
  }
};
