import { test, expect } from "bun:test";
import {
  extractedPage,
  parseExtractedPage,
  readVisionResponse,
} from "./ocr-vision";
const page = {
  supplier: "CBL FOODS",
  tin: "114309834",
  invoice: "TAX-123",
  document: "0030176",
  date: "2026-08-29",
  page: 2,
  count: 2,
  rotation: 270 as const,
  gross: 584319.24,
  discount: 4966.72,
  total: 579352.52,
  items: [
    {
      code: "CK010063",
      description: "SPONGE LAYER CAKE VANILLA 480GX6EA",
      weight: "480G",
      boxes: 3,
      sold: 3,
      unit: "MC",
      unitPrice: 4282.47,
      amount: 12847.41,
    },
  ],
};
test("vision extraction preserves invoice identity and source pricing without guessing MRP or approving", () => {
  const parsed = parseExtractedPage(extractedPage.parse(page), 1);
  expect(parsed.invoice).toBe("TAX-123");
  expect(parsed.fields.document).toBe("0030176");
  expect(parsed.fields.reviewed).toBe(false);
  expect(parsed.lines[0]!.packSize).toBe(6);
  expect(parsed.lines[0]!.sold).toBe(3);
  expect(parsed.lines[0]!.unitPrice).toBe(4282.47);
  expect(parsed.lines[0]!.mrp).toBeNull();
  expect(parsed.lines[0]!.reviewed).toBe(false);
  expect(parsed.lines[0]!.productId).toBe("");
});
test("vision extraction rejects missing rows and invalid amounts", () => {
  expect(() => extractedPage.parse({ ...page, items: [] })).toThrow();
  expect(() =>
    extractedPage.parse({ ...page, items: [{ ...page.items[0], sold: -1 }] }),
  ).toThrow();
  expect(() => extractedPage.parse({ ...page, total: Infinity })).toThrow();
  const parsed = parseExtractedPage(
    extractedPage.parse({
      ...page,
      items: [{ ...page.items[0], description: "SPONGE CAKE" }],
    }),
    1,
  );
  expect(parsed.lines[0]!.packSize).toBeNull();
});

test("daily AI quota errors are actionable and never become empty successful drafts", async () => {
  const response = Response.json(
    {
      success: false,
      errors: [
        {
          code: 4006,
          message:
            "AiError: you have used up your daily free allocation of 10,000 neurons",
        },
      ],
    },
    { status: 429 },
  );
  await expect(readVisionResponse(response)).rejects.toMatchObject({
    status: 429,
    message: expect.stringContaining("Daily scanning allowance used"),
  });
});

test("provider outages and unreadable responses have safe retry messages", async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    await expect(
      readVisionResponse(
        new Response("Provider diagnostic with private details", { status }),
      ),
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("photos are saved"),
    });
  }
  await expect(
    readVisionResponse(
      Response.json({ success: true, result: { response: "not JSON" } }),
    ),
  ).rejects.toMatchObject({ status: 422 });
  await expect(
    readVisionResponse(
      Response.json({
        success: true,
        result: {
          choices: [
            {
              finish_reason: "length",
              message: { content: JSON.stringify(page) },
            },
          ],
        },
      }),
    ),
  ).rejects.toMatchObject({ status: 422 });
  expect(
    await readVisionResponse(
      Response.json({
        success: true,
        result: {
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(page) },
            },
          ],
        },
      }),
    ),
  ).toEqual(page);
});
