import React, { useState, useEffect, useRef, useCallback, type FormEvent } from 'react';
import { callCapability } from '../lib/tauri';
import { useToast } from './Toast';
import type { Task } from '../store/useAppStore';

// ── Types ──────────────────────────────────────────────────────

interface FormData {
  title: string;
  description: string;
  duration_minutes: string;
  due_date: string;
  time_effect_type: string;
  project: string;
  tags: string[];
  parent_task_id: string;
}

interface FormErrors {
  title?: string;
  duration_minutes?: string;
  due_date?: string;
  description?: string;
}

interface TaskEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  task?: Task | null; // null = create mode, Task = edit mode
  existingProjects?: string[];
  existingTasks?: Task[];
}

// ── Constants ──────────────────────────────────────────────────

const TIME_EFFECT_TYPES = [
  { value: 'continuous', label: '持续任务（灵活安排）' },
  { value: 'deadline', label: '截止任务（固定截止时间）' },
  { value: 'event_bound', label: '事件绑定（与事件关联）' },
];

// ── Component ──────────────────────────────────────────────────

export default function TaskEditModal({
  isOpen,
  onClose,
  onSaved,
  task,
  existingProjects = [],
  existingTasks = [],
}: TaskEditModalProps) {
  const toast = useToast();
  const isEditing = task !== null && task !== undefined;

  const [formData, setFormData] = useState<FormData>({
    title: '',
    description: '',
    duration_minutes: '',
    due_date: '',
    time_effect_type: 'continuous',
    project: '',
    tags: [],
    parent_task_id: '',
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSaving, setIsSaving] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [showProjectSuggestions, setShowProjectSuggestions] = useState(false);

  const modalRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const formDataRef = useRef<FormData>(formData);

  // Keep the ref in sync with the latest formData
  useEffect(() => {
    formDataRef.current = formData;
  }, [formData]);

  // Initialize form data when task changes
  useEffect(() => {
    if (isOpen) {
      if (task) {
        setFormData({
          title: task.title || '',
          description: task.description || '',
          duration_minutes: task.duration_minutes !== null && task.duration_minutes !== undefined ? String(task.duration_minutes) : '',
          due_date: task.due_date ? task.due_date.slice(0, 10) : '',
          time_effect_type: task.time_effect_type || 'continuous',
          project: task.project || '',
          tags: task.tags || [],
          parent_task_id: task.parent_task_id || '',
        });
      } else {
        setFormData({
          title: '',
          description: '',
          duration_minutes: '',
          due_date: '',
          time_effect_type: 'continuous',
          project: '',
          tags: [],
          parent_task_id: '',
        });
      }
      setErrors({});
      setTagInput('');
      setProjectFilter('');
    }
  }, [isOpen, task]);

  // Focus trap and keyboard handling
  useEffect(() => {
    if (!isOpen) {return;}

    previousFocusRef.current = document.activeElement as HTMLElement;
    // Focus title input after a brief delay for the animation
    setTimeout(() => titleInputRef.current?.focus(), 50);

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      // Enter to submit (not in textarea)
      if (e.key === 'Enter' && !e.shiftKey) {
        const target = e.target as HTMLElement;
        if (target.tagName !== 'TEXTAREA') {
          e.preventDefault();
          handleSubmit(e as unknown as FormEvent);
        }
      }

      // Focus trap
      if (e.key === 'Tab' && modalRef.current) {
        const focusableElements = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusableElements.length === 0) {return;}

        const first = focusableElements[0];
        const last = focusableElements[focusableElements.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [isOpen, onClose]);

  // ── Validation ──────────────────────────────────────────────

  function validate(): FormErrors {
    const fd = formDataRef.current;
    const newErrors: FormErrors = {};

    if (!fd.title.trim()) {
      newErrors.title = '任务标题不能为空';
    } else if (fd.title.trim().length > 200) {
      newErrors.title = '标题不能超过200个字符';
    }

    if (fd.duration_minutes) {
      const dur = Number(fd.duration_minutes);
      if (isNaN(dur) || dur <= 0) {
        newErrors.duration_minutes = '请输入有效的分钟数（大于0）';
      } else if (dur > 1440) {
        newErrors.duration_minutes = '任务时长不能超过24小时（1440分钟）';
      }
    }

    if (fd.due_date) {
      const dateObj = new Date(fd.due_date);
      if (isNaN(dateObj.getTime())) {
        newErrors.due_date = '请输入有效的日期';
      }
    }

    if (fd.description.length > 2000) {
      newErrors.description = '描述不能超过2000个字符';
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

    setIsSaving(true);

    try {
      const payload: Record<string, unknown> = {
        title: fd.title.trim(),
        description: fd.description.trim(),
      };

      if (fd.duration_minutes) {
        payload.duration_minutes = Number(fd.duration_minutes);
      }
      if (fd.due_date) {
        payload.due_date = fd.due_date;
      }
      if (fd.time_effect_type) {
        payload.time_effect_type = fd.time_effect_type;
      }
      if (fd.project.trim()) {
        payload.project = fd.project.trim();
      }
      if (fd.tags.length > 0) {
        payload.tags = fd.tags;
      }
      if (fd.parent_task_id) {
        payload.parent_task_id = fd.parent_task_id;
      }

      if (isEditing && task) {
        payload.task_id = task.id;
        const result = await callCapability('task.update', payload) as { success: boolean; data?: Task };
        if (result.success) {
          toast.success('任务已更新');
          onSaved();
          onClose();
        } else {
          toast.error('更新任务失败');
        }
      } else {
        const result = await callCapability('task.create', payload) as { success: boolean; data?: Task };
        if (result.success) {
          toast.success('任务已创建');
          onSaved();
          onClose();
        } else {
          toast.error('创建任务失败');
        }
      }
    } catch (err) {
      toast.error(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsSaving(false);
    }
  }

  // ── Tag Management ──────────────────────────────────────────

  function handleAddTag() {
    const tag = tagInput.trim().toLowerCase();
    if (tag && !formData.tags.includes(tag)) {
      setFormData((prev) => ({ ...prev, tags: [...prev.tags, tag] }));
    }
    setTagInput('');
  }

  function handleRemoveTag(tag: string) {
    setFormData((prev) => ({
      ...prev,
      tags: prev.tags.filter((t) => t !== tag),
    }));
  }

  function handleTagKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag();
    }
    if (e.key === 'Backspace' && !tagInput && formData.tags.length > 0) {
      setFormData((prev) => ({ ...prev, tags: prev.tags.slice(0, -1) }));
    }
  }

  // ── Project Autocomplete ────────────────────────────────────

  const filteredProjects = existingProjects.filter((p) =>
    p.toLowerCase().includes(projectFilter.toLowerCase())
  );

  function handleSelectProject(project: string) {
    setFormData((prev) => ({ ...prev, project }));
    setProjectFilter('');
    setShowProjectSuggestions(false);
  }

  // ── Exclude current task and its subtrees from parent selection ──

  const availableParentTasks = existingTasks.filter((t) => {
    if (isEditing && task) {
      if (t.id === task.id) {return false;}
      // Exclude subtasks of this task
      if (t.parent_task_id === task.id) {return false;}
    }
    return !t.parent_task_id; // Only top-level tasks as potential parents
  });

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
            {isEditing ? '编辑任务' : '新建任务'}
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
            aria-label="关闭"
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
                任务标题 <span style={{ color: '#f44336' }}>*</span>
              </label>
              <input
                ref={titleInputRef}
                type="text"
                value={formData.title}
                onChange={(e) => setFormData((prev) => ({ ...prev, title: e.target.value }))}
                placeholder="输入任务标题..."
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
                描述
              </label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="任务描述（可选）..."
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

            {/* Duration + Due Date Row */}
            <div style={{ display: 'flex', gap: 12 }}>
              {/* Duration */}
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4, color: '#444' }}>
                  预计时长（分钟）
                </label>
                <input
                  type="number"
                  min="1"
                  max="1440"
                  value={formData.duration_minutes}
                  onChange={(e) => setFormData((prev) => ({ ...prev, duration_minutes: e.target.value }))}
                  placeholder="例如: 30"
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    border: `1px solid ${errors.duration_minutes ? '#f44336' : '#dee2e6'}`,
                    borderRadius: 6,
                    fontSize: 14,
                  }}
                />
                {errors.duration_minutes && (
                  <span style={{ fontSize: 12, color: '#f44336', marginTop: 2, display: 'block' }}>
                    {errors.duration_minutes}
                  </span>
                )}
              </div>

              {/* Due Date */}
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4, color: '#444' }}>
                  截止日期
                </label>
                <input
                  type="date"
                  value={formData.due_date}
                  onChange={(e) => setFormData((prev) => ({ ...prev, due_date: e.target.value }))}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    border: `1px solid ${errors.due_date ? '#f44336' : '#dee2e6'}`,
                    borderRadius: 6,
                    fontSize: 14,
                  }}
                />
                {errors.due_date && (
                  <span style={{ fontSize: 12, color: '#f44336', marginTop: 2, display: 'block' }}>
                    {errors.due_date}
                  </span>
                )}
              </div>
            </div>

            {/* Time Effect Type */}
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4, color: '#444' }}>
                时间效应类型
              </label>
              <select
                value={formData.time_effect_type}
                onChange={(e) => setFormData((prev) => ({ ...prev, time_effect_type: e.target.value }))}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  border: '1px solid #dee2e6',
                  borderRadius: 6,
                  fontSize: 14,
                }}
              >
                {TIME_EFFECT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Project with Autocomplete */}
            <div style={{ position: 'relative' }}>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4, color: '#444' }}>
                项目
              </label>
              <input
                type="text"
                value={projectFilter || formData.project}
                onChange={(e) => {
                  setProjectFilter(e.target.value);
                  setFormData((prev) => ({ ...prev, project: e.target.value }));
                  setShowProjectSuggestions(true);
                }}
                onFocus={() => setShowProjectSuggestions(true)}
                onBlur={() => {
                  // Delay hiding so click on suggestion registers
                  setTimeout(() => setShowProjectSuggestions(false), 200);
                }}
                placeholder="项目名称（可选）..."
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  border: '1px solid #dee2e6',
                  borderRadius: 6,
                  fontSize: 14,
                }}
              />
              {showProjectSuggestions && filteredProjects.length > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    right: 0,
                    background: '#fff',
                    border: '1px solid #dee2e6',
                    borderRadius: 6,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                    zIndex: 10,
                    maxHeight: 150,
                    overflowY: 'auto',
                  }}
                >
                  {filteredProjects.map((p) => (
                    <div
                      key={p}
                      onMouseDown={() => handleSelectProject(p)}
                      style={{
                        padding: '8px 12px',
                        cursor: 'pointer',
                        fontSize: 13,
                        borderBottom: '1px solid #f0f0f0',
                      }}
                      onMouseOver={(e) => {
                        (e.currentTarget as HTMLElement).style.background = '#f0f4ff';
                      }}
                      onMouseOut={(e) => {
                        (e.currentTarget as HTMLElement).style.background = '';
                      }}
                    >
                      {p}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Tags */}
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4, color: '#444' }}>
                标签
              </label>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 4,
                  padding: '8px 12px',
                  border: '1px solid #dee2e6',
                  borderRadius: 6,
                  minHeight: 42,
                  cursor: 'text',
                  alignItems: 'center',
                }}
                onClick={() => {
                  // Focus the hidden input
                  const input = document.getElementById('tag-input') as HTMLInputElement;
                  input?.focus();
                }}
              >
                {formData.tags.map((tag) => (
                  <span
                    key={tag}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '2px 8px',
                      background: '#e8f0fe',
                      borderRadius: 12,
                      fontSize: 12,
                      color: '#4a6fa5',
                    }}
                  >
                    #{tag}
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(tag)}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: 14,
                        color: '#4a6fa5',
                        padding: 0,
                        lineHeight: 1,
                      }}
                      aria-label={`移除标签 ${tag}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  id="tag-input"
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={handleTagKeyDown}
                  placeholder={formData.tags.length === 0 ? '输入标签后按 Enter 添加...' : ''}
                  style={{
                    border: 'none',
                    outline: 'none',
                    fontSize: 13,
                    flex: 1,
                    minWidth: 80,
                    padding: '2px 0',
                  }}
                />
              </div>
            </div>

            {/* Parent Task */}
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4, color: '#444' }}>
                父任务（子任务归属）
              </label>
              <select
                value={formData.parent_task_id}
                onChange={(e) => setFormData((prev) => ({ ...prev, parent_task_id: e.target.value }))}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  border: '1px solid #dee2e6',
                  borderRadius: 6,
                  fontSize: 14,
                }}
              >
                <option value="">无（顶级任务）</option>
                {availableParentTasks.map((t) => (
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
            {isEditing && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={async () => {
                  if (!window.confirm('确定要删除此任务吗？')) {return;}
                  if (!task) {return;}
                  try {
                    setIsSaving(true);
                    await callCapability('task.delete', { task_id: task.id });
                    toast.success('任务已删除');
                    onSaved();
                    onClose();
                  } catch (err) {
                    toast.error(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
                  } finally {
                    setIsSaving(false);
                  }
                }}
                disabled={isSaving}
                style={{ color: '#c62828', marginRight: 'auto' }}
              >
                删除任务
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isSaving}
            >
              取消
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
              {isSaving ? '保存中...' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
