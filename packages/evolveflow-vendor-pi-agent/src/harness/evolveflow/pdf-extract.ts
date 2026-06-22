/**
 * PDF 文本抽取（经 pdfjs-dist）。
 *
 * 用于 read 工具的 PDF 支持：AI 能读 PDF 文档内容。
 * 懒加载 pdfjs-dist，避免无 PDF 操作时的开销。
 */

// pdfjs-dist 懒加载：第一次抽 PDF 时才 require。
let pdfjsModule: typeof import('pdfjs-dist') | null = null;
async function getPdfjs() {
  if (!pdfjsModule) {
    // 动态导入。失败时（包未安装）抛清晰错误。
    pdfjsModule = await import('pdfjs-dist');
  }
  return pdfjsModule;
}

/**
 * 抽取 PDF 全文文本。
 * @param filePath PDF 文件绝对路径
 * @returns 拼接的文本（每页之间空行分隔）
 */
export async function extractPdfText(filePath: string): Promise<string> {
  const pdfjs = await getPdfjs();
  // Node 环境用 fake worker（pdfjs 在 Node 下不自动加载 worker）
  // @ts-expect-error: legacy build flag for Node usage
  pdfjs.GlobalWorkerOptions.workerSrc = false;

  const fs = await import('node:fs/promises');
  const data = await fs.readFile(filePath);
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(data) });
  const pdf = await loadingTask.promise;

  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    pages.push(`--- 第 ${i} 页 ---\n${text}`);
  }

  try {
    await pdf.destroy();
  } catch {
    /* 忽略销毁错误 */
  }

  return pages.join('\n\n');
}
