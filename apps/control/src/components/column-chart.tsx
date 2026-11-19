/**
 * One series of columns, such as call minutes per month: thin columns with
 * rounded tops on one baseline, hairline gridlines, the latest column and the
 * highest labelled, and each column's value in its tooltip and accessible
 * name. The table beside it holds every value.
 */

export type Column = { label: string; value: number; title: string };

/** A round top for the axis: 1, 2, 2.5 or 5 times a power of ten, at least the largest value. */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (value <= step * power) return step * power;
  return 10 * power;
}

// About the width of a panel on a desktop screen, so text and columns are drawn near their real size.
const WIDTH = 1200;
const HEIGHT = 240;
const LEFT = 52;
const RIGHT = 8;
const TOP = 20;
const BOTTOM = 28;
const RADIUS = 4;

/** A column rising from the baseline, square at the bottom and rounded at the top. */
function columnPath(x: number, width: number, top: number, bottom: number): string {
  const r = Math.min(RADIUS, width / 2, bottom - top);
  return `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${bottom}Z`;
}

export function ColumnChart({ title, columns, format }: { title: string; columns: Column[]; format: (value: number) => string }) {
  const max = niceMax(Math.max(0, ...columns.map((column) => column.value)));
  const plotWidth = WIDTH - LEFT - RIGHT;
  const plotHeight = HEIGHT - TOP - BOTTOM;
  const band = plotWidth / Math.max(1, columns.length);
  const columnWidth = Math.min(24, band * 0.6);
  const bottom = TOP + plotHeight;
  const y = (value: number) => bottom - (value / max) * plotHeight;
  const ticks = [0, max / 2, max];
  const highest = columns.reduce((best, column, index) => (column.value > (columns[best]?.value ?? -1) ? index : best), 0);
  const labelled = new Set([columns.length - 1, highest]);
  return (
    <svg className="chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${title}: ${columns.map((column) => column.title).join("; ")}`}>
      {ticks.map((tick) => (
        <g key={tick}>
          {tick > 0 ? <line className="gridline" x1={LEFT} x2={WIDTH - RIGHT} y1={y(tick)} y2={y(tick)} /> : null}
          <text className="tick" x={LEFT - 6} y={y(tick)} dy="0.32em" textAnchor="end">{format(tick)}</text>
        </g>
      ))}
      {columns.map((column, index) => {
        const x = LEFT + band * index + (band - columnWidth) / 2;
        const top = y(column.value);
        return (
          <g key={column.label} className="bar" tabIndex={0} aria-label={column.title}>
            <title>{column.title}</title>
            <rect className="hit" x={LEFT + band * index} y={TOP} width={band} height={plotHeight} />
            {column.value > 0 ? <path className="column" d={columnPath(x, columnWidth, top, bottom)} /> : null}
            {labelled.has(index) && column.value > 0 ? (
              <text className="label" x={x + columnWidth / 2} y={top - 5} textAnchor="middle">{format(column.value)}</text>
            ) : null}
            <text className="tick" x={x + columnWidth / 2} y={HEIGHT - 8} textAnchor="middle">{column.label}</text>
          </g>
        );
      })}
      <line className="baseline" x1={LEFT} x2={WIDTH - RIGHT} y1={bottom} y2={bottom} />
    </svg>
  );
}
