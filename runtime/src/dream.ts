import * as fs from 'fs';
import * as path from 'path';

export interface DreamConfig {
  sessionThreshold: number;
  timeSinceLastDreamMs: number;
  idleWindowMinutes: number;
  dailyEndHour: number;
}

const DEFAULT_CONFIG: DreamConfig = {
  sessionThreshold: 5,
  timeSinceLastDreamMs: 4 * 60 * 60 * 1000,
  idleWindowMinutes: 30,
  dailyEndHour: 22,
};

export class DreamOrchestrator {
  private config: DreamConfig;
  private memoryDir: string;
  private lastDreamTime: Date | null = null;
  private sessionCount: number = 0;
  private isRunning: boolean = false;

  constructor(memoryDir: string, config?: Partial<DreamConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.memoryDir = memoryDir;
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }
  }

  recordSession(): void {
    this.sessionCount++;
  }

  shouldRun(userIdleMinutes: number): boolean {
    if (this.isRunning) return false;

    const sessionMet = this.sessionCount >= this.config.sessionThreshold;
    const timeMet = !this.lastDreamTime ||
      (Date.now() - this.lastDreamTime.getTime()) >= this.config.timeSinceLastDreamMs;
    const idleMet = userIdleMinutes >= this.config.idleWindowMinutes;

    return sessionMet && timeMet && idleMet;
  }

  shouldRunDailyEnd(): boolean {
    if (this.isRunning) return false;
    const now = new Date();
    return now.getHours() === this.config.dailyEndHour && now.getMinutes() < 5;
  }

  async run(): Promise<DreamResult> {
    if (this.isRunning) {
      return { status: 'already_running' };
    }

    this.isRunning = true;
    try {
      const memories = this.loadMemories();
      const result = await this.processMemories(memories);
      this.saveDreamResult(result);
      this.lastDreamTime = new Date();
      this.sessionCount = 0;
      return { status: 'completed', insights: result.insights };
    } finally {
      this.isRunning = false;
    }
  }

  private loadMemories(): string[] {
    const normalizedDir = path.resolve(this.memoryDir);
    const files = fs.readdirSync(this.memoryDir).filter((f) => f.endsWith('.md'));
    const result: string[] = [];
    for (const f of files) {
      const filePath = path.resolve(path.join(this.memoryDir, f));
      // Path traversal protection
      if (!filePath.startsWith(normalizedDir)) {
        console.warn(`Skipping file outside memory directory: ${f}`);
        continue;
      }
      result.push(fs.readFileSync(filePath, 'utf-8'));
    }
    return result;
  }

  private async processMemories(memories: string[]): Promise<{ insights: string[]; preferences: Record<string, unknown> }> {
    return {
      insights: ['Processed ' + memories.length + ' memory files'],
      preferences: {},
    };
  }

  private saveDreamResult(result: { insights: string[]; preferences: Record<string, unknown> }): void {
    const normalizedDir = path.resolve(this.memoryDir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `dream-${timestamp}.md`;
    const filePath = path.resolve(path.join(this.memoryDir, fileName));

    // Path traversal protection
    if (!filePath.startsWith(normalizedDir)) {
      console.error('Attempted to write outside memory directory');
      return;
    }

    const content = `# Dream Result\nDate: ${new Date().toISOString()}\n\n## Insights\n${result.insights.map((i) => `- ${i}`).join('\n')}\n`;
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  getStatus(): { isRunning: boolean; lastDreamTime: Date | null; sessionCount: number } {
    return {
      isRunning: this.isRunning,
      lastDreamTime: this.lastDreamTime,
      sessionCount: this.sessionCount,
    };
  }
}

export interface DreamResult {
  status: 'completed' | 'already_running';
  insights?: string[];
}
