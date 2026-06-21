/**
 * EvolveFlow 原生文件工具：read + glob。
 *
 * 让 AI 能读用户机器上的文件（笔记、配置、文本素材）。
 * 这是"消费用户日常素材"愿景（CONTEXT §64-79）的基础能力。
 *
 * 自实现而非 vendor pi coding-agent 的工具——后者依赖 @earendil-works/pi-tui
 * （终端渲染），EvolveFlow 用 React 用不到 render 部分。这里只做 execute，
 * 纯 AgentTool 定义，跨平台（纯 Node fs）。
 *
 * 工具名用合法标识符（无点号，满足 OpenAI 端点）。
 * 权限：这些是只读工具，所有 mode（除 chat）都可用。
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, isAbsolute, relative, extname } from 'node:path';
import { Type } from 'typebox';
import type { AgentTool } from '@evolveflow/vendor-pi-agent';
// pdfjs-dist 是 PDF.js 的 Node 构建，动态 import 避免启动时加载。
// （pdf-parse 1.1.1 用旧版 PDF.js，对压缩流 PDF 报 "bad XRef entry"，故选 pdfjs-dist。）
type PdfjsModule = {
  getDocument: (params: { data: Uint8Array }) => { promise: Promise<PdfjsDoc> };
};
interface PdfjsDoc {
  numPages: number;
  getPage: (n: number) => Promise<PdfjsPage>;
}
interface PdfjsPage {
  getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
}
let _pdfjs: PdfjsModule | null | undefined = undefined;
async function getPdfjs(): Promise<PdfjsModule | null> {
  if (_pdfjs !== undefined) {
    return _pdfjs;
  }
  try {
    // legacy build 对 Node 友好（不依赖 DOM fetch）。
    _pdfjs = (await import('pdfjs-dist/legacy/build/pdf.js')) as unknown as PdfjsModule;
  } catch {
    try {
      _pdfjs = (await import('pdfjs-dist/build/pdf.js')) as unknown as PdfjsModule;
    } catch {
      _pdfjs = null;
    }
  }
  return _pdfjs;
}

const MAX_READ_BYTES = 256 * 1024; // 单次 read 上限 256KB，防止超大文件撑爆上下文
const MAX_GLOB_RESULTS = 200; // glob 结果上限

/** read 工具：读文本文件内容，支持行范围。 */
export function createReadTool(cwd: string): AgentTool {
  return {
    name: 'read',
    label: 'read',
    description: `读取本地文件内容。路径相对 ${cwd} 或绝对路径。支持 offset（起始行，1基）和 limit（读取行数）。单次最多 ${MAX_READ_BYTES / 1024}KB。用于查看笔记、配置、代码、文档等。支持 PDF 文本抽取（.pdf 自动提取可读文本）。`,
    parameters: Type.Object({
      file_path: Type.String({
        description: '文件路径（相对工作目录或绝对路径）。支持 .pdf 自动文本抽取。',
      }),
      offset: Type.Optional(Type.Number({ description: '起始行号（1 基），默认 1（PDF 不适用）' })),
      limit: Type.Optional(Type.Number({ description: '读取行数，默认全部（受字节上限）' })),
    }),
    async execute(_toolCallId, params) {
      const { file_path, offset, limit } = params as {
        file_path: string;
        offset?: number;
        limit?: number;
      };
      const absPath = resolvePath(cwd, file_path);
      try {
        // PDF 分支：二进制读取 + pdf-parse 文本抽取。
        if (extname(absPath).toLowerCase() === '.pdf') {
          return await readPdf(absPath);
        }
        const content = await readFile(absPath, 'utf8');
        const lines = content.split('\n');
        const start = offset ? Math.max(0, offset - 1) : 0;
        if (start >= lines.length) {
          return {
            content: [
              { type: 'text', text: `offset ${offset} 超出文件范围（共 ${lines.length} 行）` },
            ],
            details: { path: absPath, truncated: false },
          };
        }
        const end = limit ? Math.min(start + limit, lines.length) : lines.length;
        let selected = lines.slice(start, end).join('\n');
        let truncated = false;
        // 字节上限截断
        if (Buffer.byteLength(selected, 'utf8') > MAX_READ_BYTES) {
          selected = Buffer.from(selected, 'utf8').subarray(0, MAX_READ_BYTES).toString('utf8');
          truncated = true;
        }
        const header = `${absPath}（行 ${start + 1}-${end}${end < lines.length ? ` / ${lines.length}` : ''}）${truncated ? ' [已截断]' : ''}`;
        return {
          content: [{ type: 'text', text: `${header}\n\n${selected}` }],
          details: { path: absPath, truncated, totalLines: lines.length },
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const msg =
          code === 'ENOENT'
            ? `文件不存在：${absPath}`
            : code === 'EISDIR'
              ? `是目录不是文件：${absPath}`
              : `读取失败：${(err as Error).message}`;
        return {
          content: [{ type: 'text', text: msg }],
          details: { path: absPath, error: msg },
        };
      }
    },
  };
}

/** glob 工具：按模式找文件（简单实现，递归匹配扩展名/文件名模式）。 */
export function createGlobTool(cwd: string): AgentTool {
  return {
    name: 'glob',
    label: 'glob',
    description: `按文件名模式查找文件。path 指定搜索目录（默认 ${cwd}），pattern 是简化 glob（如 "*.md"、"notes/**"、"*.pdf"）。最多返回 ${MAX_GLOB_RESULTS} 个结果。`,
    parameters: Type.Object({
      pattern: Type.String({ description: '文件名模式，如 "*.md"、"*.pdf"、"report*"' }),
      path: Type.Optional(Type.String({ description: '搜索目录（默认工作目录）' })),
    }),
    async execute(_toolCallId, params) {
      const { pattern, path: searchPath } = params as { pattern: string; path?: string };
      const baseDir = searchPath ? resolvePath(cwd, searchPath) : cwd;
      try {
        const results: string[] = [];
        const regex = globToRegex(pattern);
        await walk(baseDir, baseDir, regex, results, 0);
        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: `在 ${baseDir} 下未找到匹配 "${pattern}" 的文件。` }],
            details: { pattern, baseDir, count: 0 },
          };
        }
        const limited = results.slice(0, MAX_GLOB_RESULTS);
        const more =
          results.length > MAX_GLOB_RESULTS
            ? `\n...（还有 ${results.length - MAX_GLOB_RESULTS} 个未显示）`
            : '';
        return {
          content: [
            {
              type: 'text',
              text: `匹配 "${pattern}"（${results.length} 个）：\n${limited.join('\n')}${more}`,
            },
          ],
          details: { pattern, baseDir, count: results.length },
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const msg =
          code === 'ENOENT' ? `目录不存在：${baseDir}` : `搜索失败：${(err as Error).message}`;
        return {
          content: [{ type: 'text', text: msg }],
          details: { pattern, baseDir, error: msg },
        };
      }
    },
  };
}

