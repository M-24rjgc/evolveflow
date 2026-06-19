/**
 * EvolveFlow Buddy System
 * =======================
 * An animated AI companion that responds to user actions with mood-appropriate
 * messages. Mood is driven by real-time context and dream analysis insights.
 */

export type BuddyLevel = 'full' | 'minimal' | 'off';

export type BuddyMood = 'happy' | 'neutral' | 'encouraging' | 'concerned';

export interface BuddyState {
  mood: BuddyMood;
  lastInteraction: Date | null;
}

/** Adjustments to the buddy's personality, produced by dream analysis. */
export interface BuddyAdjustments {
  encouragementFrequency?: number;
  severityTone?: number;
  formality?: number;
  brevity?: number;
  moodBias?: BuddyMood;
}

/** Range 0.0-1.0 personality traits that modulate response selection. */
interface PersonalityTraits {
  /** How often to send encouraging messages (0=minimal, 1=very often) */
  encouragementFrequency: number;
  /** How direct/severe the tone is (0=gentle, 1=direct/firm) */
  severityTone: number;
  /** How formal the language is (0=casual, 1=formal) */
  formality: number;
  /** How short the messages are (0=verbose, 1=very brief) */
  brevity: number;
}

// ── Mood-Response Tables ───────────────────────────────────────
// Each mood has 5+ response variants. Packed arrays avoid branching.

const GREETINGS: Record<BuddyMood, string[]> = {
  happy: [
    '早上好！阳光正好，一起创造美好的一天吧！',
    '嗨！今天一定会是超棒的一天，我已经等不及了 ✨',
    '早上好呀！充满活力的早晨，让我们大干一场！',
    '新的一天来啦！你状态看起来很棒，加油！',
    '早安！今天的你，一定无所不能 💪',
    '起床啦！世界在等你发光发热，我们开始吧！',
    '早上好！昨晚休息得怎么样？今天有好多精彩等着你！',
  ],
  neutral: ['早上好', '上午好', '下午好', '晚上好', '你好'],
  encouraging: [
    '早上好！每一步都在向前，你做得很好。',
    '新的一天开始了，记得你昨天的努力不会白费 🌱',
    '早安，保持你的节奏，持续进步就是胜利。',
    '又一天，又一次机会变得更好。一起加油。',
    '早上好，不必完美，只要前进就好。',
  ],
  concerned: [
    '早上好，今天感觉怎么样？记住照顾好自己的节奏。',
    '早安。如果今天觉得累，记得适当休息也很重要。',
    '新的一天开始了。慢慢来，按自己的步调走就好 🌿',
    '早上好，有什么需要我帮忙的吗？我一直在这里。',
    '早安。记得你不需要一次性做完所有事情。',
  ],
};

const SCHEDULE_COMMENTS: Record<BuddyMood, Array<string | ((n: number) => string)>> = {
  happy: [
    (n: number) => `今天有 ${n} 项安排，充实又精彩，我们一起搞定它！`,
    (n: number) => `哇，今天安排了 ${n} 项任务，效率拉满！`,
    (n: number) => `${n} 项任务已就绪！今天的状态一定势如破竹 💥`,
    (n: number) => `日程表上排了 ${n} 件事，来吧，一个一个击破！`,
    (n: number) => `太棒了，今天有 ${n} 件事要做！充实的一天最让人满足`,
    (n: number) => `${n} 项任务？没问题，你超厉害的！`,
  ],
  neutral: [
    (n: number) => `今天有 ${n} 项安排。`,
    (n: number) => `日程中有 ${n} 项待办。`,
    (n: number) => `${n} 件事待完成。`,
    (n: number) => `今日计划：${n} 项任务。`,
    (n: number) => `今天有不少安排，按计划一步步来就行。`,
  ],
  encouraging: [
    (n: number) => `今天有 ${n} 项安排，专注当下，一件一件来就好 🌟`,
    (n: number) => `${n} 件事等着你，每一步都离目标更近一步。`,
    (n: number) => `不用着急全部完成，${n} 项任务中，做掉最重要的就很棒了。`,
    (n: number) => `${n} 项任务——你已经准备好了，我相信你可以的。`,
    (n: number) => `今天计划了 ${n} 件事，记得庆祝每一个小进展 🎯`,
  ],
  concerned: [
    (n: number) => `今天有 ${n} 项安排，看起来不少。记得留出休息时间。`,
    (n: number) => `日程排了 ${n} 件事，这个量不算少，注意取舍哦。`,
    (n: number) => `${n} 项待办，如果觉得太多，我们可以调整一下优先级。`,
    (n: number) => `今天任务量 ${n} 项，不要给自己太大压力，完成比完美重要。`,
    (n: number) => `${n} 项安排要处理，需要我帮你优化一下顺序吗？`,
  ],
};

