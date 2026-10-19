// Security-rules tests for firestore.rules and storage.rules
// (docs/backend.md, docs/tests.md). Runs against the local emulators:
//   cd tests/rules && npm install && npm test
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, addDoc, query, where } from 'firebase/firestore';
import { ref, uploadString, getBytes, deleteObject } from 'firebase/storage';

let env;
const A = 'firmA', B = 'firmB';

// Identities as the `login` function will issue them (custom-token claims).
const who = {
  superadmin:   { uid: 'u-super',  claims: { role: 'superadmin', perms: ['*'] } },
  ownerA:       { uid: 'u-ownerA', claims: { role: 'tenant_admin', tenantId: A, perms: ['*'] } },
  ownerB:       { uid: 'u-ownerB', claims: { role: 'tenant_admin', tenantId: B, perms: ['*'] } },
  staffAll:     { uid: 'u-staffAll', claims: { role: 'staff', tenantId: A, perms: ['*'] } },
  staffSched:   { uid: 'u-staffSched', claims: { role: 'staff', tenantId: A, perms: ['schedule'] } },
  staffSchedAcc: { uid: 'u-staffSA', claims: { role: 'staff', tenantId: A, perms: ['schedule', 'accounting'] } },
  staffWorkers: { uid: 'u-staffWorkers', claims: { role: 'staff', tenantId: A, perms: ['workers'] } },
  staffNone:    { uid: 'u-staffNone', claims: { role: 'staff', tenantId: A, perms: [] } },
  clientA:      { uid: 'u-clientA', claims: { role: 'client', tenantId: A, clientId: 'c1', perms: [], hp: ['hours', 'approve', 'dispute', 'fix', 'schedule', 'export'] } },
  supplierA:    { uid: 'u-supA', claims: { role: 'supplier', tenantId: A, supplierId: 's1', perms: [] } },
  hrOwn:        { uid: 'u-hrOwn', claims: { role: 'hr', tenantId: A, perms: ['workers'], own: true } },
  hrOwnClients: { uid: 'u-hrOwnC', claims: { role: 'hr', tenantId: A, perms: ['workers', 'clients'], own: true } },
  hrAll:        { uid: 'u-hrAll', claims: { role: 'hr', tenantId: A, perms: ['workers'], own: false } },
  hrOwnPay:     { uid: 'u-hrOwn', claims: { role: 'hr', tenantId: A, perms: ['workers', 'accounting', 'payEdit'], own: true } },
  hrOwnB:       { uid: 'u-hrOwnB', claims: { role: 'hr', tenantId: B, perms: ['workers'], own: true } },
  // On a permission template: what they may change (claim ed).
  staffShifts:  { uid: 'u-stShifts', claims: { role: 'staff', tenantId: A, perms: ['schedule', 'workers'], ed: ['editSchedule'] } },
  staffRecords: { uid: 'u-stRec', claims: { role: 'staff', tenantId: A, perms: ['schedule', 'workers'], ed: ['editWorkers'] } },
  staffView:    { uid: 'u-stView', claims: { role: 'staff', tenantId: A, perms: ['schedule', 'workers'], ed: [] } },
  staffEdAll:   { uid: 'u-stEdAll', claims: { role: 'staff', tenantId: A, perms: ['schedule', 'workers'], ed: ['editSchedule', 'editWorkers', 'editPunches'] } },
  hrOwnView:    { uid: 'u-hrOwn', claims: { role: 'hr', tenantId: A, perms: ['workers'], own: true, ed: ['editWorkers'] } },
  // Signed in on the flat rights (claim rt): every check is one right of the list.
  flatWorkers:  { uid: 'u-fW', claims: { role: 'staff', tenantId: A, perms: [], rt: ['today', 'workers', 'editWorkers'] } },
  flatView:     { uid: 'u-fV', claims: { role: 'staff', tenantId: A, perms: ['schedule', 'workers'], rt: ['schedule', 'workers'] } },
  flatClients:  { uid: 'u-fC', claims: { role: 'staff', tenantId: A, perms: ['schedule'], rt: ['clients'] } },
  flatPay:      { uid: 'u-fP', claims: { role: 'staff', tenantId: A, perms: [], rt: ['workers', 'editWorkers', 'editPay', 'editPunches'] } },
  flatHrOwn:    { uid: 'u-hrOwn', claims: { role: 'hr', tenantId: A, perms: ['workers', 'payEdit'], own: true, rt: ['workers', 'editWorkers'] } },
  flatHrPay:    { uid: 'u-hrOwn', claims: { role: 'hr', tenantId: A, perms: [], own: true, rt: ['workers', 'editWorkers', 'editPay', 'suppliers'] } },
  // Signed in on the first flat rights (claim r): a staff login changes pay only with payEdit (Edit pay).
  staffFlatAcc: { uid: 'u-stFA', claims: { role: 'staff', tenantId: A, perms: ['today', 'schedule', 'accounting'], r: true } },
  staffFlatPay: { uid: 'u-stFP', claims: { role: 'staff', tenantId: A, perms: ['today', 'schedule', 'accounting', 'payEdit'], r: true } },
};
const db = name => (name === 'anon' ? env.unauthenticatedContext() : env.authenticatedContext(who[name].uid, who[name].claims)).firestore();
const st = name => (name === 'anon' ? env.unauthenticatedContext() : env.authenticatedContext(who[name].uid, who[name].claims)).storage();

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-schedule',
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
    storage: { rules: readFileSync(new URL('../../storage.rules', import.meta.url), 'utf8') },
  });
});
after(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const d = ctx.firestore();
    for (const t of [A, B]) {
      await setDoc(doc(d, 'tenants', t), { companyName: 'Firm ' + t, active: true, phone: '050' });
      await setDoc(doc(d, 'tenants', t, 'workers', 'w1'), { name: 'Worker', hourlyRate: 40, supplierId: 's1' });
      await setDoc(doc(d, 'tenants', t, 'clients', 'c1'), { name: 'Client', billRate: 60 });
      await setDoc(doc(d, 'tenants', t, 'suppliers', 's1'), { name: 'Agency' });
      await setDoc(doc(d, 'tenants', t, 'punches', 'p1'), { workerId: 'w1', type: 'in', ts: new Date() });
      await setDoc(doc(d, 'tenants', t, 'pendingHours', 'b1'), { status: 'pending', createdBy: 'x', rows: [] });
      // w2 belongs to the own-workers hr of firm A, w3 to another hr.
      await setDoc(doc(d, 'tenants', t, 'workers', 'w2'), { name: 'Mine', hourlyRate: 40, hrId: 'u-hrOwn' });
      await setDoc(doc(d, 'tenants', t, 'workers', 'w3'), { name: 'Other', hourlyRate: 40, hrId: 'u-other' });
      await setDoc(doc(d, 'tenants', t, 'punches', 'p2'), { workerId: 'w2', type: 'in', ts: new Date(), hrId: 'u-hrOwn' });
      await setDoc(doc(d, 'tenants', t, 'pendingHours', 'bh'), { status: 'pending', createdBy: 'u-hrOwn', rows: [] });
    }
    await setDoc(doc(d, 'users', 'u-ownerA'), { username: 'ownera', tenantId: A, role: 'tenant_admin' });
    await setDoc(doc(d, 'users', 'u-staffAll'), { username: 'staff', tenantId: A, role: 'staff' });
    await setDoc(doc(d, 'users', 'u-ownerB'), { username: 'ownerb', tenantId: B, role: 'tenant_admin' });
    await setDoc(doc(d, 'authSecrets', 'u-ownerA'), { passwordHash: 'h', passwordSalt: 's' });
    await setDoc(doc(d, 'workerTokens', 'tok1'), { tenantId: A, workerId: 'w1' });
    await setDoc(doc(d, 'usernames', 'ownera'), { uid: 'u-ownerA' });
    await setDoc(doc(d, 'errors', 'e1'), { message: 'x' });
  });
});

