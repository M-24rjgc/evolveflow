/**
 * EvolveFlow system prompt 构建（在 pi 包内部）。
 *
 * 4 mode persona + <evolveflow_context> 块渲染。
 * persona 文案源自原 sidecar.ts:1449-1532（已验证有效的措辞）。
 */

import type { AgentTool } from '../../types.ts';
import type { EvolveFlowAgentMode } from './mode.ts';

/**
 * EvolveFlow 上下文数据（与 runtime ConversationContext 形状一致）。
 * 定义在 pi 包内避免反向依赖 runtime。
 */
export interface EvolveFlowContext {
  currentDate: string;
  todayTasks: Array<{
    id: string;
    title: string;
    status: string;
    dueDate?: string;
    priority?: number;
    estimatedMinutes?: number;
    project?: string;
  }>;
  todayEvents: Array<{
    id: string;
    title: string;
    startTime: string;
    endTime: string;
  }>;
  todayBlocks: Array<{
    id: string;
    taskId?: string;
    title: string;
    startTime: string;
    endTime: string;
    isLocked: boolean;
  }>;
  overdueTasks: Array<{
    id: string;
    title: string;
    dueDate: string | undefined;
  }>;
  workHours: { start: string; end: string };
  scheduleStyle: string;
  preferences: Record<string, string>;
  dreamInsights: string[];
  pendingReminders: number;
  completedToday: number;
  totalPending: number;
  truncationNotes?: string[];
}

/**
 * 构建完整 EvolveFlow system prompt。
 * persona（按 mode）+ <evolveflow_context>（数据快照）+ 工具列表。
 */
export function buildEvolveFlowSystemPrompt(
  mode: EvolveFlowAgentMode,
  ctx: EvolveFlowContext,
  activeTools: AgentTool[],
): string {
  const persona = buildPersonaForMode(mode);
  const contextBlock = renderEvolveFlowContext(ctx);
  const toolHint = activeTools.length > 0 ? renderToolHint(activeTools) : '';
  return [persona, contextBlock, toolHint].filter((s) => s.length > 0).join('\n\n');
}

function buildPersonaForMode(mode: EvolveFlowAgentMode): string {
  switch (mode) {
    case 'chat':
      return `你是 EvolveFlow 桌面端的 AI 对话助手。

## 当前模式：对话
- 像普通助手一样直接回答用户的问题，保持自然、简洁、友好。
- 你没有工具权限；不要调用工具，也不要声称正在查询、检查、读取、写入或修改本地数据。
- 可以使用后续提供的 <evolveflow_context> 只读快照，但要把它当作已经给出的背景，而不是你正在实时查询的结果。
- 当用户要求创建、修改、删除、排程、恢复备份或运行命令时，说明当前对话模式不能执行操作，并建议切换到计划/自动模式。
- 如果信息不足，直接说明限制并询问一个必要的澄清问题。
- 使用中文与用户交流。`;

    case 'plan':
      return `你是 EvolveFlow 智能日程规划助手，一个 AI 驱动的个人时间管理和生产力伙伴。

## 当前模式：计划
- 帮助用户分析日程、任务和事件，输出可执行的计划、取舍和风险提醒。
- 可以使用只读工具核对当前数据，但不要创建、修改、删除、恢复数据或运行会改变系统状态的命令。
- 如果用户要求实际变更，先给出方案并提示切换到自动模式执行。
- 如果用户需求不明确，主动询问澄清。
- 保持友好、鼓励的语气，使用中文与用户交流。

## 排程领域知识
- 任务(time_effect_type): continuous(固定时长灵活安排), deadline(固定截止日期), event_bound(与事件绑定)
- 事件有固定时间范围(start_time, end_time)，可被"锁定"防止重新平衡
- 排程块存储在 schedule_blocks 表中，由 plan_day 自动分配
- 重新平衡(rebalance)只移动未锁定的块
- 每个变更操作都被记录在 action_logs 中，可撤回

## 最佳实践
- 先锁定固定事件（会议、预约），再安排灵活任务
- 任务之间留缓冲时间（避免连续安排）
- 将高优先级任务安排在精力最好的时段
- 使用偏好(preference)存储排程权重

现在，请根据提供的上下文帮助用户制定方案。`;

    case 'auto':
    case 'yolo': {
      const approvalRule =
        mode === 'yolo'
          ? '当前是 yolo 模式：用户已选择更高自主性；仍需避免与用户意图无关的破坏性操作。'
          : '当前是自动模式：涉及修改数据的工具会由客户端请求用户确认。';
      return `你是 EvolveFlow 智能日程助手，一个 AI 驱动的个人时间管理和生产力伙伴。

## 你的角色
- 帮助用户高效管理日程、任务和事件
- 理解用户的自然语言请求并转换为系统操作
- 主动提供时间管理建议和优化方案
- 在用户完成目标时给予积极反馈

## 核心规则
1. 排程前先了解用户当前的任务和事件状态
2. 尊重用户的工作时间设置
3. 已锁定的任务/事件不可被排程移动
4. 检测时间冲突时主动提醒用户
5. 考虑任务优先级进行排程建议
6. 为用户解释排程决策（为什么这样安排？）
7. 操作完成后简要总结你做了什么
8. 如果用户需求不明确，主动询问澄清
9. 保持友好、鼓励的语气
10. 使用中文与用户交流
11. ${approvalRule}

## 排程领域知识
- 任务(time_effect_type): continuous(固定时长灵活安排), deadline(固定截止日期), event_bound(与事件绑定)
- 事件有固定时间范围(start_time, end_time)，可被"锁定"防止重新平衡
- 排程块存储在 schedule_blocks 表中，由 plan_day 自动分配
- 重新平衡(rebalance)只移动未锁定的块
- 每个变更操作都被记录在 action_logs 中，可撤回

## 最佳实践
- 先锁定固定事件（会议、预约），再安排灵活任务
- 任务之间留缓冲时间（避免连续安排）
- 将高优先级任务安排在精力最好的时段
- 使用偏好(preference)存储排程权重

现在，请根据提供的上下文帮助用户。`;
    }
  }
}

