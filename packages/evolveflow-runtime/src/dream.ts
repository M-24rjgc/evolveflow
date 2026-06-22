/**
 * EvolveFlow Dream System
 * ========================
 * THE core differentiator: real AI analysis of user behavior patterns.
 * Queries the actual database, analyzes with DeepSeek-V4-Flash, and produces
 * structured insights about productivity, energy, scheduling, and habits.
 *
 * No rule engines. No hardcoded returns. No stubs. Only real AI.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type Database from 'better-sqlite3';
// Dream 不再直接依赖 ApiClient——改用 AiCompleter 接口（pi-backed），解耦旧 AI 代码。
import type { AiCompleter } from './ai/ai-pi-glue.js';

// ── Configuration ──────────────────────────────────────────────

export interface DreamConfig {
  /** Minimum user sessions before a dream can run */
  sessionThreshold: number;
  /** Minimum time between dreams (ms) */
  timeSinceLastDreamMs: number;
  /** Minutes of user inactivity required */
  idleWindowMinutes: number;
  /** Hour of day for daily end-of-day analysis */
  dailyEndHour: number;
  /** Minimum days of data required for meaningful analysis */
  coldStartDays: number;
  /** Model name for dream analysis (cost-effective Haiku) */
  modelName: string;
}

const DEFAULT_CONFIG: DreamConfig = {
  sessionThreshold: 5,
  timeSinceLastDreamMs: 4 * 60 * 60 * 1000,
  idleWindowMinutes: 30,
  dailyEndHour: 22,
  coldStartDays: 3,
  modelName: 'deepseek-v4-flash',
};

// ── Data Types ─────────────────────────────────────────────────

/** Structured data collected from the database for dream analysis */
export interface DreamData {
  actionLogs: Array<{
    capability: string;
    actor: string;
    origin: string;
    description: string | null;
    createdAt: string;
  }>;
  taskStats: {
    byStatus: Array<{ status: string; count: number }>;
    total: number;
  };
  completionPatterns: {
    byDayOfWeek: Array<{ dayOfWeek: number; count: number; label: string }>;
    byHourOfDay: Array<{ hourOfDay: number; count: number }>;
  };
  scheduleBlocks: Array<{
    date: string;
    totalBlocks: number;
    lockedBlocks: number;
  }>;
  dailySummaries: Array<{
    date: string;
    completedItems: string;
    incompleteItems: string;
    deferredItems: string;
    rawText: string | null;
  }>;
  preferences: Array<{ key: string; value: string }>;
  totalDays: number;
  totalActionLogs: number;
}

/** A single insight produced by dream analysis */
export interface DreamInsight {
  id: string;
  category: 'productivity' | 'energy' | 'scheduling' | 'habit' | 'adherence' | 'issue';
  description: string;
  confidence: number;
  supportingData: Record<string, unknown>;
  suggestion: string;
}

