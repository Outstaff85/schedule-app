// Security-rules tests for firestore.rules and storage.rules
// (FIRESTORE_PLAN.md stage 1). Runs against the local emulators:
//   cd tests/rules && npm install && npm test
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, addDoc } from 'firebase/firestore';
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
  staffWorkers: { uid: 'u-staffWorkers', claims: { role: 'staff', tenantId: A, perms: ['workers'] } },
  staffNone:    { uid: 'u-staffNone', claims: { role: 'staff', tenantId: A, perms: [] } },
  supplierA:    { uid: 'u-supA', claims: { role: 'supplier', tenantId: A, supplierId: 's1', perms: [] } },
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

test('punches: any manager-side login of the firm reads and writes', async () => {
  for (const r of ['ownerA', 'staffNone', 'staffAll', 'superadmin']) {
    await assertSucceeds(setDoc(doc(db(r), 'tenants', A, 'punches', 'p-' + r), { workerId: 'w1', type: 'in', ts: new Date() }));
    await assertSucceeds(updateDoc(doc(db(r), 'tenants', A, 'punches', 'p-' + r), { notes: 'edited' }));
    await assertSucceeds(deleteDoc(doc(db(r), 'tenants', A, 'punches', 'p-' + r)));
  }
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

test('telemetry: any signed-in caller appends, only superadmin reads', async () => {
  await assertSucceeds(addDoc(collection(db('staffNone'), 'errors'), { message: 'x' }));
  await assertSucceeds(addDoc(collection(db('supplierA'), 'timings'), { kind: 'open' }));
  await assertFails(getDoc(doc(db('ownerA'), 'errors', 'e1')));
  await assertSucceeds(getDoc(doc(db('superadmin'), 'errors', 'e1')));
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
