import React, { useState, useEffect, useCallback, useRef } from 'react';
import { callCapability } from '../lib/tauri';

interface GlobalAIFloatingProps {
  currentPage?: string;
}

export default function GlobalAIFloating({ currentPage = 'unknown' }: GlobalAIFloatingProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([
    { role: 'assistant', content: '需要什么帮助？' }
  ]);
  const [input, setInput] = useState('');

  const isOpenRef = useRef(isOpen);
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  isOpenRef.current = isOpen;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'f') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
      if (e.key === 'Escape' && isOpenRef.current) {
        setIsOpen(false);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleSend = useCallback(async () => {
    if (!input.trim()) return;
    const msg = input.trim();
    setMessages((prev) => [...prev, { role: 'user', content: msg }]);
    setInput('');

    setTimeout(async () => {
      try {
        const result = await callCapability('task.create', { title: msg }) as { success: boolean; data?: { title: string } };
        if (!mountedRef.current) return;
        if (result.success) {
          setMessages((prev) => [...prev, { role: 'assistant', content: `已创建任务："${result.data?.title}"` }]);
        } else {
          setMessages((prev) => [...prev, { role: 'assistant', content: `处理完成（当前页面: ${currentPage}）` }]);
        }
      } catch {
        if (!mountedRef.current) return;
        setMessages((prev) => [...prev, { role: 'assistant', content: '请求已发送（AI 连接待完善）' }]);
      }
    }, 300);
  }, [input, currentPage]);

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setIsOpen(true)}
        style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
          width: 56, height: 56, borderRadius: '50%',
          background: '#4a6fa5', color: 'white', border: 'none',
          fontSize: 24, cursor: 'pointer', boxShadow: '0 4px 12px rgba(74,111,165,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        title="AI 助手 (Ctrl+Shift+F)"
      >AI</button>

      {/* Overlay */}
      {isOpen && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9998,
            background: 'rgba(0,0,0,0.3)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setIsOpen(false); }}
        >
          <div
            style={{
              width: 500, maxHeight: '60vh', background: 'white',
              borderRadius: '16px 16px 0 0', padding: 20,
              display: 'flex', flexDirection: 'column',
              boxShadow: '0 -4px 20px rgba(0,0,0,0.15)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontWeight: 700, fontSize: 16 }}>AI 助手</span>
              <span style={{ fontSize: 12, color: '#888' }}>当前: {currentPage}</span>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', maxHeight: 300, marginBottom: 12 }}>
              {messages.map((msg, i) => (
                <div key={i} className={`message-bubble message-${msg.role}`} style={{ maxWidth: '90%', fontSize: 13 }}>
                  {msg.content}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                placeholder="快速录入任务..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              />
              <button className="btn btn-primary" onClick={handleSend}>发送</button>
              <button className="btn btn-secondary" onClick={() => setIsOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}