/** Learned preferences extracted from dream analysis */
export interface DreamPreferences {
  preferredWorkHours?: { start: string; end: string };
  energyPatterns?: Record<string, unknown>;
  scheduleAdherence?: Record<string, unknown>;
  productivityTrend?: string;
  taskPreferences?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Adjustments to BuddyCore personality based on dream insights */
export interface BuddyAdjustments {
  encouragementFrequency?: number;
  severityTone?: number;
  formality?: number;
  brevity?: number;
  moodBias?: 'happy' | 'neutral' | 'encouraging' | 'concerned';
}

/** Full result from AI dream analysis */
export interface DreamAnalysisResult {
  status: 'completed' | 'insufficient_data' | 'error';
  summary: string;
  insights: DreamInsight[];
  preferences: DreamPreferences;
  buddyAdjustments?: BuddyAdjustments;
  confidence: number;
}

/** Result returned from DreamOrchestrator.run() */
export interface DreamRunResult {
  status: 'completed' | 'already_running' | 'insufficient_data' | 'error';
  insights?: DreamInsight[];
  summary?: string;
  preferences?: DreamPreferences;
  buddyAdjustments?: BuddyAdjustments;
  error?: string;
  runId?: string;
}

// ── Dream Analysis Prompt ─────────────────────────────────────

const DREAM_SYSTEM_PROMPT = `你是一个专业的个人生产力分析专家。你的任务是基于用户的真实数据，分析其工作模式并提供深度洞察。

## 你的角色
- 分析用户的日程数据、任务完成情况、行为日志
- 识别生产力模式、能量曲线、排程偏好
- 检测习惯、评估排程遵守度
- 发现重复出现的问题
- 输出结构化JSON分析结果

## 数据分析指南

### 1. 生产力模式分析
- 查看任务完成率（completed vs total）
- 分析一天中哪个时间段完成率最高
- 分析一周中哪几天完成率最高
- 检测长期趋势——生产力是在提高还是下降

### 2. 能量模式分析
- 基于完成时间和任务类型的分布
- 推测用户精力高峰期和低谷期
- 识别最佳工作时段建议

### 3. 排程偏好分析
- 分析计划与实际执行的一致性
- 推荐最佳工作时间窗口
- 检测排程密度偏好（紧凑 vs 宽松）

### 4. 习惯检测
- 识别重复出现的行为模式
- 检测每日/每周例行事项
- 发现新形成的习惯或中断的旧习惯

### 5. 排程遵守度分析
- 分析已锁定的排程块 vs 实际完成的排程
- 计算遵守率趋势
- 识别导致偏离排程的常见原因

### 6. 重复问题检测
- 寻找反复出现的延期、取消、错过
- 识别任务类型与失败模式的关联
- 发现潜在的系统性问题

## 置信度评分规则
- 0.9+ (very_strong): 模式极其明显，数据量充足且一致，几乎没有反例
- 0.7+ (clear): 模式清晰可见，有足够的数据支撑，有少量反例
- 0.5+ (suggestive): 有初步迹象表明可能存在该模式，需要更多数据确认
- <0.5: 置信度不足，不要返回该洞察

## 冷启动处理
如果数据量不足（少于3天的数据或少于20条行为日志），请设置 status 为 "insufficient_data"，
并在 summary 中说明需要更多数据。

## 输出格式
你必须在以下JSON结构内返回分析结果（不要使用Markdown代码块，直接输出纯JSON）：

{
  "status": "completed" | "insufficient_data" | "error",
  "summary": "总体分析摘要，2-4句话概括用户状态",
  "insights": [
    {
      "category": "productivity" | "energy" | "scheduling" | "habit" | "adherence" | "issue",
      "description": "人类可读的洞察描述，中文",
      "confidence": 0.0-1.0,
      "supportingData": { "key": "value" },
      "suggestion": "基于该洞察的可操作建议，中文"
    }
  ],
  "preferences": {
    "preferredWorkHours": { "start": "HH:MM", "end": "HH:MM" },
    "energyPatterns": { "peakHours": [...], "lowHours": [...] },
    "scheduleAdherence": { "rate": 0.0-1.0, "trend": "improving" | "declining" | "stable" },
    "productivityTrend": "用户生产力趋势描述，中文",
    "taskPreferences": { "preferredTaskTypes": [...], "avoidedTaskTypes": [...] }
  },
  "buddyAdjustments": {
    "encouragementFrequency": 0.0-1.0,
    "severityTone": 0.0-1.0,
    "formality": 0.0-1.0,
    "brevity": 0.0-1.0,
    "moodBias": "happy" | "neutral" | "encouraging" | "concerned"
  },
  "confidence": 0.0-1.0
}`;

// ── ID Generator ──────────────────────────────────────────────

function generateId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

// ── Dream Orchestrator ─────────────────────────────────────────

export class DreamOrchestrator {
  private config: DreamConfig;
  private memoryDir: string;
  private db: Database.Database;
  private aiComplete: AiCompleter;
  private lastDreamTime: Date | null = null;
  private sessionCount: number = 0;
  private isRunning: boolean = false;

  constructor(
    memoryDir: string,
    db: Database.Database,
    aiComplete: AiCompleter,
    config?: Partial<DreamConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.memoryDir = memoryDir;
    this.db = db;
    this.aiComplete = aiComplete;

    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }
  }

