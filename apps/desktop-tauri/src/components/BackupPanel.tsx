import React, { useState, useEffect, useCallback } from 'react';
import { callCapability } from '../lib/tauri';
import { useToast } from './Toast';
import { useI18n } from '../lib/i18n';

// ── Types ──────────────────────────────────────────────────────

interface BackupEntry {
  path: string;
  name: string;
  date: string;
  sizeBytes: number;
  verified: boolean | null; // null = not yet verified, true = valid, false = invalid
  verifying: boolean;
}

interface BackupListResult {
  success: boolean;
  data?: {
    backups: Array<{
      path: string;
      name: string;
      date: string;
      size_bytes: number;
    }>;
    total_count: number;
    total_size_bytes: number;
  };
}

interface BackupCreateResult {
  success: boolean;
  data?: {
    path: string;
    name: string;
  };
}

interface BackupVerifyResult {
  success: boolean;
  data?: {
    valid: boolean;
    error?: string;
  };
}

interface BackupRestoreResult {
  success: boolean;
  error?: string;
}

interface BackupDeleteResult {
  success: boolean;
}

// ── Helpers ────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes === 0) {return '0 B';}
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0);
  return `${size} ${units[i]}`;
}

function formatDate(isoStr: string, locale: string): string {
  try {
    const d = new Date(isoStr);
    return d.toLocaleString(locale === 'en-US' ? 'en-US' : 'zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoStr;
  }
}

// ── Component ──────────────────────────────────────────────────

export default function BackupPanel() {
  const { t, locale } = useI18n();
  const toast = useToast();

  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalSize, setTotalSize] = useState(0);
  const [isCreating, setIsCreating] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);

  // ── Load Backups ────────────────────────────────────────────

  const loadBackups = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await callCapability('backup.list', {}) as BackupListResult;
      if (result.success && result.data) {
        const entries: BackupEntry[] = (result.data.backups || []).map((b) => ({
          path: b.path,
          name: b.name,
          date: b.date,
          sizeBytes: b.size_bytes || 0,
          verified: null,
          verifying: false,
        }));
        setBackups(entries);
        setTotalCount(result.data.total_count || 0);
        setTotalSize(result.data.total_size_bytes || 0);
      } else {
        // If backup.list capability doesn't exist yet, show empty state
        setBackups([]);
        setTotalCount(0);
        setTotalSize(0);
      }
    } catch {
      // Capability might not exist yet — show empty state gracefully
      setBackups([]);
      setTotalCount(0);
      setTotalSize(0);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBackups();
  }, [loadBackups]);

  // ── Create Backup ───────────────────────────────────────────

  async function handleCreateBackup() {
    setIsCreating(true);
    try {
      const result = await callCapability('backup.create', {}) as BackupCreateResult;
      if (result.success && result.data) {
        toast.success(t('backup.created', { name: result.data.name }));
        await loadBackups();
      } else {
        toast.error(t('backup.create_failed'));
      }
    } catch (err) {
      toast.error(t('backup.create_failed') + ': ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsCreating(false);
    }
  }

  // ── Verify Backup ───────────────────────────────────────────

  async function handleVerify(backupPath: string) {
    // Mark as verifying
    setBackups((prev) =>
      prev.map((b) => (b.path === backupPath ? { ...b, verifying: true } : b))
    );

    try {
      const result = await callCapability('backup.verify', {
        path: backupPath,
      }) as BackupVerifyResult;

      setBackups((prev) =>
        prev.map((b) =>
          b.path === backupPath
            ? {
                ...b,
                verifying: false,
                verified: result.success ? (result.data?.valid ?? false) : false,
              }
            : b
        )
      );

      if (result.success && result.data?.valid) {
        toast.success(t('backup.verify_success'));
      } else {
        toast.error(t('backup.verify_failed', { reason: result.data?.error || t('backup.verify_failed') }));
      }
    } catch (err) {
      setBackups((prev) =>
        prev.map((b) =>
          b.path === backupPath ? { ...b, verifying: false, verified: false } : b
        )
      );
      toast.error(t('backup.verify_failed', { reason: err instanceof Error ? err.message : String(err) }));
    }
  }

  // ── Restore Backup ─────────────────────────────────────────

  async function handleRestore(backupPath: string) {
    setConfirmRestore(null);
    setIsLoading(true);

    try {
      const result = await callCapability('backup.restore', {
        path: backupPath,
      }) as BackupRestoreResult;

      if (result.success) {
        toast.success(t('backup.restore_success'));
        await loadBackups();
      } else {
        toast.error(t('backup.restore_failed', { reason: result.error || t('backup.restore_failed') }));
      }
    } catch (err) {
      toast.error(t('backup.restore_failed', { reason: err instanceof Error ? err.message : String(err) }));
    } finally {
      setIsLoading(false);
    }
  }

  // ── Delete Backup ──────────────────────────────────────────

  async function handleDelete(backupPath: string, backupName: string) {
    const confirmed = window.confirm(t('backup.delete_confirm', { name: backupName }));
    if (!confirmed) {return;}

    try {
      const result = await callCapability('backup.delete', {
        path: backupPath,
      }) as BackupDeleteResult;

      if (result.success) {
        toast.success(t('backup.delete_success'));
        await loadBackups();
      } else {
        toast.error(t('backup.delete_failed'));
      }
    } catch (err) {
      toast.error(t('backup.delete_failed') + ': ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  // ── Render ───────────────────────────────────────────────────

  return (
    <div className="card">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <div>
          <h3 className="card-title" style={{ margin: 0 }}>
            {t('backup.title')}
          </h3>
          {totalCount > 0 && (
            <span style={{ fontSize: 12, color: '#888' }}>
              {t('backup.total_info', { count: totalCount, size: formatFileSize(totalSize) })}
            </span>
          )}
        </div>
        <button
          className="btn btn-primary"
          onClick={handleCreateBackup}
          disabled={isCreating}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            opacity: isCreating ? 0.7 : 1,
          }}
        >
          {isCreating ? (
            <>
              <span className="loading-spinner" style={{ width: 14, height: 14, margin: 0 }} />
              {t('backup.creating')}
            </>
          ) : (
            t('backup.create')
          )}
        </button>
      </div>

      {/* Backup List */}
      {isLoading && backups.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <div className="loading-spinner" />
          <p style={{ fontSize: 13, color: '#888', marginTop: 8 }}>{t('backup.loading')}</p>
        </div>
      ) : backups.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: 32,
            background: '#fafafa',
            borderRadius: 8,
            border: '1px dashed #dee2e6',
          }}
        >
          <p style={{ fontSize: 14, color: '#888', margin: 0 }}>
            {t('backup.no_backups')}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {backups.map((backup) => (
            <div
              key={backup.path}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 16px',
                background: '#f8f9fa',
                borderRadius: 8,
                border: '1px solid #e9ecef',
                flexWrap: 'wrap',
              }}
            >
              {/* Icon */}
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: '#e8f0fe',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 16,
                  flexShrink: 0,
                }}
              >
                💾
              </div>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 120 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#333' }}>
                  {backup.name.replace('evolveflow-backup-', '')}
                </div>
                <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#888', marginTop: 2 }}>
                  <span>{formatDate(backup.date, locale)}</span>
                  <span>{formatFileSize(backup.sizeBytes)}</span>
                  <span>
                    {backup.verified === null
                      ? t('backup.unverified')
                      : backup.verified
                        ? '✓ ' + t('backup.verified_yes')
                        : '✗ ' + t('backup.verified_no')}
                  </span>
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  className="btn btn-secondary"
                  style={{ fontSize: 11, padding: '4px 10px' }}
                  onClick={() => handleVerify(backup.path)}
                  disabled={backup.verifying}
                >
                  {backup.verifying ? (
                    <span className="loading-spinner" style={{ width: 12, height: 12, margin: 0 }} />
                  ) : (
                    t('backup.verify')
                  )}
                </button>

                {confirmRestore === backup.path ? (
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: '#c62828' }}>{t('backup.restore_confirm')}</span>
                    <button
                      className="btn btn-primary"
                      style={{ fontSize: 11, padding: '4px 10px', background: '#c62828' }}
                      onClick={() => handleRestore(backup.path)}
                    >
                      {t('backup.restore_confirm_action')}
                    </button>
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: 11, padding: '4px 10px' }}
                      onClick={() => setConfirmRestore(null)}
                    >
                      {t('backup.restore_cancel')}
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: 11, padding: '4px 10px' }}
                    onClick={() => setConfirmRestore(backup.path)}
                  >
                    {t('backup.restore')}
                  </button>
                )}

                <button
                  className="btn btn-secondary"
                  style={{ fontSize: 11, padding: '4px 10px', color: '#c62828' }}
                  onClick={() => handleDelete(backup.path, backup.name)}
                >
                  {t('backup.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Info text */}
      <div
        style={{
          marginTop: 16,
          padding: '12px',
          background: '#f0f4ff',
          borderRadius: 8,
          fontSize: 12,
          color: '#666',
          lineHeight: 1.6,
        }}
      >
        <strong style={{ color: '#4a6fa5' }}>{t('backup.info_title')}：</strong>
        {t('backup.info_text')}
      </div>
    </div>
  );
}
