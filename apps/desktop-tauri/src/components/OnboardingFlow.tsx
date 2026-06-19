import React, { useState, useEffect } from 'react';
import { ArrowRight, CheckCircle2, ListPlus, Sparkles } from 'lucide-react';
import { callCapability } from '../lib/tauri';
import { useI18n } from '../lib/i18n';
import { localIsoDate } from '../lib/date';

interface OnboardingFlowProps {
  onComplete: () => void;
}

export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { t } = useI18n();
  const [step, setStep] = useState(1);
  const [taskTitle, setTaskTitle] = useState('');
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  useEffect(() => {
    if (step === 3) {
      checkApiKeyStatus();
    }
  }, [step]);

  async function checkApiKeyStatus() {
    try {
      const result = await callCapability('api_key.status', {}) as {
        success?: boolean;
        data?: { configured: boolean };
        configured?: boolean;
      };
      setHasApiKey(!!(result.data?.configured ?? result.configured));
    } catch {
      setHasApiKey(false);
    }
  }

  async function handleCreateFirstTask() {
    if (!taskTitle.trim()) {return;}
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
      await callCapability('schedule.plan_day', { date: localIsoDate() });
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

  return (
    <div className="onboarding-overlay">
      <div className="onboarding-shell">
        <div className="logo-mark">
          <Sparkles size={18} />
        </div>
        <div className="onboarding-steps" aria-label="Onboarding progress">
          {[1, 2, 3].map((item) => (
            <span key={item} className={`onboarding-step ${step >= item ? 'active' : ''}`} />
          ))}
        </div>

      {step === 1 && (
        <div className="onboarding-card">
          <h1>{t('onboarding.welcome_title')}</h1>
          <p>
            {t('onboarding.welcome_desc')}
          </p>
          <div className="onboarding-actions">
            <button className="btn btn-primary" onClick={() => setStep(2)}>
              {t('onboarding.start')}
              <ArrowRight size={16} />
            </button>
            <button className="btn btn-secondary" onClick={handleSkip}>{t('onboarding.skip')}</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="onboarding-card">
          <h1>
            <ListPlus size={26} />
            {t('onboarding.step2_title')}
          </h1>
          <p>
            {t('onboarding.step2_desc')}
          </p>
          <div className="onboarding-form">
            <input
              type="text"
              placeholder={t('onboarding.step2_placeholder')}
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateFirstTask()}
            />
            <button className="btn btn-primary" onClick={handleCreateFirstTask}>
              <ListPlus size={16} />
              {t('onboarding.step2_create')}
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="onboarding-card">
          <h1>
            <CheckCircle2 size={26} />
            {t('onboarding.step3_title')}
          </h1>
          <p>
            {t('onboarding.step3_desc1')}
          </p>
          {createdTaskId && (
            <p className="field-help">
              {t('onboarding.step3_task_id', { id: createdTaskId.slice(0, 8) })}
            </p>
          )}
          <p>
            {t('onboarding.step3_desc2')}
          </p>
          <div className="onboarding-actions">
            <button className="btn btn-primary" onClick={handleViewSchedule}>
              {t('onboarding.step3_view_schedule')}
              <ArrowRight size={16} />
            </button>
          </div>
          {hasApiKey === false && (
            <p className="onboarding-note">
              {t('onboarding.step3_no_api_key')}
              <span
                className="onboarding-link"
                onClick={() => { window.location.hash = '#settings-ai'; onComplete(); }}
              >{t('onboarding.step3_go_settings')}</span>
              {t('onboarding.step3_enable_ai')}
            </p>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
