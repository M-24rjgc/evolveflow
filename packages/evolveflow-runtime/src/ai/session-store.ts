/**
 * 会话 JSONL 持久化。
 *
 * Agent（L2）没有内置持久化（AgentHarness 才有，但事件转发坏了，C7）。
 * 这里手动做：每个 session 一个 JSONL 文件，每条 AgentMessage 追加一行；
 * rebuild 时读全部行还原 messages 数组。
 *
 * 文件格式：每行一个 JSON 序列化的 AgentMessage（含 role/content/timestamp）。
 * 不存 system prompt / tools / mode（那些每次 rebuild 重建）。
 * 只存对话 transcript——这是"重启不丢"的核心。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentMessage } from '@evolveflow/vendor-pi-agent';

/** 默认会话目录：~/.evolveflow/sessions/（可经 EVOLVEFLOW_SESSIONS_DIR 覆盖，测试用）。 */
export function defaultSessionsDir(): string {
  return process.env.EVOLVEFLOW_SESSIONS_DIR ?? path.join(os.homedir(), '.evolveflow', 'sessions');
}

/**
 * SessionStore：按 sessionId 管理 JSONL 文件。
 * 一个 store 实例对应一个目录；多个 session 共享目录但文件独立。
 */
export class SessionStore {
  constructor(private readonly dir: string = defaultSessionsDir()) {}

  /** 返回某 session 的 JSONL 文件路径。 */
  private file(sessionId: string): string {
    // sessionId 只允许字母数字-（防路径穿越）。
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.jsonl`);
  }

  /** 确保目录存在。 */
  async ensureDir(): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
    } catch {
      /* 并发创建或权限问题，忽略——append 时会再报 */
    }
  }

  /**
   * 追加一条消息到 session 文件。
   * append-only，O(1) 写入。失败不抛（持久化是 best-effort，不应阻断对话）。
   */
  async append(sessionId: string, message: AgentMessage): Promise<void> {
    try {
      await this.ensureDir();
      await fs.appendFile(this.file(sessionId), JSON.stringify(message) + '\n', 'utf8');
    } catch (err) {
      console.error(`[session-store] append 失败 session=${sessionId}:`, err);
    }
  }

  /**
   * 加载某 session 的全部消息（按写入顺序）。
   * 文件不存在返回空数组。损坏行跳过（不阻断）。
   */
  async load(sessionId: string): Promise<AgentMessage[]> {
    try {
      const content = await fs.readFile(this.file(sessionId), 'utf8');
      const messages: AgentMessage[] = [];
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          messages.push(JSON.parse(trimmed) as AgentMessage);
        } catch {
          /* 跳过损坏行 */
        }
      }
      return messages;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return [];
      } // 文件不存在 = 新 session
      console.error(`[session-store] load 失败 session=${sessionId}:`, err);
      return [];
    }
  }

  /** 删除某 session 文件（ai.delete_session 用）。 */
  async delete(sessionId: string): Promise<boolean> {
    try {
      await fs.unlink(this.file(sessionId));
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return false;
      }
      console.error(`[session-store] delete 失败 session=${sessionId}:`, err);
      return false;
    }
  }

  /** 列出所有 session 的元数据（文件名 + 行数 + mtime）。 */
  async list(): Promise<Array<{ sessionId: string; messageCount: number; mtimeMs: number }>> {
    try {
      await this.ensureDir();
      const entries = await fs.readdir(this.dir);
      const result: Array<{ sessionId: string; messageCount: number; mtimeMs: number }> = [];
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) {
          continue;
        }
        const sessionId = entry.slice(0, -'.jsonl'.length);
        const filePath = path.join(this.dir, entry);
        try {
          const stat = await fs.stat(filePath);
          const content = await fs.readFile(filePath, 'utf8');
          const messageCount = content.split('\n').filter((l) => l.trim()).length;
          result.push({ sessionId, messageCount, mtimeMs: stat.mtimeMs });
        } catch {
          /* 跳过读不了的文件 */
        }
      }
      // 按 mtime 降序（最近活跃在前）。
      result.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return result;
    } catch {
      return [];
    }
  }
}