const CELEBRATIONS: Record<BuddyMood, string[]> = {
  happy: [
    '太棒了！又完成一项！你简直势不可挡 🎉',
    '完成啦！太厉害了，继续保持这个节奏！',
    '耶！又搞定一个！你真的是效率超人 ✨',
    '完美收工！又一个任务被您拿下！👏',
    '好耶！进度条又前进了一大截！继续冲！',
    '完成了！今天的你又朝目标迈进了一大步 🚀',
  ],
  neutral: ['已完成。', '任务完成。', '已搞定。', '完成一项。', '好，这一项结束了。'],
  encouraging: [
    '完成得很好！每个任务的完成都值得被看见 🌱',
    '很棒，又一个任务被你拿下了。积少成多，继续加油！',
    '做得不错！每一次完成都在累积你的成就感。',
    '好样的！这就是进步——不需要惊天动地，只需要持续向前。',
    '任务完成！别忘了给自己一个肯定，你值得 👍',
    '又前进一步！坚持的力量比爆发更可贵。',
  ],
  concerned: [
    '完成了！做得不错，记得给自己一点喘息的时间。',
    '这一项搞定了，干得好。如果累了就休息一下。',
    '任务完成，辛苦了。别忘了照顾好自己 💚',
    '又完成了一项，你的努力我看在眼里。适度放松也很重要哦。',
    '好，这一项处理好了。不用急着下一个，先喘口气。',
  ],
};

// ── Time-Seeded Pseudo-Random ──────────────────────────────────

/**
 * Simple seedable PRNG (mulberry32) for deterministic-but-varied
 * response selection. Seed is derived from the current minute so
 * the same minute yields the same response, avoiding flicker.
 */
