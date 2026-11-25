import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import { readPdfInvoicePage, type PdfText } from "./pdf-invoice-text";

GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

export async function renderInvoicePdf(
  file: File,
  progress: (page: number, count: number) => void,
) {
  const data = new Uint8Array(await file.arrayBuffer());
  if (!new TextDecoder().decode(data.subarray(0, 1024)).includes("%PDF-"))
    throw new Error("Choose a valid PDF invoice.");
  const task = getDocument({
    data,
    useSystemFonts: true,
    maxImageSize: 20000000,
    enableXfa: false,
  });
  const files: File[] = [];
  const pages: ReturnType<typeof readPdfInvoicePage>[] = [];
  try {
    const pdf = await task.promise;
    if (!pdf.numPages || pdf.numPages > 20)
      throw new Error("Choose one invoice with up to 20 pages.");
    const filename = file.name.replace(/\.pdf$/i, "").slice(0, 200);
    for (let n = 1; n <= pdf.numPages; n++) {
      progress(n, pdf.numPages);
      const page = await pdf.getPage(n);
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: 2300 / Math.max(natural.width, natural.height),
      });
      const canvas = document.createElement("canvas");
      try {
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, viewport }).promise;
        const jpeg = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (blob) =>
              blob
                ? resolve(blob)
                : reject(new Error("Could not render PDF page.")),
            "image/jpeg",
            0.92,
          );
        });
        files.push(
          new File([jpeg], `${filename} - Page ${n}.jpg`, { type: jpeg.type }),
        );

        let extracted = null;
        if (page.rotate === 0) {
          const text = await page.getTextContent().catch(() => null);
          const words: PdfText[] = [];
          for (const item of text?.items || []) {
            if (!("str" in item) || !item.str.trim()) continue;
            const [x, y] = natural.convertToViewportPoint(
              item.transform[4]!,
              item.transform[5]!,
            );
            words.push({
              text: item.str.trim(),
              x: x! / natural.width,
              y: y! / natural.height,
            });
          }
          extracted = readPdfInvoicePage(words);
        }
        pages.push(extracted);
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
      }
    }
    if (files.reduce((size, page) => size + page.size, 0) > 60 * 1024 * 1024)
      throw new Error("Rendered pages exceed 60 MB. Export a smaller PDF.");
    return {
      files,
      pages: pages.every((page) => page !== null) ? pages : undefined,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException")
      throw new Error(
        "This PDF is password protected. Upload an unlocked copy.",
      );
    if (error instanceof Error && error.name === "InvalidPDFException")
      throw new Error(
        "This PDF could not be opened. Export it again and retry.",
      );
    throw error;
  } finally {
    await task.destroy().catch(() => {});
  }
}
