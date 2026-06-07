import { useEffect } from 'react';

export interface KeyboardShortcut {
  id: string;
  label: string;
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  global?: boolean;
  handler: () => void;
}

export interface KeyboardShortcutGroup {
  title: string;
  shortcuts: Array<Omit<KeyboardShortcut, 'handler'>>;
}

export const DEFAULT_SHORTCUT_GROUPS: KeyboardShortcutGroup[] = [
  {
    title: 'Navigation',
    shortcuts: [
      { id: 'tab_today', label: 'Today', key: '1' },
      { id: 'tab_calendar', label: 'Calendar', key: '2' },
      { id: 'tab_tasks', label: 'Tasks', key: '3' },
      { id: 'tab_ai', label: 'AI', key: '4' },
      { id: 'tab_settings', label: 'Settings', key: '5' },
    ],
  },
  {
    title: 'Actions',
    shortcuts: [
      { id: 'new_task', label: 'New task', key: 'n', ctrl: true },
      { id: 'toggle_ai_floating', label: 'Toggle AI', key: 'f', ctrl: true, shift: true },
      { id: 'undo', label: 'Undo', key: 'z', ctrl: true },
      { id: 'save_form', label: 'Save form', key: 's', ctrl: true },
      { id: 'close_modal', label: 'Close modal', key: 'Escape' },
    ],
  },
];

function formatShortcut(shortcut: Omit<KeyboardShortcut, 'handler'>): string {
  const parts: string[] = [];
  if (shortcut.ctrl) {parts.push('Ctrl');}
  if (shortcut.shift) {parts.push('Shift');}
  if (shortcut.alt) {parts.push('Alt');}
  parts.push(shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key);
  return parts.join('+');
}

export function ShortcutDisplay({
  groups,
}: {
  groups: KeyboardShortcutGroup[];
  variant?: 'inline' | 'panel';
}): JSX.Element {
  return (
    <div className="shortcut-display" aria-label="Keyboard shortcuts">
      {groups.map((group) => (
        <div className="shortcut-group" key={group.title}>
          <div className="shortcut-group-title">{group.title}</div>
          <div className="shortcut-grid">
            {group.shortcuts.map((shortcut) => (
              <div className="shortcut-row" key={shortcut.id}>
                <span>{shortcut.label}</span>
                <kbd>{formatShortcut(shortcut)}</kbd>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function useKeyboardShortcuts(
  shortcuts: KeyboardShortcut[],
  options: { enabled?: boolean } = {},
): void {
  useEffect(() => {
    if (options.enabled === false) {return;}
    function handleKeyDown(e: KeyboardEvent): void {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
      const isModalShortcut = e.key === 'Escape' || (e.ctrlKey && e.key === 'z');
      if (isInput && !isModalShortcut) {return;}
      for (const s of shortcuts) {
        const keyMatch = e.key.toLowerCase() === s.key.toLowerCase();
        const ctrlMatch = !!s.ctrl === (e.ctrlKey || e.metaKey);
        const shiftMatch = !!s.shift === e.shiftKey;
        const altMatch = !!s.alt === e.altKey;
        if (keyMatch && ctrlMatch && shiftMatch && altMatch) {
          if (!s.global) {e.preventDefault();}
          s.handler();
          return;
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts, options.enabled]);
}
