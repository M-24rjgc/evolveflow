import React, { useState, useEffect } from 'react';
import { callCapability } from '../lib/tauri';

interface OnboardingFlowProps {
  onComplete: () => void;
}

export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const [step, setStep] = useState(1);
  const [taskTitle, setTaskTitle] = useState('');
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  async function handleCreateFirstTask() {
    if (!taskTitle.trim()) return;
    try {
      const result = await callCapability('task.create', { title: taskTitle }) as { success: boolean; data?: { id: string } };
      if (result.success && result.data) {
        setCreatedTaskId(result.data.id);
        setStep(3);
      }
    } catch (err) { console.error('Failed to create first task:', err); }
  }

  async function handleViewSchedule() {
    try {
      await callCapability('schedule.plan_day', { date: new Date().toISOString().split('T')[0] });
      await callCapability('preference.set', { key: 'is_onboarded', value: 'true' });
    } catch (err) {
      console.error('Onboarding schedule plan failed:', err);
    }
    onComplete();
  }

  async function handleSkip() {
    try {
      await callCapability('preference.set', { key: 'is_onboarded', value: 'true' });
    } catch (err) {
      console.error('Onboarding skip preference save failed:', err);
    }
    onComplete();
  }

  const overlayStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 10000,
    background: 'linear-gradient(135deg, #4a6fa5, #6b8ec9)',
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    color: 'white', padding: 20,
  };

  return (
    <div style={overlayStyle}>
      {step === 1 && (
        <div style={{ textAlign: 'center', maxWidth: 500 }}>
          <h1 style={{ fontSize: 36, marginBottom: 16 }}>👋 欢迎使用 EvolveFlow</h1>
          <p style={{ fontSize: 18, marginBottom: 32, opacity: 0.9 }}>
            你的智能日程助手，帮你轻松管理时间和任务。
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <button
              style={{
                padding: '14px 32px', borderRadius: 8, border: 'none',
                background: 'white', color: '#4a6fa5', fontSize: 16, fontWeight: 600,
                cursor: 'pointer',
              }}
              onClick={() => setStep(2)}
            >开始使用</button>
            <button
              style={{
                padding: '14px 32px', borderRadius: 8, border: '2px solid rgba(255,255,255,0.5)',
                background: 'transparent', color: 'white', fontSize: 16, cursor: 'pointer',
              }}
              onClick={handleSkip}
            >跳过引导</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div style={{ textAlign: 'center', maxWidth: 500 }}>
          <h2 style={{ fontSize: 28, marginBottom: 12 }}>📝 创建你的第一个任务</h2>
          <p style={{ fontSize: 16, marginBottom: 24, opacity: 0.9 }}>
            试试看！输入一个你想做的事情，比如"准备明天的会议"
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <input
              type="text"
              placeholder="例如：准备明天的会议"
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateFirstTask()}
              style={{
                padding: '12px 16px', borderRadius: 8, border: 'none',
                fontSize: 16, width: 300,
              }}
            />
            <button
              style={{
                padding: '12px 24px', borderRadius: 8, border: 'none',
                background: 'white', color: '#4a6fa5', fontSize: 16, fontWeight: 600,
                cursor: 'pointer',
              }}
              onClick={handleCreateFirstTask}
            >创建</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div style={{ textAlign: 'center', maxWidth: 500 }}>
          <h2 style={{ fontSize: 28, marginBottom: 12 }}>🎉 太棒了！</h2>
          <p style={{ fontSize: 16, marginBottom: 8, opacity: 0.9 }}>
            你已成功创建了第一个任务！
          </p>
          {createdTaskId && (
            <p style={{ fontSize: 14, marginBottom: 24, opacity: 0.7 }}>
              任务 ID: {createdTaskId.slice(0, 8)}...
            </p>
          )}
          <p style={{ fontSize: 16, marginBottom: 32, opacity: 0.9 }}>
            接下来，让我帮你排程今天，看看你的日程安排。
          </p>
          <button
            style={{
              padding: '14px 32px', borderRadius: 8, border: 'none',
              background: 'white', color: '#4a6fa5', fontSize: 16, fontWeight: 600,
              cursor: 'pointer',
            }}
            onClick={handleViewSchedule}
          >查看我的日程</button>
        </div>
      )}
    </div>
  );
}