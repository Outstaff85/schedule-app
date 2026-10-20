// saveWorker() (docs/workers.md → Saving), moved from the page with the worker
// window (stage 6c-2). The window saves itself when it is closed by a tap
// outside (auto): an edit with nothing changed just closes; an empty name
// closes without saving (an edit says so, a new worker is not created). It
// reads the form, guards against a second record for the same document
// number, then updates the worker (rebuilding the Form 101 when a field
// printed on it changed or a signature was drawn) or adds the new one and
// builds its Form 101 while the window shows the progress. The page's data and
// uploads come through the bridge.
import { tr } from '@/lib/i18n';
import type { Child, DayShift, ManagerBridge, WorkerRecord } from './bridge';
import { commonFields, form101Changed, mergeIntoDuplicate, sameFields, workerDocId, type WorkerForm } from './worker';

export type EditorState = { values: WorkerForm; clientIds: string[]; children: Child[]; roster: DayShift[] | null; sig: string | null };

export async function saveWorker(api: ManagerBridge, o: {
  w: WorkerRecord; editId: string | null; docType: string; state: EditorState; auto: boolean;
  focusName: () => void; progress: (label: string, pct: number) => void;
}): Promise<void> {
  const { values, sig } = o.state;
  let editId = o.editId;
  const close = () => api.closeModal('workerOverlay');
  const name = (String(values.docGiven || '').trim() + ' ' + String(values.docSurname || '').trim()).trim();
  if (!name) {
    if (o.auto) {
      if (editId !== null) api.toast(tr('The name is empty — the changes were not saved'));
      close();
      return;
    }
    o.focusName();
    return;
  }
  const prev0 = editId !== null ? api.record(editId) : null;
  let fields = commonFields(values, {
    // Status is set on the worker card, not in this form; a new worker keeps the colour the page picked for it.
    status: prev0 ? prev0.status || 'active' : 'active',
    colorIdx: prev0 ? prev0.colorIdx || 0 : o.w.colorIdx || 0,
    children: o.state.children, clientIds: o.state.clientIds, docType: o.docType,
    roster: o.state.roster, prevSchedule: prev0 ? prev0.schedule || null : null,
  });
  const docId = String(fields.docId || '');
  // The HR field (owner / super-admin only): undefined keeps the worker's HR.
  const hrPicked = document.getElementById('wHrId') ? values.hrId || null : undefined;
  const hr = api.isHr();

  if (editId === null && docId) {
    const dup = api.findByDocId(docId);
    // An own-workers HR has only its own workers here: the server checks the whole firm (yes / no only).
    if (!dup && hr) {
      try { if (await api.docExistsInFirm(docId)) { alert(tr('A worker with this document number already exists in the firm.')); return; } } catch { /* offline: go on */ }
    }
    if (dup) {
      if (!confirm(tr('A worker with this document number already exists: {0}.\nOK — update that worker with the data entered here.\nCancel — go back and edit.', { 0: dup.name || '?' }))) return;
      fields = mergeIntoDuplicate(fields, dup.clientIds);
      editId = dup.id;
      // A live scan in this session → the Form 101 is built from the fresh images.
      if (api.liveScan()) api.setRescanned(dup.id);
    }
  }
  if (editId !== null && hr && docId) {
    const cur = api.record(editId);
    if (cur && docId !== workerDocId(cur)) {
      try { if (await api.docExistsInFirm(docId, editId)) { alert(tr('A worker with this document number already exists in the firm.')); return; } } catch { /* offline: go on */ }
    }
  }

  if (editId !== null) {
    const prev = api.record(editId);
    if (!prev) { close(); return; }
    const isId = prev.docType !== 'passport';
    // Closed with nothing changed: nothing to save.
    if (o.auto && sameFields(fields, prev) && !sig && (hrPicked === undefined || (prev.hrId || null) === hrPicked) && api.rescannedId() !== prev.id) { close(); return; }
    const changed = form101Changed(prev, { ...prev, ...fields });
    api.commitEdit(editId, fields, hrPicked);
    api.toast(tr('{0} updated!', { 0: name }));
    // A fresh rescan of this worker in this session: the PDF is rebuilt from the new photos.
    const justRescanned = api.rescannedId() === editId;
    api.setRescanned(null);
    if (justRescanned) {
      api.sendScanDocument(editId, fields); // the scan with what the user saved, for the field reader model (H8a)
      o.progress(tr('Building the PDF, please do not close…'), 0);
      await api.uploadForm101(isId, editId, sig ?? undefined);
      close();
      return;
    }
    close();
    // Otherwise from the stored pages (the scan in memory could be another worker's).
    // A worker with signed documents: they are never built again — a change waits for a new signing (docs/contracts.md).
    if ((changed || sig) && !prev.signedAt) {
      const id = editId;
      api.regenerateDoc(id, sig).then(ok => api.toast(ok ? tr("{0}'s document was updated", { 0: name }) : tr("Updating {0}'s document failed", { 0: name })));
    }
    return;
  }

  // A new worker: its token and createdAt (the Form 101 signature date), saved at once; the window
  // stays open with the progress until the Form 101 is built and uploaded.
  const rec: WorkerRecord = { id: api.newId(), ...fields, token: api.genToken(), createdAt: new Date().toISOString() } as WorkerRecord;
  api.addRecord(rec, hrPicked);
  if (api.liveScan()) api.sendScanDocument(rec.id, fields); // the scan with what the user saved, for the field reader model (H8a)
  api.toast(tr('{0} added!', { 0: name }));
  o.progress(tr('Building the PDF, please do not close…'), 0);
  await api.uploadForm101(rec.docType !== 'passport', rec.id, sig);
  close();
}
