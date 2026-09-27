import { test, expect } from "bun:test";
import {
  extractedPage,
  parseExtractedPage,
  readVisionResponse,
  readGeminiResponse,
  scanWithFallback,
} from "./ocr-vision";
import { AppError } from "./store";
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

test("backup runs once only for primary availability errors", async () => {
  let calls = 0;
  const backup = async () => {
    calls++;
    return page;
  };
  expect((await scanWithFallback(async () => page, backup)).provider).toBe(
    "cloudflare",
  );
  expect(calls).toBe(0);
  for (const status of [429, 503]) {
    expect(
      (
        await scanWithFallback(async () => {
          throw new AppError("Primary unavailable", status);
        }, backup)
      ).provider,
    ).toBe("gemini");
  }
  expect(calls).toBe(2);
  for (const error of [
    new AppError("Unclear image", 422),
    new Error("Invalid image"),
    new AppError("Invalid request", 400),
  ]) {
    await expect(
      scanWithFallback(async () => {
        throw error;
      }, backup),
    ).rejects.toBe(error);
  }
  expect(calls).toBe(2);
  const limited = new AppError("Primary limited", 429);
  await expect(
    scanWithFallback(async () => {
      throw limited;
    }),
  ).rejects.toBe(limited);
  await expect(
    scanWithFallback(
      async () => {
        throw limited;
      },
      async () => {
        throw new AppError("Backup limited", 429);
      },
    ),
  ).rejects.toMatchObject({ status: 429, message: "Backup limited" });
});

test("Gemini accepts only complete schema-valid data and hides provider details", async () => {
  const result = {
    candidates: [
      {
        finishReason: "STOP",
        content: {
          parts: [
            { thought: true, text: "private reasoning" },
            { text: JSON.stringify(page) },
          ],
        },
      },
    ],
  };
  expect(await readGeminiResponse(Response.json(result))).toEqual(page);
  const original = parseExtractedPage(
    await readGeminiResponse(Response.json(result)),
    0,
  );
  expect(original.lines[0]!.reviewed).toBe(false);
  expect(original.lines[0]!.mrp).toBeNull();
  for (const finishReason of ["MAX_TOKENS", "SAFETY", undefined]) {
    await expect(
      readGeminiResponse(
        Response.json({
          candidates: [{ ...result.candidates[0], finishReason }],
        }),
      ),
    ).rejects.toMatchObject({ status: 422 });
  }
  await expect(
    readGeminiResponse(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [{ text: JSON.stringify({ ...page, items: [] }) }],
            },
          },
        ],
      }),
    ),
  ).rejects.toMatchObject({ status: 422 });
  for (const status of [400, 401, 403, 404, 429, 500]) {
    try {
      await readGeminiResponse(
        Response.json(
          { error: { message: "SECRET_PROVIDER_DETAIL" } },
          { status },
        ),
      );
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).status).toBe(status === 429 ? 429 : 503);
      expect((error as Error).message).not.toContain("SECRET_PROVIDER_DETAIL");
    }
  }
});
