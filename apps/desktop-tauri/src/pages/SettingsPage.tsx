import React, { useState, useEffect } from 'react';
import {
  Bell,
  Bot,
  Clock3,
  Keyboard,
  Languages,
  Palette,
  Save,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  UserRound,
} from 'lucide-react';
import { callCapability } from '../lib/tauri';
import { useToast } from '../components/Toast';
import BackupPanel from '../components/BackupPanel';
import { ShortcutDisplay, DEFAULT_SHORTCUT_GROUPS } from '../lib/useKeyboardShortcuts';
import { useI18n, type Locale } from '../lib/i18n';
import { MetricCard, PageHeader, PageShell, Panel, SegmentedTabs } from '../components/PageChrome';

export default function SettingsPage() {
  const toast = useToast();
  const { t, locale, setLocale } = useI18n();
  const [workStart, setWorkStart] = useState('09:00');
  const [workEnd, setWorkEnd] = useState('18:00');
  const [reminderPreference, setReminderPreference] = useState('15');
  const [scheduleStyle, setScheduleStyle] = useState<'relaxed' | 'balanced' | 'tight'>('balanced');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [apiKeyPrefix, setApiKeyPrefix] = useState('');
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);
  const [connectivityStatus, setConnectivityStatus] = useState<string | null>(null);
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [buddyLevel, setBuddyLevel] = useState<'full' | 'minimal' | 'off'>('full');
  const [provider, setProvider] = useState<'anthropic' | 'deepseek'>('deepseek');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  // Toast-based notifications replace the old StatusMessage pattern

  useEffect(() => {
    loadPreferences();
    loadTheme();
  }, []);

  function loadTheme() {
    try {
      const stored = localStorage.getItem('evolveflow_theme');
      const isDark = stored === 'dark' || (!stored && window.matchMedia('(prefers-color-scheme: dark)').matches);
      setTheme(isDark ? 'dark' : 'light');
    } catch {
      setTheme('light');
    }
  }

  function toggleTheme() {
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
    try {
      localStorage.setItem('evolveflow_theme', newTheme);
    } catch {
      // Ignore localStorage failures; the in-memory theme still updates.
    }
    document.documentElement.setAttribute('data-theme', newTheme);
  }

  function handleLocaleChange(newLocale: Locale) {
    setLocale(newLocale);
    toast.success(t('settings.localeSwitched'));
  }

  async function loadPreferences() {
    try {
      const [startResult, endResult, reminderResult, styleResult, keyStatusResult, buddyResult, providerResult] = await Promise.all([
        callCapability('preference.get', { key: 'work_hours_start' }) as Promise<{ success: boolean; data?: string }>,
        callCapability('preference.get', { key: 'work_hours_end' }) as Promise<{ success: boolean; data?: string }>,
        callCapability('preference.get', { key: 'reminder_minutes_before' }) as Promise<{ success: boolean; data?: string }>,
        callCapability('preference.get', { key: 'schedule_style' }) as Promise<{ success: boolean; data?: string }>,
        callCapability('api_key.status', {}) as Promise<{ success?: boolean; data?: { configured: boolean; prefix: string }; configured?: boolean; prefix?: string }>,
        callCapability('preference.get', { key: 'buddy_level' }) as Promise<{ success: boolean; data?: string }>,
        callCapability('preference.get', { key: 'ai_provider' }) as Promise<{ success: boolean; data?: string }>,
      ]);

      if (startResult.success && startResult.data) {setWorkStart(startResult.data);}
      if (endResult.success && endResult.data) {setWorkEnd(endResult.data);}
      if (reminderResult.success && reminderResult.data) {setReminderPreference(reminderResult.data);}
      if (styleResult.success && styleResult.data) {
        setScheduleStyle(styleResult.data as 'relaxed' | 'balanced' | 'tight');
      }
      if (keyStatusResult) {
        const keyStatus = keyStatusResult.data || keyStatusResult;
        setApiKeyConfigured(!!keyStatus.configured);
        setApiKeyPrefix(keyStatus.prefix || '');
      }
      if (buddyResult.success && buddyResult.data) {
        setBuddyLevel(buddyResult.data as 'full' | 'minimal' | 'off');
      }
      if (providerResult.success && providerResult.data) {
        setProvider(providerResult.data as 'anthropic' | 'deepseek');
      }
    } catch {
      // Use defaults
    }
  }

  async function saveWorkHours() {
    try {
      await callCapability('preference.set', { key: 'work_hours_start', value: workStart });
      await callCapability('preference.set', { key: 'work_hours_end', value: workEnd });
      toast.success(t('settings.savedWorkHours'));
    } catch (e) {
      toast.error(t('settings.saveFailed', { reason: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function saveReminderPreference() {
    try {
      await callCapability('preference.set', { key: 'reminder_minutes_before', value: reminderPreference });
      await callCapability('preference.set', { key: 'schedule_style', value: scheduleStyle });
      toast.success(t('settings.savedPreferences'));
    } catch (e) {
      toast.error(t('settings.saveFailed', { reason: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function saveApiKey() {
    if (!apiKeyInput.trim()) {
      toast.warning(t('settings.enterApiKey'));
      return;
    }

    try {
      await callCapability('preference.set', { key: 'api_key', value: apiKeyInput.trim() });
      await callCapability('preference.set', { key: 'ai_provider', value: provider });
      setApiKeyConfigured(true);
      setApiKeyPrefix(apiKeyInput.trim().slice(-4));
      setApiKeyInput('');
      setShowApiKeyInput(false);
      toast.success(t('settings.api_key_saved'));
      setAiStatus(t('settings.aiInitializing'));
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await testAiConnectivity();
    } catch (e) {
      toast.error(t('settings.saveApiKeyFailed', { reason: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleChangeApiKey() {
    setShowApiKeyInput(true);
    setApiKeyInput('');
  }

  async function handleClearApiKey() {
    try {
      await callCapability('preference.set', { key: 'api_key', value: '' });
      setApiKeyConfigured(false);
      setApiKeyPrefix('');
      setShowApiKeyInput(false);
      setApiKeyInput('');
      toast.info(t('settings.api_key_cleared'));
    } catch (e) {
      toast.error(t('settings.clearFailed', { reason: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleProviderChange(newProvider: 'anthropic' | 'deepseek') {
    if (newProvider === provider) {return;}
    setProvider(newProvider);
    setApiKeyInput('');
    setApiKeyConfigured(false);
    setApiKeyPrefix('');
    setShowApiKeyInput(true);
    setAiStatus(null);
    try {
      await callCapability('preference.set', { key: 'ai_provider', value: newProvider });
      await callCapability('preference.set', { key: 'api_key', value: '' });
      const providerName = newProvider === 'anthropic' ? 'Anthropic (Claude)' : 'DeepSeek';
      toast.info(t('settings.switchedProvider', { provider: providerName }));
    } catch (e) {
      toast.error(t('settings.providerSwitchFailed', { reason: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function saveBuddyLevel(level: 'full' | 'minimal' | 'off') {
    setBuddyLevel(level);
    try {
      await callCapability('preference.set', { key: 'buddy_level', value: level });
      toast.success(t('settings.buddy_switched', { mode: t('settings.buddy_mode_' + level) }));
    } catch (e) {
      toast.error(t('settings.saveFailed', { reason: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function testConnectivity() {
    setConnectivityStatus(t('settings.connectivity_checking'));
    try {
      const result = await callCapability('task.list', { limit: 1 }) as { success: boolean };
      if (result.success) {
        setConnectivityStatus(t('settings.connectivity_ok'));
      } else {
        setConnectivityStatus(t('settings.connectivity_error'));
      }
    } catch (e) {
      setConnectivityStatus(t('settings.connectivityFailure', { reason: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function testAiConnectivity() {
    setAiStatus(t('settings.connectivity_checking'));
    try {
      const result = await callCapability('ai.check_connectivity', {}) as {
        connected?: boolean;
        reason?: string;
      };
      if (result.connected) {
        setAiStatus(t('settings.ai_check_ok'));
      } else {
        setAiStatus(t('settings.ai_check_fail', { reason: result.reason || t('settings.aiCheckNetworkKey') }));
      }
    } catch (e) {
      setAiStatus(t('settings.aiCheckFailure', { reason: e instanceof Error ? e.message : String(e) }));
    }
  }

  return (
    <PageShell>
      <PageHeader
        title={t('settings.title')}
        subtitle={`${provider === 'anthropic' ? 'Anthropic' : 'DeepSeek'} · ${locale}`}
        icon={<SettingsIcon size={19} />}
        actions={
          <>
            <button className="btn btn-secondary" onClick={testConnectivity}>
              <ShieldCheck size={16} />
              {t('settings.check_core')}
            </button>
            {apiKeyConfigured && (
              <button className="btn btn-primary" onClick={testAiConnectivity}>
                <Sparkles size={16} />
                {t('settings.check_ai')}
              </button>
            )}
          </>
        }
      />

      <div className="metric-grid">
        <MetricCard label={t('settings.appearance')} value={theme === 'dark' ? t('settings.theme_dark') : t('settings.theme_light')} hint={t('settings.language')} />
        <MetricCard label={t('settings.work_hours')} value={`${workStart}-${workEnd}`} hint={t('settings.schedule_style')} />
        <MetricCard label={t('settings.ai_config')} value={apiKeyConfigured ? t('ai.ready') : t('ai.no_key')} hint={provider === 'anthropic' ? 'Anthropic' : 'DeepSeek'} tone={apiKeyConfigured ? 'good' : 'warn'} />
        <MetricCard label={t('settings.reminder_preferences')} value={`${reminderPreference}m`} hint={t('settings.schedule_style')} />
        <MetricCard label={t('settings.buddy_settings')} value={t('settings.buddy_mode_' + buddyLevel)} hint={t('settings.buddy_desc')} />
      </div>

      {(connectivityStatus || aiStatus) && (
        <div className="card">
          {connectivityStatus && <span className="status-badge">{connectivityStatus}</span>}
          {aiStatus && <span className="status-badge" style={{ marginLeft: connectivityStatus ? 8 : 0 }}>{aiStatus}</span>}
        </div>
      )}

      <div className="settings-grid">
        <Panel title={t('settings.appearance')} icon={<Palette size={17} />}>
          <div className="field-grid">
            <label className="field-row">
              {t('settings.theme_label')}
              <button className="theme-toggle" onClick={toggleTheme} title={theme === 'dark' ? t('settings.theme_light') : t('settings.theme_dark')}>
                <Palette size={15} />
                <span>{theme === 'dark' ? t('settings.theme_dark') : t('settings.theme_light')}</span>
              </button>
            </label>
            <label htmlFor="settings-locale" className="field-row">
              <span><Languages size={15} style={{ verticalAlign: '-3px', marginRight: 6 }} />{t('settings.language')}</span>
              <select
                id="settings-locale"
                value={locale}
                onChange={(event) => handleLocaleChange(event.target.value as Locale)}
              >
                <option value="zh-CN">{t('settings.lang_zh')}</option>
                <option value="en-US">{t('settings.lang_en')}</option>
              </select>
            </label>
          </div>
        </Panel>

        <Panel title={t('settings.work_hours')} icon={<Clock3 size={17} />}>
          <div className="field-grid">
            <label htmlFor="settings-work-start" className="field-row">
              {t('settings.start')}
              <input id="settings-work-start" type="time" value={workStart} onChange={(event) => setWorkStart(event.target.value)} />
            </label>
            <label htmlFor="settings-work-end" className="field-row">
              {t('settings.end')}
              <input id="settings-work-end" type="time" value={workEnd} onChange={(event) => setWorkEnd(event.target.value)} />
            </label>
          </div>
          <div className="settings-actions" style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={saveWorkHours}>
              <Save size={16} />
              {t('settings.save')}
            </button>
          </div>
        </Panel>

        <Panel title={t('settings.reminder_preferences')} icon={<Bell size={17} />}>
          <div className="field-grid">
            <label htmlFor="settings-remind-before" className="field-row">
              {t('settings.remind_before')}
              <select id="settings-remind-before" value={reminderPreference} onChange={(event) => setReminderPreference(event.target.value)}>
                <option value="5">{t('settings.reminder_5min')}</option>
                <option value="10">{t('settings.reminder_10min')}</option>
                <option value="15">{t('settings.reminder_15min')}</option>
                <option value="30">{t('settings.reminder_30min')}</option>
                <option value="60">{t('settings.reminder_1hour')}</option>
              </select>
            </label>
            <label htmlFor="settings-schedule-style" className="field-row">
              {t('settings.schedule_style')}
              <select id="settings-schedule-style" value={scheduleStyle} onChange={(event) => setScheduleStyle(event.target.value as 'relaxed' | 'balanced' | 'tight')}>
                <option value="relaxed">{t('settings.style_relaxed')}</option>
                <option value="balanced">{t('settings.style_balanced')}</option>
                <option value="tight">{t('settings.style_tight')}</option>
              </select>
            </label>
          </div>
          <div className="settings-actions" style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={saveReminderPreference}>
              <Save size={16} />
              {t('settings.save_preferences')}
            </button>
          </div>
        </Panel>

        <Panel title={t('settings.buddy_settings')} icon={<UserRound size={17} />}>
          <SegmentedTabs<'full' | 'minimal' | 'off'>
            value={buddyLevel}
            onChange={(value) => { void saveBuddyLevel(value); }}
            ariaLabel={t('settings.buddy_settings')}
            items={[
              { value: 'full', label: t('settings.buddy_full') },
              { value: 'minimal', label: t('settings.buddy_minimal') },
              { value: 'off', label: t('settings.buddy_off') },
            ]}
          />
          <p className="field-help" style={{ marginTop: 12 }}>{t('settings.buddy_desc')}</p>
        </Panel>

        <Panel title={t('settings.ai_config')} icon={<Bot size={17} />} className="wide" >
          <div className="field-grid">
            <label className="field-row">
              {t('settings.ai_config')} - {t('common.name')}
              <SegmentedTabs<'deepseek' | 'anthropic'>
                value={provider}
                onChange={(value) => { void handleProviderChange(value); }}
                ariaLabel={t('settings.ai_config')}
                items={[
                  { value: 'deepseek', label: 'DeepSeek' },
                  { value: 'anthropic', label: 'Anthropic (Claude)' },
                ]}
              />
            </label>
            <div className="field-row">
              <span>{t(provider === 'anthropic' ? 'settings.apiKeyLabelAnthropic' : 'settings.apiKeyLabelDeepseek')}</span>
              <span className="field-help">
                {t(provider === 'anthropic' ? 'settings.apiKeyDescAnthropic' : 'settings.apiKeyDescDeepseek')}
              </span>
              <a className="field-help" href={provider === 'anthropic' ? 'https://console.anthropic.com/settings/keys' : 'https://platform.deepseek.com/api_keys'} target="_blank" rel="noreferrer">
                {provider === 'anthropic' ? 'https://console.anthropic.com/settings/keys' : 'https://platform.deepseek.com/api_keys'}
              </a>
            </div>
          </div>

          {apiKeyConfigured && !showApiKeyInput ? (
            <div className="settings-actions" style={{ marginTop: 14 }}>
              <span className="status-badge good">
                {t('settings.apiKeyConfiguredLabel', { provider: provider === 'anthropic' ? 'Anthropic' : 'DeepSeek', prefix: apiKeyPrefix })}
              </span>
              <button className="btn btn-secondary" onClick={handleChangeApiKey}>{t('settings.api_key_change')}</button>
              <button className="btn btn-secondary" onClick={handleClearApiKey} style={{ color: 'var(--danger-text)' }}>{t('settings.api_key_clear')}</button>
            </div>
          ) : (
            <div className="quick-command" style={{ marginTop: 14, marginBottom: 0 }}>
              <input
                id="settings-api-key"
                type="password"
                placeholder={provider === 'anthropic' ? 'sk-ant-api03-...' : 'sk-...'}
                value={apiKeyInput}
                onChange={(event) => { setApiKeyInput(event.target.value); }}
              />
              <button className="btn btn-primary" onClick={saveApiKey}>
                <Save size={16} />
                {apiKeyConfigured ? t('settings.api_key_update') : t('settings.api_key_save')}
              </button>
              {showApiKeyInput && (
                <button className="btn btn-secondary" onClick={() => setShowApiKeyInput(false)}>
                  {t('common.cancel')}
                </button>
              )}
            </div>
          )}
        </Panel>

        <div className="settings-wide">
          <BackupPanel />
        </div>

        <Panel title={t('settings.keyboard_shortcuts')} icon={<Keyboard size={17} />} className="wide">
          <p className="field-help" style={{ marginBottom: 12 }}>{t('settings.shortcut_desc')}</p>
          <ShortcutDisplay groups={DEFAULT_SHORTCUT_GROUPS} variant="panel" />
          <p className="field-help" style={{ marginTop: 12 }}>{t('settings.shortcut_note')}</p>
        </Panel>
      </div>
    </PageShell>
  );
}
