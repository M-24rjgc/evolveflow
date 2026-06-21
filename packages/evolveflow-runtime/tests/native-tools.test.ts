/**
 * native-tools 单元测试：read + glob 的 execute 行为。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createReadTool,
  createGlobTool,
  createEvolveFlowNativeTools,
} from '../src/ai/native-tools.js';

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ef-native-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('createReadTool', () => {
  it('读取存在的文本文件', async () => {
    const filePath = path.join(tmpDir, 'note.md');
    await fs.writeFile(filePath, 'line1\nline2\nline3\n', 'utf8');
    const tool = createReadTool(tmpDir);
    const res = await tool.execute('tc1', { file_path: 'note.md' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('line1');
    expect(text).toContain('line2');
    expect(text).toContain('line3');
  });

  it('offset/limit 切片正确', async () => {
    const filePath = path.join(tmpDir, 'lines.txt');
    await fs.writeFile(filePath, 'aaa\nbbb\nccc\nddd\neee\n', 'utf8');
    const tool = createReadTool(tmpDir);
    const res = await tool.execute('tc1', { file_path: 'lines.txt', offset: 2, limit: 2 });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('bbb');
    expect(text).toContain('ccc');
    expect(text).not.toContain('aaa');
    expect(text).not.toContain('eee');
  });

  it('文件不存在返回友好错误（不抛）', async () => {
    const tool = createReadTool(tmpDir);
    const res = await tool.execute('tc1', { file_path: 'nope.txt' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('文件不存在');
  });

  it('读目录返回错误提示', async () => {
    const tool = createReadTool(tmpDir);
    const res = await tool.execute('tc1', { file_path: '.' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('目录');
  });

  it('工具名满足 OpenAI 约束', () => {
    const tool = createReadTool(tmpDir);
    expect(tool.name).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe('createGlobTool', () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(tmpDir, 'a.md'), 'x');
    await fs.writeFile(path.join(tmpDir, 'b.txt'), 'x');
    await fs.mkdir(path.join(tmpDir, 'sub'));
    await fs.writeFile(path.join(tmpDir, 'sub', 'c.md'), 'x');
    await fs.writeFile(path.join(tmpDir, 'sub', 'd.pdf'), 'x');
  });

  it('按扩展名匹配', async () => {
    const tool = createGlobTool(tmpDir);
    const res = await tool.execute('tc1', { pattern: '*.md' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('a.md');
    expect(text).toContain('c.md');
    expect(text).not.toContain('b.txt');
  });

  it('递归匹配（** 模式或后缀）', async () => {
    const tool = createGlobTool(tmpDir);
    const res = await tool.execute('tc1', { pattern: '*.pdf' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('d.pdf');
  });

  it('无匹配返回提示', async () => {
    const tool = createGlobTool(tmpDir);
    const res = await tool.execute('tc1', { pattern: '*.xyz' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('未找到');
  });

  it('工具名满足 OpenAI 约束', () => {
    const tool = createGlobTool(tmpDir);
    expect(tool.name).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe('createEvolveFlowNativeTools', () => {
  it('返回 read + glob 两个工具', () => {
    const tools = createEvolveFlowNativeTools(tmpDir);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(['glob', 'read']);
  });
});

describe('read 工具：PDF 文本抽取', () => {
  it('读真实 PDF（pdfkit 生成）并提取文本', async () => {
    // 动态用 pdfkit 生成一个含已知文本的真实 PDF。
    const PDFDocument = (await import('pdfkit')).default;
    const pdfPath = path.join(tmpDir, 'sample.pdf');
    await new Promise<void>((resolve, reject) => {
      const doc = new PDFDocument();
      const chunks: Buffer[] = [];
      doc.text('EvolveFlow PDF test content chapter one.');
      doc.text('Second paragraph with key points: alpha, beta, gamma.');
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => {
        fs.writeFile(pdfPath, Buffer.concat(chunks)).then(resolve, reject);
      });
      doc.on('error', reject);
      doc.end();
    });

    const tool = createReadTool(tmpDir);
    const res = await tool.execute('tc1', { file_path: 'sample.pdf' });
    const text = (res.content[0] as { text: string }).text;
    // 经 pdfjs-dist 抽取，应包含原文关键字（顺序可能被分词打散，但词应存在）。
    expect(text).toContain('EvolveFlow');
    expect(text).toContain('PDF test content');
    expect(text).toContain('alpha');
    // details 含 PDF 元信息
    expect((res.details as { extractedText?: boolean }).extractedText).toBe(true);
    expect((res.details as { numpages?: number }).numpages).toBeGreaterThanOrEqual(1);
  });
});