// ── Firm isolation ───────────────────────────────────────────────────────────
test('a firm reads only its own data; superadmin reads every firm', async () => {
  for (const sub of ['workers', 'clients', 'suppliers', 'punches', 'pendingHours']) {
    await assertSucceeds(getDocs(collection(db('ownerA'), 'tenants', A, sub)));
    await assertFails(getDocs(collection(db('ownerA'), 'tenants', B, sub)));
    await assertSucceeds(getDocs(collection(db('superadmin'), 'tenants', B, sub)));
  }
  await assertSucceeds(getDoc(doc(db('ownerA'), 'tenants', A)));
  await assertFails(getDoc(doc(db('ownerA'), 'tenants', B)));
});

test('a firm cannot write into another firm', async () => {
  await assertFails(setDoc(doc(db('ownerA'), 'tenants', B, 'workers', 'x'), { name: 'n' }));
  await assertFails(setDoc(doc(db('ownerA'), 'tenants', B, 'punches', 'x'), { type: 'in' }));
  await assertFails(deleteDoc(doc(db('ownerA'), 'tenants', B, 'punches', 'p1')));
});

test('not signed in: nothing at all', async () => {
  await assertFails(getDoc(doc(db('anon'), 'tenants', A)));
  await assertFails(getDocs(collection(db('anon'), 'tenants', A, 'workers')));
  await assertFails(addDoc(collection(db('anon'), 'errors'), { message: 'x' }));
});

// ── Roles inside a firm ──────────────────────────────────────────────────────
test('workers/clients/suppliers: tenant_admin and staff with "schedule" write, other staff only read', async () => {
  for (const sub of ['workers', 'clients', 'suppliers', 'settings']) {
    await assertSucceeds(setDoc(doc(db('ownerA'), 'tenants', A, sub, 'n1'), { name: 'a' }));
    await assertSucceeds(setDoc(doc(db('staffSched'), 'tenants', A, sub, 'n2'), { name: 'b' }));
    await assertSucceeds(setDoc(doc(db('staffAll'), 'tenants', A, sub, 'n3'), { name: 'c' }));
    await assertFails(setDoc(doc(db('staffWorkers'), 'tenants', A, sub, 'n4'), { name: 'd' }));
    await assertFails(setDoc(doc(db('staffNone'), 'tenants', A, sub, 'n5'), { name: 'e' }));
    await assertSucceeds(getDocs(collection(db('staffNone'), 'tenants', A, sub)));
  }
});

test('suppliers: only the owner or a superadmin sets the commission; staff keep it', async () => {
  const com = [{ from: '2026-10-01', mode: 'hour', rate: 7 }];
  await assertSucceeds(setDoc(doc(db('ownerA'), 'tenants', A, 'suppliers', 'sc1'), { name: 'Agency', commission: com }));
  await assertSucceeds(setDoc(doc(db('superadmin'), 'tenants', A, 'suppliers', 'sc2'), { name: 'Agency 2', commission: com }));
  await assertFails(setDoc(doc(db('staffSched'), 'tenants', A, 'suppliers', 'sc3'), { name: 'New', commission: com }));
  await assertSucceeds(setDoc(doc(db('staffSched'), 'tenants', A, 'suppliers', 'sc3'), { name: 'New' }));
  await assertSucceeds(setDoc(doc(db('staffSched'), 'tenants', A, 'suppliers', 'sc1'), { name: 'Agency renamed', commission: com }));
  await assertFails(setDoc(doc(db('staffSched'), 'tenants', A, 'suppliers', 'sc1'), { name: 'Agency', commission: [{ from: '', mode: 'day', rate: 99 }] }));
  await assertFails(updateDoc(doc(db('staffAll'), 'tenants', A, 'suppliers', 'sc1'), { commission: [] }));
  await assertSucceeds(updateDoc(doc(db('ownerA'), 'tenants', A, 'suppliers', 'sc1'), { commission: [] }));
});

