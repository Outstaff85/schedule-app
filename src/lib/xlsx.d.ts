// SheetJS, loaded from the CDN on demand (lib/backend.ts → loadScript, XLSX_URL):
// only what the new pages call.
interface XlsxSheet { [cell: string]: unknown }
interface XlsxBook { SheetNames: string[] }
declare const XLSX: {
  utils: {
    book_new(): XlsxBook;
    aoa_to_sheet(rows: unknown[][]): XlsxSheet;
    book_append_sheet(wb: XlsxBook, ws: XlsxSheet, name: string): void;
  };
  writeFile(wb: XlsxBook, name: string): void;
};
