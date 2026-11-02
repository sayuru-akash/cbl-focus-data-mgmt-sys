import { expect, test } from "bun:test";
import { invoiceCosts } from "./intake-costs";
import type { IntakeDraft, IntakeLine } from "./supplier-parser";
test("purchase cost preview distributes discount cents exactly and separates packet cost from MRP", () => {
  const draft = {
    gross: 0.09,
    discount: 0.02,
    total: 0.07,
    lines: [0.03, 0.03, 0.03].map(
      (amount) => ({ amount, sold: 1, packSize: 1, mrp: 1 }) as IntakeLine,
    ),
  } as IntakeDraft;
  const costs = invoiceCosts(draft)!;
  expect(costs.map((c) => c.discountCents)).toEqual([1, 1, 0]);
  expect(costs.map((c) => c.costPrice)).toEqual([0.03, 0.03, 0.03]);
  expect(costs.map((c) => c.netCostPrice)).toEqual([0.02, 0.02, 0.03]);
  expect(costs.reduce((s, c) => s + Math.round(c.netAmount * 100), 0)).toBe(7);
  draft.total = 0.08;
  expect(invoiceCosts(draft)).toBeNull();
  draft.total = 0.07;
  draft.lines[0]!.packSize = null;
  expect(invoiceCosts(draft)![0]!.costPrice).toBeNull();
});
test("unit costs round half up before and after discount, including full discounts and fractional dozens", () => {
  const d = {
    gross: 10.01,
    discount: 1.01,
    total: 9,
    lines: [{ amount: 10.01, sold: 0.5, packSize: 12, mrp: null }],
  } as IntakeDraft;
  expect(invoiceCosts(d)![0]).toEqual({
    discountCents: 101,
    netAmount: 9,
    costPrice: 1.67,
    netCostPrice: 1.5,
  });
  d.gross = 0.01;
  d.discount = 0.01;
  d.total = 0;
  d.lines = [{ amount: 0.01, sold: 1, packSize: 2, mrp: 500 } as IntakeLine];
  expect(invoiceCosts(d)![0]).toEqual({
    discountCents: 1,
    netAmount: 0,
    costPrice: 0.01,
    netCostPrice: 0,
  });
});