test('punches: any manager-side login of the firm reads and writes', async () => {
  for (const r of ['ownerA', 'staffNone', 'staffAll', 'superadmin']) {
    await assertSucceeds(setDoc(doc(db(r), 'tenants', A, 'punches', 'p-' + r), { workerId: 'w1', type: 'in', ts: new Date() }));
    await assertSucceeds(updateDoc(doc(db(r), 'tenants', A, 'punches', 'p-' + r), { notes: 'edited' }));
    await assertSucceeds(deleteDoc(doc(db(r), 'tenants', A, 'punches', 'p-' + r)));
  }
});

test('client: no direct read or write anywhere, even with every tick (portal goes through a function)', async () => {
  for (const sub of ['workers', 'clients', 'suppliers', 'punches', 'pendingHours', 'settings', 'hourApprovals']) {
    await assertFails(getDocs(collection(db('clientA'), 'tenants', A, sub)));
    await assertFails(setDoc(doc(db('clientA'), 'tenants', A, sub, 'x'), { a: 1 }));
  }
  await assertFails(getDoc(doc(db('clientA'), 'tenants', A)));
});

test('hourApprovals: managers read, nobody writes directly', async () => {
  await assertSucceeds(getDocs(collection(db('ownerA'), 'tenants', A, 'hourApprovals')));
  await assertSucceeds(getDocs(collection(db('staffNone'), 'tenants', A, 'hourApprovals')));
  await assertFails(setDoc(doc(db('ownerA'), 'tenants', A, 'hourApprovals', 'client_c1_2026-10'), { status: 'approved' }));
});

test('supplier: no direct read or write anywhere (portal goes through functions)', async () => {
  for (const sub of ['workers', 'clients', 'suppliers', 'punches', 'pendingHours', 'settings']) {
    await assertFails(getDocs(collection(db('supplierA'), 'tenants', A, sub)));
    await assertFails(setDoc(doc(db('supplierA'), 'tenants', A, sub, 'x'), { a: 1 }));
  }
  await assertFails(getDoc(doc(db('supplierA'), 'tenants', A)));
  await assertFails(getDoc(doc(db('supplierA'), 'tenants', A, 'workers', 'w1')));
});

test('pending hours: staff submits as pending, only owner/superadmin approve', async () => {
  const mine = { status: 'pending', createdBy: 'u-staffNone', rows: [] };
  await assertSucceeds(setDoc(doc(db('staffNone'), 'tenants', A, 'pendingHours', 'b2'), mine));
  await assertFails(setDoc(doc(db('staffNone'), 'tenants', A, 'pendingHours', 'b3'), { ...mine, status: 'approved' }));
  await assertFails(setDoc(doc(db('staffNone'), 'tenants', A, 'pendingHours', 'b4'), { ...mine, createdBy: 'someone-else' }));
  await assertFails(updateDoc(doc(db('staffNone'), 'tenants', A, 'pendingHours', 'b2'), { status: 'approved' }));
  await assertFails(updateDoc(doc(db('staffAll'), 'tenants', A, 'pendingHours', 'b1'), { status: 'approved' }));
  await assertSucceeds(updateDoc(doc(db('ownerA'), 'tenants', A, 'pendingHours', 'b1'), { status: 'approved' }));
  await assertSucceeds(updateDoc(doc(db('superadmin'), 'tenants', A, 'pendingHours', 'b2'), { status: 'rejected' }));
  await assertFails(setDoc(doc(db('supplierA'), 'tenants', A, 'pendingHours', 'b5'), { ...mine, createdBy: 'u-supA' }));
});

test('firm profile: owner edits profile fields only; activation and creation are superadmin', async () => {
  await assertSucceeds(updateDoc(doc(db('ownerA'), 'tenants', A), { phone: '0501234567', city: 'חולון' }));
  await assertFails(updateDoc(doc(db('ownerA'), 'tenants', A), { active: false }));
  await assertFails(updateDoc(doc(db('ownerA'), 'tenants', A), { phone: '1', workerCount: 99 }));
  await assertFails(updateDoc(doc(db('staffAll'), 'tenants', A), { phone: '1' }));
  await assertFails(updateDoc(doc(db('ownerA'), 'tenants', B), { phone: '1' }));
  await assertFails(setDoc(doc(db('ownerA'), 'tenants', 'newFirm'), { companyName: 'x' }));
  await assertSucceeds(updateDoc(doc(db('superadmin'), 'tenants', A), { active: false }));
  await assertSucceeds(setDoc(doc(db('superadmin'), 'tenants', 'newFirm'), { companyName: 'x' }));
  await assertSucceeds(deleteDoc(doc(db('superadmin'), 'tenants', 'newFirm')));
  await assertFails(deleteDoc(doc(db('ownerA'), 'tenants', A)));
});

// ── Function-only collections ────────────────────────────────────────────────
test('users: own profile, owner sees own firm, superadmin all; nobody writes', async () => {
  await assertSucceeds(getDoc(doc(db('staffAll'), 'users', 'u-staffAll')));
  await assertFails(getDoc(doc(db('staffAll'), 'users', 'u-ownerA')));
  await assertSucceeds(getDoc(doc(db('ownerA'), 'users', 'u-staffAll')));
  await assertFails(getDoc(doc(db('ownerA'), 'users', 'u-ownerB')));
  await assertSucceeds(getDoc(doc(db('superadmin'), 'users', 'u-ownerB')));
  await assertFails(setDoc(doc(db('superadmin'), 'users', 'u-new'), { role: 'superadmin' }));
  await assertFails(updateDoc(doc(db('staffAll'), 'users', 'u-staffAll'), { role: 'tenant_admin' }));
});

