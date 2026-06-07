import * as fs from 'fs';
import * as path from 'path';

export interface ExportableDay {
  date: string;
  tasks: { title: string; status: string; start_time?: string; end_time?: string }[];
  events: { title: string; start_time: string; end_time: string }[];
}

export class ExportService {
  private exportsDir: string;

  constructor(dataDir: string) {
    this.exportsDir = path.join(dataDir, 'exports');
    if (!fs.existsSync(this.exportsDir)) {
      fs.mkdirSync(this.exportsDir, { recursive: true });
    }
  }

  /**
   * Export a day's schedule as a valid HTML5 document with proper charset and styling.
   */
  exportDayToHtml(day: ExportableDay): string {
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EvolveFlow - ${this.escapeHtml(day.date)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
    h1 { color: #4a6fa5; }
    h2 { color: #333; border-bottom: 1px solid #eee; padding-bottom: 4px; }
    .task { padding: 8px; margin: 4px 0; border-left: 3px solid #4a6fa5; background: #f8f9fa; }
    .task.completed { opacity: 0.6; text-decoration: line-through; }
    .event { padding: 8px; margin: 4px 0; border-left: 3px solid #3b82f6; background: #e8f0fe; }
    .time { color: #888; font-size: 12px; }
    .footer { margin-top: 24px; font-size: 12px; color: #999; border-top: 1px solid #eee; padding-top: 8px; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <h1>${this.escapeHtml(day.date)} - EvolveFlow 日程</h1>
  <h2>事件</h2>
  ${day.events.map((e) => `<div class="event"><strong>${this.escapeHtml(e.title)}</strong> <span class="time">${this.escapeHtml(e.start_time)} - ${this.escapeHtml(e.end_time)}</span></div>`).join('\n')}
  <h2>任务</h2>
  ${day.tasks.map((t) => `<div class="task ${t.status === 'completed' ? 'completed' : ''}"><strong>${this.escapeHtml(t.title)}</strong> ${t.start_time ? `<span class="time">${this.escapeHtml(t.start_time)} - ${this.escapeHtml(t.end_time ?? '')}</span>` : ''}</div>`).join('\n')}
  <div class="footer">导出时间: ${new Date().toISOString()}</div>
</body>
</html>`;

    const filePath = path.join(this.exportsDir, `schedule-${day.date}.html`);
    fs.writeFileSync(filePath, html, 'utf-8');
    return filePath;
  }

  /**
   * Export a day's schedule as a plain text file (.txt).
   * Replaces the previous broken text-as-PDF implementation.
   */
  exportDayToTxt(day: ExportableDay): string {
    const lines: string[] = [
      '========================================',
      `  EvolveFlow - 日程导出`,
      `  日期: ${day.date}`,
      '========================================',
      '',
      '--- 事件 ---',
    ];

    for (const event of day.events) {
      const start = event.start_time.length > 11 ? event.start_time.slice(11, 16) : event.start_time;
      const end = event.end_time.length > 11 ? event.end_time.slice(11, 16) : event.end_time;
      lines.push(`  ${start}-${end}  ${event.title}`);
    }

    lines.push('');
    lines.push('--- 任务 ---');

    for (const task of day.tasks) {
      const status = task.status === 'completed' ? '[x]' : '[ ]';
      let time = '';
      if (task.start_time) {
        const start = task.start_time.length > 11 ? task.start_time.slice(11, 16) : task.start_time;
        const end = task.end_time && task.end_time.length > 11 ? task.end_time.slice(11, 16) : '';
        time = end ? ` ${start}-${end}` : ` ${start}`;
      }
      lines.push(`  ${status} ${task.title}${time}`);
    }

    lines.push('');
    lines.push(`导出时间: ${new Date().toISOString()}`);
    lines.push('========================================');

    const filePath = path.join(this.exportsDir, `schedule-${day.date}.txt`);
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return filePath;
  }

  /**
   * Escape special HTML characters to prevent injection.
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
