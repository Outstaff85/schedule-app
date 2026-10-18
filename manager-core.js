// GENERATED from src/manager/data/, src/manager/logic/ by scripts/build-globals.mjs — never edit
// by hand: change the TypeScript and run `node scripts/build-globals.mjs`
// (npm run build fails while this file is stale). The manager page's data
// layer (session, dispatcher, load / save / cache, punches, uploads, telemetry)
// and its logic (access, i18n, pay, workers, uploads…) under their old global
// names (docs/app-core.md → Data calls).
(function() {
	//#region src/manager/data/events.ts
	/** A text for the user, translated by the page when shown. */
	var tr$1 = (text, vars) => ({
		text,
		vars
	});
	var handlers = {};
	function on(name, fn) {
		(handlers[name] || (handlers[name] = [])).push(fn);
	}
	function emit(name, ...payload) {
		for (const fn of handlers[name] || []) try {
			fn(payload[0]);
		} catch (e) {
			console.error("Data event " + name + " failed:", e);
		}
	}
	var notify = (msg, ms) => emit("notice", {
		msg,
		ms
	});
	var host = {
		canWriteWorkers: () => true,
		workerWindowOpen: () => false,
		weekStart: () => null
	};
	function setHost(h) {
		Object.assign(host, h);
	}
	//#endregion
	//#region src/manager/data/ids.ts
	/** a record's id (a worker, client, supplier, punch…) */
	function uid() {
		return "id" + Math.random().toString(36).slice(2, 9);
	}
	/** a worker's punch-link token */
	function genToken() {
		return Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 6);
	}
	//#endregion
	//#region src/manager/data/session.ts
	var SESSION_KEY = "schedMgr_session";
	function getSession() {
		try {
			const raw = localStorage.getItem(SESSION_KEY);
			if (!raw) return null;
			const s = JSON.parse(raw);
			if (!s || !s.uid) {
				localStorage.removeItem(SESSION_KEY);
				return null;
			}
			return s;
		} catch {
			return null;
		}
	}
	function saveSession(s) {
		localStorage.setItem(SESSION_KEY, JSON.stringify(s));
	}
	function clearSession() {
		localStorage.removeItem(SESSION_KEY);
	}
	function fsTenantId() {
		const s = getSession();
		return s ? s.viewingTenantId || s.tenantId : null;
	}
	var STORAGE_KEY_BASE = "schedMgr_v1";
	function STORAGE_KEY() {
		const s = getSession();
		return "schedMgr_v1_" + (s && (s.viewingTenantId || s.tenantId) || "_anon");
	}
	function gsAuth() {
		const s = getSession();
		if (!s) return {};
		const out = {};
		if (s.role === "superadmin" && s.viewingTenantId) out.asTenantId = s.viewingTenantId;
		return out;
	}
	function gsAuthQuery() {
		const a = gsAuth();
		return Object.keys(a).map((k) => "&" + k + "=" + encodeURIComponent(a[k])).join("");
	}
	//#endregion
	//#region src/manager/data/state.ts
	var state = {
		workers: [],
		clients: [],
		suppliers: [],
		/** the first load (cache or server) has ended */
		ready: false
	};
	/** What is saved and cached: the three lists, the week on screen, the time. */
	function getDataObj() {
		return {
			workers: state.workers,
			clients: state.clients,
			suppliers: state.suppliers,
			weekStart: host.weekStart(),
			savedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
	}
	function applyData(d) {
		if (d.workers) state.workers = d.workers.map((w) => ({
			id: w.id || uid(),
			clientIds: w.clientIds || [],
			token: w.token || genToken(),
			status: w.status || "active",
			...w
		}));
		if (d.clients) state.clients = d.clients;
		if (d.suppliers) state.suppliers = d.suppliers;
	}
	//#endregion
	//#region src/manager/data/telemetry.ts
	var TELEMETRY_FIRST_FLUSH_MS = 8e3;
	var TELEMETRY_FLUSH_MS = 5e3;
	var queue = [];
	var timer = null;
	function queueTelemetry(item) {
		queue.push(item);
		if (queue.length > 50) queue.splice(0, queue.length - 50);
		if (!timer) {
			const sinceLoad = performance.now();
			timer = setTimeout(flushTelemetry, Math.max(TELEMETRY_FLUSH_MS, TELEMETRY_FIRST_FLUSH_MS - sinceLoad));
		}
	}
	function flushTelemetry() {
		if (timer) clearTimeout(timer);
		timer = null;
		if (!queue.length) return;
		const items = queue;
		queue = [];
		const body = JSON.stringify({
			action: "logBatch",
			items
		});
		try {
			fetch(API_URL, {
				method: "POST",
				body
			}).catch(() => {});
		} catch {}
	}
	function installTelemetryFlush() {
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "hidden") flushTelemetry();
		});
		window.addEventListener("pagehide", () => flushTelemetry());
	}
	function reportTiming(kind, totalMs, details) {
		try {
			const s = getSession() || {};
			queueTelemetry({
				type: "timing",
				kind,
				totalMs: Math.round(totalMs),
				tenantId: s.viewingTenantId || s.tenantId || "",
				user: s.username || "",
				role: s.role || "",
				details: Object.assign({ device: /Mobi|Android|iPhone/i.test(navigator.userAgent) ? "mobile" : "desktop" }, details || {})
			});
		} catch {}
	}
	var pageStartEpoch = Math.round(performance.timeOrigin || Date.now());
	var firstContentAt = null;
	var openTimingSent = false;
	function markFirstContent() {
		if (!firstContentAt) firstContentAt = Date.now();
	}
	function markFreshContent(screen) {
		if (openTimingSent) return;
		openTimingSent = true;
		markFirstContent();
		const now = Date.now();
		let pending = null;
		try {
			pending = JSON.parse(sessionStorage.getItem("pendingLoginTiming") || "null");
			sessionStorage.removeItem("pendingLoginTiming");
		} catch {}
		if (pending && pending.t0 && now - pending.t0 < 12e4) reportTiming("login", now - pending.t0, {
			screen,
			loginRequestMs: pending.loginMs,
			firstContentMs: firstContentAt - pending.t0,
			reloadToFreshMs: now - pageStartEpoch,
			pingMs: pending.pingMs,
			pingDoneBeforeClick: pending.pingDone
		});
		else reportTiming("open", now - pageStartEpoch, {
			screen,
			firstContentMs: firstContentAt - pageStartEpoch
		});
	}
	var errSent = {};
	var errCount = 0;
	function reportError(message, source, stack) {
		try {
			if (errCount > 40) return;
			const key = String(message || "").slice(0, 120), nowT = Date.now();
			if (errSent[key] && nowT - errSent[key] < 6e4) return;
			errSent[key] = nowT;
			errCount++;
			queueTelemetry({
				type: "error",
				page: location.pathname.split("/").pop() || location.href,
				role: "manager",
				worker: (getSession() || {}).username || "",
				message: String(message || "").slice(0, 500),
				source: String(source || "").slice(0, 300),
				stack: String(stack || "").slice(0, 1200)
			});
		} catch {}
	}
	//#endregion
	//#region src/manager/data/api.ts
	var API_URL = "api://app";
	var fsBackend = null;
	function loadFirestoreBackend() {
		if (fsBackend) return fsBackend;
		fsBackend = new Promise((resolve, reject) => {
			const el = document.createElement("script");
			el.src = "firestore-backend.js";
			el.onload = () => window.initFirestoreBackend().then(resolve, reject);
			el.onerror = () => reject(/* @__PURE__ */ new Error("firestore-backend.js failed to load"));
			document.head.appendChild(el);
		}).catch((e) => {
			fsBackend = null;
			throw e;
		});
		return fsBackend;
	}
	var uploadsInFlight = 0;
	var uploadsRunning = () => uploadsInFlight;
	async function uploadWorkerFile(bodyObj, onProgress) {
		uploadsInFlight++;
		try {
			const json = await (await loadFirestoreBackend()).uploadWorkerFile(fsTenantId(), bodyObj, onProgress);
			if (json && json.ok && bodyObj.previousFileId && bodyObj.previousFileId !== json.id) gsDeleteWorkerDoc(bodyObj.previousFileId);
			return json;
		} catch (e) {
			return { error: "Storage: " + (e && (e.code || e.message) || e) };
		} finally {
			uploadsInFlight = Math.max(0, uploadsInFlight - 1);
		}
	}
	var SESSION_EXPIRED_ERROR = "Session expired or invalid — please sign in again";
	var NO_LOGOUT_ACTIONS = [
		"logError",
		"login",
		"logTiming",
		"logBatch"
	];
	var SLOW_API_CALL_MS = 2500;
	function apiParams(url, opts) {
		try {
			if (opts && typeof opts.body === "string") return JSON.parse(opts.body);
		} catch {}
		try {
			return Object.fromEntries(new URL(url).searchParams);
		} catch {
			return {};
		}
	}
	var jsonResponse = (obj) => new Response(JSON.stringify(obj), {
		status: 200,
		headers: { "Content-Type": "application/json" }
	});
	async function route(url, opts) {
		const params = apiParams(url, opts);
		const action = params.action || "loadSchedule";
		const s = getSession() || {};
		const ctx = {
			role: s.role,
			username: s.username,
			tenantId: s.viewingTenantId || s.tenantId
		};
		const t0 = Date.now();
		let json;
		try {
			json = await (await loadFirestoreBackend()).handleAction(action, params, ctx);
		} catch (e) {
			console.warn(action + " failed:", e);
			json = { error: "Firestore: " + (e && e.message || e) };
		}
		if (json == null) json = { error: "Unknown action: " + action };
		const quiet = NO_LOGOUT_ACTIONS.indexOf(action) !== -1;
		const ms = Date.now() - t0;
		const meta = json && json._meta && typeof json._meta === "object" ? json._meta : null;
		if (meta) delete json._meta;
		if (!quiet && ms >= SLOW_API_CALL_MS) try {
			reportTiming("gs:" + action, ms, Object.assign({}, meta || {}, params.part ? { part: String(params.part) } : {}));
		} catch {}
		if (!quiet && json && json.error === "Session expired or invalid — please sign in again" && getSession()) {
			clearSession();
			notify(tr$1("Session expired — please sign in again"));
			setTimeout(() => location.reload(), 1200);
		}
		return jsonResponse(json);
	}
	function installDispatcher() {
		const origFetch = window.fetch.bind(window);
		window.fetch = function(url, opts) {
			if (typeof url === "string" && url.indexOf("api://app") === 0) return route(url, opts);
			return origFetch(url, opts);
		};
	}
	async function gsSave(data) {
		if ((!data.workers || !data.workers.length) && (!data.clients || !data.clients.length)) {
			console.warn("Empty payload — skipping save");
			return false;
		}
		try {
			const r = await (await loadFirestoreBackend()).saveSchedule(fsTenantId(), data);
			return !!(r && r.ok);
		} catch (e) {
			console.warn("Firestore save failed:", e);
			return false;
		}
	}
	var lastLoadError = "";
	var loadError = () => lastLoadError;
	async function gsLoad() {
		try {
			const b = await loadFirestoreBackend();
			if (!b.currentUser()) {
				clearSession();
				location.reload();
				return null;
			}
			const d = await b.loadSchedule(fsTenantId());
			lastLoadError = "";
			return d;
		} catch (e) {
			lastLoadError = "Firestore: " + (e && e.message || e);
			reportError("loadSchedule failed: " + lastLoadError, "gsLoad", "");
			return null;
		}
	}
	async function gsSavePunch(entry) {
		try {
			await (await loadFirestoreBackend()).savePunch(fsTenantId(), entry);
		} catch (e) {
			console.warn("Firestore punch save failed:", e);
		}
	}
	async function gsDeletePunch(id) {
		try {
			await (await loadFirestoreBackend()).deletePunch(fsTenantId(), id);
		} catch (e) {
			console.warn("Firestore delete failed:", e);
		}
	}
	async function gsUpdatePunch(data) {
		try {
			await (await loadFirestoreBackend()).updatePunch(fsTenantId(), data);
		} catch (e) {
			console.warn("Firestore update failed:", e);
		}
	}
	async function gsDeleteWorkerDoc(fileId) {
		try {
			await fetch(API_URL, {
				method: "POST",
				body: JSON.stringify({
					action: "deleteWorkerDoc",
					...gsAuth(),
					fileId
				})
			});
		} catch (e) {
			console.warn("Worker file delete failed:", e);
		}
	}
	//#endregion
	//#region src/manager/data/punches.ts
	function getPunchLog() {
		try {
			return JSON.parse(localStorage.getItem("punchLog") || "[]");
		} catch {
			return [];
		}
	}
	function savePunchLog(log) {
		localStorage.setItem("punchLog", JSON.stringify(log));
	}
	function punchWindowStart() {
		const d = /* @__PURE__ */ new Date();
		d.setDate(1);
		d.setHours(0, 0, 0, 0);
		d.setDate(d.getDate() - 7);
		return d;
	}
	var loadedFrom = null;
	var punchLoadedFrom = () => loadedFrom;
	var ensureChain = Promise.resolve(true);
	var ALL_PUNCHES_FROM = new Date(2e3, 0, 1);
	function ensurePunchesSince(from) {
		if (!from) return Promise.resolve(true);
		const want = from;
		ensureChain = ensureChain.then(async () => {
			const have = loadedFrom || punchWindowStart();
			if (want >= have) return true;
			notify(want <= ALL_PUNCHES_FROM ? tr$1("Loading the whole punch history…") : tr$1("Loading earlier punches…"), 1500);
			try {
				const older = await (await loadFirestoreBackend()).punchesBetween(fsTenantId(), want, have);
				loadedFrom = want;
				mergeRemotePunches(older);
				return true;
			} catch (e) {
				notify(tr$1("Could not load earlier punches: {0}", { 0: e && e.message || e }));
				return false;
			}
		});
		return ensureChain;
	}
	function ensureAllPunches() {
		return ensurePunchesSince(ALL_PUNCHES_FROM);
	}
	function periodPunchStart(period) {
		if (period === "all") return ALL_PUNCHES_FROM;
		if (/^m:\d{4}-\d{2}$/.test(period)) {
			const [y, m] = period.slice(2).split("-").map(Number);
			return new Date(y, m - 1, 0);
		}
		return null;
	}
	async function gsLoadPunchLog() {
		try {
			const since = punchWindowStart();
			if (!loadedFrom || loadedFrom > since) loadedFrom = since;
			return await (await loadFirestoreBackend()).listenPunches(fsTenantId(), (entries) => mergeRemotePunches(entries), since);
		} catch (e) {
			console.warn("Firestore punch load failed: " + (e && e.message || e));
			return null;
		}
	}
	var synced = null;
	var punchSynced = () => synced;
	function syncPunchesFromGS() {
		synced = (async () => {
			const remote = await gsLoadPunchLog();
			if (!remote) return;
			mergeRemotePunches(remote);
		})();
		return synced;
	}
	function mergeRemotePunches(remote) {
		const local = getPunchLog();
		const byId = {};
		remote.forEach((e) => {
			if (!e) return;
			const d = e.ts ? new Date(e.ts) : null;
			if (d && !isNaN(d.getTime())) e.time = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
			else if (typeof e.time === "string") {
				const m = e.time.match(/(\d{1,2}):(\d{2})/);
				if (m) e.time = m[1].padStart(2, "0") + ":" + m[2];
			}
			if (e.id != null) byId[e.id] = e;
		});
		const keepFrom = (loadedFrom || punchWindowStart()).getTime();
		const s = getSession();
		const mine = s && s.role === "hr" && s.ownOnly ? new Set(state.workers.map((w) => String(w.id))) : null;
		local.forEach((e) => {
			if (e && e.id != null && !(e.id in byId) && !(new Date(e.ts).getTime() < keepFrom) && (!mine || mine.has(String(e.workerId)))) byId[e.id] = e;
		});
		savePunchLog(Object.values(byId));
		emit("punches");
	}
	//#endregion
	//#region src/manager/data/store.ts
	function UNSAVED_KEY() {
		return STORAGE_KEY() + "_unsaved";
	}
	function hasUnsavedLocal() {
		try {
			const t = +(localStorage.getItem(UNSAVED_KEY()) || 0);
			return t > 0 && Date.now() - t < 2592e5 && !!localStorage.getItem(STORAGE_KEY());
		} catch {
			return false;
		}
	}
	function dropWorkerPhotos() {
		if (!host.canWriteWorkers()) return false;
		let n = 0;
		state.workers.forEach((w) => {
			if ("avatarB64" in w) {
				delete w.avatarB64;
				n++;
			}
		});
		return n > 0;
	}
	function writeCache(json) {
		localStorage.setItem(STORAGE_KEY(), json);
		localStorage.setItem(STORAGE_KEY_BASE, json);
	}
	function applyServerLoad(gd) {
		if (hasUnsavedLocal()) {
			notify(tr$1("Unsaved changes found on this device — saving them now"), 4e3);
			autoSave();
			return false;
		}
		applyData(gd);
		const photosDropped = dropWorkerPhotos();
		emit("data");
		if (photosDropped) autoSave();
		writeCache(JSON.stringify(gd));
		return true;
	}
	var saveTimer;
	function autoSave() {
		if (!state.workers.length && !state.clients.length) {
			let hadData = false;
			try {
				const prev = JSON.parse(localStorage.getItem(STORAGE_KEY()) || "{}");
				hadData = prev.workers && prev.workers.length || prev.clients && prev.clients.length;
			} catch {}
			if (hadData) {
				console.warn("Empty state but cache has data — skipping save");
				emit("save", "saved");
				notify({ text: "⚠ Empty data — save skipped" });
				return;
			}
		}
		emit("save", "saving");
		clearTimeout(saveTimer);
		saveTimer = setTimeout(async () => {
			try {
				const data = getDataObj();
				const json = JSON.stringify(data);
				writeCache(json);
				localStorage.setItem(STORAGE_KEY() + "_bak", json);
				try {
					localStorage.setItem(UNSAVED_KEY(), String(Date.now()));
				} catch {}
				const ok = await gsSave(data);
				if (ok) try {
					localStorage.removeItem(UNSAVED_KEY());
				} catch {}
				emit("save", "saved");
				notify(ok ? tr$1("Saved") : tr$1("Save failed — kept on this device"));
			} catch (e) {
				console.error("Save failed", e);
				emit("save", "saved");
				notify(tr$1("Save error"));
			}
		}, 800);
	}
	/** After a fresh server load: the punches, the live watchers. */
	function afterServerLoad() {
		markFreshContent("app");
		syncPunchesFromGS();
		emit("loaded");
	}
	async function loadData() {
		try {
			const raw = localStorage.getItem(STORAGE_KEY()) || localStorage.getItem(STORAGE_KEY() + "_bak");
			if (raw) {
				applyData(JSON.parse(raw));
				state.ready = true;
				emit("data");
				markFirstContent();
			}
		} catch {}
		try {
			const gd = await gsLoad();
			const wasReady = state.ready;
			state.ready = true;
			if (gd) {
				applyServerLoad(gd);
				emit("save", "saved");
				afterServerLoad();
				if (getSession()?.role === "hr") watchHrWorkers();
				watchHoursBatches();
			} else {
				const err = loadError();
				notify(tr$1("Could not load from the server — showing saved data{0}", { 0: err ? " (" + err.slice(0, 80) + ")" : "" }), 6e3);
				retryLoadDataWhenBack();
				if (!wasReady) emit("data");
			}
		} catch (e) {
			console.error("Load failed", e);
			notify(tr$1("Offline — using cached data"));
			if (!state.ready) {
				state.ready = true;
				emit("data");
			}
		}
	}
	var hoursWatched = false;
	var batches = null;
	var hoursBatches = () => batches;
	function watchHoursBatches() {
		const s = getSession();
		if (hoursWatched || !s || s.role === "supplier") return;
		hoursWatched = true;
		loadFirestoreBackend().then((b) => b.listenPendingHours(fsTenantId(), (list) => {
			batches = list;
			emit("hours");
		})).catch((e) => {
			hoursWatched = false;
			console.warn("Hours watch failed: " + (e && e.message || e));
		});
	}
	/** batches waiting for a decision */
	var pendingHoursCount = () => (batches || []).filter((b) => b.status === "pending").length;
	function latestHoursBatch(workerId) {
		return (batches || []).filter((b) => (b.entries || []).some((r) => r.workerId === workerId)).sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)))[0] || null;
	}
	var hrWorkersWatched = false;
	var hrWorkerChanges = [];
	function watchHrWorkers() {
		if (hrWorkersWatched) return;
		hrWorkersWatched = true;
		loadFirestoreBackend().then((b) => b.listenWorkers(fsTenantId(), (ch) => {
			hrWorkerChanges.push(ch);
			applyHrWorkerChanges();
		})).catch((e) => {
			hrWorkersWatched = false;
			console.warn("Worker watch failed: " + (e && e.message || e));
		});
	}
	var hrRetry;
	function applyHrWorkerChanges() {
		if (!hrWorkerChanges.length) return;
		if (host.workerWindowOpen()) {
			clearTimeout(hrRetry);
			hrRetry = setTimeout(applyHrWorkerChanges, 2e3);
			return;
		}
		const changes = hrWorkerChanges.splice(0);
		let n = 0;
		changes.forEach(({ added, removed, changed }) => {
			const gone = new Set(removed.map(String));
			const before = state.workers.length;
			state.workers = state.workers.filter((w) => !gone.has(String(w.id)));
			n += before - state.workers.length;
			added.forEach((x) => {
				if (!state.workers.some((w) => String(w.id) === String(x.id))) {
					state.workers.push(x);
					n++;
				}
			});
			(changed || []).forEach(({ data, unsaved }) => {
				const i = state.workers.findIndex((w) => String(w.id) === String(data.id));
				if (i < 0 || unsaved(state.workers[i])) return;
				state.workers[i] = data;
				n++;
			});
		});
		if (!n) return;
		try {
			localStorage.setItem(STORAGE_KEY(), JSON.stringify(getDataObj()));
		} catch {}
		emit("data");
	}
	var loadRetryArmed = false;
	function retryLoadDataWhenBack() {
		if (loadRetryArmed) return;
		loadRetryArmed = true;
		const again = async () => {
			if (document.visibilityState === "hidden" || navigator.onLine === false) return;
			window.removeEventListener("online", again);
			document.removeEventListener("visibilitychange", again);
			const gd = await gsLoad();
			loadRetryArmed = false;
			if (gd) {
				try {
					if (applyServerLoad(gd)) notify(tr$1("Data loaded"));
				} catch {}
				afterServerLoad();
			}
		};
		window.addEventListener("online", again);
		document.addEventListener("visibilitychange", again);
		setTimeout(again, 15e3);
	}
	//#endregion
	//#region src/manager/logic/access.ts
	/** A section of a staff / HR login (users.permissions → session.permissions: '*' or a list). Other roles see every section. */
	function hasPermission(section) {
		const s = getSession();
		if (!s || s.role !== "staff" && s.role !== "hr") return true;
		const perms = s.permissions;
		return perms === "*" || Array.isArray(perms) && perms.indexOf(section) !== -1;
	}
	var NAV_TAB_PERMISSION = {
		schedule: "schedule",
		workers: "workers",
		clients: "clients",
		suppliers: "suppliers",
		admin: "workers",
		accounting: "accounting"
	};
	function isHrSession() {
		const s = getSession();
		return !!s && s.role === "hr";
	}
	function isFirmAdminSession() {
		const s = getSession();
		return !!s && (s.role === "tenant_admin" || s.role === "superadmin");
	}
	var HR_HIDDEN_TABS = ["dashboard", "admin"];
	function hrPayOnly() {
		const s = getSession();
		return !!s && s.role === "hr" && hasPermission("accounting");
	}
	function hrHourReview() {
		const s = getSession();
		return !!s && s.role === "hr" && (s.hourPerms || []).some((p) => p === "hours" || p === "schedule");
	}
	function tabAllowed(tab) {
		if (isHrSession() && HR_HIDDEN_TABS.includes(tab)) return false;
		if (tab === "accounting" && hrHourReview()) return true;
		return !NAV_TAB_PERMISSION[tab] || hasPermission(NAV_TAB_PERMISSION[tab]);
	}
	/** The tab a login opens on. */
	function homeTab() {
		if (!isHrSession()) return "dashboard";
		return [
			"workers",
			"schedule",
			"clients",
			"suppliers",
			"accounting"
		].find(tabAllowed) || "workers";
	}
	var MORE_TABS = [
		"clients",
		"suppliers",
		"admin"
	];
	//#endregion
	//#region src/manager/logic/i18n.ts
	var I18N_LANGS = {
		en: "English",
		he: "עברית",
		ru: "Русский"
	};
	var dict = {};
	var lang = "en";
	/** the language and its loaded dictionary (the React pieces adopt them, ManagerBridge.lang / dict) */
	var currentLang = () => lang;
	var currentDict = () => dict;
	function tr(s, params) {
		let out = lang !== "en" && dict[s] || s;
		if (params) out = out.replace(/\{(\w+)\}/g, (m, k) => params[k] != null ? String(params[k]) : m);
		return out;
	}
	function uiLocale() {
		return {
			he: "he-IL",
			ru: "ru-RU"
		}[lang] || "en-GB";
	}
	function storedLanguage() {
		try {
			const l = localStorage.getItem("uiLang");
			return l && I18N_LANGS[l] ? l : "en";
		} catch {
			return "en";
		}
	}
	var onNewer = null;
	function onNewerDictionary(fn) {
		onNewer = fn;
	}
	async function loadI18n(want) {
		const set = (l, d) => {
			lang = l;
			dict = d || {};
			document.documentElement.lang = l;
		};
		if (!I18N_LANGS[want] || want === "en") {
			set("en", {});
			return;
		}
		let cached = null;
		try {
			cached = JSON.parse(localStorage.getItem("i18n_" + want) || "null");
		} catch {}
		if (cached) set(want, cached);
		const fresh = fetch("i18n/" + want + ".json", { cache: "no-cache" }).then((r) => r.ok ? r.json() : null).then((d) => {
			if (!d || typeof d !== "object") return false;
			const changed = JSON.stringify(d) !== JSON.stringify(cached);
			try {
				localStorage.setItem("i18n_" + want, JSON.stringify(d));
			} catch {}
			if (lang === want || !cached) set(want, d);
			return changed;
		}).catch(() => false);
		if (cached) {
			fresh.then((ch) => {
				if (ch && lang === want && onNewer) onNewer();
			});
			return;
		}
		await fresh;
	}
	//#endregion
	//#region src/lib/utils.ts
	/** Escapes text put into HTML by hand (a print page) — the old pages' esc(), the same rule (CLAUDE.md → XSS). */
	function esc(s) {
		return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			"\"": "&quot;",
			"'": "&#39;"
		})[c]);
	}
	//#endregion
	//#region src/manager/worker.ts
	var LEGACY_DOC_IN_ADDRESS = /^\s*(?:ת\.ז\.|Passport)\s*(\S+)\s*$/;
	function workerDocId(w) {
		if (w.docId) return w.docId;
		const m = LEGACY_DOC_IN_ADDRESS.exec(w.address || "");
		return m ? m[1] : "";
	}
	function workerAddress(w) {
		const addr = w.address || "";
		if (w.docId) return addr;
		return LEGACY_DOC_IN_ADDRESS.test(addr) ? "" : addr;
	}
	var WORKER_DOC_TYPES = {
		contract: "Contract",
		visa: "Visa",
		work_permit: "Work permit",
		other: "Other"
	};
	/** "DD/MM/YYYY" for a stored YYYY-MM-DD, else the value as it is. */
	function fmtDMY(s) {
		const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
		return m ? `${m[3]}/${m[2]}/${m[1]}` : s || "";
	}
	//#endregion
	//#region src/manager/logic/util.ts
	var xlsxLoading = null;
	function loadXlsx() {
		if (typeof window.XLSX !== "undefined") return Promise.resolve();
		return xlsxLoading || (xlsxLoading = new Promise((res, rej) => {
			const sc = document.createElement("script");
			sc.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
			sc.onload = () => res();
			sc.onerror = () => {
				xlsxLoading = null;
				sc.remove();
				rej(/* @__PURE__ */ new Error("Excel library not loaded"));
			};
			document.head.appendChild(sc);
		}));
	}
	function getSundayOfWeek(d) {
		const c = new Date(d);
		c.setDate(c.getDate() - c.getDay());
		c.setHours(0, 0, 0, 0);
		return c;
	}
	function toMins(t) {
		if (!t) return null;
		const [h, m] = t.split(":").map(Number);
		return h * 60 + m;
	}
	/** A shift's hours; one that ends at or before its start crosses midnight. */
	function calcHours(s, e) {
		if (!s || !e) return 0;
		const sm = toMins(s), em = toMins(e);
		return em <= sm ? (1440 - sm + em) / 60 : (em - sm) / 60;
	}
	//#endregion
	//#region src/manager/logic/pay.ts
	function analyzeDayPunches(entries, date) {
		return Payroll.analyzeDayPunches(entries, date, { tr });
	}
	function groupPunchesIntoShifts(entries) {
		return Payroll.groupPunchesIntoShifts(entries);
	}
	var PAY_RULES = () => Payroll.PAY_RULES;
	function effectiveRates(w, clientId) {
		return Payroll.effectiveRates(w, clientId, state.clients);
	}
	function shiftPay(hours, w, isSat, clientId) {
		return Payroll.shiftPay(hours, w, isSat, clientId, state.clients);
	}
	function isDailyPay(w) {
		return Payroll.isDailyPay(w);
	}
	function dailyRate(w) {
		return Payroll.dailyRate(w);
	}
	function shiftPayFor(hours, w, isSat, clientId, date, seenDays) {
		return Payroll.shiftPayFor(hours, w, isSat, clientId, date, seenDays, state.clients);
	}
	function travelPay(w, days, months) {
		return Payroll.travelPay(w, days, months);
	}
	function salaryPeriodKey(period, now) {
		return Payroll.salaryPeriodKey(period, now);
	}
	function dayOverride(w, key) {
		return Payroll.dayOverride(w, key);
	}
	function localYMD(d) {
		return Payroll.localYMD(d);
	}
	function wOwnRate(w) {
		return Payroll.wOwnRate(w);
	}
	//#endregion
	//#region src/manager/logic/workers.ts
	/** Where worker files are kept, as the UI names it. */
	var DOC_STORE = "Firebase Storage";
	function isActiveWorker(w) {
		return !!w && w.status !== "fired";
	}
	function workerExpiryStatus(w) {
		if (!w || !isActiveWorker(w) || !w.expiryEnabled || !w.startDate || !w.expiryMonths) return null;
		const start = /* @__PURE__ */ new Date(w.startDate + "T00:00:00");
		if (isNaN(start.getTime())) return null;
		const deadline = new Date(start);
		deadline.setMonth(deadline.getMonth() + Number(w.expiryMonths));
		const warnFrom = new Date(deadline);
		warnFrom.setMonth(warnFrom.getMonth() - Number(w.expiryWarnMonths || 0));
		const now = /* @__PURE__ */ new Date();
		if (now >= deadline) return {
			level: "overdue",
			deadline
		};
		if (now >= warnFrom) return {
			level: "warning",
			deadline
		};
		return null;
	}
	var WORKER_DOC_WARN_DAYS = {
		contract: 30,
		visa: 60,
		work_permit: 60,
		other: 30
	};
	function parseDocDate(v) {
		const s = String(v || "").trim();
		let m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
		if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
		m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
		if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
		return null;
	}
	function workerDocExpiries(w) {
		const today = /* @__PURE__ */ new Date();
		today.setHours(0, 0, 0, 0);
		const out = [], seen = /* @__PURE__ */ new Set();
		for (const d of w.docs || []) {
			const date = parseDocDate(d.expiry);
			if (!date || isNaN(date.getTime())) continue;
			const key = d.type + "|" + d.expiry;
			if (seen.has(key)) continue;
			seen.add(key);
			const label = tr(WORKER_DOC_TYPES[d.type] || "Document");
			const warnAt = new Date(today);
			warnAt.setDate(warnAt.getDate() + (WORKER_DOC_WARN_DAYS[d.type] || 30));
			if (date < today) out.push({
				doc: d,
				level: "error",
				date,
				text: tr("{0} expired {1}", {
					0: label,
					1: date.toLocaleDateString("en-GB")
				})
			});
			else if (date <= warnAt) out.push({
				doc: d,
				level: "warn",
				date,
				text: tr("{0} expires {1}", {
					0: label,
					1: date.toLocaleDateString("en-GB")
				})
			});
		}
		return out.sort((a, b) => a.date.getTime() - b.date.getTime());
	}
	function workerDocStatus(w) {
		const missing = [];
		if (!workerDocId(w)) missing.push(tr("ID/passport no."));
		if (!w.docUrl) missing.push(tr("Form 101"));
		if (!w.assetsFileId) missing.push(tr("document scan"));
		if (w.docHasSignature === false) missing.push(tr("signature"));
		if ((w.docType || "israeli_id") === "israeli_id" && w.docExtraPages === 0) missing.push(tr("ספח (ID appendix)"));
		let expiry = null;
		const d = parseDocDate(w.docExpiry);
		if (d && !isNaN(d.getTime())) {
			const today = /* @__PURE__ */ new Date();
			today.setHours(0, 0, 0, 0);
			const warnAt = new Date(today);
			warnAt.setMonth(warnAt.getMonth() + 3);
			if (d < today) expiry = {
				level: "error",
				date: d,
				text: tr("ID/passport expired {0}", { 0: d.toLocaleDateString("en-GB") })
			};
			else if (d <= warnAt) expiry = {
				level: "warn",
				date: d,
				text: tr("ID/passport expires {0}", { 0: d.toLocaleDateString("en-GB") })
			};
		}
		const failed = !!w.docUploadFailed;
		const docExpiries = workerDocExpiries(w);
		const docExpired = docExpiries.find((x) => x.level === "error") || null;
		const level = failed || expiry && expiry.level === "error" || docExpired ? "error" : missing.length || expiry || docExpiries.length ? "warn" : "ok";
		const lines = [];
		if (failed) lines.push(tr("Last upload to {0} failed", { 0: DOC_STORE }));
		if (missing.length) lines.push(tr("Missing: {0}", { 0: missing.join(", ") }));
		if (expiry) lines.push(expiry.text);
		for (const x of docExpiries) lines.push(x.text);
		return {
			level,
			missing,
			expiry,
			docExpiries,
			docExpired,
			failed,
			lines
		};
	}
	//#endregion
	//#region src/manager/logic/uploads.ts
	var UPLOAD_MAX_DIM = 1800;
	function downscaleForUpload(b64, mediaType) {
		return new Promise((resolve) => {
			const img = new Image();
			img.onload = () => {
				try {
					const iw = img.naturalWidth, ih = img.naturalHeight;
					const scale = Math.min(1, UPLOAD_MAX_DIM / Math.max(iw, ih, 1));
					if (scale >= 1) {
						resolve({
							b64,
							mediaType
						});
						return;
					}
					const cv = document.createElement("canvas");
					cv.width = Math.round(iw * scale);
					cv.height = Math.round(ih * scale);
					const ctx = cv.getContext("2d");
					ctx.imageSmoothingEnabled = true;
					ctx.imageSmoothingQuality = "high";
					ctx.drawImage(img, 0, 0, cv.width, cv.height);
					resolve({
						b64: cv.toDataURL("image/jpeg", .9).split(",")[1],
						mediaType: "image/jpeg"
					});
				} catch {
					resolve({
						b64,
						mediaType
					});
				}
			};
			img.onerror = () => resolve({
				b64,
				mediaType
			});
			img.src = "data:" + mediaType + ";base64," + b64;
		});
	}
	var pdfjsLoading = null;
	function loadPdfJs() {
		if (window.pdfjsLib) return Promise.resolve();
		if (pdfjsLoading) return pdfjsLoading;
		pdfjsLoading = new Promise((res, rej) => {
			const sc = document.createElement("script");
			sc.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
			sc.onload = () => {
				try {
					window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
				} catch {}
				res();
			};
			sc.onerror = () => {
				pdfjsLoading = null;
				rej(/* @__PURE__ */ new Error("pdf.js CDN failed"));
			};
			document.head.appendChild(sc);
		});
		return pdfjsLoading;
	}
	function isPdfFile(f) {
		return !!f && (f.type === "application/pdf" || /\.pdf$/i.test(f.name || ""));
	}
	function readFileB64(file) {
		return new Promise((res, rej) => {
			const r = new FileReader();
			r.onload = () => res(String(r.result).split(",")[1]);
			r.onerror = () => rej(/* @__PURE__ */ new Error("read failed"));
			r.readAsDataURL(file);
		});
	}
	async function fileToUploadPages(file) {
		if (isPdfFile(file)) {
			await loadPdfJs();
			const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
			const nums = Array.from({ length: pdf.numPages }, (_, i) => i + 1);
			return Promise.all(nums.map(async (n) => {
				const page = await pdf.getPage(n);
				const vp = page.getViewport({ scale: 2.5 });
				const cv = document.createElement("canvas");
				cv.width = vp.width;
				cv.height = vp.height;
				await page.render({
					canvasContext: cv.getContext("2d"),
					viewport: vp
				}).promise;
				let text = "";
				try {
					text = (await page.getTextContent()).items.map((it) => it.str).join(" ");
				} catch {}
				const d = await downscaleForUpload(cv.toDataURL("image/png").split(",")[1], "image/png");
				return {
					b64: d.b64,
					mediaType: d.mediaType,
					text,
					fileName: file.name || ""
				};
			}));
		}
		const raw = {
			b64: await readFileB64(file),
			mediaType: file.type || "image/jpeg"
		};
		const d = await downscaleForUpload(raw.b64, raw.mediaType);
		return [{
			b64: d.b64,
			mediaType: d.mediaType,
			text: "",
			fileName: file.name || "",
			orig: d.b64 !== raw.b64 ? raw : null
		}];
	}
	async function fileForStorage(file) {
		const raw = await readFileB64(file);
		const type = file.type || "application/octet-stream";
		if (/^image\//.test(type)) {
			const d = await downscaleForUpload(raw, type);
			const name = d.mediaType === type ? file.name : String(file.name || "image").replace(/\.[^.]+$/, "") + ".jpg";
			return {
				b64: d.b64,
				mediaType: d.mediaType,
				fileName: name
			};
		}
		return {
			b64: raw,
			mediaType: type,
			fileName: file.name || "document"
		};
	}
	async function filesToUploadPages(files) {
		return (await Promise.all([...Array.from(files || [])].map(fileToUploadPages))).flat();
	}
	//#endregion
	//#region src/manager/logic/functions.ts
	var FORM101_FN_URL = "https://us-central1-schedule-odinson.cloudfunctions.net/fill_form_101";
	var PREPROCESS_SCAN_FN_URL = "https://us-central1-schedule-odinson.cloudfunctions.net/preprocess_scan";
	var AI_FN_URL = "https://europe-west3-schedule-odinson.cloudfunctions.net/ai_read";
	var USERS_ADMIN_FN_URL = "https://europe-west3-schedule-odinson.cloudfunctions.net/users_admin";
	/** the functions a scan uses */
	function SCAN_WARM_URLS() {
		return [
			PREPROCESS_SCAN_FN_URL,
			FORM101_FN_URL,
			AI_FN_URL
		];
	}
	var fnWarm = {};
	function warmCloudFunctions(urls) {
		const now = Date.now();
		for (const url of urls) {
			const w = fnWarm[url];
			if (w && now - w.at < 24e4) continue;
			const rec = {
				at: now,
				ms: null
			};
			fnWarm[url] = rec;
			fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{\"ping\":true}"
			}).then(() => {
				rec.ms = Date.now() - rec.at;
			}).catch(() => {});
		}
	}
	//#endregion
	//#region src/manager/globals.ts
	Object.assign(window, {
		ManagerData: {
			on,
			setHost
		},
		uid,
		genToken,
		SESSION_KEY,
		getSession,
		saveSession,
		clearSession,
		fsTenantId,
		STORAGE_KEY_BASE,
		STORAGE_KEY,
		gsAuth,
		gsAuthQuery,
		getDataObj,
		applyData,
		API_URL,
		SESSION_EXPIRED_ERROR,
		loadFirestoreBackend,
		uploadWorkerFile,
		gsSave,
		gsLoad,
		gsSavePunch,
		gsDeletePunch,
		gsUpdatePunch,
		gsDeleteWorkerDoc,
		getPunchLog,
		savePunchLog,
		punchWindowStart,
		ALL_PUNCHES_FROM,
		ensurePunchesSince,
		ensureAllPunches,
		periodPunchStart,
		syncPunchesFromGS,
		mergeRemotePunches,
		UNSAVED_KEY,
		hasUnsavedLocal,
		dropWorkerPhotos,
		applyServerLoad,
		autoSave,
		loadData,
		watchHoursBatches,
		latestHoursBatch,
		pendingHoursCount,
		watchHrWorkers,
		queueTelemetry,
		flushTelemetry,
		reportTiming,
		markFirstContent,
		markFreshContent,
		reportError,
		hasPermission,
		NAV_TAB_PERMISSION,
		isHrSession,
		isFirmAdminSession,
		HR_HIDDEN_TABS,
		hrPayOnly,
		hrHourReview,
		tabAllowed,
		homeTab,
		MORE_TABS,
		I18N_LANGS,
		tr,
		uiLocale,
		storedLanguage,
		loadI18n,
		currentLang,
		currentDict,
		onNewerDictionary,
		esc,
		loadXlsx,
		getSundayOfWeek,
		toMins,
		calcHours,
		fmtDMY,
		analyzeDayPunches,
		groupPunchesIntoShifts,
		PAY_RULES: PAY_RULES(),
		effectiveRates,
		shiftPay,
		isDailyPay,
		dailyRate,
		shiftPayFor,
		travelPay,
		salaryPeriodKey,
		dayOverride,
		localYMD,
		wOwnRate,
		DOC_STORE,
		workerDocId,
		workerAddress,
		isActiveWorker,
		workerExpiryStatus,
		WORKER_DOC_TYPES,
		parseDocDate,
		workerDocExpiries,
		workerDocStatus,
		UPLOAD_MAX_DIM,
		downscaleForUpload,
		_loadPdfJs: loadPdfJs,
		isPdfFile,
		fileToUploadPages,
		fileForStorage,
		filesToUploadPages,
		FORM101_FN_URL,
		PREPROCESS_SCAN_FN_URL,
		AI_FN_URL,
		USERS_ADMIN_FN_URL,
		SCAN_WARM_URLS,
		__fnWarm: fnWarm,
		warmCloudFunctions
	});
	for (const k of [
		"workers",
		"clients",
		"suppliers"
	]) Object.defineProperty(window, k, {
		get: () => state[k],
		set: (v) => {
			state[k] = v;
		},
		configurable: true
	});
	Object.defineProperty(window, "__dataReady", {
		get: () => state.ready,
		set: (v) => {
			state.ready = !!v;
		},
		configurable: true
	});
	var getters = {
		__uploadsInFlight: uploadsRunning,
		__punchLoadedFrom: punchLoadedFrom,
		__punchSynced: punchSynced,
		__hoursBatches: hoursBatches,
		I18N_LANG: currentLang,
		I18N: currentDict
	};
	for (const [name, get] of Object.entries(getters)) Object.defineProperty(window, name, {
		get,
		configurable: true
	});
	setHost({ canWriteWorkers: () => hasPermission("workers") || hasPermission("schedule") });
	installDispatcher();
	installTelemetryFlush();
	loadFirestoreBackend().catch((e) => console.warn("Firestore backend:", e));
	//#endregion
})();
