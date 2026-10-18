// The names the manager page's modules (src/manager/page/) still reach as
// globals: the state globals.ts gives as window accessors (workers, weekStart…),
// the functions the browser tests stub (gsSavePunch…), the names one
// module assigns in another, and the calls to a part loaded later (an import
// would change the order the parts run in). Loosely typed until those parts are typed.
/* eslint-disable @typescript-eslint/no-explicit-any */
export {};
declare global {
  // scan-pipeline.js and Google Maps (loaded on demand)
  var installApp: any;
  var openAiScan: any;
  var verifyFieldsBatch: any;
  var _normScanDigits: any;
  var _normScanDate: any;
  var renderScanPagesPrompt: any;
  var I18N: any;
  var I18N_LANG: any;
  var ManagerData: any;
  var PAY_RULES: any;
  var __accOpenSeq: any;
  var __dataReady: any;
  var __firmsCache: any;
  var __hourApprovalsCache: any;
  var __hoursBatches: any;
  var __punchLoadedFrom: any;
  var __punchSynced: any;
  var __shiftReqs: any;
  var __uploadsInFlight: any;
  var autoUploadWithRetry: any;
  var clients: any;
  var closeModal: any;
  var copyTextToClipboard: any;
  var currentTab: any;
  var editingClientId: any;
  var editingSupplierId: any;
  var editingWorkerId: any;
  var ensureScanPipelineLoaded: any;
  var gsSavePunch: any;
  var hourApprovalSummary: any;
  var hourApprovalsOf: any;
  var latestOf: any;
  var maybeRegenAfterFirmEdit: any;
  var openCreateUserForm: any;
  var openManualPunch: any;
  var openNotices: any;
  var openWorkerCard: any;
  var refreshTenantProfile: any;
  var regenerateAllWorkerDocs: any;
  var regenerateWorkerDoc: any;
  var render: any;
  var renderAccountControl: any;
  var renderAccounting: any;
  var renderAdmin: any;
  var renderClientsPage: any;
  var renderCrumb: any;
  var renderDashboard: any;
  var renderPagedList: any;
  var renderSchedulePage: any;
  var renderSuppliersPage: any;
  var renderWorkersPage: any;
  var salaryEntriesFor: any;
  var saveClient: any;
  var selectedClientId: any;
  var setTheme: any;
  var setupAdminPaneBar: any;
  var startNewScan: any;
  var supplierCommission: any;
  var suppliers: any;
  var todayPunchLog: any;
  var uid: any;
  var weekStart: any;
  var workerSiteName: any;
  var workerToday: any;
  var workers: any;
  // the page's state kept on window, shared with scan-pipeline.js and the React pieces
  interface Window {
    XLSX?: any; __aiAvatarB64?: any; __aiPacketOtherPages?: any; __aiRescanWorkerId?: any; __aiRescannedWorkerId?: any;
    __aiScanImage?: any; __aiScanPageThumbs?: any; __pingMs?: any; __scanPipelineReady?: any;
    __wCapturedSigPng?: any; __wDraft?: any;
  }
  // a window's own hooks on its overlay (docs/app-core.md → Layout: closing, going back)
  interface HTMLElement { __hide?: any; __onUserClose?: any; __reopen?: any; __returnTo?: any }
}
