import React from 'react';

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

export function PageShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cx('page-shell', className)}>{children}</div>;
}

export function PageHeader({
  title,
  subtitle,
  icon,
  actions,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-header">
      <div className="page-heading">
        {icon && <span className="page-header-icon">{icon}</span>}
        <div className="page-header-main">
          <h1>{title}</h1>
          {subtitle && <span className="page-subtitle">{subtitle}</span>}
        </div>
      </div>
      {actions && <div className="toolbar">{actions}</div>}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  hint,
  tone,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: 'good' | 'warn' | 'danger';
}) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div
        className={cx(
          'metric-value',
          tone === 'good' && 'metric-good',
          tone === 'warn' && 'metric-warn',
          tone === 'danger' && 'metric-danger',
        )}
      >
        {value}
      </div>
      {hint && <div className="metric-hint">{hint}</div>}
    </div>
  );
}

export function Panel({
  title,
  meta,
  icon,
  actions,
  children,
  className,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('panel', className)}>
      <div className="panel-header">
        <h2 className="panel-title">
          {icon}
          {title}
        </h2>
        <div className="panel-actions">
          {meta && <span className="panel-meta">{meta}</span>}
          {actions}
        </div>
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function EmptyPanel({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-panel">
      <span>{children}</span>
      {action && <div className="empty-panel-action">{action}</div>}
    </div>
  );
}

export interface TabItem<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
}

export function SegmentedTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="modern-tabs" role="tablist" aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.value}
          className={`btn ${value === item.value ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => onChange(item.value)}
          role="tab"
          aria-selected={value === item.value}
          aria-pressed={value === item.value}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}
