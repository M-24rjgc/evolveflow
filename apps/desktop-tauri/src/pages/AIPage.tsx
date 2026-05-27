import React, { useState, useEffect, useRef } from 'react';
import { callCapability } from '../lib/tauri';

interface ActionLog {
  id: string;
  capability: string;
  actor: string;
  origin: string;
  description: string | null;
  created_at: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  action_log_id?: string;
}

interface DreamStatus {
  isRunning: boolean;
  lastDreamTime: string | null;
  sessionCount: number;
}

export default function AIPage() {
  const [messages, setMessages] = useState<Message[]>([
    { id: crypto.randomUUID(), role: 'assistant', content: '你好！我是 EvolveFlow AI 助手。我可以帮你安排日程、管理任务、查询历史操作。试试说"帮我安排明天"或"查看我的任务"！' }
  ]);
  const [input, setInput] = useState('');
  const [actionLogs, setActionLogs] = useState<ActionLog[]>([]);
  const [showActionLogs, setShowActionLogs] = useState(false);
  const [explainResult, setExplainResult] = useState<string | null>(null);
  const [dreamStatus, setDreamStatus] = useState<DreamStatus | null>(null);
  const [undoingId, setUndoingId] = useState<string | null>(null);

  const sendingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    loadActionLogs();
    checkDreamStatus();
  }, []);

  async function loadActionLogs() {
    try {
      const result = await callCapability('history.list_actions', { limit: 20 }) as { success: boolean; data?: ActionLog[] };
      if (result.success && result.data) setActionLogs(result.data);
    } catch (err) { console.error('Failed to load action logs:', err); }
  }

  async function checkDreamStatus() {
    try {
      const result = await callCapability('preference.get', { key: 'dream_last_run' }) as { success: boolean; data?: string };
      setDreamStatus({
        isRunning: false,
        lastDreamTime: result.success ? result.data || null : null,
        sessionCount: 0,
      });
    } catch (err) {
      console.error('Failed to check dream status:', err);
      setDreamStatus({ isRunning: false, lastDreamTime: null, sessionCount: 0 });
    }
  }

  async function handleSend() {
    if (!input.trim() || sendingRef.current) return;
    sendingRef.current = true;
    const userMsg = input.trim();
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', content: userMsg }]);
    setInput('');

    const lower = userMsg.toLowerCase();

    try {
      setTimeout(async () => {
        try {
          if (lower.includes('安排今天') || lower.includes('排程今天') || lower.includes('plan today')) {
            const result = await callCapability('schedule.plan_day', { date: new Date().toISOString().split('T')[0] }) as { success: boolean; data?: unknown };
            if (!mountedRef.current) return;
            if (result.success) {
              setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: '已为你安排好今天的日程！可以在"今天"页面查看详情。' }]);
              setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'system', content: `已执行: schedule.plan_day → ${JSON.stringify(result.data)}`, action_log_id: 'auto' }]);
            }
            loadActionLogs();
            return;
          }

          if (lower.includes('查看历史') || lower.includes('action log') || lower.includes('动作记录')) {
            setShowActionLogs(true);
            const result = await callCapability('history.list_actions', { limit: 20 }) as { success: boolean; data?: ActionLog[] };
            if (!mountedRef.current) return;
            if (result.success && result.data) {
              const logText = result.data.map((l) => `[${l.created_at}] ${l.capability} - ${l.actor}/${l.origin}`).join('\n');
              setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: `最近操作记录：\n${logText}` }]);
            }
            return;
          }

          if (lower.includes('为什么') || lower.includes('解释') || lower.includes('explain')) {
            const blocks = await callCapability('schedule.plan_day', { date: new Date().toISOString().split('T')[0] }) as { success: boolean; data?: Array<{ id: string }> };
            if (!mountedRef.current) return;
            if (blocks.success && blocks.data && blocks.data.length > 0) {
              const explanations = [];
              for (const block of blocks.data.slice(0, 3)) {
                const exp = await callCapability('schedule.explain', { schedule_block_id: block.id }) as { success: boolean; data?: { reasons: string[] } };
                if (exp.success && exp.data) {
                  explanations.push(exp.data.reasons.join(', '));
                }
              }
              setExplainResult(explanations.join('\n'));
              setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: `排程解释：\n${explanations.join('\n')}` }]);
            }
            return;
          }

          if (lower.includes('撤回') || lower.includes('撤销') || lower.includes('undo')) {
            const logs = await callCapability('history.list_actions', { limit: 1, actor: 'ai' }) as { success: boolean; data?: ActionLog[] };
            if (!mountedRef.current) return;
            if (logs.success && logs.data && logs.data.length > 0) {
              const lastLog = logs.data[0];
              setUndoingId(lastLog.id);
              const undoResult = await callCapability('undo.revert_action', { action_log_id: lastLog.id }) as { success: boolean };
              if (undoResult.success) {
                setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: `已撤回操作：${lastLog.capability}` }]);
              }
              loadActionLogs();
            } else {
              setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: '没有可撤回的动作记录。' }]);
            }
            return;
          }

          if (lower.includes('dream') || lower.includes('记忆整理')) {
            const status = dreamStatus;
            if (status) {
              setMessages((prev) => [...prev, {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: `Dream 状态：\n- 运行中: ${status.isRunning ? '是' : '否'}\n- 上次运行: ${status.lastDreamTime || '从未'}\n- 会话计数: ${status.sessionCount}`
              }]);
            }
            return;
          }

          if (!mountedRef.current) return;
          setMessages((prev) => [...prev, {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `我可以帮你做以下事情：\n1. 安排今天日程 → 说"安排今天"\n2. 查看操作历史 → 说"查看历史"\n3. 解释排程原因 → 说"为什么这么安排"\n4. 撤回最近操作 → 说"撤回"\n5. 查看 Dream 状态 → 说"Dream 状态"\n6. 创建任务 → 说"创建任务：xxx"\n\n请告诉我你需要什么帮助？`
          }]);
        } catch (e) {
          if (!mountedRef.current) return;
          setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: `处理请求时出错: ${e}` }]);
        }
      }, 300);
    } finally {
      sendingRef.current = false;
    }
  }

  return (
    <div>
      <h1 className="page-title">AI 助手</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className="btn btn-secondary" onClick={() => { loadActionLogs(); setShowActionLogs(!showActionLogs); }}>
          {showActionLogs ? '隐藏动作记录' : '显示动作记录'}
        </button>
        <button className="btn btn-secondary" onClick={async () => {
          const blocks = await callCapability('schedule.plan_day', { date: new Date().toISOString().split('T')[0] }) as { success: boolean; data?: Array<{ id: string }> };
          if (blocks.success && blocks.data && blocks.data.length > 0) {
            const exp = await callCapability('schedule.explain', { schedule_block_id: blocks.data[0].id }) as { success: boolean; data?: { reasons: string[] } };
            if (exp.success && exp.data) {
              setExplainResult(exp.data.reasons.join('\n'));
            }
          }
        }}>解释排程</button>
        <button className="btn btn-secondary" onClick={checkDreamStatus}>Dream 状态</button>
      </div>

      {showActionLogs && (
        <div className="card" style={{ maxHeight: 200, overflowY: 'auto', marginBottom: 12 }}>
          <h3 className="card-title">动作记录</h3>
          {actionLogs.length === 0 && <p style={{ color: '#888', fontSize: 13 }}>暂无动作记录</p>}
          {actionLogs.map((log) => (
            <div key={log.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f0f0f0', fontSize: 13 }}>
              <span style={{ color: '#888', minWidth: 80 }}>{log.created_at?.slice(11, 19)}</span>
              <span style={{ fontWeight: 500, minWidth: 120 }}>{log.capability}</span>
              <span style={{ color: '#666' }}>{log.actor}/{log.origin}</span>
              <button
                className="btn btn-secondary"
                style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px' }}
                onClick={async () => {
                  const result = await callCapability('undo.revert_action', { action_log_id: log.id }) as { success: boolean };
                  if (result.success) {
                    loadActionLogs();
                    alert('已撤回该操作');
                  }
                }}
              >撤回</button>
            </div>
          ))}
        </div>
      )}

      {explainResult && (
        <div className="card" style={{ marginBottom: 12 }}>
          <h3 className="card-title">排程解释</h3>
          <pre style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{explainResult}</pre>
          <button className="btn btn-secondary" style={{ marginTop: 8, fontSize: 12 }} onClick={() => setExplainResult(null)}>关闭</button>
        </div>
      )}

      {dreamStatus && (
        <div className="card" style={{ marginBottom: 12 }}>
          <h3 className="card-title">Dream 状态</h3>
          <div style={{ fontSize: 13 }}>
            <p>运行中: {dreamStatus.isRunning ? '是' : '否'}</p>
            <p>上次运行: {dreamStatus.lastDreamTime || '从未运行'}</p>
            <p>会话计数: {dreamStatus.sessionCount}</p>
          </div>
        </div>
      )}

      <div className="chat-container" style={{ height: 'calc(100vh - 380px)' }}>
        <div className="chat-messages">
          {messages.map((msg) => (
            <div key={msg.id} className={`message-bubble message-${msg.role}`}>
              {msg.content.split('\n').map((line, j) => <span key={j}>{line}<br /></span>)}
            </div>
          ))}
        </div>
        <div className="chat-input-area">
          <input
            type="text"
            placeholder="输入消息...（试试：安排今天 / 查看历史 / 为什么 / 撤回 / Dream 状态）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          />
          <button className="btn btn-primary" onClick={handleSend}>发送</button>
        </div>
      </div>
    </div>
  );
}