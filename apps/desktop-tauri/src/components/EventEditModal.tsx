import React, { useState, useEffect, useRef, type FormEvent } from 'react';
import { callCapability } from '../lib/tauri';
import { useToast } from './Toast';
import { useI18n } from '../lib/i18n';
import type { CalendarEvent, Task } from '../store/useAppStore';

// ── Types ──────────────────────────────────────────────────────

interface FormData {
  title: string;
  description: string;
  start_time: string;
  end_time: string;
  bound_task_id: string;
}

interface FormErrors {
  title?: string;
  start_time?: string;
  end_time?: string;
  description?: string;
  time_order?: string;
}

interface ConflictInfo {
  id: string;
  title: string;
  start_time: string;
  end_time: string;
}

interface EventEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  event?: CalendarEvent | null;
  existingTasks?: Task[];
}

// ── Helpers ────────────────────────────────────────────────────

function formatDatetimeForInput(isoString: string): string {
  if (!isoString) {return '';}
  // "2024-01-15T14:30:00" -> "2024-01-15T14:30"
  return isoString.slice(0, 16);
}

function getNowLocalDatetime(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

function getOneHourLater(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60000 + 3600000);
  return local.toISOString().slice(0, 16);
}

function datetimeToISO(dt: string): string {
  if (!dt) {return '';}
  return `${dt}:00`;
}

function parseDatetime(isoStr: string): Date | null {
  if (!isoStr) {return null;}
  const d = new Date(isoStr);
  return isNaN(d.getTime()) ? null : d;
}

// ── Component ──────────────────────────────────────────────────

