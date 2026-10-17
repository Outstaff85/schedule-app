// shadcn/ui Data Table: the Table with TanStack Table (v9) under it — a tap on
// a column head sorts by it (again: the other way, a third time: unsorted);
// rows page by 10 with "Show more" (CLAUDE.md → Lists page by 10); the totals
// row (`footer`) always covers every item. On a phone a table becomes plates:
// `card` draws a row as a Plate, paged the same way (the old pages' table cards).
import * as React from 'react';
import { createSortedRowModel, rowSortingFeature, sortFn_alphanumeric, sortFn_basic, tableFeatures, useTable, type ColumnDef, type RowData } from '@tanstack/react-table';
import { IconArrowDown, IconArrowUp, IconChevronDown } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useIsPhone } from '@/hooks/use-phone';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PagedList } from '@/components/shared/paged-list';

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
});
type F = typeof features;
export type DataColumn<T extends RowData> = ColumnDef<F, T, any> & { meta?: { num?: boolean } }; // eslint-disable-line @typescript-eslint/no-explicit-any

const PAGE = 10;
const inControl = (e: React.MouseEvent) => !!(e.target as HTMLElement).closest('button, a, input, [data-no-tap]');

function DataTable<T extends RowData>({ columns, data, footer, card, empty, rowId, onRowOpen, onRowEdit, className, ...rest }: {
  columns: DataColumn<T>[];
  data: T[];
  /** the totals row: one cell per column (covers every row, not only the shown ones) */
  footer?: React.ReactNode[];
  /** on a phone each row is drawn by this (a Plate); without it the table stays */
  card?: (row: T, index: number) => React.ReactNode;
  empty?: React.ReactNode;
  rowId?: (row: T, index: number) => string;
  /** a tap on a row reads it (opens its card); a double click edits it — a control inside keeps its own job */
  onRowOpen?: (row: T) => void;
  onRowEdit?: (row: T) => void;
  className?: string;
} & Omit<React.ComponentProps<'div'>, 'children'>) {
  const phone = useIsPhone();
  const [shown, setShown] = React.useState(PAGE);
  const table = useTable<F, T>({ features, columns, data, getRowId: rowId });
  if (!data.length) return <>{empty ?? null}</>;
  if (phone && card) return <div data-slot="data-table" data-kind="cards" className={className} {...rest}><PagedList items={data} render={card} /></div>;
  const rows = table.getRowModel().rows;
  const left = rows.length - shown;
  return (
    <div data-slot="data-table" data-kind="table" className={className} {...rest}>
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map(g => (
            <TableRow key={g.id} className="hover:bg-transparent">
              {g.headers.map(h => {
                const num = !!(h.column.columnDef as DataColumn<T>).meta?.num, dir = h.column.getIsSorted();
                return (
                  <TableHead key={h.id} num={num} aria-sort={dir ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {h.isPlaceholder ? null : h.column.getCanSort() ? (
                      <button type="button" onClick={h.column.getToggleSortingHandler()} className={cn('inline-flex items-center gap-1 uppercase', num && 'flex-row-reverse')}>
                        <table.FlexRender header={h} />
                        {dir === 'asc' ? <IconArrowUp className="size-3" /> : dir === 'desc' ? <IconArrowDown className="size-3" /> : null}
                      </button>
                    ) : <table.FlexRender header={h} />}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.slice(0, shown).map(r => (
            <TableRow key={r.id} data-row-id={r.id}
              className={cn((onRowOpen || onRowEdit) && 'cursor-pointer')}
              onClick={onRowOpen ? e => { if (!inControl(e)) onRowOpen(r.original); } : undefined}
              onDoubleClick={onRowEdit ? e => { if (!inControl(e)) onRowEdit(r.original); } : undefined}>
              {r.getAllCells().map(c => (
                <TableCell key={c.id} num={!!(c.column.columnDef as DataColumn<T>).meta?.num}><table.FlexRender cell={c} /></TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
        {footer && (
          <TableFooter>
            <TableRow className="hover:bg-transparent">
              {footer.map((f, i) => <TableCell key={i} num={!!(columns[i] as DataColumn<T> | undefined)?.meta?.num}>{f}</TableCell>)}
            </TableRow>
          </TableFooter>
        )}
      </Table>
      {left > 0 && (
        <div className="flex justify-center py-1.5" data-slot="paged-more">
          <Button size="sm" onClick={() => setShown(s => s + PAGE)}><IconChevronDown className="size-4" />{tr('Show more ({0} left)', { 0: left })}</Button>
        </div>
      )}
    </div>
  );
}

export { DataTable };