test('password hashes, usernames and punch-link tokens: unreachable for everyone, superadmin included', async () => {
  for (const r of ['superadmin', 'ownerA', 'staffAll', 'supplierA', 'anon']) {
    await assertFails(getDoc(doc(db(r), 'authSecrets', 'u-ownerA')));
    await assertFails(getDoc(doc(db(r), 'workerTokens', 'tok1')));
    await assertFails(setDoc(doc(db(r), 'workerTokens', 'tok2'), { tenantId: A }));
    await assertFails(getDoc(doc(db(r), 'usernames', 'ownera')));
    await assertFails(setDoc(doc(db(r), 'usernames', 'grab'), { uid: 'x' }));
  }
});

test('the weather cache: written and read by the weather function only', async () => {
  for (const r of ['superadmin', 'ownerA', 'staffAll', 'supplierA', 'anon']) {
    await assertFails(getDoc(doc(db(r), 'weatherCache', '32.0_34.8')));
    await assertFails(setDoc(doc(db(r), 'weatherCache', '32.0_34.8'), { kind: 'clear', temp: 20 }));
  }
});

test('the permission templates: read and written by the users_admin function only', async () => {
  for (const r of ['superadmin', 'ownerA', 'staffAll', 'supplierA', 'anon']) {
    await assertFails(getDoc(doc(db(r), 'permTemplates', 'hr')));
    await assertFails(setDoc(doc(db(r), 'permTemplates', 'hr'), { name: 'HR', role: 'hr' }));
  }
});

test('telemetry: any signed-in caller appends, only superadmin reads and deletes (Reset)', async () => {
  await assertSucceeds(addDoc(collection(db('staffNone'), 'errors'), { message: 'x' }));
  await assertSucceeds(addDoc(collection(db('supplierA'), 'timings'), { kind: 'open' }));
  await assertFails(getDoc(doc(db('ownerA'), 'errors', 'e1')));
  await assertSucceeds(getDoc(doc(db('superadmin'), 'errors', 'e1')));
  await assertFails(deleteDoc(doc(db('ownerA'), 'errors', 'e1')));
  await assertSucceeds(deleteDoc(doc(db('superadmin'), 'errors', 'e1')));
});

// ── HR ───────────────────────────────────────────────────────────────────────
test('hr own-workers: reads and writes only workers with its hrId, never reassigns', async () => {
  const h = db('hrOwn');
  const mine = query(collection(h, 'tenants', A, 'workers'), where('hrId', '==', 'u-hrOwn'));
  await assertSucceeds(getDocs(mine));
  await assertFails(getDocs(collection(h, 'tenants', A, 'workers')));
  await assertSucceeds(getDoc(doc(h, 'tenants', A, 'workers', 'w2')));
  await assertFails(getDoc(doc(h, 'tenants', A, 'workers', 'w3')));
  await assertFails(getDoc(doc(h, 'tenants', A, 'workers', 'w1')));
  await assertSucceeds(updateDoc(doc(h, 'tenants', A, 'workers', 'w2'), { phone: '052' }));
  await assertFails(updateDoc(doc(h, 'tenants', A, 'workers', 'w2'), { hrId: 'u-other' }));
  await assertFails(updateDoc(doc(h, 'tenants', A, 'workers', 'w3'), { hourlyRate: 45 }));
  await assertFails(updateDoc(doc(h, 'tenants', A, 'workers', 'w1'), { hrId: 'u-hrOwn' }));
  await assertSucceeds(setDoc(doc(h, 'tenants', A, 'workers', 'n1'), { name: 'New', hrId: 'u-hrOwn' }));
  await assertFails(setDoc(doc(h, 'tenants', A, 'workers', 'n2'), { name: 'New' }));
  await assertFails(setDoc(doc(h, 'tenants', A, 'workers', 'n3'), { name: 'New', hrId: 'u-other' }));
  await assertFails(deleteDoc(doc(h, 'tenants', A, 'workers', 'w3')));
  await assertSucceeds(deleteDoc(doc(h, 'tenants', A, 'workers', 'w2')));
  // Another firm: nothing, even a worker carrying the same uid.
  await assertFails(getDoc(doc(h, 'tenants', B, 'workers', 'w2')));
  await assertFails(setDoc(doc(h, 'tenants', B, 'workers', 'n4'), { name: 'x', hrId: 'u-hrOwn' }));
  await assertFails(getDoc(doc(db('hrOwnB'), 'tenants', A, 'workers', 'w2')));
});