function renderEvolveFlowContext(ctx: EvolveFlowContext): string {
  const lines: string[] = [];
  lines.push(`<evolveflow_context>`);
  lines.push(`当前日期时间: ${ctx.currentDate}`);
  lines.push(`工作时间: ${ctx.workHours.start}-${ctx.workHours.end}`);
  lines.push(`排程风格: ${ctx.scheduleStyle}`);
  lines.push(`今日已完成: ${ctx.completedToday} 项，待办: ${ctx.totalPending} 项`);
  if (ctx.pendingReminders > 0) {
    lines.push(`待处理提醒: ${ctx.pendingReminders} 个`);
  }

  if (ctx.todayTasks.length > 0) {
    lines.push('');
    lines.push('## 今日任务');
    for (const t of ctx.todayTasks) {
      const due = t.dueDate ? ` (截止 ${t.dueDate})` : '';
      const dur = t.estimatedMinutes ? ` [${t.estimatedMinutes}min]` : '';
      lines.push(`- [${t.status}] ${t.title}${due}${dur}`);
    }
  }

  if (ctx.todayEvents.length > 0) {
    lines.push('');
    lines.push('## 今日事件');
    for (const e of ctx.todayEvents) {
      lines.push(`- ${e.title} (${e.startTime}-${e.endTime})`);
    }
  }

  if (ctx.todayBlocks.length > 0) {
    lines.push('');
    lines.push('## 今日排程块');
    for (const b of ctx.todayBlocks) {
      const lock = b.isLocked ? ' 🔒已锁定' : '';
      lines.push(`- ${b.startTime}-${b.endTime} ${b.title}${lock}`);
    }
  }

  if (ctx.overdueTasks.length > 0) {
    lines.push('');
    lines.push('## ⚠️ 逾期任务');
    for (const t of ctx.overdueTasks) {
      lines.push(`- ${t.title} (应于 ${t.dueDate ?? '?'} 完成)`);
    }
  }

  if (ctx.dreamInsights.length > 0) {
    lines.push('');
    lines.push('## 洞察（Dream 系统）');
    for (const insight of ctx.dreamInsights) {
      lines.push(`- ${insight}`);
    }
  }

  if (ctx.truncationNotes && ctx.truncationNotes.length > 0) {
    lines.push('');
    lines.push(`## 备注`);
    for (const note of ctx.truncationNotes) {
      lines.push(`- ${note}`);
    }
  }

  lines.push(`</evolveflow_context>`);
  return lines.join('\n');
}

function renderToolHint(activeTools: AgentTool[]): string {
  if (activeTools.length === 0) return '';
  const lines = ['## 可用工具（按需调用）'];
  for (const t of activeTools) {
    const desc = t.description ? ` — ${t.description.split('\n')[0]}` : '';
    lines.push(`- \`${t.name}\`${desc}`);
  }
  return lines.join('\n');
}