  /** Record a user session (called when user interacts with the system) */
  recordSession(): void {
    this.sessionCount++;
  }

  /** Check whether conditions are met for a dream run */
  shouldRun(userIdleMinutes: number): boolean {
    if (this.isRunning) {
      return false;
    }

    const sessionMet = this.sessionCount >= this.config.sessionThreshold;
    const timeMet =
      !this.lastDreamTime ||
      Date.now() - this.lastDreamTime.getTime() >= this.config.timeSinceLastDreamMs;
    const idleMet = userIdleMinutes >= this.config.idleWindowMinutes;

    return sessionMet && timeMet && idleMet;
  }

  /** Check whether it's the configured daily-end hour */
  shouldRunDailyEnd(): boolean {
    if (this.isRunning) {
      return false;
    }
    const now = new Date();
    return now.getHours() === this.config.dailyEndHour && now.getMinutes() < 5;
  }

  /**
   * Execute a dream analysis cycle.
   * 1. Queries structured data from the database
   * 2. Checks cold-start conditions
   * 3. Calls AI for analysis
   * 4. Saves results to memory files and database
   * 5. Cleans up old dream files
   */
  async run(): Promise<DreamRunResult> {
    if (this.isRunning) {
      return { status: 'already_running' };
    }

    this.isRunning = true;
    const runId = `dream_${Date.now()}_${generateId().slice(0, 8)}`;

    try {
      // Step 1: Get real data from the database
      const dreamData = this.queryStructuredData();

      // Step 2: Cold-start check
      if (dreamData.totalDays < this.config.coldStartDays || dreamData.totalActionLogs < 20) {
        const result: DreamAnalysisResult = {
          status: 'insufficient_data',
          summary: `需要至少${this.config.coldStartDays}天数据和20条操作日志才能进行分析。当前有 ${dreamData.totalDays} 天数据和 ${dreamData.totalActionLogs} 条日志。`,
          insights: [],
          preferences: {},
          confidence: 0,
        };
        this.saveDreamResult(result, runId, dreamData);
        this.lastDreamTime = new Date();
        return {
          status: 'insufficient_data',
          summary: result.summary,
          insights: [],
          runId,
        };
      }

      // Step 3: Real AI analysis
      const analysis = await this.analyzeWithAI(dreamData);

      // Step 4: Save everything
      this.saveDreamResult(analysis, runId, dreamData);
      if (analysis.status === 'completed') {
        this.saveInsightsToDb(analysis, runId);
      }

      // Step 5: Clean up old reports
      this.cleanOldDreamFiles();

      this.lastDreamTime = new Date();
      this.sessionCount = 0;

      return {
        status: analysis.status,
        insights: analysis.insights,
        summary: analysis.summary,
        preferences: analysis.preferences,
        buddyAdjustments: analysis.buddyAdjustments,
        runId,
        error: analysis.status === 'error' ? analysis.summary : undefined,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[Dream] Analysis failed: ${errorMessage}`);

      const errorResult: DreamAnalysisResult = {
        status: 'error',
        summary: `梦境分析失败: ${errorMessage}`,
        insights: [],
        preferences: {},
        confidence: 0,
      };
      this.saveDreamResult(errorResult, runId, null);

      return {
        status: 'error',
        error: errorMessage,
        runId,
      };
    } finally {
      this.isRunning = false;
    }
  }

  // ── Database Query ───────────────────────────────────────────

  /**
   * Query the actual database for all data needed for dream analysis.
   * No stubs. No hardcoded data. Pure database queries.
   */
  private queryStructuredData(): DreamData {
    // 1. Action logs - last 500
    const actionLogs = this.db
      .prepare(
        `SELECT capability, actor, origin, description, created_at
         FROM action_logs
         ORDER BY created_at DESC
         LIMIT 500`
      )
      .all() as Array<{
      capability: string;
      actor: string;
      origin: string;
      description: string | null;
      created_at: string;
    }>;

    // 2. Task status distribution
    const taskByStatus = this.db
      .prepare(
        `SELECT status, COUNT(*) as count
         FROM tasks
         GROUP BY status
         ORDER BY count DESC`
      )
      .all() as Array<{ status: string; count: number }>;

    const totalTasks = taskByStatus.reduce((sum, row) => sum + row.count, 0);

    // 3. Completion patterns by day of week (from action_logs where capability = 'task.complete')
    const completionsByDayOfWeek = this.db
      .prepare(
        `SELECT CAST(strftime('%w', created_at) AS INTEGER) as day_of_week, COUNT(*) as count
         FROM action_logs
         WHERE capability = 'task.complete'
         GROUP BY day_of_week
         ORDER BY day_of_week`
      )
      .all() as Array<{ day_of_week: number; count: number }>;

    const weekDayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    // 4. Completion patterns by hour of day
    const completionsByHour = this.db
      .prepare(
        `SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour_of_day, COUNT(*) as count
         FROM action_logs
         WHERE capability = 'task.complete'
         GROUP BY hour_of_day
         ORDER BY hour_of_day`
      )
      .all() as Array<{ hour_of_day: number; count: number }>;

    // 5. Schedule blocks by date (last 30 days)
    const scheduleBlocks = this.db
      .prepare(
        `SELECT date, COUNT(*) as total_blocks, SUM(locked) as locked_blocks
         FROM schedule_blocks
         GROUP BY date
         ORDER BY date DESC
         LIMIT 30`
      )
      .all() as Array<{ date: string; total_blocks: number; locked_blocks: number | null }>;

    // 6. Daily summaries (last 30)
    const dailySummaries = this.db
      .prepare(
        `SELECT date, completed_items, incomplete_items, deferred_items, raw_text
         FROM daily_summaries
         ORDER BY date DESC
         LIMIT 30`
      )
      .all() as Array<{
      date: string;
      completed_items: string;
      incomplete_items: string;
      deferred_items: string;
      raw_text: string | null;
    }>;

    // 7. All preferences
    const preferences = this.db
      .prepare('SELECT key, value FROM preferences ORDER BY key')
      .all() as Array<{ key: string; value: string }>;

    // 8. Data range: compute total days of data
    const dateRange = this.db
      .prepare(
        `SELECT
           MIN(created_at) as first_date,
           MAX(created_at) as last_date
         FROM action_logs`
      )
      .get() as { first_date: string | null; last_date: string | null } | undefined;

    let totalDays = 0;
    if (dateRange?.first_date && dateRange?.last_date) {
      const first = new Date(dateRange.first_date);
      const last = new Date(dateRange.last_date);
      totalDays = Math.max(1, Math.floor((last.getTime() - first.getTime()) / 86400000) + 1);
    }

    return {
      actionLogs: actionLogs.map((r) => ({
        capability: r.capability,
        actor: r.actor,
        origin: r.origin,
        description: r.description,
        createdAt: r.created_at,
      })),
      taskStats: {
        byStatus: taskByStatus.map((r) => ({ status: r.status, count: r.count })),
        total: totalTasks,
      },
      completionPatterns: {
        byDayOfWeek: completionsByDayOfWeek.map((r) => ({
          dayOfWeek: r.day_of_week,
          count: r.count,
          label: weekDayNames[r.day_of_week] ?? `Day${r.day_of_week}`,
        })),
        byHourOfDay: completionsByHour.map((r) => ({
          hourOfDay: r.hour_of_day,
          count: r.count,
        })),
      },
      scheduleBlocks: scheduleBlocks.map((r) => ({
        date: r.date,
        totalBlocks: r.total_blocks,
        lockedBlocks: r.locked_blocks ?? 0,
      })),
      dailySummaries: dailySummaries.map((r) => ({
        date: r.date,
        completedItems: r.completed_items,
        incompleteItems: r.incomplete_items,
        deferredItems: r.deferred_items,
        rawText: r.raw_text,
      })),
      preferences,
      totalDays,
      totalActionLogs: actionLogs.length,
    };
  }

  // ── AI Analysis ──────────────────────────────────────────────

  /**
   * Send the structured data to DeepSeek-V4-Flash for real AI analysis.
   * The AI returns a structured JSON analysis with insights and recommendations.
   */
  private async analyzeWithAI(dreamData: DreamData): Promise<DreamAnalysisResult> {
    // Build the user message with structured data
    const dataStr = JSON.stringify(dreamData, null, 2);

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      {
        role: 'user',
        content: `以下是用户的完整数据分析数据，请分析并返回结构化JSON结果：

\`\`\`json
${dataStr}
\`\`\``,
      },
    ];

    // 经 pi-backed AiCompleter 做单次补全（低温度求稳定结构化输出）。
    const { text } = await this.aiComplete(messages, DREAM_SYSTEM_PROMPT, {
      maxTokens: 4096,
      temperature: 0.3,
    });

    // text 即 AI 返回的文本内容
    if (!text || !text.trim()) {
      return {
        status: 'error',
        summary: 'AI返回了空响应或无文本内容',
        insights: [],
        preferences: {},
        confidence: 0,
      };
    }

    const rawText = text;

    // Parse the JSON from the AI response
    return this.parseAIResponse(rawText);
  }

