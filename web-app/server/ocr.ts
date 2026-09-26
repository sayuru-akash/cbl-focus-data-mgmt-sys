import sharp from "sharp";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { AppError } from "./store";
import type { OcrBlock } from "./supplier-parser";
let compilation: Promise<string> | undefined;
async function command(args: string[], timeout = 120000) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), timeout);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0) throw new Error(stderr || "Image processing timed out");
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}
async function visionBinary() {
  if (!compilation)
    compilation = (async () => {
      if (process.platform !== "darwin")
        throw new AppError(
          "Local photo processing requires the Mac OCR worker.",
          503,
        );
      const source = resolve(import.meta.dir, "ocr/recognize.swift");
      const hash = createHash("sha256")
        .update(await Bun.file(source).text())
        .digest("hex")
        .slice(0, 16);
      const folder = resolve(import.meta.dir, "../data/ocr-worker");
      await mkdir(folder, { recursive: true });
      const binary = join(folder, `vision-${hash}`);
      if (!(await Bun.file(binary).exists()))
        await command(["swiftc", source, "-o", binary]);
      return binary;
    })().catch((error) => {
      compilation = undefined;
      throw error;
    });
  return compilation;
}
export async function recognizePhoto(raw: Uint8Array, rotation?: number) {
  const dir = await mkdtemp(join(tmpdir(), "focus-invoice-"));
  try {
    const input = join(dir, "input.png"),
      normalized = await sharp(raw, { limitInputPixels: 40_000_000 })
        .autoOrient()
        .png()
        .toBuffer();
    await Bun.write(input, normalized);
    let angle = rotation;
    if (angle === undefined) {
      try {
        const osd = await command(
          ["tesseract", input, "stdout", "--psm", "0"],
          20000,
        );
        angle = Number(osd.match(/Rotate: (\d+)/)?.[1] || 0);
      } catch {
        angle = 0;
      }
    }
    const lossless = await sharp(normalized).rotate(angle).png().toBuffer();
    const preview = await sharp(lossless).jpeg({ quality: 95 }).toBuffer();
    const upright = join(dir, "upright.png");
    await Bun.write(upright, lossless);
    const binary = await visionBinary();
    const blocks = JSON.parse(await command([binary, upright])) as OcrBlock[];
    // Enlarge the small page-number line; full-page OCR often omits single digits.
    const label = blocks.find((b) => /^Page\s*:/i.test(b.text));
    if (label) {
      const meta = await sharp(preview).metadata();
      const left = Math.floor(label.x * meta.width!),
        top = Math.max(0, Math.floor((label.y - 0.01) * meta.height!));
      const width = meta.width! - left,
        height = Math.min(Math.ceil(0.05 * meta.height!), meta.height! - top);
      const crop = join(dir, "page-header.png");
      await sharp(lossless)
        .extract({ left, top, width, height })
        .resize({ width: width * 3 })
        .png()
        .toFile(crop);
      for (const args of [
        [binary, crop],
        [binary, crop, "fast"],
      ]) {
        const extra = JSON.parse(await command(args)) as OcrBlock[];
        for (const b of extra) {
          const mapped = {
            ...b,
            x: (left + b.x * width) / meta.width!,
            y: (top + b.y * height) / meta.height!,
            width: (b.width * width) / meta.width!,
            height: (b.height * height) / meta.height!,
          };
          if (
            Math.abs(mapped.y - label.y) < 0.012 &&
            /^(?:Page\s*:?\s*\d*|of|\d+)$/i.test(b.text)
          )
            blocks.push(mapped);
        }
      }
    }
    return { preview, blocks, rotation: angle };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "Could not read this photo. Use a clearer photo and try again.",
      422,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
