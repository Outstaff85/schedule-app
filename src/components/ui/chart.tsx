// shadcn/ui Chart: Recharts inside a container that sizes it and hands each
// series its colour as a CSS variable (`--color-<key>`, from `config`), plus a
// tooltip in the glass menu look (written from the shadcn source; the registry
// is not reachable from the cloud sessions). Restyled to Odinson Glass: the
// grid and axes in the hairline / ink-2 tokens, the tooltip on `bg-popover`.
import * as React from 'react';
import * as RechartsPrimitive from 'recharts';
import { cn } from '@/lib/utils';

export type ChartConfig = Record<string, { label?: React.ReactNode; color?: string; icon?: React.ComponentType }>;

const ChartContext = React.createContext<{ config: ChartConfig } | null>(null);
function useChart() {
  const c = React.useContext(ChartContext);
  if (!c) throw new Error('useChart must be used within a <ChartContainer />');
  return c;
}

function ChartContainer({ id, className, children, config, ...props }: React.ComponentProps<'div'> & {
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children'];
}) {
  const uid = React.useId();
  const chartId = `chart-${id || uid.replace(/:/g, '')}`;
  const vars = Object.fromEntries(Object.entries(config).filter(([, v]) => v.color).map(([k, v]) => [`--color-${k}`, v.color])) as React.CSSProperties;
  return (
    <ChartContext.Provider value={{ config }}>
      <div data-slot="chart" data-chart={chartId} style={vars}
        className={cn(
          'flex aspect-video justify-center text-xs',
          '[&_.recharts-cartesian-axis-tick_text]:fill-[var(--ink-2)] [&_.recharts-cartesian-grid_line]:stroke-[var(--hairline)]',
          '[&_.recharts-rectangle.recharts-tooltip-cursor]:fill-white/5 [&_.recharts-layer]:outline-hidden [&_.recharts-surface]:outline-hidden',
          className,
        )} {...props}>
        <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

const ChartTooltip = RechartsPrimitive.Tooltip;

type TooltipItem = { dataKey?: string | number; name?: string | number; value?: number | string; color?: string; payload?: Record<string, unknown> };

/** The tooltip: the label (formatted), then a line per series — its colour, its label from `config`, its value (formatted). */
function ChartTooltipContent({ active, payload, label, labelFormatter, formatter, className, hideLabel }: {
  active?: boolean;
  payload?: TooltipItem[];
  label?: React.ReactNode;
  labelFormatter?: (label: React.ReactNode, payload: TooltipItem[]) => React.ReactNode;
  formatter?: (value: number | string, name: string) => React.ReactNode;
  className?: string;
  hideLabel?: boolean;
}) {
  const { config } = useChart();
  if (!active || !payload || !payload.length) return null;
  return (
    <div className={cn('og-glass-menu grid min-w-32 gap-1 rounded-[10px] border border-white/12 px-2.5 py-1.5 text-xs shadow-xl', className)}>
      {!hideLabel && <div className="font-medium text-ink">{labelFormatter ? labelFormatter(label, payload) : label}</div>}
      {payload.map((item, i) => {
        const key = String(item.dataKey || item.name || 'value'), cfg = config[key];
        return (
          <div key={i} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: item.color || `var(--color-${key})` }} />
            <span className="text-ink-2">{cfg?.label ?? item.name}</span>
            <span className="ml-auto font-mono font-medium tabular-nums text-ink">{formatter && item.value != null ? formatter(item.value, key) : item.value}</span>
          </div>
        );
      })}
    </div>
  );
}

export { ChartContainer, ChartTooltip, ChartTooltipContent, RechartsPrimitive as Recharts };
