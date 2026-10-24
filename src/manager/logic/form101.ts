// The values a Form 101 is built from (functions/main.py `fill_form_101`,
// docs/form101.md): the worker record's fields, the firm's employer block and
// the signing date — moved out of the page's aiFillForm101 (React migration
// 8f; the same values in the same shape). Pure: it never draws or calls.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { workerAddress, workerDocId } from './workers';

/** The request body's data part for a worker (`targetWorker`, null: an empty form), its document type and the firm profile. */
export function form101Payload(targetWorker: any, isId: any, profile: any): Record<string, any> {
  const surname=(targetWorker&&targetWorker.docSurname)||'';
  const given=(targetWorker&&targetWorker.docGiven)||'';
  const dob=(targetWorker&&targetWorker.docDob)||'';
  const sex=(targetWorker&&targetWorker.docSex)||'';
  const no=workerDocId(targetWorker||{})||'';
  // No separate "nationality" field in the unified form — isId (Israeli ID
  // vs. foreign passport, matching w.docType) is the single source of truth.
  const isIsraeli=isId;
  const signDateSrc=(targetWorker&&targetWorker.createdAt)?new Date(targetWorker.createdAt):new Date();
  const signDate=isNaN(+signDateSrc)?new Date():signDateSrc;
  const signDateStr=String(signDate.getDate()).padStart(2,'0')+'/'+String(signDate.getMonth()+1).padStart(2,'0')+'/'+signDate.getFullYear();

  const payload: any={
    isId, isIsraeli, surname, given, dob, sex, no,
    signDate: signDateStr,
    workerPhone: (targetWorker&&targetWorker.phone)||'',
    incomeType: targetWorker&&targetWorker.incomeType,
    otherIncomeType: targetWorker&&targetWorker.otherIncomeType,
    employer: profile ? {
      companyName: profile.companyName, street: profile.street, streetNumber: profile.streetNumber,
      city: profile.city, phone: profile.phone, deductionsFileNumber: profile.deductionsFileNumber,
    } : null,
  };

  // Israeli ID: address, marital, work start, fund, children — all from
  // the worker record (saveWorker() already wrote everything the unified
  // modal collected onto it before this function was ever called).
  let addr: any,city: any,marital: any,workStart: any,fund: any,children: any;
  if(isId){
    // The street and the house number go apart (street / houseNumber: a number
    // such as "12א" stays whole); `address` keeps both in one string for an
    // older server (functions/main.py's _split_street()).
    addr=(workerAddress(targetWorker||{})+' '+((targetWorker&&targetWorker.houseNumber)||'')).trim();
    city=(targetWorker&&targetWorker.city)||'';
    marital=(targetWorker&&targetWorker.maritalStatus)||'';
    workStart=(targetWorker&&targetWorker.workStartDate)||'';
    fund=(targetWorker&&targetWorker.healthFund)||'';
    // Children table — only the Israeli-ID branch has one (from the ID's
    // ספח, manually editable in the modal as a fallback for a failed scan).
    children=(targetWorker&&targetWorker.docChildren)||[];
    Object.assign(payload,{address:addr,street:workerAddress(targetWorker||{}),houseNumber:(targetWorker&&targetWorker.houseNumber)||'',city,marital,workStart,healthFund:fund,children});
  } else {
    workStart=(targetWorker&&targetWorker.workStartDate)||'';
    fund=(targetWorker&&targetWorker.healthFund)||'';
    // A foreign-passport worker defaults to single server-side unless a
    // status was set (e.g. married with a spouse entered).
    marital=(targetWorker&&targetWorker.maritalStatus)||'';
    // Address in Israel and children, typed in by hand for a foreign
    // worker — printed in the same boxes as for an Israeli ID.
    addr=(workerAddress(targetWorker||{})+' '+((targetWorker&&targetWorker.houseNumber)||'')).trim();
    city=(targetWorker&&targetWorker.city)||'';
    children=(targetWorker&&targetWorker.docChildren)||[];
    Object.assign(payload,{workStart,healthFund:fund,marital,address:addr,street:workerAddress(targetWorker||{}),houseNumber:(targetWorker&&targetWorker.houseNumber)||'',city,children});
  }
  // Form 101 section ו (spouse), either document type.
  const tw=targetWorker||{};
  if(tw.spouseSurname||tw.spouseGiven||tw.spouseId||tw.spouseDob||tw.spouseIncome){
    payload.spouse={surname:tw.spouseSurname||'',given:tw.spouseGiven||'',idNo:tw.spouseId||'',dob:tw.spouseDob||'',income:tw.spouseIncome||''};
  }
  return payload;
}