/** 创建 EvolveFlow 原生工具集（只读：read + glob）。 */
export function createEvolveFlowNativeTools(cwd: string): AgentTool[] {
  return [createReadTool(cwd), createGlobTool(cwd)];
}

// ── 内部辅助 ──────────────────────────────────────────

function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/**
 * 读 PDF 并抽取文本（经 pdfjs-dist）。
 * 遍历每页的 getTextContent，拼接 items.str。
 * 失败时返回友好错误（不抛），让 AI 知道 PDF 无法解析（可能是扫描件/加密）。
 */
async function readPdf(absPath: string): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
}> {
  const pdfjs = await getPdfjs();
  if (!pdfjs) {
    return {
      content: [{ type: 'text', text: `无法解析 PDF（pdfjs-dist 不可用）：${absPath}` }],
      details: { path: absPath, error: 'pdfjs unavailable' },
    };
  }
  try {
    // 先确认文件存在（pdfjs 对不存在的文件抛的错不友好）。
    try {
      await stat(absPath);
    } catch {
      return {
        content: [{ type: 'text', text: `文件不存在：${absPath}` }],
        details: { path: absPath, error: 'ENOENT' },
      };
    }
    const buf = await readFile(absPath);
    const data = new Uint8Array(buf);
    const doc = await pdfjs.getDocument({ data }).promise;
    const numpages = doc.numPages;
    const pageTexts: string[] = [];
    for (let i = 1; i <= numpages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((it) => it.str ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (pageText) {
        pageTexts.push(`--- 第 ${i} 页 ---\n${pageText}`);
      }
    }
    let text = pageTexts.join('\n\n').trim();
    let truncated = false;
    if (Buffer.byteLength(text, 'utf8') > MAX_READ_BYTES) {
      text = Buffer.from(text, 'utf8').subarray(0, MAX_READ_BYTES).toString('utf8');
      truncated = true;
    }
    if (!text) {
      return {
        content: [
          {
            type: 'text',
            text: `PDF 已读取（${numpages} 页），但未提取到文本——可能是扫描件/图片型 PDF，需要 OCR。`,
          },
        ],
        details: { path: absPath, numpages, extractedText: false },
      };
    }
    const header = `${absPath}（PDF，${numpages} 页）${truncated ? ' [已截断]' : ''}`;
    return {
      content: [{ type: 'text', text: `${header}\n\n${text}` }],
      details: { path: absPath, numpages, truncated, extractedText: true },
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `PDF 解析失败：${(err as Error).message}（${absPath}）` }],
      details: { path: absPath, error: (err as Error).message },
    };
  }
}

/** 简化 glob → RegExp：支持 *（单层）、**（多层）、字面后缀匹配。 */
function globToRegex(pattern: string): RegExp {
  // 转义正则特殊字符，再把通配符转回来
  let re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // ** 匹配任意层级（含 /）。先用普通占位串（非控制字符，规避 no-control-regex）
  // 替换 **，再处理单 *，最后把占位串转成 .*。
  const DOUBLE_STAR_PLACEHOLDER = 'DBLSTAR';
  re = re.replace(/\*\*/g, DOUBLE_STAR_PLACEHOLDER);
  // * 匹配单层（不含 /）
  re = re.replace(/\*/g, '[^/]*');
  re = re.replace(new RegExp(DOUBLE_STAR_PLACEHOLDER, 'g'), '.*');
  // 支持后缀模式如 "*.md" 匹配任意目录下的 .md
  return new RegExp(`(^|/)${re}$`, 'i');
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.cache',
  '.evolveflow',
  'AppData',
  'Library',
  '.venv',
  '__pycache__',
]);

/** 递归遍历目录，收集匹配 regex 的文件。depth 限制防无限递归。 */
async function walk(
  root: string,
  current: string,
  regex: RegExp,
  results: string[],
  depth: number
): Promise<void> {
  if (depth > 8 || results.length >= MAX_GLOB_RESULTS + 50) {
    return;
  }
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return; // 无权限等，跳过
  }
  for (const entry of entries) {
    if (results.length >= MAX_GLOB_RESULTS + 50) {
      return;
    }
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      await walk(root, fullPath, regex, results, depth + 1);
    } else if (entry.isFile()) {
      const relPath = relative(root, fullPath).split('\\').join('/'); // Windows 路径兼容
      if (regex.test(relPath) || regex.test(entry.name)) {
        results.push(fullPath);
      }
    }
  }
}