  /**
   * Parse AI response text into DreamAnalysisResult.
   * Handles raw JSON, JSON in code blocks, and malformed responses.
   */
  private parseAIResponse(rawText: string): DreamAnalysisResult {
    // Strategy 1: Try to parse the entire response as JSON
    try {
      const parsed = JSON.parse(rawText.trim());
      return this.validateAnalysisResult(parsed);
    } catch {
      // Not valid JSON as-is, try next strategy
    }

    // Strategy 2: Extract JSON from markdown code blocks
    const jsonBlockMatch = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (jsonBlockMatch) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1].trim());
        return this.validateAnalysisResult(parsed);
      } catch {
        // Code block content is not valid JSON
      }
    }

    // Strategy 3: Find the first JSON-like object in the text
    const jsonLikeMatch = rawText.match(/\{[\s\S]*"status"[\s\S]*"summary"[\s\S]*\}/);
    if (jsonLikeMatch) {
      try {
        const parsed = JSON.parse(jsonLikeMatch[0]);
        return this.validateAnalysisResult(parsed);
      } catch {
        // Still not valid JSON
      }
    }

    // All parsing strategies failed
    return {
      status: 'error',
      summary: `无法解析AI返回的JSON结果。原始响应: ${rawText.slice(0, 500)}`,
      insights: [],
      preferences: {},
      confidence: 0,
    };
  }

  /**
   * Validate and normalize a parsed analysis result.
   * Ensures all required fields are present and have correct types.
   */
  private validateAnalysisResult(parsed: Record<string, unknown>): DreamAnalysisResult {
    const status =
      parsed.status === 'completed' || parsed.status === 'insufficient_data'
        ? parsed.status
        : 'error';

    const result: DreamAnalysisResult = {
      status,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '分析完成',
      insights: Array.isArray(parsed.insights)
        ? parsed.insights
            .filter((i: unknown) => i && typeof i === 'object')
            .map((i: Record<string, unknown>, idx: number) => ({
              id: `dream_insight_${Date.now()}_${idx}`,
              category: this.validateCategory(i.category as string),
              description: typeof i.description === 'string' ? i.description : '',
              confidence:
                typeof i.confidence === 'number' ? Math.max(0, Math.min(1, i.confidence)) : 0,
              supportingData: (i.supportingData as Record<string, unknown>) ?? {},
              suggestion: typeof i.suggestion === 'string' ? i.suggestion : '',
            }))
            .filter((i: DreamInsight) => i.confidence >= 0.5 && i.description.length > 0)
        : [],
      preferences: {},
      confidence:
        typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
    };

    // Extract preferences if provided
    if (parsed.preferences && typeof parsed.preferences === 'object') {
      const prefs = parsed.preferences as Record<string, unknown>;
      if (prefs.preferredWorkHours && typeof prefs.preferredWorkHours === 'object') {
        const wh = prefs.preferredWorkHours as Record<string, unknown>;
        result.preferences.preferredWorkHours = {
          start: String(wh.start ?? '09:00'),
          end: String(wh.end ?? '18:00'),
        };
      }
      if (prefs.energyPatterns) {
        result.preferences.energyPatterns = prefs.energyPatterns as Record<string, unknown>;
      }
      if (prefs.scheduleAdherence) {
        result.preferences.scheduleAdherence = prefs.scheduleAdherence as Record<string, unknown>;
      }
      if (typeof prefs.productivityTrend === 'string') {
        result.preferences.productivityTrend = prefs.productivityTrend;
      }
      if (prefs.taskPreferences) {
        result.preferences.taskPreferences = prefs.taskPreferences as Record<string, unknown>;
      }
    }

    // Extract buddy adjustments if provided
    if (parsed.buddyAdjustments && typeof parsed.buddyAdjustments === 'object') {
      const adj = parsed.buddyAdjustments as Record<string, unknown>;
      result.buddyAdjustments = {};
      if (typeof adj.encouragementFrequency === 'number') {
        result.buddyAdjustments.encouragementFrequency = Math.max(
          0,
          Math.min(1, adj.encouragementFrequency)
        );
      }
      if (typeof adj.severityTone === 'number') {
        result.buddyAdjustments.severityTone = Math.max(0, Math.min(1, adj.severityTone));
      }
      if (typeof adj.formality === 'number') {
        result.buddyAdjustments.formality = Math.max(0, Math.min(1, adj.formality));
      }
      if (typeof adj.brevity === 'number') {
        result.buddyAdjustments.brevity = Math.max(0, Math.min(1, adj.brevity));
      }
      if (typeof adj.moodBias === 'string') {
        const validMoods = ['happy', 'neutral', 'encouraging', 'concerned'];
        if (validMoods.includes(adj.moodBias)) {
          result.buddyAdjustments.moodBias = adj.moodBias as BuddyAdjustments['moodBias'];
        }
      }
      // Remove empty object if nothing was set
      if (Object.keys(result.buddyAdjustments).length === 0) {
        delete result.buddyAdjustments;
      }
    }

    return result;
  }

  private validateCategory(
    cat: string
  ): 'productivity' | 'energy' | 'scheduling' | 'habit' | 'adherence' | 'issue' {
    const valid = ['productivity', 'energy', 'scheduling', 'habit', 'adherence', 'issue'];
    return valid.includes(cat)
      ? (cat as 'productivity' | 'energy' | 'scheduling' | 'habit' | 'adherence' | 'issue')
      : 'productivity';
  }

  // ── Persistence ──────────────────────────────────────────────

  /**
   * Save dream results:
   * 1. Human-readable .md report to memory directory
   * 2. Purge old dream files (> 90 days)
   */
  private saveDreamResult(
    analysis: DreamAnalysisResult,
    runId: string,
    dreamData: DreamData | null
  ): void {
    const normalizedDir = path.resolve(this.memoryDir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `dream-${timestamp}.md`;
    const filePath = path.resolve(path.join(this.memoryDir, fileName));

    // Path traversal protection
    if (!filePath.startsWith(normalizedDir)) {
      console.error('[Dream] Attempted to write outside memory directory');
      return;
    }

    const lines: string[] = [];
    lines.push(`# 梦境分析报告`);
    lines.push(`- **运行ID**: ${runId}`);
    lines.push(`- **时间**: ${new Date().toISOString()}`);
    lines.push(`- **状态**: ${analysis.status}`);
    lines.push(`- **综合置信度**: ${(analysis.confidence * 100).toFixed(1)}%`);
    lines.push('');

    // Summary
    lines.push('## 总体摘要');
    lines.push(analysis.summary);
    lines.push('');

    // Data context
    if (dreamData) {
      lines.push('## 数据概况');
      lines.push(`- 数据跨度: ${dreamData.totalDays} 天`);
      lines.push(`- 行为日志: ${dreamData.totalActionLogs} 条`);
      lines.push(`- 任务总数: ${dreamData.taskStats.total}`);
      for (const s of dreamData.taskStats.byStatus) {
        lines.push(`  - ${s.status}: ${s.count} 个`);
      }
      lines.push('');
    }

    // Insights
    if (analysis.insights.length > 0) {
      lines.push(`## 洞察分析（共 ${analysis.insights.length} 条）`);
      lines.push('');
      for (const insight of analysis.insights) {
        const confidenceBar = this.renderConfidenceBar(insight.confidence);
        lines.push(`### ${insight.description}`);
        lines.push(`- **分类**: ${insight.category}`);
        lines.push(`- **置信度**: ${(insight.confidence * 100).toFixed(0)}% ${confidenceBar}`);
        lines.push(`- **建议**: ${insight.suggestion}`);
        if (Object.keys(insight.supportingData).length > 0) {
          lines.push(
            `- **支持数据**: \`\`\`json\n${JSON.stringify(insight.supportingData, null, 2)}\n\`\`\``
          );
        }
        lines.push('');
      }
    }

    // Preferences
    if (Object.keys(analysis.preferences).length > 0) {
      lines.push('## 学习到的偏好');
      lines.push('');
      for (const [key, value] of Object.entries(analysis.preferences)) {
        lines.push(`- **${key}**: \`${JSON.stringify(value)}\``);
      }
      lines.push('');
    }

    // Buddy adjustments
    if (analysis.buddyAdjustments) {
      lines.push('## Buddy 调整');
      lines.push('');
      for (const [key, value] of Object.entries(analysis.buddyAdjustments)) {
        if (value !== undefined) {
          lines.push(`- **${key}**: ${value}`);
        }
      }
      lines.push('');
    }

    const content = lines.join('\n');
    fs.writeFileSync(filePath, content, 'utf-8');

    // Clean up old files
    this.cleanOldDreamFiles();
  }

  /**
   * Save structured insights to the dream_insights database table.
   */
  private saveInsightsToDb(analysis: DreamAnalysisResult, runId: string): void {
    const now = new Date();
    const insertStmt = this.db.prepare(`
      INSERT INTO dream_insights (id, dream_run_id, category, insight_text, confidence, supporting_data, source_analysis, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction(() => {
      for (const insight of analysis.insights) {
        const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 day expiry
        insertStmt.run(
          generateId(),
          runId,
          insight.category,
          insight.description,
          insight.confidence,
          JSON.stringify(insight.supportingData),
          `Dream analysis ${runId}: ${analysis.summary.slice(0, 200)}`,
          expiresAt,
          now.toISOString()
        );
      }
    });

    try {
      insertMany();
      console.log(
        `[Dream] Saved ${analysis.insights.length} insights to database for run ${runId}`
      );
    } catch (err) {
      console.error(
        `[Dream] Failed to save insights to database: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Remove dream report files older than 90 days.
   */
  private cleanOldDreamFiles(): void {
    try {
      const normalizedDir = path.resolve(this.memoryDir);
      const cutoffMs = Date.now() - 90 * 24 * 60 * 60 * 1000;

      const files = fs.readdirSync(this.memoryDir);
      for (const f of files) {
        if (!f.startsWith('dream-') || !f.endsWith('.md')) {
          continue;
        }

        const filePath = path.resolve(path.join(this.memoryDir, f));
        if (!filePath.startsWith(normalizedDir)) {
          continue;
        }

        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoffMs) {
            fs.unlinkSync(filePath);
            console.log(`[Dream] Purged old dream file: ${f}`);
          }
        } catch {
          // File might be gone already, skip
        }
      }
    } catch (err) {
      console.error(
        `[Dream] Failed to clean old dream files: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private renderConfidenceBar(confidence: number): string {
    const filled = Math.round(confidence * 10);
    const empty = 10 - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  // ── Status ───────────────────────────────────────────────────

  getStatus(): {
    isRunning: boolean;
    lastDreamTime: Date | null;
    sessionCount: number;
    config: DreamConfig;
  } {
    return {
      isRunning: this.isRunning,
      lastDreamTime: this.lastDreamTime,
      sessionCount: this.sessionCount,
      config: { ...this.config },
    };
  }

  /** Update config at runtime */
  updateConfig(config: Partial<DreamConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
