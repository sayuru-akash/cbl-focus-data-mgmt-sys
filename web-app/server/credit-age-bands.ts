export const creditAgeBands = [
  { key: "today", label: "Today", min: 0, max: 0 },
  { key: "1-13", label: "1-13 days", min: 1, max: 13 },
  { key: "14-20", label: "14-20 days", min: 14, max: 20 },
  { key: "21-29", label: "21-29 days", min: 21, max: 29 },
  { key: "30+", label: "30+ days", min: 30, max: Infinity },
] as const;
