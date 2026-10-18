// The page's names for the pay functions (docs/accounting.md → Payroll
// module): one-line wrappers over the global Payroll (payroll.js, built from
// src/lib/payroll.ts) that pass the firm's clients and the translation. Kept
// as wrappers over that global on purpose: the browser tests check that the
// page's pay comes from payroll.js. The React pieces import src/lib/payroll.ts.
import type * as PayrollModule from '../../lib/payroll';
import { state, type Rec } from '../data/state';
import { tr } from './i18n';

declare const Payroll: typeof PayrollModule;
/* eslint-disable @typescript-eslint/no-explicit-any */
type W = any;

// Pair a day's punches chronologically; total hours and the anomalies.
export function analyzeDayPunches(entries: Rec[], date: unknown) { return Payroll.analyzeDayPunches(entries as any, date as any, {tr}); }
// Pair one worker's punches into shifts chronologically, across midnight.
export function groupPunchesIntoShifts(entries: Rec[]) { return Payroll.groupPunchesIntoShifts(entries as any); }
export const PAY_RULES = (): typeof PayrollModule.PAY_RULES => Payroll.PAY_RULES;
// Effective per-hour rates: worker.clientRates[clientId] > the worker's own > the client's.
export function effectiveRates(w: W, clientId: unknown) { return Payroll.effectiveRates(w, clientId as any, state.clients as any); }
// Pay for one shift's hours: the law tiers, or a flat OT/Shabbat rate when one is set.
export function shiftPay(hours: number, w: W, isSat: boolean, clientId: unknown) { return Payroll.shiftPay(hours, w, isSat, clientId as any, state.clients as any); }
// Daily pay (w.payMode === 'daily'): the worker's own rate, as ₪/day, once a day worked.
export function isDailyPay(w: W) { return Payroll.isDailyPay(w); }
export function dailyRate(w: W) { return Payroll.dailyRate(w); }
// One shift's pay, for every payroll figure. seenDays is a Set kept per
// worker over the period: a daily-paid worker's later shifts on a day
// already paid pay 0.
export function shiftPayFor(hours: number, w: W, isSat: boolean, clientId: unknown, date: unknown, seenDays: unknown) { return Payroll.shiftPayFor(hours, w, isSat, clientId as any, date as any, seenDays as any, state.clients as any); }
export function travelPay(w: W, days: number, months: number) { return Payroll.travelPay(w, days, months); }
export function salaryPeriodKey(period: unknown, now: unknown) { return Payroll.salaryPeriodKey(period as any, now as any); }
export function dayOverride(w: W, key: unknown) { return Payroll.dayOverride(w, key as any); }
// Local-date YYYY-MM-DD — toISOString() is UTC, which in Israel turns Sunday
// 00:00 local into the previous Saturday's date.
export function localYMD(d: Date) { return Payroll.localYMD(d); }
// The worker's own regular rate (hourlyRate, or the older regRate); '' = none.
export function wOwnRate(w: W) { return Payroll.wOwnRate(w); }
