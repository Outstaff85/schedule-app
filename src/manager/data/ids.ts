// Ids the app makes on the device (from schedule-manager.html).
/** a record's id (a worker, client, supplier, punch…) */
export function uid(): string { return 'id' + Math.random().toString(36).slice(2, 9); }
/** a worker's punch-link token */
export function genToken(): string {
  return Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 6);
}