function seededRandom(seed: number): () => number {
  let s = seed | 0;
  return (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function timeSeed(): number {
  const now = new Date();
  return (
    now.getFullYear() * 1000000 +
    now.getMonth() * 100000 +
    now.getDate() * 10000 +
    now.getHours() * 60 +
    now.getMinutes()
  );
}

function pickWeighted<T>(items: T[], rng: () => number): T {
  const index = Math.floor(rng() * items.length);
  return items[index < items.length ? index : items.length - 1];
}

// ── BuddyCore ──────────────────────────────────────────────────

export class BuddyCore {
  private level: BuddyLevel = 'full';
  private state: BuddyState = {
    mood: 'happy',
    lastInteraction: null,
  };
  private personality: PersonalityTraits = {
    encouragementFrequency: 0.8,
    severityTone: 0.3,
    formality: 0.2,
    brevity: 0.3,
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

  /** Access current personality traits (read-only snapshot). */
  getPersonality(): PersonalityTraits {
    return { ...this.personality };
  }

  shouldRespond(): boolean {
    return this.level !== 'off';
  }

  shouldShowFullPersonality(): boolean {
    return this.level === 'full';
  }

  // ── Mood-Driven Greeting ───────────────────────────────────

  generateGreeting(): string | null {
    if (!this.shouldRespond()) {
      return null;
    }

    const rng = seededRandom(timeSeed());
    const mood = this.state.mood;
    const pool = GREETINGS[mood];
    let message = pickWeighted(pool, rng);

    // For neutral mood at minimal level, use simple time-based greeting
    if (this.level === 'minimal') {
      const hour = new Date().getHours();
      if (hour < 12) {
        return '早上好';
      }
      if (hour < 18) {
        return '下午好';
      }
      return '晚上好';
    }

    // Apply personality modifiers
    message = this.applyPersonalityToText(message);

    return message;
  }

  // ── Mood-Driven Schedule Comment ───────────────────────────

  generateScheduleComment(taskCount: number): string | null {
    if (!this.shouldRespond()) {
      return null;
    }
    if (!this.shouldShowFullPersonality()) {
      return null;
    }

    const rng = seededRandom(timeSeed() + taskCount * 1000);
    const mood = this.state.mood;
    const pool = SCHEDULE_COMMENTS[mood];

    // Handle edge cases with mood-appropriate neutral responses
    if (taskCount === 0) {
      const noTaskMsgs: Record<BuddyMood, string> = {
        happy: '今天没有安排！自由自在的一天，想做点什么？',
        neutral: '今天没有安排。',
        encouraging: '今天没有待办事项，休息一下或者规划未来都不错 🌿',
        concerned: '今天没有安排，如果需要建议，我可以帮你想想今天做什么。',
      };
      return this.applyPersonalityToText(noTaskMsgs[mood]);
    }

    const template = pickWeighted(pool, rng);
    // Templates are either strings or functions (n: number) => string
    const message =
      typeof template === 'function' ? (template as (n: number) => string)(taskCount) : template;

    return this.applyPersonalityToText(message);
  }

  // ── Mood-Driven Completion Celebration ─────────────────────

  generateCompletionCelebration(): string | null {
    if (!this.shouldRespond()) {
      return null;
    }

    const rng = seededRandom(timeSeed() + 777);
    const mood = this.state.mood;
    const pool = CELEBRATIONS[mood];

    if (this.level === 'minimal') {
      // Minimal level: just acknowledge
      const minimalMsgs = ['已完成', '完成', '搞定', '好'];
      return pickWeighted(minimalMsgs, seededRandom(timeSeed() + 999));
    }

    const message = pickWeighted(pool, rng);
    return this.applyPersonalityToText(message);
  }

  // ── Mood Setter ────────────────────────────────────────────

  /** Set the buddy's current mood based on context. */
  setMood(mood: BuddyMood): void {
    this.state.mood = mood;
  }

  /** Automatically infer mood from task completion ratio and time of day. */
  inferMood(completedRatio: number, pendingCount: number, isLate: boolean): BuddyMood {
    if (isLate || pendingCount > 10) {
      return 'concerned';
    }
    if (completedRatio >= 0.8) {
      return 'happy';
    }
    if (completedRatio >= 0.5) {
      return 'encouraging';
    }
    if (completedRatio >= 0.3) {
      return 'neutral';
    }
    return 'concerned';
  }

  // ── Dream Integration ──────────────────────────────────────

  /**
   * Apply adjustments from dream analysis to mood and personality.
   * Called when a DreamAnalysisResult contains buddyAdjustments.
   */
  applyDreamInsights(adjustments: BuddyAdjustments): void {
    if (adjustments.encouragementFrequency !== undefined) {
      this.personality.encouragementFrequency = Math.max(
        0,
        Math.min(1, adjustments.encouragementFrequency)
      );
    }
    if (adjustments.severityTone !== undefined) {
      this.personality.severityTone = Math.max(0, Math.min(1, adjustments.severityTone));
    }
    if (adjustments.formality !== undefined) {
      this.personality.formality = Math.max(0, Math.min(1, adjustments.formality));
    }
    if (adjustments.brevity !== undefined) {
      this.personality.brevity = Math.max(0, Math.min(1, adjustments.brevity));
    }
    if (adjustments.moodBias !== undefined) {
      this.state.mood = adjustments.moodBias;
    }

    console.log(
      `[Buddy] Applied dream adjustments: freq=${this.personality.encouragementFrequency.toFixed(2)}, ` +
        `tone=${this.personality.severityTone.toFixed(2)}, ` +
        `formality=${this.personality.formality.toFixed(2)}, ` +
        `brevity=${this.personality.brevity.toFixed(2)}, ` +
        `mood=${this.state.mood}`
    );
  }

  // ── Personality Modifiers ──────────────────────────────────

  /**
   * Apply personality traits to a message.
   * - High formality: removes casual particles, emoji
   * - High brevity: truncates or uses shorter variants
   * - High severityTone: more direct language
   */
  private applyPersonalityToText(text: string): string {
    let result = text;

    // Formality: high formality removes emoji and casual markers
    if (this.personality.formality >= 0.7) {
      result = result
        .replace(
          /[\u{1F600}-\u{1F64F}\u{1F389}\u{2728}\u{1F4AA}\u{1F680}\u{1F31F}\u{1F4A5}\u{1F3AF}\u{1F44F}\u{1F44D}\u{1F49A}\u{1F33F}\u{1F331}\u{1F38A}\u{1F389}]/gu,
          ''
        ) // Strip emoji
        .replace(/[～~]+/g, '。')
        .replace(/！+/g, '。')
        .replace(/[？?]+/g, '。')
        .replace(/[。]{2,}/g, '。')
        .replace(/[。]+$/, '。');
    }

    // Brevity: short messages
    if (this.personality.brevity >= 0.7) {
      // Keep first sentence only
      const sentences = result.split(/[。！？\n]/).filter((s) => s.trim().length > 0);
      if (sentences.length > 0) {
        result = sentences[0].trim();
        if (result.length > 30) {
          result = result.slice(0, 28) + '…';
        }
      }
    } else if (this.personality.brevity >= 0.4) {
      // Moderate brevity: keep 2 sentences max
      const sentences = result.split(/[。！？\n]/).filter((s) => s.trim().length > 0);
      if (sentences.length > 2) {
        result = sentences.slice(0, 2).join('，') + '。';
      }
    }

    // Severity tone: more direct for high severity
    if (this.personality.severityTone >= 0.7) {
      result = result
        .replace(/[好棒真]厉害/g, '表现不错')
        .replace(/太棒了/g, '完成了')
        .replace(/超棒/g, '不错')
        .replace(/好棒/g, '好')
        .replace(/加油/g, '继续');
    }

    // Encouragement frequency: if low, don't add trailing encouragement
    if (this.personality.encouragementFrequency < 0.3) {
      result = result.replace(/[，,].*$/, '。');
    }

    return result;
  }

  // ── Interaction Recording ──────────────────────────────────

  recordInteraction(): void {
    this.state.lastInteraction = new Date();
  }
}

// ── Renderer ───────────────────────────────────────────────────

export class BuddyCliRenderer {
  render(message: string): string {
    const lines = ['  ╭─────────╮', '  │  ◕ ◡ ◕  │', '  ╰─────────╯', `  Buddy: ${message}`];
    return lines.join('\n');
  }
}
