/**
 * CapabilityRegistry → Anthropic Tool adapter.
 * Converts EvolveFlow's 18 capabilities into Anthropic-compatible tool definitions.
 *
 * Each capability has: name, domain, description, inputSchema, mutating, handler
 * Each Anthropic tool needs: name, description, input_schema
 */

import type { AnthropicTool } from './types.js';
import type { CapabilityRegistry } from '@evolveflow/capabilities';

/** Convert dotted capability name to Anthropic tool name (dots -> underscores) */
export function capabilityToToolName(name: string): string {
  return name.replace(/_/g, '__').replace(/\./g, '_');
}

/** Convert Anthropic tool name back to capability name (underscores -> dots) */
export function toolToCapabilityName(name: string): string {
  let capabilityName = '';
  for (let i = 0; i < name.length; i++) {
    if (name[i] === '_') {
      if (name[i + 1] === '_') {
        capabilityName += '_';
        i++;
      } else {
        capabilityName += '.';
      }
    } else {
      capabilityName += name[i];
    }
  }
  return capabilityName;
}

/** Convert a CapabilityRegistry listing into Anthropic Tool definitions */
export function capabilitiesToTools(registry: CapabilityRegistry): AnthropicTool[] {
  const capabilities = registry.list();

  return capabilities.map((cap) => {
    // CapabilityDefinition.inputSchema is Record<string, unknown> —
    // cast to the expected JSON Schema shape for safe access.
    const schema = cap.inputSchema as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    const hasRequired = !!(schema.required?.length);
    const hasNonEmptyProps = !!(
      schema.properties &&
      Object.keys(schema.properties).length > 0
    );

    const input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean } = {
      type: 'object' as const,
      properties: (schema.properties || {}) as Record<string, unknown>,
    };

    if (hasRequired) {
      input_schema.required = schema.required;
      if (hasNonEmptyProps) {
        input_schema.additionalProperties = false;
      }
    }

    return {
      name: capabilityToToolName(cap.name),
      description: buildToolDescription(cap.name, cap.description, cap.domain),
      input_schema,
    };
  });
}

/** Build a detailed description for the LLM including domain context */
function buildToolDescription(name: string, description: string, domain: string): string {
  const domainHints: Record<string, string> = {
    task: '[任务管理] ',
    event: '[日历事件] ',
    schedule: '[智能排程] ',
    reminder: '[提醒管理] ',
    summary: '[每日总结] ',
    history: '[操作历史] ',
    undo: '[操作撤销] ',
    memory: '[记忆管理] ',
    preference: '[用户偏好] ',
    ai: '[AI 引擎] ',
    dream: '[Dream 分析] ',
    backup: '[备份管理] ',
    buddy: '[Buddy 伙伴] ',
  };

  let prefix = domainHints[domain];
  if (prefix === undefined) {
    console.warn(`[tools.ts] Unknown capability domain: "${domain}" — add to domainHints`);
    prefix = '';
  }
  return `${prefix}${description}`;
}

/** Get tool definitions grouped by domain for better LLM understanding */
export function getToolsByDomain(registry: CapabilityRegistry): Map<string, AnthropicTool[]> {
  const tools = capabilitiesToTools(registry);
  const capabilities = registry.list();
  const grouped = new Map<string, AnthropicTool[]>();

  for (let i = 0; i < tools.length; i++) {
    const domain = capabilities[i].domain;
    if (!grouped.has(domain)) {
      grouped.set(domain, []);
    }
    grouped.get(domain)!.push(tools[i]);
  }

  return grouped;
}

/** Get system prompt text listing all available tools */
export function getToolListingPrompt(registry: CapabilityRegistry): string {
  const capabilities = registry.list();
  const lines: string[] = ['## 可用工具'];

  const grouped = new Map<string, string[]>();
  for (const cap of capabilities) {
    if (!grouped.has(cap.domain)) {
      grouped.set(cap.domain, []);
    }
    const toolName = capabilityToToolName(cap.name);
    grouped.get(cap.domain)!.push(`- **${toolName}**: ${cap.description}${cap.mutating ? ' (会修改数据)' : ' (只读)'}`);
  }

  for (const [domain, toolLines] of grouped) {
    const domainNames: Record<string, string> = {
      task: '📋 任务管理',
      event: '📅 日历事件',
      schedule: '🔄 智能排程',
      reminder: '⏰ 提醒管理',
      summary: '📊 每日总结',
      history: '📜 操作历史',
      undo: '↩️ 操作撤销',
      memory: '🧠 记忆管理',
      preference: '⚙️ 用户偏好',
      ai: '🤖 AI 引擎',
      dream: '💭 Dream 分析',
      backup: '💾 备份管理',
      buddy: '👋 Buddy 伙伴',
    };
    lines.push(`\n### ${domainNames[domain] || domain}`);
    lines.push(...toolLines);
  }

  return lines.join('\n');
}
