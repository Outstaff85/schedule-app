// GENERATED from src/lib/payroll.ts by scripts/build-globals.mjs — never edit
// by hand: change the TypeScript and run `node scripts/build-globals.mjs`
// (npm run build fails while this file is stale). Defines the global `Payroll`
// used by the old pages (docs/accounting.md → Payroll module).
var Payroll = (function(exports) {
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	//#region src/lib/payroll.ts
	var PAY_RULES = {
		regularMax: 8,
		ot1Span: 2,
		roundMinutes: 0,
		otMult: 1.25,
		shabbatMult: 1.5
	};
	function roundMins(m) {
		const n = PAY_RULES.roundMinutes;
		return n > 0 ? Math.round(m / n) * n : m;
	}
	function localYMD(d) {
		return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
	}
	var tsOf = (p) => new Date(p.ts).getTime();
	var minsFull = (t) => {
		const [h, m] = t.split(":").map(Number);
		return h * 60 + m;
	};
	var minsShort = (t) => {
		const [h, m] = t.split(":").map(Number);
		return h * 60 + (m || 0);
	};
	var nowHHMM = () => {
		const n = /* @__PURE__ */ new Date();
		return String(n.getHours()).padStart(2, "0") + ":" + String(n.getMinutes()).padStart(2, "0");
	};
	function analyzeDayPunches(entries, date, opts) {
		const chrono = [...entries].sort((a, b) => tsOf(a) - tsOf(b));
		let hours = 0, openIn = null;
		const warnings = [];
		const tr = opts && opts.tr;
		if (!tr) {
			chrono.forEach((e) => {
				if (e.type === "in") openIn = e;
				else if (e.type === "out") {
					if (!openIn) return;
					if (!openIn.time || !e.time) {
						openIn = null;
						return;
					}
					let dur = minsShort(e.time) - minsShort(openIn.time);
					if (dur < 0) dur += 1440;
					hours += dur / 60;
					openIn = null;
				}
			});
			return {
				hours,
				warnings
			};
		}
		chrono.forEach((e) => {
			if (e.type === "in") {
				if (openIn) warnings.push(tr("double IN (no OUT after {0})", { 0: openIn.time }));
				openIn = e;
			} else if (e.type === "out") {
				if (!openIn) {
					warnings.push(tr("OUT without IN ({0})", { 0: e.time }));
					return;
				}
				if (!openIn.time || !e.time) {
					openIn = null;
					return;
				}
				let dur = minsFull(e.time) - minsFull(openIn.time);
				if (dur < 0) dur += 1440;
				dur = roundMins(dur);
				const hh = dur / 60;
				if (hh <= 0) warnings.push(tr("0-minute shift ({0}→{1})", {
					0: openIn.time,
					1: e.time
				}));
				else if (hh > 12) warnings.push(tr("shift >12h ({0}→{1})", {
					0: openIn.time,
					1: e.time
				}));
				hours += hh;
				openIn = null;
			}
		});
		const open = openIn;
		if (open) {
			const isToday = (/* @__PURE__ */ new Date()).toDateString() === new Date(date).toDateString();
			warnings.push(tr(isToday ? "open shift from {0} (still at work)" : "open shift from {0} — no OUT", { 0: open.time }));
			if (isToday && open.time) {
				let dur = minsFull(nowHHMM()) - minsFull(open.time);
				if (dur < 0) dur += 1440;
				dur = roundMins(dur);
				hours += dur / 60;
			}
		}
		return {
			hours,
			warnings
		};
	}
	function groupPunchesIntoShifts(entries) {
		const chrono = [...entries].sort((a, b) => tsOf(a) - tsOf(b));
		const buckets = [];
		let cur = null;
		chrono.forEach((e) => {
			if (e.type === "in") {
				if (cur) buckets.push(cur);
				cur = {
					date: new Date(e.ts),
					entries: [e]
				};
			} else {
				if (!cur) cur = {
					date: new Date(e.ts),
					entries: []
				};
				cur.entries.push(e);
				buckets.push(cur);
				cur = null;
			}
		});
		const last = cur;
		if (last) buckets.push(last);
		return buckets;
	}
	function israeliDayPay(hours, rate, isSat) {
		const base = isSat ? 1.5 : 1, ot1 = isSat ? 1.75 : 1.25, ot2 = isSat ? 2 : 1.5;
		const RM = PAY_RULES.regularMax, O1 = PAY_RULES.ot1Span;
		const reg = Math.min(hours, RM), o1 = Math.min(Math.max(hours - RM, 0), O1), o2 = Math.max(hours - (RM + O1), 0);
		const regularPay = reg * rate * base, otPay = o1 * rate * ot1 + o2 * rate * ot2;
		return {
			regularPay,
			otPay,
			total: regularPay + otPay,
			isSat
		};
	}
	function effectiveRates(w, clientId, clients) {
		const ov = clientId && w && w.clientRates && w.clientRates[clientId];
		const cl = clientId && clients.find((c) => c.id === clientId);
		const set = (v) => v != null && v !== "";
		const own = set(w && w.regRate) ? w.regRate : Number(w && w.hourlyRate) > 0 ? w.hourlyRate : null;
		const pick = (ovVal, wVal, clVal, fallback) => {
			if (set(ovVal)) return {
				val: Number(ovVal),
				has: true,
				src: "override"
			};
			if (set(wVal)) return {
				val: Number(wVal),
				has: true,
				src: "worker"
			};
			if (set(clVal)) return {
				val: Number(clVal),
				has: true,
				src: "client"
			};
			return {
				val: fallback,
				has: false,
				src: ""
			};
		};
		const reg = pick(ov && ov.rate, own, cl && cl.defaultHourlyRate, 0);
		const ot = pick(ov && ov.otRate, w && w.otRate, cl && cl.defaultOtRate, Math.round(reg.val * PAY_RULES.otMult * 100) / 100);
		const shab = pick(ov && ov.shabbatRate, w && w.shabbatRate, cl && cl.defaultShabbatRate, Math.round(reg.val * PAY_RULES.shabbatMult * 100) / 100);
		return {
			regRate: reg.val,
			otRate: ot.val,
			shabbatRate: shab.val,
			hasOtOverride: ot.has,
			hasShabbatOverride: shab.has,
			src: reg.src,
			otSrc: ot.src,
			shabbatSrc: shab.src
		};
	}
	function shiftPay(hours, w, isSat, clientId, clients) {
		const RM = PAY_RULES.regularMax, r = effectiveRates(w, clientId, clients);
		if (isSat) {
			if (r.hasShabbatOverride) return hours * r.shabbatRate;
			return israeliDayPay(hours, r.regRate, true).total;
		}
		if (r.hasOtOverride) return Math.min(hours, RM) * r.regRate + Math.max(hours - RM, 0) * r.otRate;
		return israeliDayPay(hours, r.regRate, false).total;
	}
	function wOwnRate(w) {
		if (!w) return "";
		if (w.regRate != null && w.regRate !== "") return w.regRate;
		return Number(w.hourlyRate) > 0 ? w.hourlyRate : "";
	}
	function isDailyPay(w) {
		return !!(w && w.payMode === "daily");
	}
	function dailyRate(w) {
		return Number(wOwnRate(w)) || 0;
	}
	function shiftPayFor(hours, w, isSat, clientId, date, seenDays, clients) {
		if (isDailyPay(w)) {
			const k = localYMD(date);
			if (seenDays.has(k)) return 0;
			seenDays.add(k);
			return dailyRate(w);
		}
		return shiftPay(hours, w, isSat, clientId, clients);
	}
	function travelPay(w, days, months) {
		return (Number(w && w.travelAllowance) || 0) * days + (Number(w && w.travelMonthly) || 0) * months;
	}
	function salaryPeriodKey(period, now) {
		now = now || /* @__PURE__ */ new Date();
		if (period === "week") {
			const ws = new Date(now);
			ws.setDate(ws.getDate() - ws.getDay());
			return "w:" + localYMD(ws);
		}
		if (period === "month") return "m:" + localYMD(now).slice(0, 7);
		return period || "all";
	}
	function dayOverride(w, key) {
		const v = w && w.dayOverrides && w.dayOverrides[key];
		return v == null || v === "" ? null : Number(v);
	}
	//#endregion
	exports.PAY_RULES = PAY_RULES;
	exports.analyzeDayPunches = analyzeDayPunches;
	exports.dailyRate = dailyRate;
	exports.dayOverride = dayOverride;
	exports.effectiveRates = effectiveRates;
	exports.groupPunchesIntoShifts = groupPunchesIntoShifts;
	exports.isDailyPay = isDailyPay;
	exports.israeliDayPay = israeliDayPay;
	exports.localYMD = localYMD;
	exports.roundMins = roundMins;
	exports.salaryPeriodKey = salaryPeriodKey;
	exports.shiftPay = shiftPay;
	exports.shiftPayFor = shiftPayFor;
	exports.travelPay = travelPay;
	exports.wOwnRate = wOwnRate;
	return exports;
})({});