export default function EventEditModal({
  isOpen,
  onClose,
  onSaved,
  event,
  existingTasks = [],
}: EventEditModalProps) {
  const { t } = useI18n();
  const toast = useToast();
  const isEditing = event !== null && event !== undefined;

  const [formData, setFormData] = useState<FormData>({
    title: '',
    description: '',
    start_time: '',
    end_time: '',
    bound_task_id: '',
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSaving, setIsSaving] = useState(false);
  const [conflicts, setConflicts] = useState<ConflictInfo[]>([]);
  const [showConflictConfirm, setShowConflictConfirm] = useState(false);
  const [allEvents, setAllEvents] = useState<CalendarEvent[]>([]);

  const modalRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const formDataRef = useRef<FormData>(formData);
  const pendingPayloadRef = useRef<Record<string, unknown> | null>(null);

  // Keep the ref in sync with the latest formData
  useEffect(() => {
    formDataRef.current = formData;
  }, [formData]);

  // Load existing events for conflict detection
  useEffect(() => {
    if (!isOpen) {return;}
    loadAllEvents();
  }, [isOpen]);

  async function loadAllEvents() {
    try {
      const result = await callCapability('event.list', {}) as {
        success: boolean;
        data?: CalendarEvent[];
      };
      if (result.success && result.data) {
        setAllEvents(result.data);
      }
    } catch {
      // silent
    }
  }

  // Initialize form data
  useEffect(() => {
    if (isOpen) {
      if (event) {
        setFormData({
          title: event.title || '',
          description: event.description || '',
          start_time: formatDatetimeForInput(event.start_time),
          end_time: formatDatetimeForInput(event.end_time),
          bound_task_id: event.bound_task_id || '',
        });
      } else {
        setFormData({
          title: '',
          description: '',
          start_time: getNowLocalDatetime(),
          end_time: getOneHourLater(),
          bound_task_id: '',
        });
      }
      setErrors({});
      setConflicts([]);
    }
  }, [isOpen, event]);

  // Focus trap and keyboard handling
  useEffect(() => {
    if (!isOpen) {return;}
    setTimeout(() => titleInputRef.current?.focus(), 50);

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const target = e.target as HTMLElement;
        if (target.tagName !== 'TEXTAREA') {
          e.preventDefault();
          handleSubmit(e as unknown as FormEvent);
        }
      }
      // Focus trap
      if (e.key === 'Tab' && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) {return;}
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // ── Conflict Detection ──────────────────────────────────────

  function detectConflicts(
    startIso: string,
    endIso: string,
    excludeId?: string,
  ): ConflictInfo[] {
    if (!startIso || !endIso) {return [];}
    const start = parseDatetime(startIso);
    const end = parseDatetime(endIso);
    if (!start || !end) {return [];}

    return allEvents
      .filter((e) => {
        if (excludeId && e.id === excludeId) {return false;}
        const eStart = parseDatetime(e.start_time);
        const eEnd = parseDatetime(e.end_time);
        if (!eStart || !eEnd) {return false;}
        // Check overlap: (StartA < EndB) and (EndA > StartB)
        return start < eEnd && end > eStart;
      })
      .map((e) => ({
        id: e.id,
        title: e.title,
        start_time: e.start_time,
        end_time: e.end_time,
      }));
  }

  // ── Validation ──────────────────────────────────────────────

  function validate(): FormErrors {
    const fd = formDataRef.current;
    const newErrors: FormErrors = {};

    if (!fd.title.trim()) {
      newErrors.title = t('event_edit.validation.title_required');
    } else if (fd.title.trim().length > 200) {
      newErrors.title = t('event_edit.validation.title_too_long');
    }

    if (!fd.start_time) {
      newErrors.start_time = t('event_edit.validation.start_time_required');
    }

    if (!fd.end_time) {
      newErrors.end_time = t('event_edit.validation.end_time_required');
    }

    if (fd.start_time && fd.end_time) {
      const start = parseDatetime(fd.start_time);
      const end = parseDatetime(fd.end_time);
      if (start && end) {
        if (start >= end) {
          newErrors.time_order = t('event_edit.validation.end_after_start');
        }
      }
    }

    if (fd.description.length > 2000) {
      newErrors.description = t('event_edit.validation.description_too_long');
    }

    return newErrors;
  }

  // ── Submit ───────────────────────────────────────────────────

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    const fd = formDataRef.current;

    const validationErrors = validate();
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) {return;}

    // Check for conflicts before saving
    const startIso = datetimeToISO(fd.start_time);
    const endIso = datetimeToISO(fd.end_time);
    const detectedConflicts = detectConflicts(
      startIso,
      endIso,
      isEditing && event ? event.id : undefined,
    );
    setConflicts(detectedConflicts);

    // Build the payload
    const payload: Record<string, unknown> = {
      title: fd.title.trim(),
      description: fd.description.trim(),
      start_time: startIso,
      end_time: endIso,
    };

    if (fd.bound_task_id) {
      payload.bound_task_id = fd.bound_task_id;
    }

    if (isEditing && event) {
      payload.event_id = event.id;
    }

    if (detectedConflicts.length > 0) {
      pendingPayloadRef.current = payload;
      setShowConflictConfirm(true);
      setIsSaving(false);
      return;
    }

    await executeSave(payload);
  }

  async function executeSave(payload: Record<string, unknown>) {
    setIsSaving(true);
    try {
      const capability = isEditing && event ? 'event.update' : 'event.create';
      const result = await callCapability(capability, payload) as {
        success: boolean;
        data?: CalendarEvent;
      };
      if (result.success) {
        toast.success(isEditing && event ? t('event_edit.updated') : t('event_edit.created'));
        onSaved();
        onClose();
      } else {
        toast.error(isEditing && event ? t('event_edit.update_failed') : t('event_edit.create_failed'));
      }
    } catch (err) {
      toast.error(t('event_edit.operation_failed', { reason: err instanceof Error ? err.message : String(err) }));
    } finally {
      setIsSaving(false);
    }
  }

  function handleConflictConfirm() {
    setShowConflictConfirm(false);
    if (pendingPayloadRef.current) {
      executeSave(pendingPayloadRef.current);
      pendingPayloadRef.current = null;
    }
  }

  function handleConflictCancel() {
    setShowConflictConfirm(false);
    pendingPayloadRef.current = null;
  }

  // ── Time Change Handler ─────────────────────────────────────

  function handleTimeChange(field: 'start_time' | 'end_time', value: string) {
    setFormData((prev) => ({ ...prev, [field]: value }));

    // Recalculate conflicts when times change
    const newFormData = { ...formData, [field]: value };
    const startIso = datetimeToISO(field === 'start_time' ? value : newFormData.start_time);
    const endIso = datetimeToISO(field === 'end_time' ? value : newFormData.end_time);

    if (startIso && endIso) {
      const detected = detectConflicts(
        startIso,
        endIso,
        isEditing && event ? event.id : undefined,
      );
      setConflicts(detected);
    }
  }

  // ── Render ───────────────────────────────────────────────────

  if (!isOpen) {return null;}

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {onClose();}
      }}
    >
      <div
        ref={modalRef}
        style={{
          background: '#fff',
          borderRadius: 12,
          padding: 24,
          width: '100%',
          maxWidth: 560,
          maxHeight: '85vh',
          overflowY: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 20,
          }}
        >
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: '#2c3e50' }}>
            {isEditing ? t('event_edit.title_edit') : t('event_edit.title_new')}
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: 24,
              cursor: 'pointer',
              color: '#888',
              padding: '0 4px',
              lineHeight: 1,
            }}
            aria-label={t('event_edit.close_aria')}
          >
            ×
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Title */}
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4, color: '#444' }}>
                {t('event_edit.title_label')} <span style={{ color: '#f44336' }}>*</span>
              </label>
              <input
                ref={titleInputRef}
                type="text"
                value={formData.title}
                onChange={(e) => setFormData((prev) => ({ ...prev, title: e.target.value }))}
                placeholder={t('event_edit.title_placeholder')}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  border: `1px solid ${errors.title ? '#f44336' : '#dee2e6'}`,
                  borderRadius: 6,
                  fontSize: 14,
                }}
              />
              {errors.title && (
                <span style={{ fontSize: 12, color: '#f44336', marginTop: 2, display: 'block' }}>
                  {errors.title}
                </span>
              )}
            </div>

            {/* Description */}
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4, color: '#444' }}>
                {t('event_edit.description_label')}
              </label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                placeholder={t('event_edit.description_placeholder')}
                rows={3}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  border: `1px solid ${errors.description ? '#f44336' : '#dee2e6'}`,
                  borderRadius: 6,
                  fontSize: 14,
                  resize: 'vertical',
                  fontFamily: 'inherit',
                }}
              />
              {errors.description && (
                <span style={{ fontSize: 12, color: '#f44336', marginTop: 2, display: 'block' }}>
                  {errors.description}
                </span>
              )}
            </div>

            {/* Start/End Time Row */}
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4, color: '#444' }}>
                  {t('event_edit.start_time_label')} <span style={{ color: '#f44336' }}>*</span>
                </label>
                <input
                  type="datetime-local"
                  value={formData.start_time}
                  onChange={(e) => handleTimeChange('start_time', e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    border: `1px solid ${errors.start_time ? '#f44336' : '#dee2e6'}`,
                    borderRadius: 6,
                    fontSize: 14,
                  }}
                />
                {errors.start_time && (
                  <span style={{ fontSize: 12, color: '#f44336', marginTop: 2, display: 'block' }}>
                    {errors.start_time}
                  </span>
                )}
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4, color: '#444' }}>
                  {t('event_edit.end_time_label')} <span style={{ color: '#f44336' }}>*</span>
                </label>
                <input
                  type="datetime-local"
                  value={formData.end_time}
                  onChange={(e) => handleTimeChange('end_time', e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    border: `1px solid ${errors.end_time ? '#f44336' : '#dee2e6'}`,
                    borderRadius: 6,
                    fontSize: 14,
                  }}
                />
                {errors.end_time && (
                  <span style={{ fontSize: 12, color: '#f44336', marginTop: 2, display: 'block' }}>
                    {errors.end_time}
                  </span>
                )}
              </div>
            </div>

            {/* Time order error */}
            {errors.time_order && (
              <div
                style={{
                  padding: '8px 12px',
                  background: '#ffebee',
                  borderRadius: 6,
                  fontSize: 13,
                  color: '#c62828',
                }}
              >
                {errors.time_order}
              </div>
            )}

            {/* Conflict Display */}
            {conflicts.length > 0 && (
              <div
                style={{
                  padding: '12px',
                  background: '#fff8e1',
                  border: '1px solid #ffe082',
                  borderRadius: 6,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: '#e65100', marginBottom: 8 }}>
                  {t('event_edit.conflicts_detected', { count: conflicts.length })}
                </div>
                {conflicts.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '4px 0',
                      fontSize: 12,
                      color: '#555',
                    }}
                  >
                    <span style={{ fontWeight: 600, color: '#e65100' }}>●</span>
                    <span style={{ flex: 1 }}>{c.title}</span>
                    <span style={{ color: '#888', fontSize: 11 }}>
                      {c.start_time.slice(11, 16)}-{c.end_time.slice(11, 16)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Bound Task */}
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4, color: '#444' }}>
                {t('event_edit.bound_task_label')}
              </label>
              <select
                value={formData.bound_task_id}
                onChange={(e) => setFormData((prev) => ({ ...prev, bound_task_id: e.target.value }))}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  border: '1px solid #dee2e6',
                  borderRadius: 6,
                  fontSize: 14,
                }}
              >
                <option value="">{t('event_edit.no_bound_task')}</option>
                {existingTasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Action Buttons */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 8,
              marginTop: 24,
              paddingTop: 16,
              borderTop: '1px solid #eee',
            }}
          >
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isSaving}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSaving}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                opacity: isSaving ? 0.7 : 1,
              }}
            >
              {isSaving && <span className="loading-spinner" style={{ width: 16, height: 16, margin: 0 }} />}
              {isSaving ? t('calendar.saving') : t('common.save')}
            </button>
          </div>

          {/* Inline Conflict Confirmation */}
          {showConflictConfirm && (
            <div
              style={{
                marginTop: 16,
                padding: 16,
                background: '#fff8e1',
                border: '1px solid #ffe082',
                borderRadius: 8,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 600, color: '#e65100', marginBottom: 8 }}>
                {t('event_edit.conflict_confirm_title', { count: conflicts.length })}
              </div>
              <div style={{ fontSize: 12, color: '#555', marginBottom: 12 }}>
                {conflicts.map((c) => (
                  <div key={c.id} style={{ padding: '2px 0' }}>
                    - {c.title} ({c.start_time.slice(11, 16)}-{c.end_time.slice(11, 16)})
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>
                {t('event_edit.conflict_save_anyway')}
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleConflictCancel}
                >
                  {t('event_edit.cancel_save')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleConflictConfirm}
                  style={{ background: '#e65100' }}
                >
                  {t('event_edit.save_anyway')}
                </button>
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
