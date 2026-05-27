import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EvolveFlowDatabase, ensureDataDirs } from '@evolveflow/storage';
import { createRegistry } from '@evolveflow/capabilities';

// Updated JSON-RPC message structure with all required fields
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
  // Extended fields
  request_id?: string;
  command?: string;
  payload?: Record<string, unknown>;
  idempotency_key?: string;
  session_id?: string;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  // Extended fields
  request_id?: string;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  request_id?: string;
}

type Message = JsonRpcRequest | JsonRpcNotification;

const ALLOWED_CAPABILITIES = new Set([
  'task.create', 'task.update', 'task.complete', 'task.defer', 'task.lock',
  'event.create', 'event.update', 'event.lock',
  'schedule.plan_day', 'schedule.plan_range', 'schedule.rebalance', 'schedule.explain',
  'reminder.snooze',
  'summary.generate_daily',
  'history.list_actions',
  'undo.revert_action',
  'memory.clear_ai_history', 'memory.clear_learned_state',
  'heartbeat', 'shutdown', 'rebuild_state',
  'task.list', 'event.list', 'preference.set', 'preference.get',
]);

let _registry: ReturnType<typeof createRegistry> | null = null;

let reminderQueue: Array<{ id: string; triggerAt: string; message: string | null; taskId: string | null }> = [];
let pendingTaskIds: string[] = [];

async function handleMessage(msg: Message): Promise<JsonRpcResponse | null> {
  const requestId = (msg as JsonRpcRequest).request_id;

  if (!('id' in msg)) {
    handleNotification(msg as JsonRpcNotification);
    return null;
  }

  const request = msg as JsonRpcRequest;
  const { method, params } = request;

  if (method === 'heartbeat') {
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: { status: 'alive', timestamp: Date.now(), reminderQueueLength: reminderQueue.length },
    };
  }

  if (method === 'shutdown') {
    sendNotification('system.shutting_down', { timestamp: Date.now() });
    setTimeout(() => process.exit(0), 100);
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: { status: 'shutting_down' },
    };
  }

  if (method === 'rebuild_state') {
    const data = params as { reminders?: Array<{ id: string; triggerAt: string; message: string | null; taskId: string | null }>; pendingTaskIds?: string[] } | undefined;
    if (data?.reminders) reminderQueue = data.reminders;
    if (data?.pendingTaskIds) pendingTaskIds = data.pendingTaskIds;
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: {
        status: 'state_rebuilt',
        reminderCount: reminderQueue.length,
        pendingTaskCount: pendingTaskIds.length,
      },
    };
  }

  if (!ALLOWED_CAPABILITIES.has(method)) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      error: {
        code: -32601,
        message: `Method not found or not allowed: ${method}`,
      },
    };
  }

  const command = request.command || method;
  const payload = request.payload || params || {};

  try {
    const result = await _registry!.invoke(method, payload, {
      actor: 'sidecar',
      origin: 'sidecar',
      idempotency_key: request.idempotency_key,
      session_id: request.session_id,
    });
    return {
      jsonrpc: '2.0', id: request.id, request_id: requestId,
      result: result,
    };
  } catch (err) {
    return {
      jsonrpc: '2.0', id: request.id, request_id: requestId,
      error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
    };
  }
}

function handleNotification(msg: JsonRpcNotification): void {
  // Handle notifications from Tauri (no response needed)
}

function sendNotification(method: string, params: Record<string, unknown>, requestId?: string): void {
  const notification: JsonRpcNotification = {
    jsonrpc: '2.0',
    method,
    params,
  };
  if (requestId) notification.request_id = requestId;
  process.stdout.write(JSON.stringify(notification) + '\n');
}

// Quick reminder polling - every 10 seconds check due reminders
function startReminderPoller(): void {
  setInterval(() => {
    const now = Date.now();
    for (const reminder of reminderQueue) {
      const triggerTime = new Date(reminder.triggerAt).getTime();
      if (triggerTime <= now && triggerTime > now - 10000) {
        sendNotification('reminder.due', {
          reminder_id: reminder.id,
          message: reminder.message || '提醒时间到了',
          task_id: reminder.taskId,
        });
      }
    }
  }, 10000);
}

// Daily summary scheduler - check every minute if it's 23:00
function startDailySummaryScheduler(): void {
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 23 && now.getMinutes() === 0) {
      sendNotification('summary.auto_generate', {
        date: now.toISOString().split('T')[0],
      });
    }
  }, 60000);
}

function main(): void {
  const dataDir = path.join(os.homedir(), '.evolveflow', 'app-data');
  ensureDataDirs(dataDir);
  const db = new EvolveFlowDatabase(path.join(dataDir, 'evolveflow.db'));
  _registry = createRegistry(db);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', async (line: string) => {
    try {
      const msg: Message = JSON.parse(line.trim());
      const response = await handleMessage(msg);
      if (response) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (err) {
      const errorResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        error: {
          code: -32700,
          message: 'Parse error',
        },
      };
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });

  startReminderPoller();
  startDailySummaryScheduler();

  sendNotification('system.ready', { timestamp: Date.now(), pid: process.pid, reminderQueueLength: reminderQueue.length });
}

main();