test('a worker\'s pay and bank: hr only with payEdit (own workers), staff only with Edit pay (accounting before the flat rights)', async () => {
  const h = db('hrOwn');
  for (const f of [{ hourlyRate: 45 }, { regRate: 45 }, { otRate: 60 }, { shabbatRate: 70 }, { payMode: 'daily' },
    { travelAllowance: 20 }, { travelMonthly: 150 }, { bank: 'X' }, { bankBranch: '1' }, { bankAccountNumber: '9' },
    { clientRates: { c1: { rate: 50 } } }, { dayOverrides: { all: 3 } }]) {
    await assertFails(updateDoc(doc(h, 'tenants', A, 'workers', 'w2'), f));
  }
  // the whole document written back unchanged (how the app saves) still passes
  await assertSucceeds(setDoc(doc(h, 'tenants', A, 'workers', 'w2'), { name: 'Mine 2', hourlyRate: 40, hrId: 'u-hrOwn' }));
  await assertFails(setDoc(doc(h, 'tenants', A, 'workers', 'n1'), { name: 'New', hrId: 'u-hrOwn', hourlyRate: 50 }));
  await assertSucceeds(setDoc(doc(h, 'tenants', A, 'workers', 'n2'), { name: 'New', hrId: 'u-hrOwn', hourlyRate: 0, bank: '' }));
  const hp = db('hrOwnPay');
  await assertSucceeds(updateDoc(doc(hp, 'tenants', A, 'workers', 'w2'), { hourlyRate: 52, bank: 'Discount', bankAccountNumber: '777', travelMonthly: 150 }));
  await assertSucceeds(setDoc(doc(hp, 'tenants', A, 'workers', 'n3'), { name: 'New', hrId: 'u-hrOwn', hourlyRate: 50 }));
  await assertFails(updateDoc(doc(hp, 'tenants', A, 'workers', 'w3'), { hourlyRate: 52 }));
  // the owner always; staff only with accounting
  await assertSucceeds(updateDoc(doc(db('ownerA'), 'tenants', A, 'workers', 'w3'), { bank: 'Y' }));
  await assertSucceeds(updateDoc(doc(db('staffAll'), 'tenants', A, 'workers', 'w3'), { hourlyRate: 42 }));
  await assertSucceeds(updateDoc(doc(db('staffSchedAcc'), 'tenants', A, 'workers', 'w3'), { travelMonthly: 100 }));
  for (const f of [{ hourlyRate: 41 }, { bank: 'Z' }, { payMode: 'daily' }, { travelAllowance: 5 }]) {
    await assertFails(updateDoc(doc(db('staffSched'), 'tenants', A, 'workers', 'w3'), f));
  }
  await assertSucceeds(updateDoc(doc(db('staffSched'), 'tenants', A, 'workers', 'w3'), { phone: '053' }));
  await assertSucceeds(setDoc(doc(db('staffSched'), 'tenants', A, 'workers', 'w3'), { name: 'Other 2', hourlyRate: 42, hrId: 'u-other', travelMonthly: 100, bank: 'Y' }));
  await assertFails(setDoc(doc(db('staffSched'), 'tenants', A, 'workers', 'n9'), { name: 'New', hourlyRate: 30 }));
  await assertSucceeds(setDoc(doc(db('staffSched'), 'tenants', A, 'workers', 'n9'), { name: 'New' }));
  // only the owner assigns a worker to an hr
  await assertFails(updateDoc(doc(db('staffSched'), 'tenants', A, 'workers', 'w3'), { hrId: 'u-hrOwn' }));
  await assertFails(setDoc(doc(db('staffSched'), 'tenants', A, 'workers', 'n10'), { name: 'New', hrId: 'u-hrOwn' }));
  await assertSucceeds(updateDoc(doc(db('ownerA'), 'tenants', A, 'workers', 'w3'), { hrId: 'u-hrOwn' }));
  // on the flat rights: Accounting alone no longer changes pay, Edit pay does
  await assertFails(updateDoc(doc(db('staffFlatAcc'), 'tenants', A, 'workers', 'w3'), { hourlyRate: 43 }));
  await assertFails(setDoc(doc(db('staffFlatAcc'), 'tenants', A, 'workers', 'n8'), { name: 'New', hourlyRate: 30 }));
  await assertSucceeds(updateDoc(doc(db('staffFlatAcc'), 'tenants', A, 'workers', 'w3'), { phone: '054' }));
  await assertSucceeds(updateDoc(doc(db('staffFlatPay'), 'tenants', A, 'workers', 'w3'), { hourlyRate: 43 }));
});

test('hr own-workers: punches and pending hours of its own workers only', async () => {
  const h = db('hrOwn');
  await assertSucceeds(getDocs(query(collection(h, 'tenants', A, 'punches'), where('hrId', '==', 'u-hrOwn'))));
  await assertFails(getDocs(collection(h, 'tenants', A, 'punches')));
  await assertFails(getDoc(doc(h, 'tenants', A, 'punches', 'p1')));
  await assertSucceeds(addDoc(collection(h, 'tenants', A, 'punches'), { workerId: 'w2', type: 'out', hrId: 'u-hrOwn' }));
  await assertFails(addDoc(collection(h, 'tenants', A, 'punches'), { workerId: 'w1', type: 'out' }));
  await assertSucceeds(updateDoc(doc(h, 'tenants', A, 'punches', 'p2'), { type: 'out' }));
  await assertFails(updateDoc(doc(h, 'tenants', A, 'punches', 'p2'), { hrId: 'u-other' }));
  await assertFails(deleteDoc(doc(h, 'tenants', A, 'punches', 'p1')));
  await assertSucceeds(deleteDoc(doc(h, 'tenants', A, 'punches', 'p2')));

  await assertSucceeds(getDocs(query(collection(h, 'tenants', A, 'pendingHours'), where('createdBy', '==', 'u-hrOwn'))));
  await assertFails(getDocs(collection(h, 'tenants', A, 'pendingHours')));
  await assertSucceeds(setDoc(doc(h, 'tenants', A, 'pendingHours', 'b9'), { status: 'pending', createdBy: 'u-hrOwn', rows: [] }));
  await assertFails(setDoc(doc(h, 'tenants', A, 'pendingHours', 'b8'), { status: 'approved', createdBy: 'u-hrOwn', rows: [] }));
  await assertFails(updateDoc(doc(h, 'tenants', A, 'pendingHours', 'bh'), { status: 'approved' }));
});

test('hr: shared clients/suppliers readable, written only with that section; firm doc readable', async () => {
  await assertSucceeds(getDoc(doc(db('hrOwn'), 'tenants', A)));
  await assertFails(updateDoc(doc(db('hrOwn'), 'tenants', A), { phone: '1' }));
  await assertSucceeds(getDocs(collection(db('hrOwn'), 'tenants', A, 'clients')));
  await assertSucceeds(getDocs(collection(db('hrOwn'), 'tenants', A, 'suppliers')));
  await assertSucceeds(getDocs(collection(db('hrOwn'), 'tenants', A, 'settings')));
  await assertFails(setDoc(doc(db('hrOwn'), 'tenants', A, 'clients', 'c9'), { name: 'x' }));
  await assertSucceeds(setDoc(doc(db('hrOwnClients'), 'tenants', A, 'clients', 'c9'), { name: 'x' }));
  await assertFails(setDoc(doc(db('hrOwnClients'), 'tenants', A, 'suppliers', 's9'), { name: 'x' }));
  await assertFails(setDoc(doc(db('hrOwn'), 'tenants', A, 'settings', 'x'), { a: 1 }));
  await assertFails(getDocs(collection(db('hrOwn'), 'tenants', B, 'clients')));
  await assertFails(getDoc(doc(db('hrOwn'), 'users', 'u-ownerA')));
});

