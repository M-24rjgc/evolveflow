// pdfjs-dist 的 legacy/build 路径没有 d.ts 入口，补最小声明（实际类型用我们 cast 的 PdfjsModule）。
declare module 'pdfjs-dist/legacy/build/pdf.js' {
  export interface PdfDocumentProxy {
    numPages: number;
    getPage(n: number): Promise<{
      getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
    }>;
  }
  export interface PDFDocumentLoadingTask {
    promise: Promise<PdfDocumentProxy>;
  }
  export function getDocument(params: { data: Uint8Array }): PDFDocumentLoadingTask;
}
declare module 'pdfjs-dist/build/pdf.js' {
  export interface PdfDocumentProxy {
    numPages: number;
    getPage(n: number): Promise<{
      getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
    }>;
  }
  export interface PDFDocumentLoadingTask {
    promise: Promise<PdfDocumentProxy>;
  }
  export function getDocument(params: { data: Uint8Array }): PDFDocumentLoadingTask;
}
