// GENERATED from src/manager/data/*.ts by scripts/build-globals.mjs — never edit
// by hand: change the TypeScript and run `node scripts/build-globals.mjs`
// (npm run build fails while this file is stale). The manager page's data
// layer — session, dispatcher, load / save / cache, punches, uploads, telemetry —
// under its old global names (docs/app-core.md → Data calls).
(function() {
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
			showToast(tr("Session expired — please sign in again"));
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
			showToast(want <= ALL_PUNCHES_FROM ? tr("Loading the whole punch history…") : tr("Loading earlier punches…"), 1500);
			try {
				const older = await (await loadFirestoreBackend()).punchesBetween(fsTenantId(), want, have);
				loadedFrom = want;
				mergeRemotePunches(older);
				return true;
			} catch (e) {
				showToast(tr("Could not load earlier punches: {0}", { 0: e && e.message || e }));
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
			return await (await loadFirestoreBackend()).listenPunches(fsTenantId(), (entries) => {
				mergeRemotePunches(entries);
				if (currentTab === "dashboard") renderDashboard();
				if (currentTab === "accounting") renderAccounting();
			}, since);
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
		const mine = s && s.role === "hr" && s.ownOnly ? new Set(workers.map((w) => String(w.id))) : null;
		local.forEach((e) => {
			if (e && e.id != null && !(e.id in byId) && !(new Date(e.ts).getTime() < keepFrom) && (!mine || mine.has(String(e.workerId)))) byId[e.id] = e;
		});
		savePunchLog(Object.values(byId));
		if (currentTab === "admin") renderAdmin();
	}
	//#endregion
	//#region src/manager/data/store.ts
	function setSaveStatus(s) {
		const el = document.getElementById("saveIndicator");
		if (!el) return;
		el.className = "save-indicator " + s;
		el.querySelector("span").textContent = s === "saving" ? tr("Saving...") : tr("Saved");
	}
	function getDataObj() {
		return {
			workers,
			clients,
			suppliers,
			weekStart: weekStart.toISOString(),
			savedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
	}
	function applyData(d) {
		if (d.workers) workers = d.workers.map((w) => ({
			id: w.id || uid(),
			clientIds: w.clientIds || [],
			token: w.token || genToken(),
			status: w.status || "active",
			...w
		}));
		if (d.clients) clients = d.clients;
		if (d.suppliers) suppliers = d.suppliers;
	}
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
		if (!(hasPermission("workers") || hasPermission("schedule"))) return false;
		let n = 0;
		workers.forEach((w) => {
			if ("avatarB64" in w) {
				delete w.avatarB64;
				n++;
			}
		});
		return n > 0;
	}
	function applyServerLoad(gd) {
		if (hasUnsavedLocal()) {
			showToast(tr("Unsaved changes found on this device — saving them now"), 4e3);
			autoSave();
			return false;
		}
		applyData(gd);
		const photosDropped = dropWorkerPhotos();
		render();
		if (photosDropped) autoSave();
		const gdJson = JSON.stringify(gd);
		localStorage.setItem(STORAGE_KEY(), gdJson);
		localStorage.setItem(STORAGE_KEY_BASE, gdJson);
		return true;
	}
	var saveTimer;
	function autoSave() {
		if ((!workers || !workers.length) && (!clients || !clients.length)) {
			let hadData = false;
			try {
				const prev = JSON.parse(localStorage.getItem(STORAGE_KEY()) || "{}");
				hadData = prev.workers && prev.workers.length || prev.clients && prev.clients.length;
			} catch {}
			if (hadData) {
				console.warn("Empty state but cache has data — skipping save");
				setSaveStatus("saved");
				showToast("⚠ Empty data — save skipped");
				return;
			}
		}
		setSaveStatus("saving");
		clearTimeout(saveTimer);
		saveTimer = setTimeout(async () => {
			try {
				const data = getDataObj();
				const json = JSON.stringify(data);
				localStorage.setItem(STORAGE_KEY(), json);
				localStorage.setItem(STORAGE_KEY() + "_bak", json);
				localStorage.setItem(STORAGE_KEY_BASE, json);
				try {
					localStorage.setItem(UNSAVED_KEY(), String(Date.now()));
				} catch {}
				const ok = await gsSave(data);
				if (ok) try {
					localStorage.removeItem(UNSAVED_KEY());
				} catch {}
				setSaveStatus("saved");
				if (ok) showToast(tr("Saved"));
				else showToast(tr("Save failed — kept on this device"));
			} catch (e) {
				console.error("Save failed", e);
				setSaveStatus("saved");
				showToast(tr("Save error"));
			}
		}, 800);
	}
	async function loadData() {
		try {
			const raw = localStorage.getItem(STORAGE_KEY()) || localStorage.getItem(STORAGE_KEY() + "_bak");
			if (raw) {
				applyData(JSON.parse(raw));
				__dataReady = true;
				render();
				markFirstContent();
			}
		} catch {}
		try {
			const gd = await gsLoad();
			__dataReady = true;
			if (gd) {
				applyServerLoad(gd);
				markFreshContent("app");
				setSaveStatus("saved");
				syncPunchesFromGS();
				if (isHrSession()) watchHrWorkers();
				watchHoursBatches();
				maybeRegenAfterFirmEdit();
			} else {
				const err = loadError();
				showToast(tr("Could not load from the server — showing saved data{0}", { 0: err ? " (" + err.slice(0, 80) + ")" : "" }), 6e3);
				retryLoadDataWhenBack();
			}
		} catch (e) {
			console.error("Load failed", e);
			showToast(tr("Offline — using cached data"));
		}
		if (!__dataReady) {
			__dataReady = true;
			if (currentTab === "dashboard") renderDashboard();
			if (currentTab === "schedule") renderSchedulePage();
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
			updateHoursBadge();
			refreshBell();
			refreshCardHoursStatus();
			if (currentTab === "accounting") renderAccounting();
		})).catch((e) => {
			hoursWatched = false;
			console.warn("Hours watch failed: " + (e && e.message || e));
		});
	}
	function updateHoursBadge() {
		const tab = document.getElementById("tabAccounting");
		if (!tab) return;
		const n = (batches || []).filter((b) => b.status === "pending").length;
		let el = document.getElementById("accPendingBadge");
		if (!el) {
			el = document.createElement("span");
			el.id = "accPendingBadge";
			el.className = "tab-badge";
			tab.querySelector(".ic").appendChild(el);
		}
		el.textContent = n > 99 ? "99+" : String(n);
		el.style.display = n ? "" : "none";
		el.title = tr("{0} hours batch(es) waiting for review", { 0: n });
	}
	function latestHoursBatch(workerId) {
		return (batches || []).filter((b) => (b.entries || []).some((r) => r.workerId === workerId)).sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)))[0] || null;
	}
	function refreshCardHoursStatus() {
		if (window.ManagerIsland) window.ManagerIsland.refreshWindows();
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
		if ([
			"workerOverlay",
			"workerCardOverlay",
			"payOverlay"
		].some((id) => document.getElementById(id)?.classList.contains("open"))) {
			clearTimeout(hrRetry);
			hrRetry = setTimeout(applyHrWorkerChanges, 2e3);
			return;
		}
		const changes = hrWorkerChanges.splice(0);
		let n = 0;
		changes.forEach(({ added, removed, changed }) => {
			const gone = new Set(removed.map(String));
			const before = workers.length;
			workers = workers.filter((w) => !gone.has(String(w.id)));
			n += before - workers.length;
			added.forEach((x) => {
				if (!workers.some((w) => String(w.id) === String(x.id))) {
					workers.push(x);
					n++;
				}
			});
			(changed || []).forEach(({ data, unsaved }) => {
				const i = workers.findIndex((w) => String(w.id) === String(data.id));
				if (i < 0 || unsaved(workers[i])) return;
				workers[i] = data;
				n++;
			});
		});
		if (!n) return;
		try {
			localStorage.setItem(STORAGE_KEY(), JSON.stringify(getDataObj()));
		} catch {}
		render();
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
					if (applyServerLoad(gd)) showToast(tr("Data loaded"));
				} catch {}
				markFreshContent("app");
				syncPunchesFromGS();
				maybeRegenAfterFirmEdit();
			}
		};
		window.addEventListener("online", again);
		document.addEventListener("visibilitychange", again);
		setTimeout(again, 15e3);
	}
	//#endregion
	//#region src/manager/data/global.ts
	Object.assign(window, {
		SESSION_KEY,
		getSession,
		saveSession,
		clearSession,
		fsTenantId,
		STORAGE_KEY_BASE,
		STORAGE_KEY,
		gsAuth,
		gsAuthQuery,
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
		setSaveStatus,
		getDataObj,
		applyData,
		UNSAVED_KEY,
		hasUnsavedLocal,
		dropWorkerPhotos,
		applyServerLoad,
		autoSave,
		loadData,
		watchHoursBatches,
		updateHoursBadge,
		latestHoursBatch,
		watchHrWorkers,
		queueTelemetry,
		flushTelemetry,
		reportTiming,
		markFirstContent,
		markFreshContent,
		reportError
	});
	var getters = {
		__uploadsInFlight: uploadsRunning,
		__punchLoadedFrom: punchLoadedFrom,
		__punchSynced: punchSynced,
		__hoursBatches: hoursBatches
	};
	for (const [name, get] of Object.entries(getters)) Object.defineProperty(window, name, {
		get,
		configurable: true
	});
	installDispatcher();
	installTelemetryFlush();
	loadFirestoreBackend().catch((e) => console.warn("Firestore backend:", e));
	//#endregion
})();