test('hr without own-workers: sees the whole firm like staff, still never reassigns', async () => {
  const h = db('hrAll');
  for (const sub of ['workers', 'punches', 'pendingHours', 'clients']) {
    await assertSucceeds(getDocs(collection(h, 'tenants', A, sub)));
    await assertFails(getDocs(collection(h, 'tenants', B, sub)));
  }
  await assertSucceeds(updateDoc(doc(h, 'tenants', A, 'workers', 'w3'), { phone: '052' }));
  await assertFails(updateDoc(doc(h, 'tenants', A, 'workers', 'w3'), { hourlyRate: 50 }));
  await assertFails(updateDoc(doc(h, 'tenants', A, 'workers', 'w3'), { hrId: 'u-hrAll' }));
  await assertSucceeds(setDoc(doc(h, 'tenants', A, 'workers', 'n1'), { name: 'New' }));
  await assertSucceeds(setDoc(doc(h, 'tenants', A, 'workers', 'n2'), { name: 'New', hrId: 'u-hrAll' }));
  await assertFails(setDoc(doc(h, 'tenants', A, 'workers', 'n3'), { name: 'New', hrId: 'u-other' }));
  await assertSucceeds(deleteDoc(doc(h, 'tenants', A, 'workers', 'w1')));
  await assertFails(updateDoc(doc(h, 'tenants', A, 'pendingHours', 'b1'), { status: 'approved' }));
});

test('owner assigns workers to an hr and stamps punches', async () => {
  await assertSucceeds(updateDoc(doc(db('ownerA'), 'tenants', A, 'workers', 'w1'), { hrId: 'u-hrOwn' }));
  await assertSucceeds(updateDoc(doc(db('ownerA'), 'tenants', A, 'punches', 'p1'), { hrId: 'u-hrOwn' }));
  await assertSucceeds(getDoc(doc(db('hrOwn'), 'tenants', A, 'workers', 'w1')));
  await assertSucceeds(getDoc(doc(db('hrOwn'), 'tenants', A, 'punches', 'p1')));
});

// ── Storage ──────────────────────────────────────────────────────────────────
test('storage: firm files readable by its managers, written by owner/workers staff, isolated by firm', async () => {
  const pA = 'tenants/' + A + '/workers/w1/form101.pdf';
  await assertSucceeds(uploadString(ref(st('ownerA'), pA), 'pdf-bytes'));
  await assertSucceeds(getBytes(ref(st('staffNone'), pA)));
  await assertSucceeds(uploadString(ref(st('staffWorkers'), 'tenants/' + A + '/workers/w1/visa.jpg'), 'img'));
  await assertFails(uploadString(ref(st('staffSched'), 'tenants/' + A + '/workers/w1/x.jpg'), 'img'));
  await assertFails(uploadString(ref(st('staffNone'), 'tenants/' + A + '/workers/w1/y.jpg'), 'img'));
  await assertFails(getBytes(ref(st('ownerB'), pA)));
  await assertFails(uploadString(ref(st('ownerB'), pA), 'evil'));
  await assertFails(getBytes(ref(st('supplierA'), pA)));
  await assertFails(getBytes(ref(st('anon'), pA)));
  await assertSucceeds(getBytes(ref(st('superadmin'), pA)));
  await assertFails(uploadString(ref(st('ownerA'), 'elsewhere/file.txt'), 'x'));
  await assertFails(deleteObject(ref(st('staffNone'), pA)));
  await assertSucceeds(deleteObject(ref(st('ownerA'), pA)));
});

test('storage: a client\'s signed month PDF is server-only — managers read it, no browser login writes or deletes it', async () => {
  const pSigned = 'tenants/' + A + '/clients/c1/documents/hours-2026-10-signed.pdf';
  await env.withSecurityRulesDisabled(async ctx => { await uploadString(ref(ctx.storage(), pSigned), 'signed'); });
  await assertSucceeds(getBytes(ref(st('ownerA'), pSigned)));
  await assertFails(uploadString(ref(st('staffWorkers'), pSigned), 'forged'));
  await assertFails(uploadString(ref(st('ownerA'), pSigned), 'forged'));
  await assertFails(uploadString(ref(st('hrAll'), pSigned), 'forged'));
  await assertFails(deleteObject(ref(st('staffWorkers'), pSigned)));
  await assertFails(deleteObject(ref(st('ownerA'), pSigned)));
});

test('storage: hr uploads with the workers section; an own-workers hr reads back only its stamped files, deletes via the function', async () => {
  const pA = 'tenants/' + A + '/workers/w2/form101.pdf';
  const mine = { customMetadata: { hrId: 'u-hrOwn' } };
  await assertFails(uploadString(ref(st('hrOwn'), pA), 'pdf'));
  await assertFails(uploadString(ref(st('hrOwn'), pA), 'pdf', 'raw', { customMetadata: { hrId: 'u-other' } }));
  await assertSucceeds(uploadString(ref(st('hrOwn'), pA), 'pdf', 'raw', mine));
  await assertSucceeds(getBytes(ref(st('hrOwn'), pA)));
  // another own-workers hr can't replace a file stamped by this one
  await assertFails(uploadString(ref(st('hrOwnClients'), pA), 'evil', 'raw', { customMetadata: { hrId: 'u-hrOwnC' } }));
  const pOther = 'tenants/' + A + '/workers/w3/form101.pdf';
  await assertSucceeds(uploadString(ref(st('ownerA'), pOther), 'pdf'));
  await assertFails(getBytes(ref(st('hrOwn'), pOther)));
  await assertFails(deleteObject(ref(st('hrOwn'), pA)));
  await assertSucceeds(getBytes(ref(st('hrAll'), pA)));
  await assertFails(uploadString(ref(st('hrOwnB'), pA), 'evil'));
  await assertSucceeds(deleteObject(ref(st('hrAll'), pA)));
});

