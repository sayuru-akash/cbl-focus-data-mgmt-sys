"use client";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { money } from "../features/Lists";
export default function FinanceChart({
  days,
}: {
  days: { date: string; net: number; discount: number; bills: number }[];
}) {
  const monthly = days.length > 62;
  const groups = new Map<string, { date: string; net: number }>();
  for (const day of days) {
    const date = monthly ? day.date.slice(0, 7) : day.date;
    const prev = groups.get(date)?.net || 0;
    groups.set(date, { date, net: Math.round((prev + day.net) * 100) / 100 });
  }
  return (
    <section className="finance-chart" aria-label="Net billed chart">
      <div className="finance-section-title">
        <h2>Net billed</h2>
        <span>{monthly ? "By month" : "By day"} · Rs</span>
      </div>
      {days.length ? (
        <ResponsiveContainer width="100%" height={220} minWidth={0}>
          <BarChart
            data={[...groups.values()]}
            accessibilityLayer
            margin={{ left: 0, right: 12, top: 12, bottom: 0 }}
          >
            <CartesianGrid vertical={false} stroke="#e9edf5" />
            <XAxis
              dataKey="date"
              tickFormatter={(v) =>
                monthly ? String(v).slice(2) : String(v).slice(5)
              }
              tickLine={false}
              axisLine={false}
              fontSize={11}
              minTickGap={28}
            />
            <YAxis
              tickFormatter={(v) =>
                new Intl.NumberFormat("en", { notation: "compact" }).format(v)
              }
              tickLine={false}
              axisLine={false}
              fontSize={11}
              width={52}
            />
            <Tooltip
              formatter={(value) => [money(Number(value)), "Net billed"]}
              cursor={{ fill: "#eef3ff" }}
              contentStyle={{ borderRadius: 12, border: "1px solid #e5eaf2" }}
            />
            <ReferenceLine y={0} stroke="#cdd7e7" />
            <Bar
              dataKey="net"
              fill="#3862e8"
              maxBarSize={42}
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div className="finance-chart-empty">No bills in this period</div>
      )}
    </section>
  );
}
