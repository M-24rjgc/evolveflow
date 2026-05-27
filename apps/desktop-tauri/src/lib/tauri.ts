import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export async function callCapability(method: string, params?: Record<string, unknown>): Promise<unknown> {
  return invoke('invoke_capability', { method, params: params ?? null });
}

export async function getSidecarStatus(): Promise<{ healthy: boolean }> {
  return invoke('get_sidecar_status');
}

export function onSidecarEvent(callback: (event: string) => void): () => void {
  const unlisten = listen<string>('sidecar-event', (e) => {
    callback(e.payload);
  });
  return () => {
    unlisten.then((fn) => fn());
  };
}
