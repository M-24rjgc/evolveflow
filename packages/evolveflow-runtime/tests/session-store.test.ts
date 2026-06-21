/**
 * SessionStore 单元测试：JSONL 持久化的 append/load/delete/list。
 * 用临时目录，不碰真实 ~/.evolveflow/sessions。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/ai/session-store.js';
import type { AgentMessage } from '@evolveflow/vendor-pi-agent';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ef-session-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function userMsg(text: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  } as AgentMessage;
}
function assistantMsg(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as AgentMessage;
}

describe('SessionStore', () => {
  it('load 不存在的 session 返回空数组', async () => {
    const store = new SessionStore(tmpDir);
    expect(await store.load('nonexistent')).toEqual([]);
  });

  it('append 后 load 能按顺序还原消息', async () => {
    const store = new SessionStore(tmpDir);
    await store.append('s1', userMsg('你好'));
    await store.append('s1', assistantMsg('你好！'));
    const loaded = await store.load('s1');
    expect(loaded).toHaveLength(2);
    expect((loaded[0] as { content: Array<{ text?: string }> }).content[0]!.text).toBe('你好');
    expect((loaded[1] as { content: Array<{ text?: string }> }).content[0]!.text).toBe('你好！');
    expect(loaded[0]!.role).toBe('user');
    expect(loaded[1]!.role).toBe('assistant');
  });

  it('delete 删除文件，再次 load 返回空', async () => {
    const store = new SessionStore(tmpDir);
    await store.append('s1', userMsg('x'));
    expect(await store.delete('s1')).toBe(true);
    expect(await store.load('s1')).toEqual([]);
    expect(await store.delete('s1')).toBe(false); // 已删
  });

  it('list 按修改时间降序返回所有 session', async () => {
    const store = new SessionStore(tmpDir);
    await store.append('old', userMsg('a'));
    // 让 mtime 不同
    await new Promise((r) => setTimeout(r, 30));
    await store.append('new', userMsg('b'));
    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list[0]!.sessionId).toBe('new'); // 最新在前
    expect(list[1]!.sessionId).toBe('old');
    expect(list[0]!.messageCount).toBe(1);
  });

  it('损坏行被跳过，不阻断 load', async () => {
    const store = new SessionStore(tmpDir);
    await store.append('s1', userMsg('good'));
    // 手动写一行坏 JSON
    await fs.appendFile(path.join(tmpDir, 's1.jsonl'), '{invalid json\n', 'utf8');
    await store.append('s1', userMsg('good2'));
    const loaded = await store.load('s1');
    expect(loaded).toHaveLength(2); // 坏行跳过
  });

  it('sessionId 含特殊字符被清洗（防路径穿越）', async () => {
    const store = new SessionStore(tmpDir);
    await store.append('../escape', userMsg('x'));
    // 应落在 tmpDir 下，不是上级目录
    const files = await fs.readdir(tmpDir);
    expect(files.some((f) => f.endsWith('.jsonl'))).toBe(true);
  });
});
