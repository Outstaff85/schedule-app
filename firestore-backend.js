// GENERATED from src/lib/firestore-backend.ts by scripts/build-globals.mjs — never edit
// by hand: change the TypeScript and run `node scripts/build-globals.mjs`
// (npm run build fails while this file is stale). Defines the global
// initFirestoreBackend(), the browser data layer (docs/backend.md → Browser data layer).
(function() {
	//#region src/lib/firestore-backend.ts
	var FB_CDN = "https://www.gstatic.com/firebasejs/12.19.0/";
	var LOGIN_FN_URL = "https://europe-west3-schedule-odinson.cloudfunctions.net/login";
	var USERS_ADMIN_URL = "https://europe-west3-schedule-odinson.cloudfunctions.net/users_admin";
	var AI_FN_URL = "https://europe-west3-schedule-odinson.cloudfunctions.net/ai_read";
	var AI_ACTIONS = [
		"aiReadDoc",
		"aiReadSefach",
		"aiDetectAlign",
		"aiVerifyField",
		"aiVerifyFields",
		"aiReadHoursTable",
		"aiFindField"
	];
	var FUNCTION_ACTIONS = [
		"listTenants",
		"setTenantActive",
		"deleteTenant",
		"createUser",
		"updateTenant",
		"loadTenantProfile",
		"listUsers",
		"createTenantUser",
		"updateUser",
		"resetUserPassword",
		"deleteUser",
		"checkWorkerDoc",
		"updateMyName",
		"updateMyLanguage",
		"updateMyTheme"
	];
	var UPLOAD_ACTIONS = [
		"saveWorkerDoc",
		"saveWorkerAssets",
		"saveWorkerFile"
	];
	var STORAGE_FILE_ACTIONS = ["loadWorkerAssets", "deleteWorkerDoc"];
	var isStoragePath = (id) => typeof id === "string" && id.indexOf("tenants/") === 0;
	var PUNCH_MONTHS = 13;
	var BATCH_LIMIT = 450;
	var cdn = (file) => import(
		/* @vite-ignore */
		FB_CDN + file
);
	async function webConfig() {
		if (window.FIREBASE_WEB_CONFIG) return window.FIREBASE_WEB_CONFIG;
		const r = await fetch("/__/firebase/init.json");
		if (!r.ok) throw new Error("Firebase web config not found (HTTP " + r.status + ")");
		return r.json();
	}
	function plain(v) {
		return JSON.parse(JSON.stringify(v));
	}
	function docKeysOf(w) {
		const keys = [];
		[
			"docId",
			"passportNo",
			"israeliId"
		].forEach((f) => {
			const k = String(w && w[f] || "").toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");
			if (k && !keys.includes(k)) keys.push(k);
		});
		return keys;
	}
	function sig(v) {
		if (Array.isArray(v)) return "[" + v.map(sig).join(",") + "]";
		if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + sig(v[k])).join(",") + "}";
		return JSON.stringify(v);
	}
	function ddmmyyyyToDay(s) {
		const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || ""));
		return m ? m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0") : null;
	}
	async function initFirestoreBackend() {
		const [appMod, authMod, fsMod] = await Promise.all([
			cdn("firebase-app.js"),
			cdn("firebase-auth.js"),
			cdn("firebase-firestore.js")
		]);
		const app = appMod.initializeApp(await webConfig());
		const auth = authMod.getAuth(app);
		const db = fsMod.getFirestore(app);
		const F = fsMod;
		const emu = localStorage.getItem("fsEmulator");
		if (emu) {
			F.connectFirestoreEmulator(db, emu, 8080);
			authMod.connectAuthEmulator(auth, "http://" + emu + ":9099", { disableWarnings: true });
		}
		let stMod = null, storage = null, stLoading = null;
		function loadStorage() {
			return stLoading || (stLoading = cdn("firebase-storage.js").then((m) => {
				stMod = m;
				storage = m.getStorage(app);
				if (emu) m.connectStorageEmulator(storage, emu, 9199);
			}).catch((e) => {
				stLoading = null;
				throw e;
			}));
		}
		await auth.authStateReady();
		if (auth.currentUser) setTimeout(() => loadStorage().catch(() => {}), 4e3);
		const col = (t, name) => F.collection(db, "tenants", t, name);
		const emptyStore = () => ({
			workers: /* @__PURE__ */ new Map(),
			clients: /* @__PURE__ */ new Map(),
			suppliers: /* @__PURE__ */ new Map()
		});
		const known = emptyStore();
		let knownTenant = null;
		const workerHr = /* @__PURE__ */ new Map();
		let claimsFor = null, claims = {};
		async function myClaims() {
			const u = auth.currentUser;
			if (!u) return {};
			if (claimsFor !== u.uid) {
				claims = (await u.getIdTokenResult()).claims || {};
				claimsFor = u.uid;
			}
			return claims;
		}
		async function hrOnly() {
			const c = await myClaims();
			return c.role === "hr" && c.own === true ? auth.currentUser.uid : null;
		}
		async function mayWrite(kind) {
			const c = await myClaims();
			if (c.role !== "hr" || kind === "workers") return true;
			const p = Array.isArray(c.perms) ? c.perms : [];
			return p.includes("*") || p.includes(kind);
		}
		const hrWhere = (hr) => hr ? [F.where("hrId", "==", hr)] : [];
		async function login(username, password) {
			const res = await fetch(LOGIN_FN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					username,
					password
				})
			});
			let json;
			try {
				json = await res.json();
			} catch {
				return { error: "The login server returned an error (HTTP " + res.status + ")" };
			}
			if (!json || json.error) return json || { error: "Could not sign in" };
			await authMod.signInWithCustomToken(auth, json.token);
			return json;
		}
		const storedPos = /* @__PURE__ */ new Map();
		function listOf(snap, kind, store) {
			const map = store[kind];
			map.clear();
			if (kind === "workers" && store === known) storedPos.clear();
			const items = [];
			snap.forEach((d) => {
				const data = d.data();
				const pos = typeof data.sortIndex === "number" ? data.sortIndex : 1e9;
				delete data.sortIndex;
				if (data.id == null) data.id = d.id;
				map.set(d.id, sig(data) + "#" + pos);
				if (kind === "workers") delete data.docKeys;
				items.push({
					pos,
					data
				});
				if (kind === "workers" && store === known) storedPos.set(d.id, pos);
			});
			items.sort((a, b) => a.pos - b.pos || String(a.data.id).localeCompare(String(b.data.id)));
			return items.map((x) => x.data);
		}
		async function loadSchedule(t, track = true) {
			const hr = await hrOnly();
			const [w, c, s, set] = await Promise.all([
				F.getDocs(F.query(col(t, "workers"), ...hrWhere(hr))),
				F.getDocs(col(t, "clients")),
				F.getDocs(col(t, "suppliers")),
				F.getDoc(F.doc(db, "tenants", t, "settings", "schedule"))
			]);
			const settings = set.exists() ? set.data() : {};
			const keep = track ? known : emptyStore();
			const out = {
				workers: listOf(w, "workers", keep),
				clients: listOf(c, "clients", keep),
				suppliers: listOf(s, "suppliers", keep),
				weekStart: settings.weekStart || null,
				savedAt: settings.savedAt || null
			};
			if (track) {
				knownTenant = t;
				workerHr.clear();
				out.workers.forEach((x) => workerHr.set(String(x.id), x.hrId || null));
			}
			return out;
		}
		async function saveSchedule(t, data, first) {
			if (knownTenant !== t) await loadSchedule(t);
			const hrScoped = !!await hrOnly();
			const ops = [];
			const next = {};
			for (const kind of [
				"workers",
				"clients",
				"suppliers"
			]) {
				if (!await mayWrite(kind)) {
					next[kind] = known[kind];
					continue;
				}
				next[kind] = /* @__PURE__ */ new Map();
				(data[kind] || []).forEach((item, idx) => {
					if (!item || item.id == null) return;
					const id = String(item.id), body = plain(item);
					if (kind === "workers") body.docKeys = docKeysOf(body);
					let pos = idx;
					if (hrScoped && kind === "workers") {
						if (!storedPos.has(id)) storedPos.set(id, 1e6 + Date.now() % 1e6 + idx);
						pos = storedPos.get(id);
					}
					const s = sig(body) + "#" + pos;
					next[kind].set(id, s);
					if (known[kind].get(id) !== s) ops.push([
						"set",
						F.doc(db, "tenants", t, kind, id),
						Object.assign(body, { sortIndex: pos })
					]);
				});
				known[kind].forEach((_, id) => {
					if (!next[kind].has(id)) ops.push(["delete", F.doc(db, "tenants", t, kind, id)]);
				});
			}
			if (first) {
				const linked = new Set((first.ids || []).map(String));
				const isLinked = (op) => op[1].parent.id === "workers" && linked.has(op[1].id);
				ops.splice(0, ops.length, ...first.ops, ...ops.filter(isLinked), ...ops.filter((op) => !isLinked(op)));
			}
			for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
				const batch = F.writeBatch(db);
				ops.slice(i, i + BATCH_LIMIT).forEach((op) => op[0] === "set" ? batch.set(op[1], op[2]) : op[0] === "update" ? batch.update(op[1], op[2]) : batch.delete(op[1]));
				await batch.commit();
			}
			for (const kind in next) known[kind] = next[kind];
			workerHr.clear();
			(data.workers || []).forEach((x) => {
				if (x && x.id != null) workerHr.set(String(x.id), x.hrId || null);
			});
			return {
				ok: true,
				written: ops.length
			};
		}
		function punchFromDoc(d) {
			const x = d.data();
			const ts = x.ts && typeof x.ts.toDate === "function" ? x.ts.toDate().toISOString() : x.tsRaw || null;
			const e = Object.assign({}, x, { ts });
			delete e.day;
			delete e.archived;
			delete e.tsRaw;
			if (e.id == null) e.id = d.id;
			return e;
		}
		function punchDoc(entry, hrId) {
			const body = plain(entry);
			delete body.tenantId;
			const when = new Date(entry.ts || Date.now());
			body.ts = isNaN(when.getTime()) ? null : F.Timestamp.fromDate(when);
			body.day = ddmmyyyyToDay(entry.date);
			body.archived = false;
			const wid = String(entry.workerId);
			const hr = hrId !== void 0 ? hrId : workerHr.has(wid) ? workerHr.get(wid) : entry.hrId;
			if (hr) body.hrId = hr;
			else delete body.hrId;
			return body;
		}
		let workersUnsub = null;
		function listenWorkers(t, onChange) {
			if (workersUnsub) workersUnsub();
			return hrOnly().then((hr) => {
				const q = F.query(col(t, "workers"), ...hrWhere(hr));
				workersUnsub = F.onSnapshot(q, (snap) => {
					if (knownTenant !== t) return;
					const ids = new Set(snap.docs.map((d) => d.id));
					const added = [], changed = [];
					snap.docs.forEach((d) => {
						if (known.workers.has(d.id)) {
							if (d.metadata.hasPendingWrites) return;
							const data = d.data();
							const pos = typeof data.sortIndex === "number" ? data.sortIndex : 1e9;
							delete data.sortIndex;
							if (data.id == null) data.id = d.id;
							const before = known.workers.get(d.id), now = sig(data) + "#" + pos;
							if (before === now) return;
							const baseSig = before.slice(0, before.lastIndexOf("#"));
							known.workers.set(d.id, now);
							storedPos.set(d.id, pos);
							workerHr.set(String(data.id), data.hrId || null);
							delete data.docKeys;
							changed.push({
								data,
								unsaved: (item) => {
									const b = plain(item);
									b.docKeys = docKeysOf(b);
									return sig(b) !== baseSig;
								}
							});
							return;
						}
						const data = d.data();
						const pos = typeof data.sortIndex === "number" ? data.sortIndex : 1e9;
						delete data.sortIndex;
						if (data.id == null) data.id = d.id;
						known.workers.set(d.id, sig(data) + "#" + pos);
						storedPos.set(d.id, pos);
						delete data.docKeys;
						workerHr.set(String(data.id), data.hrId || null);
						added.push(data);
					});
					const removed = [...known.workers.keys()].filter((id) => !ids.has(id));
					removed.forEach((id) => {
						known.workers.delete(id);
						storedPos.delete(id);
						workerHr.delete(id);
					});
					if (added.length || removed.length || changed.length) onChange({
						added,
						removed,
						changed
					});
				}, (err) => console.warn("Worker listener stopped:", err));
			});
		}
		let hoursUnsub = null;
		function listenPendingHours(t, onChange) {
			if (hoursUnsub) hoursUnsub();
			return hrOnly().then((hr) => {
				const q = hr ? F.query(col(t, "pendingHours"), F.where("createdBy", "==", hr)) : col(t, "pendingHours");
				hoursUnsub = F.onSnapshot(q, (snap) => onChange(snap.docs.map(batchFromDoc)), (err) => console.warn("Hours listener stopped:", err));
			});
		}
		let punchUnsub = null;
		function listenPunches(t, onChange, since) {
			if (punchUnsub) punchUnsub();
			if (!since) {
				since = /* @__PURE__ */ new Date();
				since.setMonth(since.getMonth() - PUNCH_MONTHS);
				since.setDate(1);
				since.setHours(0, 0, 0, 0);
			}
			const from = since;
			return hrOnly().then((hr) => new Promise((resolve, reject) => {
				const q = F.query(col(t, "punches"), ...hrWhere(hr), F.where("ts", ">=", F.Timestamp.fromDate(from)));
				let first = true;
				punchUnsub = F.onSnapshot(q, (snap) => {
					const entries = snap.docs.map(punchFromDoc);
					if (first) {
						first = false;
						resolve(entries);
					} else onChange(entries);
				}, (err) => {
					if (first) {
						first = false;
						reject(err);
					} else console.warn("Punch listener stopped:", err);
				});
			}));
		}
		async function punchesBetween(t, from, to) {
			return (await F.getDocs(F.query(col(t, "punches"), ...hrWhere(await hrOnly()), F.where("ts", ">=", F.Timestamp.fromDate(from)), F.where("ts", "<", F.Timestamp.fromDate(to))))).docs.map(punchFromDoc);
		}
		async function punchesOfBatch(t, batchId) {
			const pre = "imp-" + batchId + "-";
			return (await F.getDocs(F.query(col(t, "punches"), ...hrWhere(await hrOnly()), F.where(F.documentId(), ">=", pre), F.where(F.documentId(), "<", pre + "")))).docs.map(punchFromDoc);
		}
		async function savePunch(t, entry) {
			await F.setDoc(F.doc(db, "tenants", t, "punches", String(entry.id)), punchDoc(entry));
			return {
				ok: true,
				id: entry.id
			};
		}
		async function updatePunch(t, data) {
			const upd = { editedAt: (/* @__PURE__ */ new Date()).toISOString() };
			[
				"type",
				"time",
				"site",
				"notes",
				"clientId"
			].forEach((k) => {
				if (data[k] !== void 0) upd[k] = k === "clientId" ? data[k] || null : data[k];
			});
			await F.updateDoc(F.doc(db, "tenants", t, "punches", String(data.id)), upd);
			return { ok: true };
		}
		async function deletePunch(t, id) {
			await F.deleteDoc(F.doc(db, "tenants", t, "punches", String(id)));
			return { ok: true };
		}
		async function callUsersAdmin(params, url = USERS_ADMIN_URL) {
			const idToken = await auth.currentUser.getIdToken();
			const res = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer " + idToken
				},
				body: JSON.stringify(Object.assign({}, params, {
					token: void 0,
					secret: void 0
				}))
			});
			try {
				return await res.json();
			} catch {
				return { error: "The server returned an error (HTTP " + res.status + ")" };
			}
		}
		async function writeTelemetry(params) {
			const items = params.action === "logBatch" ? (params.items || []).slice(0, 60) : [Object.assign({ type: params.action === "logTiming" ? "timing" : "error" }, params)];
			const clip = (v, n) => String(v == null ? "" : v).slice(0, n);
			const when = (/* @__PURE__ */ new Date()).toISOString();
			const batch = F.writeBatch(db);
			items.forEach((d) => {
				if (d.type === "timing") batch.set(F.doc(F.collection(db, "timings")), {
					when,
					kind: clip(d.kind, 40),
					totalMs: Math.max(0, Math.round(Number(d.totalMs) || 0)),
					tenantId: clip(d.tenantId, 80),
					user: clip(d.user, 80),
					role: clip(d.role, 40),
					details: plain(d.details || {})
				});
				else batch.set(F.doc(F.collection(db, "errors")), {
					when,
					page: clip(d.page, 200),
					role: clip(d.role, 40),
					worker: clip(d.worker, 80),
					message: clip(d.message, 500),
					source: clip(d.source, 300),
					stack: clip(d.stack, 1200)
				});
			});
			await batch.commit();
			return { ok: true };
		}
		const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
		async function readLog(name, max, from, to) {
			const parts = [F.collection(db, name)];
			if (ISO_RE.test(String(from || ""))) parts.push(F.where("when", ">=", from));
			if (ISO_RE.test(String(to || ""))) parts.push(F.where("when", "<", to));
			parts.push(F.orderBy("when", "desc"), F.limit(max));
			return { rows: (await F.getDocs(F.query(...parts))).docs.map((d) => d.data()) };
		}
		async function resetLogs() {
			const out = {
				errors: 0,
				timings: 0
			};
			for (const name of ["errors", "timings"]) for (;;) {
				const snap = await F.getDocs(F.query(F.collection(db, name), F.limit(400)));
				if (snap.empty) break;
				const batch = F.writeBatch(db);
				snap.docs.forEach((d) => batch.delete(d.ref));
				await batch.commit();
				out[name] += snap.size;
			}
			return Object.assign({ ok: true }, out);
		}
		async function deletePunchesByMonths(t, ctx, months) {
			if (ctx.role !== "tenant_admin" && ctx.role !== "superadmin") return { error: "Only the firm owner or super-admin can delete punch records" };
			const list0 = (months || []).filter((m) => /^\d{4}-\d{2}$/.test(String(m)));
			if (!list0.length) return { error: "No months selected" };
			const refs = /* @__PURE__ */ new Map();
			for (const m of list0) {
				const [y, mo] = m.split("-").map(Number);
				(await F.getDocs(F.query(col(t, "punches"), F.where("day", ">=", m + "-01"), F.where("day", "<=", m + "-31")))).forEach((d) => refs.set(d.id, d.ref));
				(await F.getDocs(F.query(col(t, "punches"), F.where("ts", ">=", F.Timestamp.fromDate(new Date(y, mo - 1, 1))), F.where("ts", "<", F.Timestamp.fromDate(new Date(y, mo, 1)))))).forEach((d) => {
					if (!d.data().day) refs.set(d.id, d.ref);
				});
			}
			const list = [...refs.values()];
			for (let i = 0; i < list.length; i += BATCH_LIMIT) {
				const batch = F.writeBatch(db);
				list.slice(i, i + BATCH_LIMIT).forEach((r) => batch.delete(r));
				await batch.commit();
			}
			return {
				ok: true,
				deleted: list.length
			};
		}
		async function savePendingHours(t, ctx, params) {
			if (ctx.role === "supplier") return { error: "Not available for the supplier role" };
			const entries = Array.isArray(params.entries) ? params.entries : [];
			if (!entries.length) return { error: "No recognized shifts to upload" };
			const ref = F.doc(col(t, "pendingHours"));
			const rows = entries.map((e) => ({
				rowId: crypto.randomUUID(),
				workerId: e.workerId || "",
				clientId: e.clientId || null,
				date: e.date || "",
				inTime: e.inTime || "",
				outTime: e.outTime || ""
			}));
			await F.setDoc(ref, {
				status: "pending",
				fileName: params.fileName || "",
				uploadedBy: ctx.username || "",
				createdBy: auth.currentUser.uid,
				uploadedAt: (/* @__PURE__ */ new Date()).toISOString(),
				createdAt: F.Timestamp.now(),
				rows
			});
			return {
				ok: true,
				batchId: ref.id,
				count: rows.length
			};
		}
		async function loadPendingHours(t, ctx) {
			if (ctx.role === "supplier") return { error: "Not available for the supplier role" };
			const hr = await hrOnly();
			return { batches: (await F.getDocs(hr ? F.query(col(t, "pendingHours"), F.where("createdBy", "==", hr)) : col(t, "pendingHours"))).docs.map(batchFromDoc) };
		}
		function batchFromDoc(d) {
			const x = d.data();
			return {
				batchId: d.id,
				fileName: x.fileName || "",
				uploadedBy: x.uploadedBy || "",
				uploadedAt: x.uploadedAt || "",
				decidedAt: x.decidedAt || "",
				status: x.status,
				entries: x.rows || []
			};
		}
		function approver(ctx) {
			return ctx.role === "tenant_admin" || ctx.role === "superadmin";
		}
		const APPROVER_ERROR = "Only the firm owner or the super-admin can approve uploaded hours";
		async function approvePendingHours(t, ctx, batchId) {
			if (!approver(ctx)) return { error: APPROVER_ERROR };
			const ref = F.doc(db, "tenants", t, "pendingHours", String(batchId));
			const snap = await F.getDoc(ref);
			if (!snap.exists()) return { error: "Batch not found" };
			const b = snap.data();
			if (b.status !== "pending") return {
				ok: true,
				created: 0
			};
			const workersSnap = await F.getDocs(col(t, "workers"));
			const names = {}, hrs = {};
			workersSnap.forEach((d) => {
				names[d.id] = d.data().name || "";
				hrs[d.id] = d.data().hrId || null;
			});
			const note = "Imported" + (b.fileName ? " from " + b.fileName : "");
			const tsFor = (date, time) => {
				const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date || "");
				if (!m || !time) return (/* @__PURE__ */ new Date()).toISOString();
				const [h, mi] = String(time).split(":").map(Number);
				return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), h || 0, mi || 0).toISOString();
			};
			const batch = F.writeBatch(db);
			(b.rows || []).forEach((r, i) => {
				[["in", r.inTime], ["out", r.outTime]].forEach(([type, time]) => {
					if (!time) return;
					const id = "imp-" + batchId + "-" + i + "-" + type;
					batch.set(F.doc(db, "tenants", t, "punches", id), punchDoc({
						id,
						workerId: r.workerId,
						workerName: names[r.workerId] || "",
						type,
						time,
						date: r.date,
						ts: tsFor(r.date, time),
						clientId: r.clientId || "",
						notes: note,
						gpsWarnings: []
					}, hrs[r.workerId] || null));
				});
			});
			batch.update(ref, {
				status: "approved",
				decidedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			await batch.commit();
			return {
				ok: true,
				created: (b.rows || []).length
			};
		}
		async function rejectPendingHours(t, ctx, batchId) {
			if (!approver(ctx)) return { error: APPROVER_ERROR };
			const ref = F.doc(db, "tenants", t, "pendingHours", String(batchId));
			const snap = await F.getDoc(ref);
			if (!snap.exists()) return { error: "Batch not found" };
			if (snap.data().status !== "pending") return {
				ok: true,
				rejected: 0
			};
			await F.updateDoc(ref, {
				status: "rejected",
				decidedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			return {
				ok: true,
				rejected: (snap.data().rows || []).length
			};
		}
		async function setPunchesHr(t, ctx, workerIds, hrId) {
			if (!approver(ctx)) return { error: "Only the firm owner or the super-admin can assign an HR" };
			const ids = (Array.isArray(workerIds) ? workerIds : []).map(String).filter(Boolean);
			const val = hrId ? String(hrId) : F.deleteField();
			let n = 0, next = 0;
			async function one(wid) {
				const refs = (await Promise.all(["punches", "shiftRequests"].map((c) => F.getDocs(F.query(col(t, c), F.where("workerId", "==", wid)))))).flatMap((s) => s.docs).filter((d) => (d.data().hrId || null) !== (hrId || null)).map((d) => d.ref);
				const commits = [];
				for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
					const batch = F.writeBatch(db);
					refs.slice(i, i + BATCH_LIMIT).forEach((r) => batch.update(r, { hrId: val }));
					commits.push(batch.commit());
				}
				await Promise.all(commits);
				n += refs.length;
			}
			async function lane() {
				while (next < ids.length) await one(ids[next++]);
			}
			await Promise.all(Array.from({ length: Math.min(8, ids.length) }, lane));
			return {
				ok: true,
				updated: n
			};
		}
		async function punchesOnce(t) {
			const since = /* @__PURE__ */ new Date();
			since.setDate(1);
			since.setHours(0, 0, 0, 0);
			since.setDate(since.getDate() - 7);
			return { entries: (await F.getDocs(F.query(col(t, "punches"), ...hrWhere(await hrOnly()), F.where("ts", ">=", F.Timestamp.fromDate(since))))).docs.map(punchFromDoc) };
		}
		function safeName(name) {
			return String(name || "file").replace(/[\/\\#?\[\]*\u0000-\u001f]/g, "_").slice(0, 150) || "file";
		}
		function b64Bytes(b64) {
			const bin = atob(String(b64 || ""));
			const out = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
			return out;
		}
		async function uploadWorkerFile(t, body, onProgress) {
			if (!auth.currentUser) return { error: "Session expired or invalid — please sign in again" };
			if (!t) return { error: "No firm" };
			const action = body.action;
			let kind, name, bytes, type;
			if (action === "saveWorkerDoc") {
				if (!body.fileBase64 || !body.fileName) return { error: "No fileBase64 or fileName" };
				kind = "form101";
				name = body.fileName;
				bytes = b64Bytes(body.fileBase64);
				type = body.mimeType || "application/pdf";
			} else if (action === "saveWorkerAssets") {
				if (!body.scanB64 && !body.sigPng) return { error: "No scanB64" };
				kind = "assets";
				name = (body.fileNameBase || "worker") + "_assets.json";
				type = "application/json";
				bytes = new TextEncoder().encode(JSON.stringify({
					scanB64: body.scanB64,
					scanMediaType: body.scanMediaType || "image/jpeg",
					sigPng: body.sigPng || null,
					extraPages: Array.isArray(body.extraPages) ? body.extraPages : []
				}));
			} else if (action === "saveWorkerFile") {
				if (!body.fileBase64 || !body.fileName) return { error: "Missing fileBase64 or fileName" };
				kind = "docs";
				name = body.fileName;
				bytes = b64Bytes(body.fileBase64);
				type = body.mimeType || "application/octet-stream";
			} else return { error: "Unknown action" };
			const wid = safeName(body.workerId || "_");
			const path = "tenants/" + t + "/workers/" + wid + "/" + kind + "/" + Date.now() + "-" + safeName(name);
			await loadStorage();
			const ref = stMod.ref(storage, path);
			const meta = {
				contentType: type,
				customMetadata: {
					workerId: String(body.workerId || ""),
					kind
				}
			};
			const hr = await hrOnly();
			if (hr) meta.customMetadata.hrId = hr;
			if (kind !== "assets") meta.contentDisposition = "inline; filename*=UTF-8''" + encodeURIComponent(safeName(name));
			await new Promise((resolve, reject) => {
				stMod.uploadBytesResumable(ref, bytes, meta).on("state_changed", (snap) => {
					if (onProgress) onProgress(snap.bytesTransferred, snap.totalBytes);
				}, reject, resolve);
			});
			if (kind === "assets") return {
				ok: true,
				id: path
			};
			return {
				ok: true,
				id: path,
				url: await stMod.getDownloadURL(ref)
			};
		}
		async function handleAction(action, params, ctx) {
			const t = params.asTenantId || ctx.tenantId;
			if ([
				"logBatch",
				"logError",
				"logTiming"
			].includes(action)) return auth.currentUser ? writeTelemetry(params) : {
				ok: false,
				skipped: true
			};
			if (!auth.currentUser) return { error: "Session expired or invalid — please sign in again" };
			if (FUNCTION_ACTIONS.includes(action)) return callUsersAdmin(params);
			if (AI_ACTIONS.includes(action)) return callUsersAdmin(params, AI_FN_URL);
			if (STORAGE_FILE_ACTIONS.includes(action)) {
				if (isStoragePath(params.fileId)) return callUsersAdmin(params);
				return action === "deleteWorkerDoc" ? { ok: true } : { error: "File not found" };
			}
			switch (action) {
				case "loadErrors": return ctx.role === "superadmin" ? readLog("errors", params.from ? 2e3 : 100, params.from, params.to) : { error: "Super-admin only" };
				case "loadTimings": return ctx.role === "superadmin" ? readLog("timings", params.from ? 5e3 : 500, params.from, params.to) : { error: "Super-admin only" };
				case "resetLogs": return ctx.role === "superadmin" ? resetLogs() : { error: "Super-admin only" };
				case "loadSchedule": return loadSchedule(t, false);
				case "loadPunchLog": return punchesOnce(t);
				case "deletePunchesByMonths": return deletePunchesByMonths(t, ctx, params.months);
				case "savePendingHoursBatch": return savePendingHours(t, ctx, params);
				case "loadPendingHours": return loadPendingHours(t, ctx);
				case "approvePendingHours": return approvePendingHours(t, ctx, params.batchId);
				case "rejectPendingHours": return rejectPendingHours(t, ctx, params.batchId);
				case "setPunchesHr": return setPunchesHr(t, ctx, params.workerIds, params.hrId);
				case "loadShiftRequests": {
					if (ctx.role === "supplier" || ctx.role === "client") return { error: "Not available for this login" };
					const hr = await hrOnly();
					const snap = await F.getDocs(hr ? F.query(col(t, "shiftRequests"), F.where("hrId", "==", hr)) : col(t, "shiftRequests"));
					const today = /* @__PURE__ */ new Date();
					const d0 = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
					return {
						ok: true,
						requests: snap.docs.map((d) => ({
							id: d.id,
							...d.data()
						})).filter((r) => String(r.date || "") >= d0)
					};
				}
				case "decideShiftRequest": {
					const status = params.status === "confirmed" ? "confirmed" : "declined";
					const ref = F.doc(db, "tenants", t, "shiftRequests", String(params.id));
					const fields = {
						status,
						decidedAt: (/* @__PURE__ */ new Date()).toISOString(),
						decidedBy: ctx.username || auth.currentUser.uid,
						decidedByUid: auth.currentUser.uid
					};
					if (status === "confirmed" && params.schedule) return saveSchedule(t, params.schedule, {
						ops: [[
							"update",
							ref,
							fields
						]],
						ids: params.workerIds
					});
					await F.updateDoc(ref, fields);
					return { ok: true };
				}
				case "loadNotifReads": {
					const snap = await F.getDoc(F.doc(db, "notifReads", auth.currentUser.uid));
					return {
						ok: true,
						ids: snap.exists() ? snap.data().ids || [] : []
					};
				}
				case "loadFirmMessages": {
					const snap = await F.getDoc(F.doc(db, "tenants", t, "settings", "messages"));
					return {
						ok: true,
						messages: snap.exists() ? snap.data() : {}
					};
				}
				case "saveFirmMessages": {
					const waTemplate = String(params.waTemplate == null ? "" : params.waTemplate).slice(0, 1e3);
					await F.setDoc(F.doc(db, "tenants", t, "settings", "messages"), {
						waTemplate,
						at: (/* @__PURE__ */ new Date()).toISOString()
					}, { merge: true });
					return { ok: true };
				}
				case "saveNotifReads": {
					const ids = (params.ids || []).filter((x) => typeof x === "string" && x.length <= 200).slice(-500);
					await F.setDoc(F.doc(db, "notifReads", auth.currentUser.uid), {
						ids,
						at: (/* @__PURE__ */ new Date()).toISOString()
					});
					return { ok: true };
				}
			}
			return null;
		}
		return {
			login,
			loadSchedule,
			saveSchedule,
			listenWorkers,
			listenPendingHours,
			listenPunches,
			punchesBetween,
			punchesOfBatch,
			savePunch,
			updatePunch,
			deletePunch,
			handleAction,
			uploadWorkerFile,
			UPLOAD_ACTIONS,
			isStoragePath,
			storageUrl: async (path) => {
				await loadStorage();
				return stMod.getDownloadURL(stMod.ref(storage, path));
			},
			currentUser: () => auth.currentUser,
			idToken: () => auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null),
			hourPerms: async () => {
				const h = (await myClaims()).hp;
				return Array.isArray(h) ? h : [];
			},
			supplierSections: async () => {
				const v = (await myClaims()).ss;
				return Array.isArray(v) ? v : [
					"dashboard",
					"workers",
					"hours"
				];
			},
			signOut: () => {
				if (punchUnsub) punchUnsub();
				claimsFor = null;
				claims = {};
				return authMod.signOut(auth);
			}
		};
	}
	//#endregion
	//#region src/lib/firestore-backend-global.ts
	window.initFirestoreBackend = initFirestoreBackend;
	//#endregion
})();
