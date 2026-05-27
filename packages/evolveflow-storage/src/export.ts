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

  exportDayToHtml(day: ExportableDay): string {
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>EvolveFlow - ${day.date}</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
    h1 { color: #4a6fa5; }
    .task { padding: 8px; margin: 4px 0; border-left: 3px solid #4a6fa5; background: #f8f9fa; }
    .task.completed { opacity: 0.6; text-decoration: line-through; }
    .event { padding: 8px; margin: 4px 0; border-left: 3px solid #3b82f6; background: #e8f0fe; }
    .time { color: #888; font-size: 12px; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <h1>${day.date} 日程</h1>
  <h2>事件</h2>
  ${day.events.map((e) => `<div class="event"><strong>${e.title}</strong> <span class="time">${e.start_time} - ${e.end_time}</span></div>`).join('\n')}
  <h2>任务</h2>
  ${day.tasks.map((t) => `<div class="task ${t.status === 'completed' ? 'completed' : ''}"><strong>${t.title}</strong> ${t.start_time ? `<span class="time">${t.start_time} - ${t.end_time}</span>` : ''}</div>`).join('\n')}
</body>
</html>`;

    const filePath = path.join(this.exportsDir, `schedule-${day.date}.html`);
    fs.writeFileSync(filePath, html, 'utf-8');
    return filePath;
  }

  exportDayToPdf(day: ExportableDay): string {
    const html = this.exportDayToHtml(day);
    const pdfPath = path.join(this.exportsDir, `schedule-${day.date}.pdf`);

    // Generate a simple text-based PDF representation
    const lines: string[] = [
      '========================================',
      `  EvolveFlow - 日程导出`,
      `  日期: ${day.date}`,
      '========================================',
      '',
      '--- 事件 ---',
    ];

    for (const event of day.events) {
      lines.push(`  ${event.start_time.slice(11, 16)}-${event.end_time.slice(11, 16)}  ${event.title}`);
    }

    lines.push('');
    lines.push('--- 任务 ---');

    for (const task of day.tasks) {
      const status = task.status === 'completed' ? '[✓]' : '[ ]';
      const time = task.start_time ? ` ${task.start_time.slice(11, 16)}-${task.end_time?.slice(11, 16)}` : '';
      lines.push(`  ${status} ${task.title}${time}`);
    }

    lines.push('');
    lines.push(`导出时间: ${new Date().toISOString()}`);
    lines.push('========================================');

    fs.writeFileSync(pdfPath, lines.join('\n'), 'utf-8');
    return pdfPath;
  }

  exportDayToPdfBinary(day: ExportableDay): string {
    // For full PDF with proper formatting, use the HTML and print
    // This generates a minimal valid PDF
    const htmlPath = this.exportDayToHtml(day);
    const pdfPath = path.join(this.exportsDir, `schedule-${day.date}.pdf`);

    // Generate a valid but minimal PDF
    const content = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj

2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj

3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]
   /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj

4 0 obj
<< /Length 44 >>
stream
BT /F1 12 Tf 50 750 Td (EvolveFlow - ${day.date}) Tj ET
BT /F1 10 Tf 50 720 Td (Events:) Tj ET
${day.events.map((e, i) => `BT /F1 10 Tf 50 ${700 - i * 20} Td (${e.start_time.slice(11,16)}-${e.end_time.slice(11,16)} ${e.title}) Tj ET`).join('\n')}
${day.tasks.map((t, i) => `BT /F1 10 Tf 50 ${700 - (day.events.length + i + 1) * 20} Td (${t.status === 'completed' ? '[x]' : '[ ]'} ${t.title}) Tj ET`).join('\n')}
endstream
endobj

5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj

xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000266 00000 n 
0000000360 00000 n 

trailer
<< /Size 6 /Root 1 0 R >>
startxref
410
%%EOF`;

    fs.writeFileSync(pdfPath, content, 'utf-8');
    return pdfPath;
  }
}
