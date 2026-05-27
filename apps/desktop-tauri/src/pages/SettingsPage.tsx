import React, { useState } from 'react';
import { callCapability } from '../lib/tauri';

export default function SettingsPage() {
  const [workStart, setWorkStart] = useState('09:00');
  const [workEnd, setWorkEnd] = useState('18:00');
  const [reminderPreference, setReminderPreference] = useState('15');
  const [scheduleStyle, setScheduleStyle] = useState<'relaxed' | 'balanced' | 'tight'>('balanced');
  const [modelProvider, setModelProvider] = useState('openai');
  const [apiKey, setApiKey] = useState('');
  const [connectivityStatus, setConnectivityStatus] = useState<string | null>(null);
  const [buddyLevel, setBuddyLevel] = useState<'full' | 'minimal' | 'off'>('full');

  async function saveWorkHours() {
    try {
      await callCapability('preference.set', { key: 'work_hours_start', value: workStart });
      await callCapability('preference.set', { key: 'work_hours_end', value: workEnd });
      alert('工作时段已保存');
    } catch (e) {
      alert('保存失败: ' + e);
    }
  }

  async function saveReminderPreference() {
    try {
      await callCapability('preference.set', { key: 'reminder_minutes_before', value: reminderPreference });
      await callCapability('preference.set', { key: 'schedule_style', value: scheduleStyle });
      alert('偏好设置已保存');
    } catch (err) { console.error('Failed to save reminder preference:', err); }
  }

  async function testConnectivity() {
    setConnectivityStatus('检查中...');
    try {
      const result = await callCapability('task.list', { limit: 1 }) as { success: boolean };
      if (result.success) {
        setConnectivityStatus('✅ 连接正常 - 数据库和侧边车运行正常');
      } else {
        setConnectivityStatus('❌ 连接异常');
      }
    } catch (e) {
      setConnectivityStatus(`❌ 连接失败: ${e}`);
    }
  }

  return (
    <div>
      <h1 className="page-title">设置</h1>

      <div className="card">
        <h3 className="card-title">工作时段</h3>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <label>开始: <input type="time" value={workStart} onChange={(e) => setWorkStart(e.target.value)} /></label>
          <label>结束: <input type="time" value={workEnd} onChange={(e) => setWorkEnd(e.target.value)} /></label>
          <button className="btn btn-primary" onClick={saveWorkHours}>保存</button>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">提醒与安排偏好</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label>
            提前提醒时间：
            <select value={reminderPreference} onChange={(e) => setReminderPreference(e.target.value)} style={{ marginLeft: 8, width: 'auto' }}>
              <option value="5">5 分钟前</option>
              <option value="10">10 分钟前</option>
              <option value="15">15 分钟前</option>
              <option value="30">30 分钟前</option>
              <option value="60">1 小时前</option>
            </select>
          </label>
          <label>
            任务安排风格：
            <select value={scheduleStyle} onChange={(e) => setScheduleStyle(e.target.value as 'relaxed' | 'balanced' | 'tight')} style={{ marginLeft: 8, width: 'auto' }}>
              <option value="relaxed">宽松（任务间留 15 分钟缓冲）</option>
              <option value="balanced">平衡（任务间留 5 分钟缓冲）</option>
              <option value="tight">紧凑（任务背靠背安排）</option>
            </select>
          </label>
          <button className="btn btn-primary" style={{ width: 'fit-content' }} onClick={saveReminderPreference}>保存偏好</button>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">模型配置</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label>
            供应商：
            <select value={modelProvider} onChange={(e) => setModelProvider(e.target.value)} style={{ marginLeft: 8, width: 'auto' }}>
              <option value="openai">OpenAI</option>
              <option value="claude">Claude (Anthropic)</option>
              <option value="local">本地模型</option>
            </select>
          </label>
          <label>API Key: <input type="password" placeholder="输入你的 API Key..." value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-primary" onClick={testConnectivity}>检查连通性</button>
            {connectivityStatus && <span style={{ fontSize: 13 }}>{connectivityStatus}</span>}
          </div>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">Buddy 设置</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className={`btn ${buddyLevel === 'full' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setBuddyLevel('full')}>完整</button>
            <button className={`btn ${buddyLevel === 'minimal' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setBuddyLevel('minimal')}>弱化</button>
            <button className={`btn ${buddyLevel === 'off' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setBuddyLevel('off')}>关闭</button>
          </div>
          <span style={{ fontSize: 12, color: '#888' }}>完整：显示 Buddy 全部个性和建议 / 弱化：只显示关键信息 / 关闭：不显示 Buddy</span>
        </div>
      </div>
    </div>
  );
}