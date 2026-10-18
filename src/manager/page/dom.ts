// Element lookups for the manager page's own script (src/manager/page/): the
// same as document.getElementById / querySelector / querySelectorAll, loosely
// typed — that code reads and writes inputs, overlays and their hooks without
// a type for each element. Typed React code does not use these.
/* eslint-disable @typescript-eslint/no-explicit-any */
export const byId = (id: string): any => document.getElementById(id);
export const qs = (sel: string): any => document.querySelector(sel);
export const qsa = (sel: string): any => document.querySelectorAll(sel);