test('notifReads: a manager-side login reads and writes only its own read list', async () => {
  const me = who.ownerA.uid, other = who.staffNone.uid;
  await assertSucceeds(setDoc(doc(db('ownerA'), 'notifReads', me), { ids: ['a', 'b'], at: 'x' }));
  await assertSucceeds(getDoc(doc(db('ownerA'), 'notifReads', me)));
  await assertFails(getDoc(doc(db('ownerA'), 'notifReads', other)));
  await assertFails(setDoc(doc(db('ownerA'), 'notifReads', other), { ids: [], at: 'x' }));
  await assertFails(setDoc(doc(db('ownerA'), 'notifReads', me), { ids: [], at: 'x', extra: 1 }));
  await assertFails(setDoc(doc(db('ownerA'), 'notifReads', me), { ids: Array.from({ length: 501 }, (_, i) => 'n' + i), at: 'x' }));
  await assertFails(getDoc(doc(db('anon'), 'notifReads', me)));
});

test('shiftRequests: the punch function writes; managers read; a schedule writer only confirms or declines a pending offer', async () => {
  const swap = { kind: 'swap', workerId: 'w1', date: '2026-11-02', start: '08:00', end: '16:00', toWorkerId: 'w3', status: 'pending' };
  await env.withSecurityRulesDisabled(async ctx => {
    const d = ctx.firestore();
    await setDoc(doc(d, 'tenants', A, 'shiftRequests', 's1'), swap);
    await setDoc(doc(d, 'tenants', A, 'shiftRequests', 's2'), { ...swap, workerId: 'w2', hrId: 'u-hrOwn' });
    await setDoc(doc(d, 'tenants', A, 'shiftRequests', 'u1'), { kind: 'unavailable', workerId: 'w1', date: '2026-11-03', status: 'active' });
  });
  const r = (who, id) => doc(db(who), 'tenants', A, 'shiftRequests', id);
  // Read: managers of the firm; an own-workers hr only its workers'; never a supplier, a client or another firm.
  for (const u of ['ownerA', 'staffNone', 'hrAll', 'superadmin']) await assertSucceeds(getDoc(r(u, 's1')));
  await assertSucceeds(getDoc(r('hrOwn', 's2')));
  await assertFails(getDoc(r('hrOwn', 's1')));
  for (const u of ['supplierA', 'clientA', 'ownerB', 'anon']) await assertFails(getDoc(r(u, 's1')));
  // Nobody creates or deletes one directly (the worker's link goes through the punch function).
  for (const u of ['ownerA', 'superadmin', 'staffSched']) {
    await assertFails(setDoc(r(u, 'new'), swap));
    await assertFails(deleteDoc(r(u, 'u1')));
  }
  // A decision: only status / decidedAt / decidedBy / decidedByUid (the decider's own uid), only on a pending offer, only confirmed or declined.
  const ok = u => ({ status: 'confirmed', decidedAt: 'now', decidedBy: 'me', decidedByUid: who[u].uid });
  await assertFails(updateDoc(r('staffNone', 's1'), ok('staffNone')));
  await assertFails(updateDoc(r('staffSched', 's1'), { ...ok('staffSched'), start: '06:00' }));
  await assertFails(updateDoc(r('staffSched', 's1'), { status: 'approved', decidedByUid: who.staffSched.uid }));
  await assertFails(updateDoc(r('staffSched', 's1'), { ...ok('staffSched'), decidedByUid: who.ownerA.uid }));  // someone else's uid
  await assertFails(updateDoc(r('staffSched', 's1'), { status: 'confirmed', decidedAt: 'now', decidedBy: 'me' }));  // no uid
  await assertFails(updateDoc(r('ownerA', 'u1'), { status: 'confirmed', decidedByUid: who.ownerA.uid }));
  await assertFails(updateDoc(r('hrOwn', 's2'), ok('hrOwn')));          // its worker, but no schedule section
  await assertSucceeds(updateDoc(r('staffSched', 's1'), ok('staffSched')));
  await assertFails(updateDoc(r('ownerA', 's1'), { status: 'declined', decidedByUid: who.ownerA.uid }));  // already decided
  await assertSucceeds(updateDoc(r('ownerA', 's2'), { status: 'declined', decidedAt: 'now', decidedByUid: who.ownerA.uid }));
  // Reassigning the worker's HR: the owner moves only hrId; nobody else, and nothing else on that path.
  await assertSucceeds(updateDoc(r('ownerA', 'u1'), { hrId: 'u-hrAll' }));
  await assertSucceeds(updateDoc(r('superadmin', 'u1'), { hrId: 'u-hrOwn' }));
  await assertFails(updateDoc(r('staffSched', 'u1'), { hrId: 'u-staffSched' }));
  await assertFails(updateDoc(r('hrOwn', 'u1'), { hrId: 'u-hrOwn2' }));
  await assertFails(updateDoc(r('ownerA', 'u1'), { hrId: 'u-hrAll', status: 'gone' }));
  await assertFails(updateDoc(r('ownerB', 'u1'), { hrId: 'x' }));
});

