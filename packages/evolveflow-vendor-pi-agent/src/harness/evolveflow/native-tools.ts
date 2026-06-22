/**
 * EvolveFlow 原生文件工具（read + glob + PDF 抽取），作为 pi AgentTool 实现。
 *
 * 这些工具属于 pi 包（pi 是项目源码）。让 AI 能读用户机器上的文件
 * （笔记、配置、文本素材、PDF）——"消费用户日常素材"愿景的基础能力。
 *
 * 工具名是合法标识符（无点号，满足 OpenAI 端点约束）。
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, isAbsolute, relative } from 'node:path';
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '../../types.ts';
import { extractPdfText } from './pdf-extract.ts';

const MAX_READ_BYTES = 256 * 1024;
const MAX_GLOB_RESULTS = 200;

/** read 工具：读文本文件 / PDF 内容，支持行范围。 */
export function createReadTool(cwd: string): AgentTool {
  return {
    name: 'read',
    label: 'read',
    description: `读取本地文件内容（文本或 PDF）。路径相对 ${cwd} 或绝对路径。支持 offset（起始行，1基）和 limit（读取行数）。单次最多 ${MAX_READ_BYTES / 1024}KB。PDF 自动抽取文本。`,
    parameters: Type.Object({
      file_path: Type.String({ description: '文件路径（相对工作目录或绝对路径）' }),
      offset: Type.Optional(Type.Number({ description: '起始行号（1 基），默认 1' })),
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
        let content: string;
        // PDF 走专门的文本抽取
        if (file_path.toLowerCase().endsWith('.pdf')) {
          const pdfText = await extractPdfText(absPath);
          content = pdfText;
        } else {
          content = await readFile(absPath, 'utf8');
        }

        let lines = content.split('\n');
        const start = offset ? Math.max(0, offset - 1) : 0;
        if (start >= lines.length) {
          return {
            content: [{ type: 'text', text: `offset ${offset} 超出文件范围（共 ${lines.length} 行）` }],
            details: { path: absPath, truncated: false },
          };
        }
        const end = limit ? Math.min(start + limit, lines.length) : lines.length;
        let selected = lines.slice(start, end).join('\n');
        let truncated = false;
        if (Buffer.byteLength(selected, 'utf8') > MAX_READ_BYTES) {
          selected = Buffer.from(selected, 'utf8').subarray(0, MAX_READ_BYTES).toString('utf8');
          truncated = true;
        }
        const isPdf = file_path.toLowerCase().endsWith('.pdf');
        const header = `${absPath}（${isPdf ? 'PDF抽取' : '行'} ${start + 1}-${end}${end < lines.length ? ` / ${lines.length}` : ''}）${truncated ? ' [已截断]' : ''}`;
        return {
          content: [{ type: 'text', text: `${header}\n\n${selected}` }],
          details: { path: absPath, truncated, totalLines: lines.length, isPdf },
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

/** glob 工具：按模式找文件。 */
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
        const more = results.length > MAX_GLOB_RESULTS ? `\n...（还有 ${results.length - MAX_GLOB_RESULTS} 个未显示）` : '';
        return {
          content: [{ type: 'text', text: `匹配 "${pattern}"（${results.length} 个）：\n${limited.join('\n')}${more}` }],
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

function globToRegex(pattern: string): RegExp {
  let re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const DOUBLE_STAR_PLACEHOLDER = 'DBLSTAR';
  re = re.replace(/\*\*/g, DOUBLE_STAR_PLACEHOLDER);
  re = re.replace(/\*/g, '[^/]*');
  re = re.replace(new RegExp(DOUBLE_STAR_PLACEHOLDER, 'g'), '.*');
  return new RegExp(`(^|/)${re}$`, 'i');
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache',
  '.evolveflow', 'AppData', 'Library', '.venv', '__pycache__',
]);

async function walk(
  root: string,
  current: string,
  regex: RegExp,
  results: string[],
  depth: number,
): Promise<void> {
  if (depth > 8 || results.length >= MAX_GLOB_RESULTS + 50) return;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= MAX_GLOB_RESULTS + 50) return;
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(root, fullPath, regex, results, depth + 1);
    } else if (entry.isFile()) {
      const relPath = relative(root, fullPath).split('\\').join('/');
      if (regex.test(relPath) || regex.test(entry.name)) {
        results.push(fullPath);
      }
    }
  }
}
