"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import type { VerticalCoordinatesGenerator } from "recharts/types/cartesian/CartesianGrid";
import { useTranslation } from "react-i18next";

import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { intlLocale } from "@/lib/locale";

export type AnalyticsChartPoint = { label: string; calls: number; messages: number; appointments: number; agentResponseSeconds: number };

export function AnalyticsOverviewChart({ data }: { data: AnalyticsChartPoint[] }) {
  const { t } = useTranslation("dashboard");
  const axis = useEvenDateAxis(data, OVERVIEW_RIGHT_MARGIN);

  return (
    <div ref={axis.measure}>
    <ChartContainer className="aspect-auto h-[300px] w-full" config={{ calls: { label: t("home.metrics.calls.title"), color: "var(--chart-2)" }, messages: { label: t("home.metrics.messages.title"), color: "var(--chart-1)" } }}>
      <AreaChart data={data} margin={{ left: 0, right: OVERVIEW_RIGHT_MARGIN, top: 8 }}>
        <defs>
          <linearGradient id="fillCalls" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="var(--color-calls)" stopOpacity={0.35} /><stop offset="95%" stopColor="var(--color-calls)" stopOpacity={0.06} /></linearGradient>
          <linearGradient id="fillMessages" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="var(--color-messages)" stopOpacity={0.3} /><stop offset="95%" stopColor="var(--color-messages)" stopOpacity={0.05} /></linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
        <XAxis axisLine={false} dataKey="label" fontSize={12} interval={0} stroke="#888888" tick={axis.tick} tickLine={false} />
        <YAxis axisLine={false} fontSize={12} stroke="#888888" tick={{ dx: 32 }} tickLine={false} width={0} />
        <Area activeDot={{ r: 6, stroke: "var(--background)", strokeWidth: 4, fill: "var(--color-calls)" }} dataKey="calls" dot={false} fill="url(#fillCalls)" stroke="var(--color-calls)" type="monotone" />
        <Area activeDot={{ r: 6, stroke: "var(--background)", strokeWidth: 4, fill: "var(--color-messages)" }} dataKey="messages" dot={false} fill="url(#fillMessages)" stroke="var(--color-messages)" type="monotone" />
        <ChartLegend content={<ChartLegendContent />} verticalAlign="bottom" />
      </AreaChart>
    </ChartContainer>
    </div>
  );
}

// Rough width of a 12px label character; a little generous so labels never touch.
const LABEL_CHARACTER_WIDTH = 7;
const LABEL_GAP = 12;
const OVERVIEW_RIGHT_MARGIN = 4;

function labelWidth(label: string): number {
  return label.length * LABEL_CHARACTER_WIDTH;
}

/** Measures the chart and picks which date labels (and grid lines) to draw so they never overlap. */
function useEvenDateAxis(data: AnalyticsChartPoint[], rightMargin: number) {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!element) return;
    observer.current = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.current.observe(element);
  }, []);
  const labels = useMemo(() => data.map((point) => point.label), [data]);
  const plotWidth = Math.max(0, width - rightMargin);
  const shown = useMemo(() => evenlySpacedTicks(labels, plotWidth), [labels, plotWidth]);
  const tick = useCallback((props: XAxisTickProps) => renderXAxisTick(props, shown, plotWidth), [shown, plotWidth]);
  const gridX: VerticalCoordinatesGenerator = useCallback(({ offset }) => {
    const count = labels.length;
    if (count < 2) return [offset.left];
    return [...shown].map((index) => offset.left + (index * offset.width) / (count - 1));
  }, [labels.length, shown]);
  return { measure, tick, gridX };
}

/** Indices of the labels to draw: every Nth point counted back from the newest, so spacing is even and the latest date is always labelled. */
export function evenlySpacedTicks(labels: string[], width: number): Set<number> {
  const count = labels.length;
  if (count === 0) return new Set();
  if (width <= 0 || count === 1) return new Set(labels.keys());
  const spacing = width / (count - 1);
  // Edge labels shift inward by up to half their width to stay visible, so leave room for that.
  const longest = Math.max(...labels.map(labelWidth));
  const step = Math.max(1, Math.ceil((longest * 1.5 + LABEL_GAP) / spacing));
  return new Set([...labels.keys()].filter((index) => (count - 1 - index) % step === 0));
}

type XAxisTickProps = { index: number; payload: { value: string }; x: number | string; y: number | string };

function renderXAxisTick({ index, payload, x, y }: XAxisTickProps, shown: Set<number>, plotWidth: number) {
  if (!shown.has(index)) return <g />;
  const half = labelWidth(payload.value) / 2;
  const pointX = typeof x === "number" ? x : Number(x);
  const xPosition = plotWidth > 0 ? Math.min(Math.max(pointX, half), plotWidth - half) : pointX;
  const yPosition = (typeof y === "number" ? y : Number(y)) + 16;
  return <text fill="#888888" fontSize={12} textAnchor="middle" x={xPosition} y={yPosition}>{payload.value}</text>;
}

export function AnalyticsMetricChart({ data, dataKey, label, formatValue }: { data: AnalyticsChartPoint[]; dataKey: keyof Omit<AnalyticsChartPoint, "label">; label: string; formatValue?: (value: number) => string }) {
  const { i18n } = useTranslation();
  const format = formatValue ?? ((value: number) => value.toLocaleString(intlLocale(i18n.language)));
  const axis = useEvenDateAxis(data, 0);
  return (
    <div ref={axis.measure}>
    <ChartContainer className="aspect-auto h-40 w-full" config={{ [dataKey]: { label, color: "var(--chart-1)" } }}>
      <LineChart accessibilityLayer data={data} margin={{ bottom: 8, left: 0, right: 0, top: 8 }}>
        <CartesianGrid horizontal={false} strokeDasharray="4 6" vertical verticalCoordinatesGenerator={axis.gridX} />
        <XAxis axisLine={false} dataKey="label" fontSize={12} height={28} interval={0} tick={axis.tick} tickLine={false} />
        <YAxis domain={[0, (maximum: number) => Math.max(maximum, 1)]} hide padding={{ bottom: 16, top: 8 }} />
        <ChartTooltip content={<ChartTooltipContent indicator="dot" formatter={(value) => <MetricTooltipRow label={label} value={format(Number(value))} />} />} cursor={false} />
        <Line dataKey={dataKey} dot={false} stroke={`var(--color-${dataKey})`} strokeWidth={2} type="natural" />
      </LineChart>
    </ChartContainer>
    </div>
  );
}

// Same layout as the default tooltip row, for values that need custom formatting.
function MetricTooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <div className="size-2.5 shrink-0 rounded-xs bg-(--color-bg)" style={{ "--color-bg": "var(--chart-1)" } as React.CSSProperties} />
      <div className="flex flex-1 items-center justify-between gap-4 leading-none">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-medium text-foreground tabular-nums">{value}</span>
      </div>
    </>
  );
}