test('the edit ticks (claim ed): shifts, worker records and punches', async () => {
  const w = r => doc(db(r), 'tenants', A, 'workers', 'w1');
  const shifts = { name: 'Worker', hourlyRate: 40, supplierId: 's1', schedule: [{ type: 'work', start: '08:00', end: '16:00' }] };
  const phone = Object.assign({}, shifts, { phone: '0501' }); // the shifts below are those of the first write
  // Only Edit shifts: the shifts, nothing else; no new or deleted worker.
  await assertSucceeds(setDoc(w('staffShifts'), shifts));
  await assertFails(setDoc(w('staffShifts'), Object.assign({}, shifts, { phone: '0501' })));
  await assertFails(setDoc(doc(db('staffShifts'), 'tenants', A, 'workers', 'wn'), { name: 'New' }));
  await assertFails(deleteDoc(w('staffShifts')));
  // Only Edit workers: the record, not the shifts.
  await assertSucceeds(setDoc(w('staffRecords'), phone));
  await assertFails(setDoc(w('staffRecords'), Object.assign({}, phone, { schedule: [] })));
  await assertSucceeds(setDoc(doc(db('staffRecords'), 'tenants', A, 'workers', 'wn'), { name: 'New' }));
  // No edit tick: reads only.
  await assertSucceeds(getDoc(w('staffView')));
  await assertFails(setDoc(w('staffView'), phone));
  await assertFails(setDoc(w('staffView'), shifts));
  // All three, or no ed claim at all (a login made before the ticks): everything, as before.
  await assertSucceeds(setDoc(w('staffEdAll'), Object.assign({}, shifts, { phone: '1' })));
  await assertSucceeds(setDoc(w('staffAll'), Object.assign({}, shifts, { phone: '2' })));
  // Punches: written only with Edit punches.
  const p = r => doc(db(r), 'tenants', A, 'punches', 'p1');
  await assertSucceeds(getDoc(p('staffView')));
  await assertFails(updateDoc(p('staffView'), { notes: 'x' }));
  await assertFails(deleteDoc(p('staffRecords')));
  await assertFails(setDoc(doc(db('staffShifts'), 'tenants', A, 'punches', 'pn'), { workerId: 'w1', type: 'in' }));
  await assertSucceeds(updateDoc(p('staffEdAll'), { notes: 'y' }));
  await assertSucceeds(updateDoc(p('staffAll'), { notes: 'z' }));
  // An own-workers HR without Edit punches: reads its punch, can't change it.
  const hp = doc(db('hrOwnView'), 'tenants', A, 'punches', 'p2');
  await assertSucceeds(getDoc(hp));
  await assertFails(updateDoc(hp, { notes: 'x' }));
  await assertFails(deleteDoc(hp));
  await assertSucceeds(updateDoc(doc(db('hrOwn'), 'tenants', A, 'punches', 'p2'), { notes: 'ok' }));
});

test('the flat rights (claim rt): a tab and an edit right, never the old fields', async () => {
  // Workers + Edit workers, no Schedule section: edits its workers (not the pay), no clients
  const fw = db('flatWorkers');
  await assertSucceeds(updateDoc(doc(fw, 'tenants', A, 'workers', 'w1'), { phone: '051' }));
  await assertSucceeds(setDoc(doc(fw, 'tenants', A, 'workers', 'n1'), { name: 'New' }));
  await assertFails(updateDoc(doc(fw, 'tenants', A, 'workers', 'w1'), { hourlyRate: 45 }));
  await assertFails(updateDoc(doc(fw, 'tenants', A, 'clients', 'c1'), { name: 'X' }));
  await assertFails(updateDoc(doc(fw, 'tenants', A, 'workers', 'w1'), { schedule: [{ d: 1 }] }));
  await assertFails(updateDoc(doc(fw, 'tenants', A, 'punches', 'p1'), { type: 'out' }));
  // the old fields (perms schedule) give nothing once the token has the flat list
  const fv = db('flatView');
  await assertFails(updateDoc(doc(fv, 'tenants', A, 'workers', 'w1'), { phone: '052' }));
  await assertFails(updateDoc(doc(fv, 'tenants', A, 'clients', 'c1'), { name: 'X' }));
  await assertFails(deleteDoc(doc(fv, 'tenants', A, 'workers', 'w1')));
  // the Clients tab writes clients (and nothing of the workers)
  const fc = db('flatClients');
  await assertSucceeds(updateDoc(doc(fc, 'tenants', A, 'clients', 'c1'), { name: 'Y' }));
  await assertFails(updateDoc(doc(fc, 'tenants', A, 'suppliers', 's1'), { name: 'Y' }));
  await assertFails(updateDoc(doc(fc, 'tenants', A, 'workers', 'w1'), { phone: '053' }));
  // Edit pay changes the money; Edit / delete punches writes punches
  const fp = db('flatPay');
  await assertSucceeds(updateDoc(doc(fp, 'tenants', A, 'workers', 'w1'), { hourlyRate: 46, bank: 'Z' }));
  await assertSucceeds(updateDoc(doc(fp, 'tenants', A, 'punches', 'p1'), { type: 'out' }));
  // an own-workers HR: its own worker, the money only with Edit pay (its old payEdit field gives nothing)
  const fh = db('flatHrOwn');
  await assertSucceeds(updateDoc(doc(fh, 'tenants', A, 'workers', 'w2'), { phone: '054' }));
  await assertFails(updateDoc(doc(fh, 'tenants', A, 'workers', 'w2'), { hourlyRate: 47 }));
  await assertFails(updateDoc(doc(fh, 'tenants', A, 'workers', 'w3'), { phone: '054' }));
  await assertFails(updateDoc(doc(fh, 'tenants', A, 'suppliers', 's1'), { name: 'Q' }));
  const fhp = db('flatHrPay');
  await assertSucceeds(updateDoc(doc(fhp, 'tenants', A, 'workers', 'w2'), { hourlyRate: 48 }));
  await assertSucceeds(updateDoc(doc(fhp, 'tenants', A, 'suppliers', 's1'), { name: 'Q' }));
  // storage: a worker's files with Workers + Edit workers; the Workers tab alone only reads
  await assertSucceeds(uploadString(ref(st('flatWorkers'), `tenants/${A}/workers/w1/f.txt`), 'x'));
  await assertFails(uploadString(ref(st('flatView'), `tenants/${A}/workers/w1/g.txt`), 'x'));
});
