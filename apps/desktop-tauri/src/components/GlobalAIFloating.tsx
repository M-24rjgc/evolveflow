/**
 * Dual-mode floating widget: creates tasks directly for simple input,
 * routes to AI for complex queries.
 *
 * - When the user types a short task description, it calls task.create.
 * - When the user types a question/conversational text, it routes to AI chat.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { callCapability } from '../lib/tauri';
import { useI18n } from '../lib/i18n';

interface GlobalAIFloatingProps {
  currentPage?: string;
}

/** Detect if user input looks like a conversational question rather than a quick task description */
function isQuestionOrConversation(text: string): boolean {
  if (/[?？]/.test(text)) {return true;}
  return /吗|什么|怎么|帮我|为什么|如何|是否|有没有|能不能|可以吗|行吗|建议|推荐|解释|分析/.test(text);
}

export default function GlobalAIFloating({ currentPage = 'unknown' }: GlobalAIFloatingProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([
    { role: 'assistant', content: t('ai_floating.initial_message') }
  ]);
  const [input, setInput] = useState('');

  const isOpenRef = useRef(isOpen);
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const sessionIdRef = useRef(`qt_${Date.now()}`);

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
      if (timerRef.current) {clearTimeout(timerRef.current);}
    };
  }, []);

  /** Derived: whether the current input looks like a question / AI conversation */
  const isAiMode = input.trim() ? isQuestionOrConversation(input.trim()) : false;
  const floatingBottom = 88;
  const hideFloatingButton = currentPage === '/settings';

  const handleSend = useCallback(async () => {
    if (!input.trim()) {return;}
    const msg = input.trim();
    const isAi = isQuestionOrConversation(msg);
    setMessages((prev) => [...prev, { role: 'user', content: msg }]);
    setInput('');

    if (isAi) {
      // AI conversation mode — route through real AI chat
      try {
        const result = await callCapability('ai.chat', {
          message: msg,
          session_id: sessionIdRef.current,
        }) as { text?: string; error?: string };
        if (!mountedRef.current) {return;}
        if (result.text) {
          setMessages((prev) => [...prev, { role: 'assistant', content: result.text! }]);
        } else if (result.error) {
          setMessages((prev) => [...prev, { role: 'assistant', content: t('ai_floating.ai_error') + ': ' + result.error }]);
        } else {
          setMessages((prev) => [...prev, { role: 'assistant', content: t('ai_floating.no_response') }]);
        }
      } catch (err) {
        if (!mountedRef.current) {return;}
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: t('ai_floating.request_failed') + ': ' + (err instanceof Error ? err.message : String(err)),
        }]);
      }
    } else {
      // Quick task creation mode
      try {
        const result = await callCapability('task.create', { title: msg }) as { success: boolean; data?: { title: string } };
        if (!mountedRef.current) {return;}
        if (result.success) {
          setMessages((prev) => [...prev, { role: 'assistant', content: t('ai_floating.task_created', { title: result.data?.title || '' }) }]);
        } else {
          setMessages((prev) => [...prev, { role: 'assistant', content: t('ai_floating.processed', { page: currentPage }) }]);
        }
      } catch {
        if (!mountedRef.current) {return;}
        setMessages((prev) => [...prev, { role: 'assistant', content: t('ai_floating.request_sent') }]);
      }
    }
  }, [input, currentPage]);

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setIsOpen(true)}
        style={{
          position: 'fixed', bottom: floatingBottom, right: 24, zIndex: 9999,
          width: 56, height: 56, borderRadius: '50%',
          background: 'var(--accent-color)', color: 'white', border: 'none',
          fontSize: 14, fontWeight: 700, cursor: 'pointer',
          boxShadow: '0 12px 24px rgba(37,99,235,0.28)',
          display: hideFloatingButton ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center',
          letterSpacing: 1,
        }}
        aria-label={t('floating.title')}
      >{t('ai_floating.create_task')}</button>

      {/* Overlay */}
      {isOpen && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9998,
            background: 'rgba(0,0,0,0.3)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) {setIsOpen(false);} }}
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
              <span style={{ fontWeight: 700, fontSize: 16 }}>{t('ai_floating.panel_title')}</span>
              <span style={{ fontSize: 12, color: '#888' }}>{t('ai_floating.current_page')}: {currentPage}</span>
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
                placeholder={t('ai_floating.input_placeholder')}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                style={{ flex: 1 }}
              />
              <button className="btn btn-primary" onClick={handleSend}>
                {isAiMode ? t('ai_floating.send_ai') : t('ai_floating.create_task')}
              </button>
              <button className="btn btn-secondary" onClick={() => setIsOpen(false)}>{t('common.close')}</button>
            </div>
            {/* Mode indicator — prominent pill badge */}
            {input.trim() && (
              <div style={{
                display: 'inline-block',
                alignSelf: 'flex-end',
                marginTop: 6,
                padding: '3px 10px',
                borderRadius: 12,
                fontSize: 11,
                fontWeight: 600,
                color: '#fff',
                background: isAiMode ? '#4a6fa5' : '#4caf50',
                boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
              }}>
                {isAiMode ? t('ai_floating.ai_mode') : t('ai_floating.task_mode')}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
