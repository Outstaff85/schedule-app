// SheetJS, loaded from the CDN on demand (lib/backend.ts → loadScript, XLSX_URL):
// only what the new pages call.
interface XlsxSheet { [cell: string]: unknown }
interface XlsxBook { SheetNames: string[]; Sheets: Record<string, XlsxSheet> }
declare const XLSX: {
  utils: {
    book_new(): XlsxBook;
    aoa_to_sheet(rows: unknown[][]): XlsxSheet;
    book_append_sheet(wb: XlsxBook, ws: XlsxSheet, name: string): void;
    sheet_to_json<T>(ws: XlsxSheet, opts: { header: 1; defval: unknown }): T[];
  };
  read(data: ArrayBuffer, opts: { type: 'array'; cellDates?: boolean }): XlsxBook;
  write(wb: XlsxBook, opts: { type: 'array'; bookType: 'xlsx' }): ArrayBuffer;
  writeFile(wb: XlsxBook, name: string): void;
};
