export type BuddyLevel = 'full' | 'minimal' | 'off';

export interface BuddyState {
  mood: 'happy' | 'neutral' | 'encouraging' | 'concerned';
  lastInteraction: Date | null;
}

export class BuddyCore {
  private level: BuddyLevel = 'full';
  private state: BuddyState = {
    mood: 'happy',
    lastInteraction: null,
  };

  setLevel(level: BuddyLevel): void {
    this.level = level;
  }

  getLevel(): BuddyLevel {
    return this.level;
  }

  getState(): BuddyState {
    return { ...this.state };
  }

  shouldRespond(): boolean {
    return this.level !== 'off';
  }

  shouldShowFullPersonality(): boolean {
    return this.level === 'full';
  }

  generateGreeting(): string | null {
    if (!this.shouldRespond()) return null;
    const hour = new Date().getHours();
    if (hour < 12) return this.shouldShowFullPersonality() ? '早上好！新的一天，让我们高效地开始吧 ✨' : '早上好';
    if (hour < 18) return this.shouldShowFullPersonality() ? '下午好！保持节奏，你做得很好 💪' : '下午好';
    return this.shouldShowFullPersonality() ? '晚上好！辛苦了，记得适当休息 🌙' : '晚上好';
  }

  generateScheduleComment(taskCount: number): string | null {
    if (!this.shouldRespond()) return null;
    if (!this.shouldShowFullPersonality()) return null;
    if (taskCount === 0) return '今天没有安排，要不要规划一下？';
    if (taskCount <= 3) return `今天有 ${taskCount} 项安排，节奏不错！`;
    if (taskCount <= 6) return `今天有 ${taskCount} 项安排，充实的一天！`;
    return `今天有 ${taskCount} 项安排，量有点大，注意节奏哦！`;
  }

  generateCompletionCelebration(): string | null {
    if (!this.shouldRespond()) return null;
    if (!this.shouldShowFullPersonality()) return '已完成！';
    const celebrations = ['太棒了！又完成一项 🎉', '干得漂亮！继续保持 💪', '完成了！你真厉害 ✨'];
    return celebrations[Math.floor(Math.random() * celebrations.length)];
  }

  recordInteraction(): void {
    this.state.lastInteraction = new Date();
  }
}

export class BuddyCliRenderer {
  render(message: string): string {
    const lines = [
      '  ╭─────────╮',
      '  │  ◕ ◡ ◕  │',
      '  ╰─────────╯',
      `  Buddy: ${message}`,
    ];
    return lines.join('\n');
  }
}
