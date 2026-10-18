// @ts-nocheck
// The manager page's own script (React migration stage 8c-2; docs/app-core.md):
// the frame (title bar, side menu / bottom bar, bell, account menu, Language
// sheet), the login and the Firms screen, the windows' open / close / return
// system, the map picker and the scan window's entry points, Form 101's upload,
// the ManagerBridge actions the React pieces call, the PWA parts. It was the
// inline <script> of schedule-manager.html; it is now a module of the page's
// Vite entry (entry.ts), the same code, in the same order. Its types are not
// checked yet (it was plain JavaScript): new code goes into typed modules
// (src/manager/data/, logic/, the React pieces), and parts of this file move
// there over time.
//
// Every top-level function and variable stays reachable under its old global
// name — the markup's onclick handlers, scan-pipeline.js, the React pieces'
// bridge and the browser tests use them — through the window accessors set
// below, so a reassignment from outside (a test's stub, the toast wrapper)
// reaches this module's own calls too, as it did when they were one script.
Object.defineProperties(window, {
  "currentTab": {get: () => currentTab, set: (v) => { currentTab = v; }, configurable: true},
  "editingWorkerId": {get: () => editingWorkerId, set: (v) => { editingWorkerId = v; }, configurable: true},
  "editingClientId": {get: () => editingClientId, set: (v) => { editingClientId = v; }, configurable: true},
  "editingSupplierId": {get: () => editingSupplierId, set: (v) => { editingSupplierId = v; }, configurable: true},
  "applyI18n": {get: () => applyI18n, set: (v) => { applyI18n = v; }, configurable: true},
  "setLanguage": {get: () => setLanguage, set: (v) => { setLanguage = v; }, configurable: true},
  "placeLangButton": {get: () => placeLangButton, set: (v) => { placeLangButton = v; }, configurable: true},
  "LOGIN_SECTORS": {get: () => LOGIN_SECTORS, configurable: true},
  "__loginSector": {get: () => __loginSector, set: (v) => { __loginSector = v; }, configurable: true},
  "__loginTimer": {get: () => __loginTimer, set: (v) => { __loginTimer = v; }, configurable: true},
  "showLoginSector": {get: () => showLoginSector, set: (v) => { showLoginSector = v; }, configurable: true},
  "startLoginShowcase": {get: () => startLoginShowcase, set: (v) => { startLoginShowcase = v; }, configurable: true},
  "loginFx": {get: () => loginFx, configurable: true},
  "I18N_LANG_EN": {get: () => I18N_LANG_EN, configurable: true},
  "syncLangButtons": {get: () => syncLangButtons, set: (v) => { syncLangButtons = v; }, configurable: true},
  "openLangSheet": {get: () => openLangSheet, set: (v) => { openLangSheet = v; }, configurable: true},
  "closeLangSheet": {get: () => closeLangSheet, set: (v) => { closeLangSheet = v; }, configurable: true},
  "renderLangList": {get: () => renderLangList, set: (v) => { renderLangList = v; }, configurable: true},
  "pickLanguage": {get: () => pickLanguage, set: (v) => { pickLanguage = v; }, configurable: true},
  "cardTables": {get: () => cardTables, set: (v) => { cardTables = v; }, configurable: true},
  "redrawForLanguage": {get: () => redrawForLanguage, set: (v) => { redrawForLanguage = v; }, configurable: true},
  "showContractNotice": {get: () => showContractNotice, set: (v) => { showContractNotice = v; }, configurable: true},
  "closeContractNotice": {get: () => closeContractNotice, set: (v) => { closeContractNotice = v; }, configurable: true},
  "applyNavPermissions": {get: () => applyNavPermissions, set: (v) => { applyNavPermissions = v; }, configurable: true},
  "openMoreSheet": {get: () => openMoreSheet, set: (v) => { openMoreSheet = v; }, configurable: true},
  "switchTab": {get: () => switchTab, set: (v) => { switchTab = v; }, configurable: true},
  "GREET_ICONS": {get: () => GREET_ICONS, configurable: true},
  "partOfDay": {get: () => partOfDay, set: (v) => { partOfDay = v; }, configurable: true},
  "GIC_CLOUD": {get: () => GIC_CLOUD, configurable: true},
  "WX_ICONS": {get: () => WX_ICONS, configurable: true},
  "weatherIconHtml": {get: () => weatherIconHtml, set: (v) => { weatherIconHtml = v; }, configurable: true},
  "greetingHtml": {get: () => greetingHtml, set: (v) => { greetingHtml = v; }, configurable: true},
  "renderGreeting": {get: () => renderGreeting, set: (v) => { renderGreeting = v; }, configurable: true},
  "CRUMB_COUNT": {get: () => CRUMB_COUNT, configurable: true},
  "renderCrumb": {get: () => renderCrumb, set: (v) => { renderCrumb = v; }, configurable: true},
  "WEATHER_FN_URL": {get: () => WEATHER_FN_URL, configurable: true},
  "__wx": {get: () => __wx, set: (v) => { __wx = v; }, configurable: true},
  "__wxAt": {get: () => __wxAt, set: (v) => { __wxAt = v; }, configurable: true},
  "__wxTid": {get: () => __wxTid, set: (v) => { __wxTid = v; }, configurable: true},
  "loadWeather": {get: () => loadWeather, set: (v) => { loadWeather = v; }, configurable: true},
  "__notifRead": {get: () => __notifRead, set: (v) => { __notifRead = v; }, configurable: true},
  "__notifReadLoaded": {get: () => __notifReadLoaded, set: (v) => { __notifReadLoaded = v; }, configurable: true},
  "__notifApprovals": {get: () => __notifApprovals, set: (v) => { __notifApprovals = v; }, configurable: true},
  "__notifApprAt": {get: () => __notifApprAt, set: (v) => { __notifApprAt = v; }, configurable: true},
  "notifEnabled": {get: () => notifEnabled, set: (v) => { notifEnabled = v; }, configurable: true},
  "notifList": {get: () => notifList, set: (v) => { notifList = v; }, configurable: true},
  "waDefaultTemplate": {get: () => waDefaultTemplate, set: (v) => { waDefaultTemplate = v; }, configurable: true},
  "__firmMsgs": {get: () => __firmMsgs, set: (v) => { __firmMsgs = v; }, configurable: true},
  "__firmMsgsAt": {get: () => __firmMsgsAt, set: (v) => { __firmMsgsAt = v; }, configurable: true},
  "loadFirmMessages": {get: () => loadFirmMessages, set: (v) => { loadFirmMessages = v; }, configurable: true},
  "waTemplate": {get: () => waTemplate, set: (v) => { waTemplate = v; }, configurable: true},
  "waPhone": {get: () => waPhone, set: (v) => { waPhone = v; }, configurable: true},
  "waMessage": {get: () => waMessage, set: (v) => { waMessage = v; }, configurable: true},
  "waLink": {get: () => waLink, set: (v) => { waLink = v; }, configurable: true},
  "openWhatsApp": {get: () => openWhatsApp, set: (v) => { openWhatsApp = v; }, configurable: true},
  "callWorker": {get: () => callWorker, set: (v) => { callWorker = v; }, configurable: true},
  "noPunchActs": {get: () => noPunchActs, set: (v) => { noPunchActs = v; }, configurable: true},
  "saveFirmMessage": {get: () => saveFirmMessage, set: (v) => { saveFirmMessage = v; }, configurable: true},
  "refreshNotifApprovals": {get: () => refreshNotifApprovals, set: (v) => { refreshNotifApprovals = v; }, configurable: true},
  "loadNotifReads": {get: () => loadNotifReads, set: (v) => { loadNotifReads = v; }, configurable: true},
  "saveNotifReads": {get: () => saveNotifReads, set: (v) => { saveNotifReads = v; }, configurable: true},
  "refreshBell": {get: () => refreshBell, set: (v) => { refreshBell = v; }, configurable: true},
  "toggleBell": {get: () => toggleBell, set: (v) => { toggleBell = v; }, configurable: true},
  "closeBell": {get: () => closeBell, set: (v) => { closeBell = v; }, configurable: true},
  "__bellItems": {get: () => __bellItems, set: (v) => { __bellItems = v; }, configurable: true},
  "drawBellPanel": {get: () => drawBellPanel, set: (v) => { drawBellPanel = v; }, configurable: true},
  "openNotif": {get: () => openNotif, set: (v) => { openNotif = v; }, configurable: true},
  "markAllNotifRead": {get: () => markAllNotifRead, set: (v) => { markAllNotifRead = v; }, configurable: true},
  "render": {get: () => render, set: (v) => { render = v; }, configurable: true},
  "blankWorkerDefaults": {get: () => blankWorkerDefaults, set: (v) => { blankWorkerDefaults = v; }, configurable: true},
  "openAddWorker": {get: () => openAddWorker, set: (v) => { openAddWorker = v; }, configurable: true},
  "openEditWorker": {get: () => openEditWorker, set: (v) => { openEditWorker = v; }, configurable: true},
  "SCAN_FIND_FIELDS": {get: () => SCAN_FIND_FIELDS, configurable: true},
  "__scanPagesCache": {get: () => __scanPagesCache, configurable: true},
  "workerScanLive": {get: () => workerScanLive, set: (v) => { workerScanLive = v; }, configurable: true},
  "workerHasScanPages": {get: () => workerHasScanPages, set: (v) => { workerHasScanPages = v; }, configurable: true},
  "workerScanPages": {get: () => workerScanPages, set: (v) => { workerScanPages = v; }, configurable: true},
  "findScanFields": {get: () => findScanFields, set: (v) => { findScanFields = v; }, configurable: true},
  "rescanFromWorkerModal": {get: () => rescanFromWorkerModal, set: (v) => { rescanFromWorkerModal = v; }, configurable: true},
  "applyWorkerDraft": {get: () => applyWorkerDraft, set: (v) => { applyWorkerDraft = v; }, configurable: true},
  "autoFindMissingScanFields": {get: () => autoFindMissingScanFields, set: (v) => { autoFindMissingScanFields = v; }, configurable: true},
  "showWorkerModal": {get: () => showWorkerModal, set: (v) => { showWorkerModal = v; }, configurable: true},
  "saveLoginField": {get: () => saveLoginField, set: (v) => { saveLoginField = v; }, configurable: true},
  "newLoginFor": {get: () => newLoginFor, set: (v) => { newLoginFor = v; }, configurable: true},
  "supplierMonthPayable": {get: () => supplierMonthPayable, set: (v) => { supplierMonthPayable = v; }, configurable: true},
  "loginsInfo": {get: () => loginsInfo, set: (v) => { loginsInfo = v; }, configurable: true},
  "saveWorker": {get: () => saveWorker, set: (v) => { saveWorker = v; }, configurable: true},
  "renderWorkerUploadProgress": {get: () => renderWorkerUploadProgress, set: (v) => { renderWorkerUploadProgress = v; }, configurable: true},
  "setWorkerStatus": {get: () => setWorkerStatus, set: (v) => { setWorkerStatus = v; }, configurable: true},
  "regenerateWorkerToken": {get: () => regenerateWorkerToken, set: (v) => { regenerateWorkerToken = v; }, configurable: true},
  "buildPunchLink": {get: () => buildPunchLink, set: (v) => { buildPunchLink = v; }, configurable: true},
  "copyWorkerLink": {get: () => copyWorkerLink, set: (v) => { copyWorkerLink = v; }, configurable: true},
  "deleteWorkerNow": {get: () => deleteWorkerNow, set: (v) => { deleteWorkerNow = v; }, configurable: true},
  "openAddClient": {get: () => openAddClient, set: (v) => { openAddClient = v; }, configurable: true},
  "openEditClient": {get: () => openEditClient, set: (v) => { openEditClient = v; }, configurable: true},
  "showClientModal": {get: () => showClientModal, set: (v) => { showClientModal = v; }, configurable: true},
  "saveClient": {get: () => saveClient, set: (v) => { saveClient = v; }, configurable: true},
  "commitClient": {get: () => commitClient, set: (v) => { commitClient = v; }, configurable: true},
  "closeEditorUnsaved": {get: () => closeEditorUnsaved, set: (v) => { closeEditorUnsaved = v; }, configurable: true},
  "punchFromClientModal": {get: () => punchFromClientModal, set: (v) => { punchFromClientModal = v; }, configurable: true},
  "deleteClientsNow": {get: () => deleteClientsNow, set: (v) => { deleteClientsNow = v; }, configurable: true},
  "GOOGLE_MAPS_API_KEY": {get: () => GOOGLE_MAPS_API_KEY, configurable: true},
  "MAP_PICK_DEFAULT_CENTER": {get: () => MAP_PICK_DEFAULT_CENTER, configurable: true},
  "_gmapsLoading": {get: () => _gmapsLoading, set: (v) => { _gmapsLoading = v; }, configurable: true},
  "__mapPick": {get: () => __mapPick, set: (v) => { __mapPick = v; }, configurable: true},
  "__mapPickDone": {get: () => __mapPickDone, set: (v) => { __mapPickDone = v; }, configurable: true},
  "loadGoogleMaps": {get: () => loadGoogleMaps, set: (v) => { loadGoogleMaps = v; }, configurable: true},
  "openMapPicker": {get: () => openMapPicker, set: (v) => { openMapPicker = v; }, configurable: true},
  "mapPickSetPos": {get: () => mapPickSetPos, set: (v) => { mapPickSetPos = v; }, configurable: true},
  "mapPickSetRadius": {get: () => mapPickSetRadius, set: (v) => { mapPickSetRadius = v; }, configurable: true},
  "mapPickUseMyLocation": {get: () => mapPickUseMyLocation, set: (v) => { mapPickUseMyLocation = v; }, configurable: true},
  "saveMapPick": {get: () => saveMapPick, set: (v) => { saveMapPick = v; }, configurable: true},
  "workersMonthHours": {get: () => workersMonthHours, set: (v) => { workersMonthHours = v; }, configurable: true},
  "todayPunchLog": {get: () => todayPunchLog, set: (v) => { todayPunchLog = v; }, configurable: true},
  "workerToday": {get: () => workerToday, set: (v) => { workerToday = v; }, configurable: true},
  "workerSiteName": {get: () => workerSiteName, set: (v) => { workerSiteName = v; }, configurable: true},
  "workerNotices": {get: () => workerNotices, set: (v) => { workerNotices = v; }, configurable: true},
  "workerBarColor": {get: () => workerBarColor, set: (v) => { workerBarColor = v; }, configurable: true},
  "setWorkersStatus": {get: () => setWorkersStatus, set: (v) => { setWorkersStatus = v; }, configurable: true},
  "openNotices": {get: () => openNotices, set: (v) => { openNotices = v; }, configurable: true},
  "runRowFn": {get: () => runRowFn, set: (v) => { runRowFn = v; }, configurable: true},
  "renderWorkersPage": {get: () => renderWorkersPage, set: (v) => { renderWorkersPage = v; }, configurable: true},
  "openWorkerCard": {get: () => openWorkerCard, set: (v) => { openWorkerCard = v; }, configurable: true},
  "editFromWorkerCard": {get: () => editFromWorkerCard, set: (v) => { editFromWorkerCard = v; }, configurable: true},
  "rescanFromWorkerCard": {get: () => rescanFromWorkerCard, set: (v) => { rescanFromWorkerCard = v; }, configurable: true},
  "openWorkerDocUpload": {get: () => openWorkerDocUpload, set: (v) => { openWorkerDocUpload = v; }, configurable: true},
  "openHoursImportModal": {get: () => openHoursImportModal, set: (v) => { openHoursImportModal = v; }, configurable: true},
  "parseHoursExcelFile": {get: () => parseHoursExcelFile, set: (v) => { parseHoursExcelFile = v; }, configurable: true},
  "parseHoursImagePage": {get: () => parseHoursImagePage, set: (v) => { parseHoursImagePage = v; }, configurable: true},
  "openHoursExportModal": {get: () => openHoursExportModal, set: (v) => { openHoursExportModal = v; }, configurable: true},
  "renderClientsPage": {get: () => renderClientsPage, set: (v) => { renderClientsPage = v; }, configurable: true},
  "renderSuppliersPage": {get: () => renderSuppliersPage, set: (v) => { renderSuppliersPage = v; }, configurable: true},
  "openAddSupplier": {get: () => openAddSupplier, set: (v) => { openAddSupplier = v; }, configurable: true},
  "openEditSupplier": {get: () => openEditSupplier, set: (v) => { openEditSupplier = v; }, configurable: true},
  "showSupplierModal": {get: () => showSupplierModal, set: (v) => { showSupplierModal = v; }, configurable: true},
  "commitSupplier": {get: () => commitSupplier, set: (v) => { commitSupplier = v; }, configurable: true},
  "deleteSuppliersNow": {get: () => deleteSuppliersNow, set: (v) => { deleteSuppliersNow = v; }, configurable: true},
  "openManualPunch": {get: () => openManualPunch, set: (v) => { openManualPunch = v; }, configurable: true},
  "addManualPunch": {get: () => addManualPunch, set: (v) => { addManualPunch = v; }, configurable: true},
  "closeModal": {get: () => closeModal, set: (v) => { closeModal = v; }, configurable: true},
  "_overlayDownOn": {get: () => _overlayDownOn, set: (v) => { _overlayDownOn = v; }, configurable: true},
  "MODAL_CHAIN_MS": {get: () => MODAL_CHAIN_MS, configurable: true},
  "__lastModalClose": {get: () => __lastModalClose, set: (v) => { __lastModalClose = v; }, configurable: true},
  "__reopeningModal": {get: () => __reopeningModal, set: (v) => { __reopeningModal = v; }, configurable: true},
  "reopenModal": {get: () => reopenModal, set: (v) => { reopenModal = v; }, configurable: true},
  "setSaveStatus": {get: () => setSaveStatus, set: (v) => { setSaveStatus = v; }, configurable: true},
  "updateHoursBadge": {get: () => updateHoursBadge, set: (v) => { updateHoursBadge = v; }, configurable: true},
  "LOGIN_FN_URL": {get: () => LOGIN_FN_URL, configurable: true},
  "goToSupplierPortal": {get: () => goToSupplierPortal, set: (v) => { goToSupplierPortal = v; }, configurable: true},
  "goToClientPortal": {get: () => goToClientPortal, set: (v) => { goToClientPortal = v; }, configurable: true},
  "logout": {get: () => logout, set: (v) => { logout = v; }, configurable: true},
  "submitLogin": {get: () => submitLogin, set: (v) => { submitLogin = v; }, configurable: true},
  "switchToTenant": {get: () => switchToTenant, set: (v) => { switchToTenant = v; }, configurable: true},
  "backToFirmsList": {get: () => backToFirmsList, set: (v) => { backToFirmsList = v; }, configurable: true},
  "cacheTenantProfile": {get: () => cacheTenantProfile, set: (v) => { cacheTenantProfile = v; }, configurable: true},
  "gateApp": {get: () => gateApp, set: (v) => { gateApp = v; }, configurable: true},
  "renderAccountControl": {get: () => renderAccountControl, set: (v) => { renderAccountControl = v; }, configurable: true},
  "THEME_BAR": {get: () => THEME_BAR, configurable: true},
  "storedTheme": {get: () => storedTheme, set: (v) => { storedTheme = v; }, configurable: true},
  "resolveTheme": {get: () => resolveTheme, set: (v) => { resolveTheme = v; }, configurable: true},
  "applyTheme": {get: () => applyTheme, set: (v) => { applyTheme = v; }, configurable: true},
  "setTheme": {get: () => setTheme, set: (v) => { setTheme = v; }, configurable: true},
  "pickTheme": {get: () => pickTheme, set: (v) => { pickTheme = v; }, configurable: true},
  "toggleAccountMenu": {get: () => toggleAccountMenu, set: (v) => { toggleAccountMenu = v; }, configurable: true},
  "closeAccountMenu": {get: () => closeAccountMenu, set: (v) => { closeAccountMenu = v; }, configurable: true},
  "editMyName": {get: () => editMyName, set: (v) => { editMyName = v; }, configurable: true},
  "__firmsCache": {get: () => __firmsCache, set: (v) => { __firmsCache = v; }, configurable: true},
  "renderFirmsViews": {get: () => renderFirmsViews, set: (v) => { renderFirmsViews = v; }, configurable: true},
  "__firmsErr": {get: () => __firmsErr, set: (v) => { __firmsErr = v; }, configurable: true},
  "__firmsLoaded": {get: () => __firmsLoaded, set: (v) => { __firmsLoaded = v; }, configurable: true},
  "loadFirms": {get: () => loadFirms, set: (v) => { loadFirms = v; }, configurable: true},
  "firmsRows": {get: () => firmsRows, set: (v) => { firmsRows = v; }, configurable: true},
  "setTenantsActive": {get: () => setTenantsActive, set: (v) => { setTenantsActive = v; }, configurable: true},
  "deleteTenantsNow": {get: () => deleteTenantsNow, set: (v) => { deleteTenantsNow = v; }, configurable: true},
  "__profileFetchedAt": {get: () => __profileFetchedAt, set: (v) => { __profileFetchedAt = v; }, configurable: true},
  "refreshTenantProfile": {get: () => refreshTenantProfile, set: (v) => { refreshTenantProfile = v; }, configurable: true},
  "__firmWin": {get: () => __firmWin, set: (v) => { __firmWin = v; }, configurable: true},
  "showFirmWindow": {get: () => showFirmWindow, set: (v) => { showFirmWindow = v; }, configurable: true},
  "openCreateFirmForm": {get: () => openCreateFirmForm, set: (v) => { openCreateFirmForm = v; }, configurable: true},
  "openEditFirmForm": {get: () => openEditFirmForm, set: (v) => { openEditFirmForm = v; }, configurable: true},
  "openMyFirmForm": {get: () => openMyFirmForm, set: (v) => { openMyFirmForm = v; }, configurable: true},
  "firmSaved": {get: () => firmSaved, set: (v) => { firmSaved = v; }, configurable: true},
  "setupAdminPaneBar": {get: () => setupAdminPaneBar, set: (v) => { setupAdminPaneBar = v; }, configurable: true},
  "__usersFetch": {get: () => __usersFetch, set: (v) => { __usersFetch = v; }, configurable: true},
  "__usersErr": {get: () => __usersErr, set: (v) => { __usersErr = v; }, configurable: true},
  "fetchAdminUsers": {get: () => fetchAdminUsers, set: (v) => { fetchAdminUsers = v; }, configurable: true},
  "prefetchAdminUsers": {get: () => prefetchAdminUsers, set: (v) => { prefetchAdminUsers = v; }, configurable: true},
  "__adminPane": {get: () => __adminPane, set: (v) => { __adminPane = v; }, configurable: true},
  "switchAdminPane": {get: () => switchAdminPane, set: (v) => { switchAdminPane = v; }, configurable: true},
  "showUserWindow": {get: () => showUserWindow, set: (v) => { showUserWindow = v; }, configurable: true},
  "openCreateUserForm": {get: () => openCreateUserForm, set: (v) => { openCreateUserForm = v; }, configurable: true},
  "openEditUserForm": {get: () => openEditUserForm, set: (v) => { openEditUserForm = v; }, configurable: true},
  "userSaved": {get: () => userSaved, set: (v) => { userSaved = v; }, configurable: true},
  "adminTeam": {get: () => adminTeam, set: (v) => { adminTeam = v; }, configurable: true},
  "deleteUsersNow": {get: () => deleteUsersNow, set: (v) => { deleteUsersNow = v; }, configurable: true},
  "__hrUsersLoaded": {get: () => __hrUsersLoaded, set: (v) => { __hrUsersLoaded = v; }, configurable: true},
  "ensureHrUsers": {get: () => ensureHrUsers, set: (v) => { ensureHrUsers = v; }, configurable: true},
  "hrUsers": {get: () => hrUsers, set: (v) => { hrUsers = v; }, configurable: true},
  "hrNameOf": {get: () => hrNameOf, set: (v) => { hrNameOf = v; }, configurable: true},
  "__logPeriod": {get: () => __logPeriod, configurable: true},
  "__logErr": {get: () => __logErr, configurable: true},
  "loadLogPane": {get: () => loadLogPane, set: (v) => { loadLogPane = v; }, configurable: true},
  "logPaneSnapshot": {get: () => logPaneSnapshot, set: (v) => { logPaneSnapshot = v; }, configurable: true},
  "resetLogs": {get: () => resetLogs, set: (v) => { resetLogs = v; }, configurable: true},
  "__rowFns": {get: () => __rowFns, configurable: true},
  "__rowFnSeq": {get: () => __rowFnSeq, set: (v) => { __rowFnSeq = v; }, configurable: true},
  "rowFnKey": {get: () => rowFnKey, set: (v) => { rowFnKey = v; }, configurable: true},
  "t3Line": {get: () => t3Line, set: (v) => { t3Line = v; }, configurable: true},
  "renderDashboard": {get: () => renderDashboard, set: (v) => { renderDashboard = v; }, configurable: true},
  "renderSchedulePage": {get: () => renderSchedulePage, set: (v) => { renderSchedulePage = v; }, configurable: true},
  "workerHeadOf": {get: () => workerHeadOf, set: (v) => { workerHeadOf = v; }, configurable: true},
  "docExpiryMap": {get: () => docExpiryMap, set: (v) => { docExpiryMap = v; }, configurable: true},
  "accPeriod": {get: () => accPeriod, set: (v) => { accPeriod = v; }, configurable: true},
  "__accOpenSeq": {get: () => __accOpenSeq, set: (v) => { __accOpenSeq = v; }, configurable: true},
  "accData": {get: () => accData, set: (v) => { accData = v; }, configurable: true},
  "salaryEntriesFor": {get: () => salaryEntriesFor, set: (v) => { salaryEntriesFor = v; }, configurable: true},
  "commissionFor": {get: () => commissionFor, set: (v) => { commissionFor = v; }, configurable: true},
  "supplierCommission": {get: () => supplierCommission, set: (v) => { supplierCommission = v; }, configurable: true},
  "hourApprovalSummary": {get: () => hourApprovalSummary, set: (v) => { hourApprovalSummary = v; }, configurable: true},
  "renderAccounting": {get: () => renderAccounting, set: (v) => { renderAccounting = v; }, configurable: true},
  "setAccTab": {get: () => setAccTab, set: (v) => { setAccTab = v; }, configurable: true},
  "HOURS_REVIEW_FN_URL": {get: () => HOURS_REVIEW_FN_URL, configurable: true},
  "hoursCall": {get: () => hoursCall, set: (v) => { hoursCall = v; }, configurable: true},
  "HOUR_APPROVALS_TTL": {get: () => HOUR_APPROVALS_TTL, configurable: true},
  "__hourApprovalsCache": {get: () => __hourApprovalsCache, set: (v) => { __hourApprovalsCache = v; }, configurable: true},
  "hourApprovalsOf": {get: () => hourApprovalsOf, set: (v) => { hourApprovalsOf = v; }, configurable: true},
  "openSignedHours": {get: () => openSignedHours, set: (v) => { openSignedHours = v; }, configurable: true},
  "bulkHoursBatches": {get: () => bulkHoursBatches, set: (v) => { bulkHoursBatches = v; }, configurable: true},
  "approveHoursBatch": {get: () => approveHoursBatch, set: (v) => { approveHoursBatch = v; }, configurable: true},
  "rejectHoursBatch": {get: () => rejectHoursBatch, set: (v) => { rejectHoursBatch = v; }, configurable: true},
  "canEditPay": {get: () => canEditPay, set: (v) => { canEditPay = v; }, configurable: true},
  "openWorkerCardById": {get: () => openWorkerCardById, set: (v) => { openWorkerCardById = v; }, configurable: true},
  "payWindowAllowed": {get: () => payWindowAllowed, set: (v) => { payWindowAllowed = v; }, configurable: true},
  "openPayModal": {get: () => openPayModal, set: (v) => { openPayModal = v; }, configurable: true},
  "latestOf": {get: () => latestOf, set: (v) => { latestOf = v; }, configurable: true},
  "workerClientName": {get: () => workerClientName, set: (v) => { workerClientName = v; }, configurable: true},
  "punchSite": {get: () => punchSite, set: (v) => { punchSite = v; }, configurable: true},
  "LIST_PAGE": {get: () => LIST_PAGE, configurable: true},
  "__pagedLists": {get: () => __pagedLists, configurable: true},
  "renderPagedList": {get: () => renderPagedList, set: (v) => { renderPagedList = v; }, configurable: true},
  "pagedMoreHtml": {get: () => pagedMoreHtml, set: (v) => { pagedMoreHtml = v; }, configurable: true},
  "wirePagedMore": {get: () => wirePagedMore, set: (v) => { wirePagedMore = v; }, configurable: true},
  "__pagedScrollQueued": {get: () => __pagedScrollQueued, set: (v) => { __pagedScrollQueued = v; }, configurable: true},
  "__pagedUserAt": {get: () => __pagedUserAt, set: (v) => { __pagedUserAt = v; }, configurable: true},
  "__pagedUp": {get: () => __pagedUp, set: (v) => { __pagedUp = v; }, configurable: true},
  "__pagedTouchY": {get: () => __pagedTouchY, set: (v) => { __pagedTouchY = v; }, configurable: true},
  "_pagedVisibleBottom": {get: () => _pagedVisibleBottom, set: (v) => { _pagedVisibleBottom = v; }, configurable: true},
  "_pagedOnScroll": {get: () => _pagedOnScroll, set: (v) => { _pagedOnScroll = v; }, configurable: true},
  "renderAdmin": {get: () => renderAdmin, set: (v) => { renderAdmin = v; }, configurable: true},
  "loadEarlierPunchMonth": {get: () => loadEarlierPunchMonth, set: (v) => { loadEarlierPunchMonth = v; }, configurable: true},
  "savePunchEdit": {get: () => savePunchEdit, set: (v) => { savePunchEdit = v; }, configurable: true},
  "deletePunchesNow": {get: () => deletePunchesNow, set: (v) => { deletePunchesNow = v; }, configurable: true},
  "exportPunchCSV": {get: () => exportPunchCSV, set: (v) => { exportPunchCSV = v; }, configurable: true},
  "punchMonthKey": {get: () => punchMonthKey, set: (v) => { punchMonthKey = v; }, configurable: true},
  "clearPunchMonths": {get: () => clearPunchMonths, set: (v) => { clearPunchMonths = v; }, configurable: true},
  "TOAST_ICONS": {get: () => TOAST_ICONS, configurable: true},
  "toastKind": {get: () => toastKind, set: (v) => { toastKind = v; }, configurable: true},
  "showToast": {get: () => showToast, set: (v) => { showToast = v; }, configurable: true},
  "startVersionWatch": {get: () => startVersionWatch, set: (v) => { startVersionWatch = v; }, configurable: true},
  "showNewVersionBar": {get: () => showNewVersionBar, set: (v) => { showNewVersionBar = v; }, configurable: true},
  "AVATAR_SIZE": {get: () => AVATAR_SIZE, configurable: true},
  "grayscaleCanvas": {get: () => grayscaleCanvas, set: (v) => { grayscaleCanvas = v; }, configurable: true},
  "_scanPipelineLoading": {get: () => _scanPipelineLoading, set: (v) => { _scanPipelineLoading = v; }, configurable: true},
  "ensureScanPipelineLoaded": {get: () => ensureScanPipelineLoaded, set: (v) => { ensureScanPipelineLoaded = v; }, configurable: true},
  "startNewScan": {get: () => startNewScan, set: (v) => { startNewScan = v; }, configurable: true},
  "rescanWorkerDoc": {get: () => rescanWorkerDoc, set: (v) => { rescanWorkerDoc = v; }, configurable: true},
  "getSignaturePng": {get: () => getSignaturePng, set: (v) => { getSignaturePng = v; }, configurable: true},
  "aiFillForm101": {get: () => aiFillForm101, set: (v) => { aiFillForm101 = v; }, configurable: true},
  "autoUploadWithRetry": {get: () => autoUploadWithRetry, set: (v) => { autoUploadWithRetry = v; }, configurable: true},
  "regenerateWorkerDoc": {get: () => regenerateWorkerDoc, set: (v) => { regenerateWorkerDoc = v; }, configurable: true},
  "maybeRegenAfterFirmEdit": {get: () => maybeRegenAfterFirmEdit, set: (v) => { maybeRegenAfterFirmEdit = v; }, configurable: true},
  "regenerateAllWorkerDocs": {get: () => regenerateAllWorkerDocs, set: (v) => { regenerateAllWorkerDocs = v; }, configurable: true},
  "_origConsoleError": {get: () => _origConsoleError, configurable: true},
  "_origConsoleWarn": {get: () => _origConsoleWarn, configurable: true},
  "_consoleArgsText": {get: () => _consoleArgsText, set: (v) => { _consoleArgsText = v; }, configurable: true},
  "SDK_RECONNECT_NOISE_RE": {get: () => SDK_RECONNECT_NOISE_RE, configurable: true},
  "MAPS_MARKER_NOTICE_RE": {get: () => MAPS_MARKER_NOTICE_RE, configurable: true},
  "_mapsNoticeSeenToday": {get: () => _mapsNoticeSeenToday, set: (v) => { _mapsNoticeSeenToday = v; }, configurable: true},
  "_consoleNoise": {get: () => _consoleNoise, configurable: true},
  "ERROR_TOAST_RE": {get: () => ERROR_TOAST_RE, configurable: true},
  "_origShowToast": {get: () => _origShowToast, configurable: true},
  "watchErrorLine": {get: () => watchErrorLine, set: (v) => { watchErrorLine = v; }, configurable: true},
  "VAPID_PUBLIC_KEY": {get: () => VAPID_PUBLIC_KEY, configurable: true},
  "PUSH_ENABLED": {get: () => PUSH_ENABLED, configurable: true},
  "urlB64ToUint8": {get: () => urlB64ToUint8, set: (v) => { urlB64ToUint8 = v; }, configurable: true},
  "subscribeToPush": {get: () => subscribeToPush, set: (v) => { subscribeToPush = v; }, configurable: true},
  "checkPushStatus": {get: () => checkPushStatus, set: (v) => { checkPushStatus = v; }, configurable: true},
  "_installPrompt": {get: () => _installPrompt, set: (v) => { _installPrompt = v; }, configurable: true},
  "_isStandalone": {get: () => _isStandalone, set: (v) => { _isStandalone = v; }, configurable: true},
  "ensureInstallButton": {get: () => ensureInstallButton, set: (v) => { ensureInstallButton = v; }, configurable: true},
});

// --- Constants ---------------------------------------------------------------
// DAYS, DAYS_HE, WORKER_COLORS, CLIENT_COLORS are src/manager/logic/schedule.ts.

// --- State -------------------------------------------------------------------
let currentTab       = 'schedule';
let editingWorkerId = null; // the worker the window edits, by id (a reorder or delete can't shift it)
let editingClientId  = null;
let editingSupplierId = null;

// workers, clients and suppliers are the data layer's (src/manager/data/state.ts),
// weekStart and selectedClientId (the Schedule's week and site filter) the
// logic's (src/manager/logic/schedule.ts), read and replaced here under these names.

// --- Utils --------------------------------------------------------------------
// esc(), loadXlsx(), getSundayOfWeek(), toMins(), calcHours(), fmtDMY() are
// src/manager/logic/util.ts.

// ── Translations (docs/translations.md) ─────────────────────────────────────
// Every UI text in the code is English. tr('Total Pay') returns it in the
// language picked in the header from i18n/<lang>.json (English text → translation); a text
// the dictionary lacks shows in English. {name} placeholders take params:
// tr(text, {n: 3}). Static HTML marks its texts with
// data-i18n (text), data-i18n-placeholder, data-i18n-title; applyI18n()
// translates them. The language is this device's choice (the header's
// language select, English by default, setLanguage()); the layout never
// changes (left to right). Form 101 is outside this: it is
// always Hebrew.
// tr(), uiLocale(), storedLanguage(), loadI18n(), I18N_LANGS are
// src/manager/logic/i18n.ts; the page's markup and the
// Language button are here.
function applyI18n(root){
  const host = root || document;
  const keyOf = (el, attr) => { const k = '__i18n_' + attr; if(el[k] == null) el[k] = attr === 'text' ? (el.getAttribute('data-i18n') || el.textContent.trim()) : el.getAttribute('data-i18n-' + attr); return el[k]; };
  host.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = tr(keyOf(el, 'text')); });
  host.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = tr(keyOf(el, 'placeholder')); });
  host.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = tr(keyOf(el, 'title')); });
}
// The language (the Language button, .lang-btn): keeps the choice on this device and redraws in it;
// a signed-in user's choice is also saved to their account (updateMyLanguage), and login brings it back on any device.
async function setLanguage(lang, opts){
  lang = I18N_LANGS[lang] ? lang : 'en';
  try{ localStorage.setItem('uiLang', lang); }catch(e){}
  if(!(opts && opts.save === false) && getSession()){
    fetch(API_URL, {method:'POST', body: JSON.stringify({action:'updateMyLanguage', language: lang})}).catch(()=>{});
  }
  try{ await loadI18n(lang); }catch(e){}
  redrawForLanguage();
}
// The one Language button sits in the title bar, or on the screen that covers
// it (login, the super-admin's Firms screen) while that one is shown.
function placeLangButton(){
  const btn = document.getElementById('langBtn'); if(!btn) return;
  const shown = id => { const el = document.getElementById(id); return el && el.style.display && el.style.display !== 'none' ? el : null; };
  // The login screen: its corner; the super-admin's firms list: in its
  // header row, before the buttons; otherwise the title bar, before the account circle.
  const cover = shown('loginScreen');
  const firms = !cover && shown('firmsScreen') ? document.getElementById('firmsActions') : null;
  const host = cover || firms || document.querySelector('.titlebar-actions');
  btn.classList.toggle('on-cover', !!cover);
  if(!host) return;
  if(cover || firms){ if(host.firstChild !== btn) host.prepend(btn); }
  else if(btn.nextElementSibling !== document.getElementById('accountControl')) host.insertBefore(btn, document.getElementById('accountControl'));
}
['loginScreen','firmsScreen'].forEach(id => { const el = document.getElementById(id); if(el) new MutationObserver(placeLangButton).observe(el, {attributes:true, attributeFilter:['style']}); });
// The login screen's showcase: the headline turns through the sectors, the
// sector tiles light up in turn (a tap picks one and stops the turning) and
// the roles of the lit sector show below them. Runs only while the login
// screen is shown.
const LOGIN_SECTORS = [
  {title:'Staff for restaurants', roles:['Cooks','Kitchen helpers','Dishwashers','Waiters']},
  {title:'Staff for factories', roles:['Production line','Packing','Sorting','Warehouse']},
  {title:'Staff for bakeries', roles:['Bakers','Dough preparation','Packing','Night shifts']},
  {title:'Staff for catering', roles:['Event staff','Servers','Kitchen crew','Setup and cleanup']},
  {title:'Full property support', roles:['Residential and commercial','Cleaning','Maintenance and repairs','Gardening','Building care']},
  {title:'Office cleaning from 3 hours', roles:['Offices','From 3 hours a visit','Regular or one-time'], pay:true},
];
let __loginSector = 0, __loginTimer = null;
function showLoginSector(i){
  __loginSector = i;
  const rot = document.getElementById('loginRotator'), roles = document.getElementById('loginRoles');
  if(!rot || !roles) return;
  rot.classList.add('out');
  setTimeout(() => { rot.textContent = tr(LOGIN_SECTORS[i].title); rot.classList.remove('out'); }, 250);
  document.querySelectorAll('#loginSectors .login-sector').forEach(b => b.classList.toggle('active', Number(b.dataset.sector) === i));
  roles.innerHTML = LOGIN_SECTORS[i].roles.map((r, k) => `<span class="login-role" style="animation-delay:${k * 70}ms">${esc(tr(r))}</span>`).join('')
    // Office cleaning is paid on the spot: the payment apps it takes.
    + (LOGIN_SECTORS[i].pay ? `<div class="login-pay"><span class="login-pay-label"><i class="ti ti-wallet"></i> ${esc(tr('Pay with'))}</span>`
      + `<span class="pay-badge"><span class="pay-ico gpay"><b>G</b></span>Google Pay</span>`
      + `<span class="pay-badge"><span class="pay-ico paybox"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7.4" r="3.1"/><path d="M4.2 5.2 7.8 10v8.2q0 .8.8.8h6.8q.8 0 .8-.8V10l3.6-4.8"/></svg></span>PayBox</span>`
      + `<span class="pay-badge"><span class="pay-ico bit">bit</span>bit</span>`
      + `<span class="pay-badge"><span class="pay-ico bank"><i class="ti ti-building-bank"></i></span>${esc(tr('Bank transfer'))}</span>`
      + `<span class="pay-badge"><span class="pay-ico invoice"><i class="ti ti-receipt"></i></span>${esc(tr('By invoice'))}</span></div>` : '');
}
function startLoginShowcase(){
  const screen = document.getElementById('loginScreen');
  const on = screen && screen.style.display && screen.style.display !== 'none';
  clearInterval(__loginTimer); __loginTimer = null;
  if(!on){ loginFx.stop(); return; }
  loginFx.start();
  showLoginSector(__loginSector);
  if(!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches))
    __loginTimer = setInterval(() => showLoginSector((__loginSector + 1) % LOGIN_SECTORS.length), 3200);
}
document.getElementById('loginSectors').addEventListener('click', e => {
  const b = e.target.closest('.login-sector'); if(!b) return;
  clearInterval(__loginTimer); __loginTimer = null;
  showLoginSector(Number(b.dataset.sector));
});
new MutationObserver(startLoginShowcase).observe(document.getElementById('loginScreen'), {attributes:true, attributeFilter:['style']});
// The login background: a field of drifting points joined by faint lines,
// drawn toward the pointer; a soft light follows the pointer, and the tiles
// light up under it. Runs only while the login screen is shown and the page
// is visible; nothing moves with prefers-reduced-motion.
const loginFx = (() => {
  let raf = 0, pts = [], w = 0, h = 0, mouse = {x: -1e4, y: -1e4}, ctx = null;
  const cv = document.getElementById('loginFx');
  const still = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function size(){
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = cv.clientWidth; h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(Math.min(90, Math.max(28, w * h / 16000)));
    pts = Array.from({length: n}, () => ({x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35, r: Math.random() * 1.6 + .6, g: Math.random() < .35}));
  }
  function frame(){
    ctx.clearRect(0, 0, w, h);
    for(const p of pts){
      const dx = mouse.x - p.x, dy = mouse.y - p.y, d2 = dx * dx + dy * dy;
      if(d2 < 32000){ p.vx += dx * 0.000025; p.vy += dy * 0.000025; }
      p.vx *= 0.995; p.vy *= 0.995;
      const sp = Math.hypot(p.vx, p.vy); if(sp < .12){ p.vx += (Math.random() - .5) * .05; p.vy += (Math.random() - .5) * .05; }
      p.x += p.vx; p.y += p.vy;
      if(p.x < -10) p.x = w + 10; if(p.x > w + 10) p.x = -10; if(p.y < -10) p.y = h + 10; if(p.y > h + 10) p.y = -10;
    }
    for(let i = 0; i < pts.length; i++){
      const a = pts[i];
      for(let j = i + 1; j < pts.length; j++){
        const b = pts[j], dx = a.x - b.x, dy = a.y - b.y, d = dx * dx + dy * dy;
        if(d < 15000){ ctx.strokeStyle = `rgba(120,160,255,${0.16 * (1 - d / 15000)})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      }
      const mx = a.x - mouse.x, my = a.y - mouse.y, md = mx * mx + my * my;
      if(md < 26000){ ctx.strokeStyle = `rgba(109,214,160,${0.35 * (1 - md / 26000)})`; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke(); }
      ctx.fillStyle = a.g ? 'rgba(109,214,160,.75)' : 'rgba(150,185,255,.7)';
      ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2); ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  }
  function start(){ if(raf || still() || document.hidden) return; size(); raf = requestAnimationFrame(frame); }
  function stop(){ cancelAnimationFrame(raf); raf = 0; }
  const screen = document.getElementById('loginScreen');
  screen.addEventListener('pointermove', e => {
    mouse.x = e.clientX; mouse.y = e.clientY;
    screen.style.setProperty('--mx', e.clientX + 'px'); screen.style.setProperty('--my', e.clientY + 'px');
    const t = e.target.closest && e.target.closest('.login-feature, .login-sector');
    if(t){ const r = t.getBoundingClientRect(); t.style.setProperty('--cx', (e.clientX - r.left) + 'px'); t.style.setProperty('--cy', (e.clientY - r.top) + 'px'); }
  });
  screen.addEventListener('pointerleave', () => { mouse.x = mouse.y = -1e4; });
  window.addEventListener('resize', () => { if(raf) size(); });
  document.addEventListener('visibilitychange', () => { if(document.hidden) stop(); else if(screen.style.display && screen.style.display !== 'none') start(); });
  return {start, stop};
})();
// The Language button (.lang-btn, top right of every page) and its sheet: the
// button shows the current language's own name; a tap opens a sheet with a
// search field and every language of I18N_LANGS (own script + English name),
// the current one ticked; a pick goes through setLanguage. A tap outside the
// sheet or Escape closes it. The same code in all four pages — keep them the same.
const I18N_LANG_EN = {en:'English', he:'Hebrew', ru:'Russian'};
function syncLangButtons(){
  document.querySelectorAll('.lang-btn .lang-btn-name').forEach(el => { el.textContent = I18N_LANGS[I18N_LANG] || I18N_LANGS.en; });
  const ov = document.getElementById('langSheet'); if(ov && ov.classList.contains('open')) renderLangList();
}
function openLangSheet(e){
  if(e) e.stopPropagation();
  let ov = document.getElementById('langSheet');
  if(!ov){
    ov = document.createElement('div'); ov.id = 'langSheet'; ov.className = 'lang-ov';
    ov.innerHTML = '<div class="lang-sheet" role="dialog" aria-modal="true"><div class="lang-grab"></div><h4></h4><label class="lang-search"><i class="ti ti-search"></i><input type="search" autocomplete="off" spellcheck="false"></label><div class="lang-list"></div></div>';
    ov.addEventListener('click', ev => { if(ev.target === ov) closeLangSheet(); });
    ov.querySelector('input').addEventListener('input', renderLangList);
    document.body.appendChild(ov);
  }
  ov.querySelector('h4').textContent = tr('Language');
  const inp = ov.querySelector('input'); inp.value = ''; inp.placeholder = tr('Search a language');
  renderLangList();
  void ov.offsetWidth; ov.classList.add('open');
}
function closeLangSheet(){ const ov = document.getElementById('langSheet'); if(ov) ov.classList.remove('open'); }
function renderLangList(){
  const ov = document.getElementById('langSheet'); if(!ov) return;
  const q = ov.querySelector('input').value.trim().toLowerCase();
  const langs = Object.keys(I18N_LANGS).filter(l => !q || [l, I18N_LANGS[l], I18N_LANG_EN[l] || ''].join(' ').toLowerCase().includes(q));
  ov.querySelector('.lang-list').innerHTML = langs.map(l => `<button type="button" class="lang-li${l === I18N_LANG ? ' on' : ''}" data-lang="${esc(l)}" onclick="pickLanguage('${esc(l)}')"><b>${esc(I18N_LANGS[l])}</b><small>${esc(I18N_LANG_EN[l] || '')}</small>${l === I18N_LANG ? '<span class="lang-tick"><i class="ti ti-check"></i></span>' : ''}</button>`).join('')
    || `<div class="lang-none">${esc(tr('No language found'))}</div>`;
}
function pickLanguage(l){ closeLangSheet(); if(l !== I18N_LANG) setLanguage(l); }
document.addEventListener('keydown', e => { if(e.key === 'Escape') closeLangSheet(); });
// Glass buttons shine on every tap (CSS .gbtn.shine).
document.addEventListener('pointerdown', e => {
  const b = e.target.closest && e.target.closest('.gbtn'); if(!b) return;
  b.classList.remove('shine'); void b.offsetWidth; b.classList.add('shine');
  clearTimeout(b.__shineT); b.__shineT = setTimeout(() => b.classList.remove('shine'), 650);
});

// Phone layout of the tables in Admin (the Errors and Timings tables, CSS:
// table.mtable at ≤ 700 px): each cell gets its column's header as data-label,
// so a row reads as a card of "label value" lines. Runs after the section redraws.
function cardTables(root){
  root.querySelectorAll('table').forEach(t => {
    t.classList.add('mtable');
    const head = t.tHead && t.tHead.rows.length ? t.tHead.rows[t.tHead.rows.length - 1] : null;
    if(!head) return;
    const labels = [];
    [...head.cells].forEach(c => { const n = c.colSpan || 1; for(let i = 0; i < n; i++) labels.push(c.textContent.trim()); });
    [...t.tBodies, ...(t.tFoot ? [t.tFoot] : [])].forEach(b => [...b.rows].forEach(r => {
      let col = 0;
      [...r.cells].forEach(c => { if(!c.hasAttribute('data-label') && labels[col]) c.setAttribute('data-label', labels[col]); col += c.colSpan || 1; });
    }));
  });
}
(() => {
  let queued = false;
  const run = () => { queued = false; ['sectionAdmin'].forEach(id => { const el = document.getElementById(id); if(el) cardTables(el); }); };
  const mo = new MutationObserver(() => { if(!queued){ queued = true; requestAnimationFrame(run); } });
  ['sectionAdmin'].forEach(id => { const el = document.getElementById(id); if(el) mo.observe(el, {childList:true, subtree:true}); });
})();
// A newer dictionary than the one shown: redraw in it.
onNewerDictionary(()=>redrawForLanguage());
function redrawForLanguage(){
  applyI18n();
  syncLangButtons();
  try{ if(document.getElementById('loginRoles')) showLoginSector(__loginSector); }catch(e){}
  try{ const s = getSession(); if(s) renderAccountControl(s); }catch(e){}
  try{ const b = document.getElementById('installBtn'); if(b) b.innerHTML = '<i class="ti ti-download"></i><span>' + esc(tr('Install app')) + '</span>'; }catch(e){}
  try{ if(typeof render === 'function') render(); }catch(e){}
  try{ if(typeof currentTab !== 'undefined' && currentTab === 'accounting') renderAccounting(); }catch(e){}
}
// ═══ CANONICAL punch-hours calculation — single source of truth. ═══
// The one copy is src/lib/payroll.ts, loaded as payroll.js (the global
// Payroll; docs/accounting.md → Payroll module); its wrappers with the page's
// names (analyzeDayPunches, shiftPay…) are src/manager/logic/pay.ts. Do not
// add a second hours calc.
// shiftOn(), weekShifts(), workerTotalHours(), getVisible() — the Schedule's
// shifts and who it shows — are src/manager/logic/schedule.ts.

// The notice under the title bar when the app opens: how many contracts have
// expired or expire soon (workerExpiryStatus, active workers only); "Show"
// opens Today, where they are listed; ✕ hides it until the next app start.
function showContractNotice(){
  const el=document.getElementById('contractNotice'); if(!el) return;
  let closed=false; try{ closed=sessionStorage.getItem('contractNoticeClosed')==='1'; }catch(e){}
  const st=workers.map(workerExpiryStatus).filter(Boolean);
  const over=st.filter(x=>x.level==='overdue').length, soon=st.length-over;
  if(closed||!st.length||!tabAllowed('dashboard')){ el.style.display='none'; return; }
  const parts=[]; if(over) parts.push(tr('{n} expired',{n:over})); if(soon) parts.push(tr('{n} expiring soon',{n:soon}));
  el.className='contract-notice'+(over?' over':'');
  el.innerHTML=`<i class="ti ti-alert-triangle"></i><span>${esc(tr('Contracts: {list}',{list:parts.join(', ')}))}</span>
    <button type="button" class="go" onclick="switchTab('dashboard')">${esc(tr('Show'))}</button>
    <button type="button" aria-label="${esc(tr('Close'))}" onclick="closeContractNotice()">✕</button>`;
  el.style.display='';
}
function closeContractNotice(){ try{ sessionStorage.setItem('contractNoticeClosed','1'); }catch(e){} showContractNotice(); }
// A worker's status — active, contract expiry, documents (isActiveWorker,
// workerExpiryStatus, workerDocStatus, workerDocId…) — and the pay wrappers
// over payroll.js (shiftPay, effectiveRates, localYMD…) are
// src/manager/logic/workers.ts and pay.ts.

// --- Tab ---------------------------------------------------------------------
// The sections and tabs a login may see (hasPermission, tabAllowed, homeTab,
// hrPayOnly, hrHourReview, NAV_TAB_PERMISSION, MORE_TABS…) are
// src/manager/logic/access.ts. The page shows / hides:
function applyNavPermissions(){
  ['dashboard', ...Object.keys(NAV_TAB_PERMISSION)].forEach(tab=>{
    const el = document.getElementById('tab'+tab.charAt(0).toUpperCase()+tab.slice(1));
    if(!el) return;
    el.style.display = tabAllowed(tab) ? '' : 'none';
  });
  const more = document.getElementById('tabMore');
  if(more) more.style.display = MORE_TABS.some(tabAllowed) ? '' : 'none';
  // The Export section: the header Export menu and the salary export.
  document.querySelectorAll('#exportDropdown, .perm-exports').forEach(el => { el.style.display = hasPermission('exports') ? '' : 'none'; });
  // If the tab we're currently sitting on just got hidden (e.g. permissions
  // changed and the page re-initialized), fall back to the home tab rather
  // than leaving a blank/inaccessible section visible.
  if(currentTab && !tabAllowed(currentTab)) switchTab(homeTab());
}

// Phone bottom bar: the sheet of the tabs under More (MORE_TABS).
function openMoreSheet(){
  const items = MORE_TABS.filter(tabAllowed).map(t => {
    const el = document.getElementById('tab'+t.charAt(0).toUpperCase()+t.slice(1));
    const icon = (el.querySelector('.ic i') || {}).className || '';
    const label = el.querySelector('.lb').textContent;
    return t3Line({c: el.style.getPropertyValue('--k'), cls: t===currentTab ? 'more-on' : '', onclick: `closeModal('moreOverlay');switchTab('${t}')`,
      av: `<span class="more-ic" style="color:${el.style.getPropertyValue('--k')}"><i class="${esc(icon)}"></i></span>`, name: esc(label), right: '<i class="ti ti-chevron-right" style="color:var(--text3)"></i>'});
  });
  document.getElementById('moreModal').innerHTML = `<div class="modal-title">${esc(tr('More'))}</div>` + items.join('');
  document.getElementById('moreOverlay').classList.add('open');
}
// A short vibration on a tap in the phone bottom bar.
document.querySelector('.top-tabs')?.addEventListener('click', () => { try{ if(matchMedia('(max-width:700px)').matches && navigator.vibrate) navigator.vibrate(8); }catch(e){} });
function switchTab(tab){
  currentTab=tab;
  document.getElementById('tabMore')?.classList.toggle('active', MORE_TABS.includes(tab));
  ['dashboard','schedule','workers','clients','suppliers','admin','accounting'].forEach(t=>{
    document.getElementById('tab'+t.charAt(0).toUpperCase()+t.slice(1))?.classList.toggle('active',tab===t);
    document.getElementById('section'+t.charAt(0).toUpperCase()+t.slice(1))?.classList.toggle('visible',tab===t);
  });
  if(tab==='workers')    renderWorkersPage();
  if(tab==='clients')    renderClientsPage();
  if(tab==='suppliers')  renderSuppliersPage();
  // setupAdminPaneBar() (role-gated pane visibility + default pane) only
  // runs here, on an actual tab switch — NOT from render()'s own
  // per-mutation renderAdmin() call below, or clicking into e.g. the Firms
  // pane would get silently reset back to Punch Log on every unrelated save.
  if(tab==='admin')      setupAdminPaneBar();
  if(tab==='dashboard')  renderDashboard();
  if(tab==='schedule')   renderSchedulePage();
  if(tab==='accounting'){ __hourApprovalsCache=null; __accOpenSeq++; renderAccounting(); } // opening the tab reads the approvals afresh
  document.body.dataset.tab=tab; // V7: the Workers / Filter-by-client panel only on Workers and Schedule
  renderCrumb();
}


// ── Greeting and notifications (redesign stage 5, docs/accounting.md → Today) ──
// "Good morning / afternoon / evening / night, <first name>" by the device's
// local time (5–12, 12–17, 17–21, 21–5), with a small animated icon after it.
const GREET_ICONS={
  morning:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><defs><clipPath id="gicHz"><rect x="0" y="0" width="32" height="23"/></clipPath></defs><g clip-path="url(#gicHz)"><g class="rise"><circle cx="16" cy="22" r="7" fill="#f7c062"/>'+[0,51,102,154,205,257,308].map(a=>`<line x1="16" y1="12" x2="16" y2="9" stroke="#f7c062" stroke-width="2" stroke-linecap="round" transform="rotate(${a} 16 22)"/>`).join('')+'</g></g><line x1="4" y1="23.5" x2="28" y2="23.5" stroke="rgba(255,255,255,.55)" stroke-width="2" stroke-linecap="round"/></svg>',
  day:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><g class="spin">'+[0,45,90,135,180,225,270,315].map(a=>`<line x1="16" y1="6" x2="16" y2="2" stroke="#fde68a" stroke-width="2.2" stroke-linecap="round" transform="rotate(${a} 16 16)"/>`).join('')+'</g><circle class="pulse" cx="16" cy="16" r="6.5" fill="#fcd34d"/></svg>',
  evening:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><defs><clipPath id="gicHz2"><rect x="0" y="0" width="32" height="21"/></clipPath></defs><g clip-path="url(#gicHz2)"><g class="sink"><circle cx="16" cy="20" r="8" fill="#f9a8d4"/></g></g><line x1="4" y1="21.5" x2="28" y2="21.5" stroke="rgba(255,255,255,.6)" stroke-width="2" stroke-linecap="round"/><line x1="9" y1="25.5" x2="23" y2="25.5" stroke="rgba(255,255,255,.3)" stroke-width="2" stroke-linecap="round"/></svg>',
  night:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><path class="moon" d="M20 6a10 10 0 1 0 7 15A8 8 0 0 1 20 6z" fill="#c7d2fe"/><circle class="tw" cx="7" cy="8" r="1.4" fill="#fff"/><circle class="tw tw2" cx="11" cy="4" r="1" fill="#fff"/></svg>'};
function partOfDay(d){ const h=(d||new Date()).getHours(); return h>=5&&h<12?'morning':h>=12&&h<17?'day':h>=17&&h<21?'evening':'night'; }
// The weather in the greeting (redesign stage 12): the `weather` function's
// {kind, temp} for the site (punch page: the worker's site; manager app: the
// firm's main site). "clear" keeps the time-of-day icon; no answer = that icon.
const GIC_CLOUD=(fill,y)=>`<circle cx="12" cy="${15+y}" r="5" fill="${fill}"/><circle cx="18" cy="${12+y}" r="6.5" fill="${fill}"/><circle cx="23.5" cy="${16+y}" r="4.5" fill="${fill}"/><rect x="8" y="${15+y}" width="19.5" height="5.5" rx="2.75" fill="${fill}"/>`;
const WX_ICONS={
  clouds:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><g transform="translate(4 -5)"><g class="drift d2" opacity=".55">'+GIC_CLOUD('#94a3b8',0)+'</g></g><g class="drift">'+GIC_CLOUD('#e2e8f0',2)+'</g></svg>',
  rain:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><g class="drift">'+GIC_CLOUD('#cbd5e1',-3)+'</g>'+[11,17,23].map((x,i)=>`<line class="drop d${i+1}" x1="${x}" y1="22" x2="${x-1.5}" y2="26" stroke="#7dd3fc" stroke-width="2" stroke-linecap="round"/>`).join('')+'</svg>',
  thunder:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><g class="drift">'+GIC_CLOUD('#94a3b8',-3)+'</g><path class="bolt" d="M17 19l-4 6h3.5l-2 5 6-7.5h-3.5l2-3.5z" fill="#fcd34d"/></svg>',
  snow:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><g class="drift">'+GIC_CLOUD('#e2e8f0',-3)+'</g>'+[11,17,23].map((x,i)=>`<circle class="flake d${i+1}" cx="${x}" cy="24" r="1.6" fill="#fff"/>`).join('')+'</svg>',
  fog:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true">'+[[6,26,10],[4,22,16],[9,28,22]].map(([a,b,y],i)=>`<line class="fogl d${i+1}" x1="${a}" y1="${y}" x2="${b}" y2="${y}" stroke="#cbd5e1" stroke-width="2.4" stroke-linecap="round"/>`).join('')+'</svg>'};
function weatherIconHtml(p,wx){
  const k=wx&&wx.kind, ic=(k&&WX_ICONS[k])||GREET_ICONS[p];
  return ic+(wx&&Number.isFinite(wx.temp)?`<span class="gtemp">${esc(String(wx.temp))}°</span>`:'');
}
function greetingHtml(name, wx){
  const p=partOfDay(), first=String(name||'').trim().split(/\s+/)[0]||'';
  const text={morning:'Good morning, {name}',day:'Good afternoon, {name}',evening:'Good evening, {name}',night:'Good night, {name}'}[p];
  return `<h3 class="t-${p}"><span class="gtext">${esc(first?tr(text,{name:first}):tr(text,{name:''}).replace(/,\s*$/,''))}</span>${weatherIconHtml(p,wx)}</h3>`;
}
// V7 (stage 6a): in the middle of the title bar on every tab — the date (short
// on a phone), the greeting (its words hidden on a phone) and the weather.
function renderGreeting(){
  const el=document.getElementById('ogGreet'), d=document.getElementById('ogDate'), s=getSession(); if(!el||!s) return;
  const now=new Date();
  if(d) d.innerHTML=`<span class="og-date-l">${esc(now.toLocaleDateString(uiLocale(),{weekday:'long',day:'numeric',month:'short'}))}</span><span class="og-date-s">${esc(now.toLocaleDateString(uiLocale(),{weekday:'short',day:'numeric',month:'short'}))}</span>`;
  el.innerHTML=greetingHtml(s.fullName||s.username, __wx&&__wxTid===fsTenantId()?__wx:null); loadWeather();
}
// The breadcrumb plate (V7): the section's icon in its colour, its name and
// count, then the open sub-tab (Accounting › Salary, Admin › Users, Schedule ›
// All sites); the page itself shows no title.
const CRUMB_COUNT={workers:()=>workers.filter(isActiveWorker).length, clients:()=>clients.length, suppliers:()=>suppliers.length};
function renderCrumb(){
  const el=document.getElementById('ogCrumb'); if(!el) return;
  const tab=document.getElementById('tab'+currentTab.charAt(0).toUpperCase()+currentTab.slice(1)); if(!tab){ el.innerHTML=''; return; }
  const sec=document.getElementById('section'+currentTab.charAt(0).toUpperCase()+currentTab.slice(1));
  const on=sec&&[...sec.querySelectorAll('.og-tabs button.on')].find(b=>b.offsetParent!==null);
  let sub='';
  if(on){ const c=on.cloneNode(true); c.querySelectorAll('i, .tab-n, .tab-badge').forEach(x=>x.remove()); sub=c.textContent.trim(); }
  const n=CRUMB_COUNT[currentTab]?CRUMB_COUNT[currentTab]():null;
  el.style.setProperty('--k', tab.style.getPropertyValue('--k'));
  el.innerHTML=`<i class="${esc((tab.querySelector('.ic i')||{}).className||'')}"></i><b>${esc(tab.querySelector('.lb').textContent)}</b>`
    +(n!=null?`<em>${n}</em>`:'')+(sub?`<i class="ti ti-chevron-right og-crumb-sep"></i><span>${esc(sub)}</span>`:'');
}
// A sub-tab changes without render(): the crumb follows any tap in the page.
document.addEventListener('click', () => setTimeout(renderCrumb, 0));
// The weather for the greeting: the firm's main site, read again after 30 minutes
// or when the super-admin opens another firm; a failure keeps the time-of-day icon.
const WEATHER_FN_URL='https://europe-west3-schedule-odinson.cloudfunctions.net/weather';
let __wx=null, __wxAt=0, __wxTid=null;
async function loadWeather(){
  const s=getSession(), tid=fsTenantId();
  if(!s || !tid || !['superadmin','tenant_admin','staff','hr'].includes(s.role)) return;
  if(__wxTid===tid && Date.now()-__wxAt<30*60e3) return;
  __wxTid=tid; __wxAt=Date.now(); __wx=null;
  try{
    const idToken=await (await loadFirestoreBackend()).idToken();
    const res=await fetch(WEATHER_FN_URL,{method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer '+idToken},
      body:JSON.stringify(s.role==='superadmin'?{asTenantId:tid}:{})});
    const j=await res.json();
    if(__wxTid!==tid) return;
    __wx=j&&j.kind?{kind:j.kind, temp:j.temp}:null;
  }catch(e){ return; }
  if(__wx) renderGreeting();
}
// The bell: what needs a look, newest first — documents and visas expiring or
// expired, contracts ending, no punch on today's shift, hours waiting for
// approval, a client that approved a month. Each has a steady id; the ids this
// login has read are kept on its account (notifReads/{uid}, loadNotifReads /
// saveNotifReads), so "Mark all read" follows it to every device.
let __notifRead=new Set(), __notifReadLoaded=false, __notifApprovals=[], __notifApprAt=0;
function notifEnabled(){ const s=getSession(); return !!s && ['superadmin','tenant_admin','staff','hr'].includes(s.role); }
function notifList(){
  const out=[], t=fsTenantId()+':', now=new Date(), today=localYMD(now), dayStart=new Date(now).setHours(0,0,0,0);
  const todayLog=todayPunchLog();
  workers.filter(isActiveWorker).forEach(w=>{
    const st=workerDocStatus(w);
    if(st.expiry){ const bad=st.expiry.level==='error'; out.push({id:t+'doc:'+w.id+':id:'+w.docExpiry, lvl:bad?'red':'amber', icon:'ti-id', title:bad?tr('ID / passport expired'):tr('ID / passport expiring'), detail:w.name+' · '+st.expiry.text, at:bad?+st.expiry.date:dayStart, open:()=>openNotices(w.id)}); }
    st.docExpiries.forEach(x=>{ const bad=x.level==='error', label=tr(WORKER_DOC_TYPES[x.doc.type]||'Document');
      out.push({id:t+'doc:'+w.id+':'+x.doc.type+':'+x.doc.expiry, lvl:bad?'red':'amber', icon:'ti-id-badge-2', title:bad?tr('{0} expired',{0:label}):tr('{0} expiring',{0:label}), detail:w.name+' · '+x.text, at:bad?+x.date:dayStart, open:()=>openNotices(w.id)}); });
    const ex=workerExpiryStatus(w);
    if(ex) out.push({id:t+'contract:'+w.id+':'+localYMD(ex.deadline), lvl:ex.level==='overdue'?'red':'amber', icon:'ti-file-certificate', title:ex.level==='overdue'?tr('Contract ended'):tr('Contract ending'), detail:w.name+' · '+ex.deadline.toLocaleDateString('en-GB'), at:ex.level==='overdue'?+ex.deadline:dayStart, open:()=>openNotices(w.id)});
    const td=workerToday(w,todayLog);
    if(td.k==='none'){ const [h,m]=String(td.sh.start).split(':').map(Number); out.push({id:t+'nopunch:'+w.id+':'+today, lvl:'red', icon:'ti-clock-off', title:tr('No punch on today\'s shift'), detail:w.name+' · '+td.sh.start+'–'+(td.sh.end||''), at:new Date(now).setHours(h||0,m||0,0,0), open:()=>openNotices(w.id), acts:noPunchActs(w,td.sh)}); }
  });
  if(hasPermission('accounting')) (__hoursBatches||[]).filter(b=>b.status==='pending').forEach(b=>{
    out.push({id:t+'hours:'+b.batchId, lvl:'blue', icon:'ti-clock-hour-4', title:tr('Hours waiting for approval'), detail:[b.fileName,b.uploadedBy].filter(Boolean).join(' · '), at:Date.parse(b.uploadedAt)||dayStart, open:()=>switchTab('accounting')}); });
  __notifApprovals.forEach(a=>out.push(Object.assign({lvl:'green', icon:'ti-circle-check', open:()=>switchTab('accounting')}, a)));
  return out.sort((a,b)=>b.at-a.at);
}
// ── WhatsApp reminder (redesign stage 11a, docs/admin.md → Firms): a "no
// punch" notice gets a WhatsApp button next to Call. It opens wa.me with the
// worker's phone in international form and the firm's template filled in
// (tenants/{t}/settings/messages.waTemplate; empty = the default, in the UI
// language). No API: the owner taps Send in WhatsApp.
function waDefaultTemplate(){ return tr('Hi {full name}, you have not punched in today (shift {start} · {site}).'); }
let __firmMsgs=null, __firmMsgsAt=0;
async function loadFirmMessages(force){
  if(!force&&__firmMsgs&&Date.now()-__firmMsgsAt<5*60e3) return __firmMsgs;
  try{ const j=await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'loadFirmMessages'})})).json();
    if(j&&j.ok){ __firmMsgs=j.messages||{}; __firmMsgsAt=Date.now(); } }catch(e){}
  return __firmMsgs||{};
}
function waTemplate(){ const t=__firmMsgs&&__firmMsgs.waTemplate; return t&&String(t).trim()?String(t):waDefaultTemplate(); }
// "050-123 4567" → "972501234567"; "+972…" / "972…" / "00972…" kept (digits only).
function waPhone(p){
  let d=String(p||'').replace(/\D/g,'');
  if(d.startsWith('00')) d=d.slice(2);
  if(/^0\d{8,9}$/.test(d)) d='972'+d.slice(1);
  return d.length>=9?d:'';
}
function waMessage(w, sh){
  const name=String(w.name||'').trim();
  return waTemplate().replace(/\{full name\}/g,name).replace(/\{first name\}/g,name.split(/\s+/)[0]||'')
    .replace(/\{start\}/g,(sh&&sh.start)||'').replace(/\{site\}/g,workerSiteName(w)||'');
}
function waLink(w, sh){ const n=waPhone(w&&w.phone); return n?'https://wa.me/'+n+'?text='+encodeURIComponent(waMessage(w,sh)):''; }
function openWhatsApp(w, sh){ const u=waLink(w,sh); if(u) window.open(u,'_blank','noopener'); }
function callWorker(w){ location.href='tel:'+String(w.phone).replace(/[^\d+]/g,''); }
// The "no punch" actions: Call and WhatsApp, when the worker has a phone.
function noPunchActs(w, sh){
  if(!w.phone) return [];
  return [{label:tr('Call'), icon:'ti-phone', fn:()=>callWorker(w)}, ...(waPhone(w.phone)?[{label:tr('WhatsApp'), icon:'ti-brand-whatsapp', fn:()=>openWhatsApp(w,sh), wa:true}]:[])];
}
// The firm window's WhatsApp reminder, saved on its own when it changes (not
// part of updateTenant, so it never rebuilds Form 101s); the default text = empty.
async function saveFirmMessage(tenantId, text){
  const v=String(text||'').trim(), waTemplate=v===waDefaultTemplate()?'':v;
  try{
    const j=await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'saveFirmMessages', asTenantId:tenantId, waTemplate})})).json();
    if(!j||j.error){ showToast(tr((j&&j.error)||'Save failed')); return; }
    __firmMsgs=Object.assign({}, __firmMsgs||{}, {waTemplate}); __firmMsgsAt=Date.now();
    showToast(tr('Saved'));
  }catch(e){ showToast(tr('Network error')); }
}
// A client login that approved every day of this month (the hours function's
// list, read at most every 5 minutes; firm admins and staff with Accounting).
async function refreshNotifApprovals(){
  if(isHrSession()||!hasPermission('accounting')||Date.now()-__notifApprAt<5*60e3) return;
  __notifApprAt=Date.now();
  const month=localYMD(new Date()).slice(0,7);
  try{
    const docs=await hourApprovalsOf(month);
    __notifApprovals=docs.filter(d=>d.kind==='client').map(d=>{ const sum=hourApprovalSummary(d,month); if(sum.open.length||!sum.done||sum.done<sum.total) return null;
      const at=Math.max(0,...Object.values(d.days||{}).map(e=>Date.parse(e.at)||0));
      return {id:fsTenantId()+':appr:'+d.id+':'+month, title:tr('A client approved the month'), detail:(d.ownerName||d.ownerId||'')+' · '+month, at:at||Date.now()}; }).filter(Boolean);
    refreshBell();
  }catch(e){}
}
async function loadNotifReads(){
  if(__notifReadLoaded||!notifEnabled()) return;
  __notifReadLoaded=true;
  try{ const j=await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'loadNotifReads'})})).json(); if(j&&Array.isArray(j.ids)) j.ids.forEach(id=>__notifRead.add(id)); }catch(e){ __notifReadLoaded=false; }
  refreshBell();
}
function saveNotifReads(){
  const ids=[...__notifRead].slice(-500); __notifRead=new Set(ids);
  fetch(API_URL,{method:'POST',body:JSON.stringify({action:'saveNotifReads', ids})}).catch(()=>{});
}
function refreshBell(){
  const btn=document.getElementById('bellBtn'); if(!btn) return;
  if(!notifEnabled()){ btn.style.display='none'; return; }
  btn.style.display='';
  const list=notifList(), n=list.filter(x=>!__notifRead.has(x.id)).length, c=document.getElementById('bellCount');
  c.textContent=n>99?'99+':String(n); c.style.display=n?'':'none'; btn.classList.toggle('has-new',n>0);
  if(document.getElementById('bellPanel')) drawBellPanel(list);
}
function toggleBell(e){
  if(e) e.stopPropagation();
  if(document.getElementById('bellPanel')){ closeBell(); return; }
  const p=document.createElement('div'); p.id='bellPanel'; p.className='og-npop'; p.setAttribute('role','dialog');
  p.addEventListener('click',ev=>ev.stopPropagation());
  document.body.appendChild(p);
  drawBellPanel(notifList());
  const r=document.getElementById('bellBtn').getBoundingClientRect(), pw=p.offsetWidth;
  const left=Math.min(window.innerWidth-pw-8, Math.max(8, r.right-pw+40));
  p.style.left=left+'px'; p.style.top=(r.bottom+10)+'px';
  p.style.setProperty('--px', Math.max(10, Math.min(pw-22, r.left+r.width/2-left-6))+'px');
  document.getElementById('bellBtn').classList.add('on');
  void p.offsetWidth; p.classList.add('open');
  refreshNotifApprovals();
  loadFirmMessages();
}
function closeBell(){ const p=document.getElementById('bellPanel'); if(p) p.remove(); const b=document.getElementById('bellBtn'); if(b) b.classList.remove('on'); }
document.addEventListener('click',()=>closeBell());
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeBell(); });
let __bellItems=[];
function drawBellPanel(list){
  const p=document.getElementById('bellPanel'); if(!p) return;
  __bellItems=list;
  const unread=list.some(x=>!__notifRead.has(x.id));
  p.innerHTML=`<h5><span>${esc(tr('Notifications'))}</span>${unread?`<button type="button" class="og-npop-all" onclick="markAllNotifRead()">${esc(tr('Mark all read'))}</button>`:''}</h5><div class="og-npop-list"></div>`;
  const box=p.querySelector('.og-npop-list');
  if(!list.length){ box.innerHTML=`<div class="t3-empty" style="padding:10px 8px">${esc(tr('Nothing new'))}</div>`; return; }
  const col={red:'var(--bad)', amber:'var(--warn)', blue:'var(--info)', green:'var(--ok)'};
  const when=ms=>{ const d=new Date(ms); return localYMD(d)===localYMD(new Date())?d.toTimeString().slice(0,5):fmtDMY(localYMD(d)); };
  const acts=x=>(x.acts||[]).length?`<div class="og-ni-acts">${x.acts.map(a=>`<button type="button" class="gbtn nact${a.wa?' wa':''}" onclick="event.stopPropagation();runRowFn('${rowFnKey(a.fn)}')"><i class="ti ${esc(a.icon)}"></i><span>${esc(a.label)}</span></button>`).join('')}</div>`:'';
  renderPagedList(box,'notifs',list.length+':'+unread,list,(x,i)=>`<div class="og-ni-w"><button type="button" class="og-ni${__notifRead.has(x.id)?'':' new'}" style="--c:${col[x.lvl]||'var(--neutral)'}" onclick="openNotif(${i})"><span class="ic"><i class="ti ${esc(x.icon)}"></i></span><span class="tx"><b>${esc(x.title)}</b><small>${esc(x.detail)}</small></span><time>${esc(when(x.at))}</time></button>${acts(x)}</div>`);
}
function openNotif(i){
  const x=__bellItems[i]; if(!x) return;
  if(!__notifRead.has(x.id)){ __notifRead.add(x.id); saveNotifReads(); }
  closeBell(); refreshBell(); if(x.open) x.open();
}
function markAllNotifRead(){
  __bellItems.forEach(x=>__notifRead.add(x.id)); saveNotifReads(); refreshBell();
}
setInterval(()=>{ if(getSession()){ refreshBell(); renderGreeting(); } }, 60e3);

// --- Week nav: the React Schedule tab sets weekStart (ManagerBridge.setWeek) ---

// --- Render -------------------------------------------------------------------
function render(){
  if(currentTab==='schedule')   renderSchedulePage();
  // render() only ever refreshed the Schedule tab's own pieces above — every
  // other tab's table (Workers/Clients/Admin/Accounting) is rendered ONLY by
  // switchTab() when the tab is first opened. Every place that mutates data
  // (saveWorker, saveClient, deletePunch, ...) calls render() to reflect the
  // change, but most of them sit ON one of those other tabs while doing it —
  // so an edit silently didn't show up until switching away and back. A few
  // call sites had already patched around this ad-hoc (search
  // `currentTab==='admin'`) instead of fixing it here once for every tab and
  // every mutation.
  if(currentTab==='workers')    renderWorkersPage();
  if(currentTab==='clients')    renderClientsPage();
  if(currentTab==='suppliers')  renderSuppliersPage();
  if(currentTab==='admin')      renderAdmin();
  if(currentTab==='dashboard')  renderDashboard();
  if(currentTab==='accounting') renderAccounting();
  refreshBell(); loadNotifReads();
  renderGreeting(); renderCrumb();
  // The worker windows that are open (the card, the notices, the worker window) read their data again.
  if(window.ManagerIsland) window.ManagerIsland.refreshWindows();
}

// The workers' requests (loadShiftRequests, decideShiftRequest), the site
// filter (filterByClient) and pruneDateShifts() are src/manager/logic/schedule.ts.

// --- Worker Modal -------------------------------------------------------------
// workerDocId() / workerAddress() (a number older records kept inside
// `address`) are src/manager/worker.ts, given to the page by ../globals.ts.
function blankWorkerDefaults(){
  return {name:'',docGiven:'',docSurname:'',colorIdx:workers.length%8,phone:'',clientIds:[],
    schedule:DAYS.map(()=>({type:'work',start:'09:00',end:'17:00'}))};
}
// Plain manual "Add Worker" (not the scan pipeline, which calls
// showWorkerModal() directly after OCR with its own fresh scan data already
// in these globals — see the scan-redirect logic below). Resets them here so
// a leftover scan/signature from a PREVIOUS, unrelated worker's session
// (e.g. the manager just created worker A from a scan a moment ago) never
// silently attaches to worker B's PDF — saveWorker()'s new-worker path reads
// these live globals directly (autoUploadWithRetry), unlike an edit-save
// (which goes through the sidecar-based regenerateWorkerDoc() instead).
function openAddWorker(){
  editingWorkerId=null;
  window.__wDraft=null;
  window.__aiScanImage=null;
  window.__aiPacketOtherPages=[];
  window.__aiAvatarB64=null;
  window.__wCapturedSigPng=undefined;
  showWorkerModal(blankWorkerDefaults());
}
function openEditWorker(wi){ const w=workers[wi]; if(!w) return; editingWorkerId=w.id; window.__wDraft=null; showWorkerModal(w); }
// Form 101 fields a document scan fills: the worker field, its input in the
// worker modal, the page it is printed on (front or ספח), its Hebrew label
// and, for digits and dates, the zoomed re-read kind (verifyField).
const SCAN_FIND_FIELDS={
  docGiven:{input:'wGiven',page:'front',label:'שם פרטי',kind:'hebrewText',passportKind:'latinName'},
  docSurname:{input:'wSurname',page:'front',label:'שם משפחה',kind:'hebrewText',passportKind:'latinName'},
  docId:{input:'wDocId',page:'front',label:'מספר זהות',passportLabel:'מספר דרכון',kind:'digits9',passportKind:'passportNo'},
  docDob:{input:'wDob',page:'front',label:'תאריך לידה',kind:'date'},
  docSex:{input:'wSex',page:'front',label:'מין'},
  address:{input:'wAddress',page:'sefach',label:'רחוב',idOnly:true,kind:'hebrewText'},
  houseNumber:{input:'wHouseNumber',page:'sefach',label:'מס׳ בית',idOnly:true,kind:'houseNumber'},
  city:{input:'wCity',page:'sefach',label:'ישוב',idOnly:true,kind:'hebrewText'},
};
// The worker's page photos, for a field search: the scan still in memory
// when it belongs to this worker (a new worker from a scan: w null), else the
// Storage sidecar saved with their Form 101 (cached per file).
const __scanPagesCache={};
function workerScanLive(w){ return !!window.__aiScanImage&&(w?window.__aiRescannedWorkerId===w.id:editingWorkerId===null); }
function workerHasScanPages(w){ return workerScanLive(w)||!!(w&&w.assetsFileId); }
async function workerScanPages(w){
  if(workerScanLive(w)) return {front:window.__aiScanImage,others:(window.__aiPacketOtherPages||[]).filter(p=>p&&p.b64)};
  if(!w||!w.assetsFileId) return null;
  if(__scanPagesCache[w.assetsFileId]) return __scanPagesCache[w.assetsFileId];
  const j=await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'loadWorkerAssets',...gsAuth(),fileId:w.assetsFileId})})).json();
  if(!j||!j.ok||!j.scanB64) return null;
  return __scanPagesCache[w.assetsFileId]={front:{b64:j.scanB64,mediaType:j.scanMediaType||'image/jpeg'},
    others:(j.extraPages||[]).filter(p=>p&&p.b64)};
}
// Searches the worker's page photos for one or more fields in ONE aiFindField
// request (the photos are the expensive part, so they go once). Each value
// found with a box is re-read zoomed — one batched aiVerifyFields per page —
// and the zoomed read wins. Resolves {key: {value, unsure}} (unsure: the two
// reads disagreed; value '' when not found), or null when there is no scan.
async function findScanFields(w,keys,docType){
  const pages=await workerScanPages(w);
  if(!pages||!keys.length) return null;
  await ensureScanPipelineLoaded();
  // The fields' own page first: ספח pages for the address, else the front.
  const sefachFirst=keys.every(k=>SCAN_FIND_FIELDS[k].page==='sefach');
  const list=(sefachFirst?[...pages.others,pages.front]:[pages.front,...pages.others]).filter(Boolean).slice(0,4);
  const j=await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'aiFindField',...gsAuth(),fields:keys,docType,
    images:list.map(p=>({image:p.b64,mediaType:p.mediaType}))})})).json();
  if(j&&j.error) console.warn('aiFindField failed: '+j.error);
  const found=(j&&j.ok&&j.found)||{};
  const out={}, zoom=new Map(); // page index -> zoom jobs
  for(const k of keys){
    const f=SCAN_FIND_FIELDS[k], hit=found[k]||{};
    out[k]={value:String(hit.value||'').trim(),unsure:false};
    const kind=docType==='passport'&&f.passportKind||f.kind;
    if(out[k].value&&kind&&hit.box&&list[hit.page]){
      if(!zoom.has(hit.page)) zoom.set(hit.page,[]);
      zoom.get(hit.page).push({field:k,kind,box:hit.box});
    }
  }
  const norm=x=>String(x||'').replace(/[\s.\/-]/g,'').toUpperCase();
  await Promise.all([...zoom].map(async([pi,jobs])=>{
    try{
      const vals=await verifyFieldsBatch(jobs,list[pi].b64,list[pi].mediaType);
      for(const jb of jobs){
        const z=String(vals[jb.field]||'').replace(/\s+/g,' ').trim();
        if(z){ out[jb.field].unsure=norm(z)!==norm(out[jb.field].value); out[jb.field].value=z; }
      }
    }catch(e){ console.error(e); }
  }));
  for(const k of keys){
    let v=out[k].value;
    if(k==='docId'&&docType!=='passport') v=_normScanDigits(v);
    else if(k==='docId') v=v.replace(/\s/g,'').toUpperCase();
    if(k==='docDob') v=_normScanDate(v)||v;
    if(k==='docSex') v=/^[mז]/i.test(v)?'M':/^[fנ]/i.test(v)?'F':'';
    if(k==='houseNumber') v=v.replace(/\s/g,'');
    out[k].value=v;
  }
  return out;
}
// "Scan again" from inside the worker window, without losing what is on the
// form: the window (React, src/manager/WorkerEditor.tsx) is kept as a draft
// (window.__wDraft) and the scan opens over it — on its review screen when the
// window came from a scan still in memory (replace or add a page there),
// otherwise as a new scan of this worker. When the scan finishes,
// openWorkerModalFromScan() (scan-pipeline.js) opens the window again and
// applyWorkerDraft() puts the draft back: a field that had a value keeps it,
// an empty one takes the new scan's value.
async function rescanFromWorkerModal(){
  window.__wDraft=window.ManagerIsland?window.ManagerIsland.editorDraft():null;
  warmCloudFunctions(SCAN_WARM_URLS());
  try{ await ensureScanPipelineLoaded(); }
  catch(e){ window.__wDraft=null; showToast(tr('Could not load the scan module — check the connection')); return; }
  const wid=editingWorkerId!==null&&workers.some(x=>x.id===editingWorkerId)?editingWorkerId:null;
  const sameSession=(window.__aiScanPageThumbs||[]).length&&window.__aiScanImage&&(wid===null||window.__aiRescannedWorkerId===wid);
  window.__aiRescanWorkerId=wid;
  if(sameSession){
    document.getElementById('aiScanOverlay').classList.add('open');
    renderScanPagesPrompt();
  } else openAiScan();
}
function applyWorkerDraft(){ if(window.ManagerIsland) window.ManagerIsland.applyDraft(); else window.__wDraft=null; }
// Second pass right after a scan: every field the scan left empty is searched
// for in one request (the window's own search, src/manager/WorkerEditor.tsx).
async function autoFindMissingScanFields(){ if(window.ManagerIsland) await window.ManagerIsland.findMissing(); }

// The worker window (stage 6c-2) is drawn in React into #workerModal
// (src/manager/WorkerEditor.tsx); editingWorkerId says which worker it edits
// (null: a new one — the scan pipeline sets it too). It has no Save button: a
// tap outside saves it (saveWorker auto).
function showWorkerModal(w){
  warmCloudFunctions([FORM101_FN_URL]); // saving builds the Form 101
  if(!window.ManagerIsland) return;
  const wov=document.getElementById('workerOverlay');
  wov.__onUserClose=()=>saveWorker({auto:true});
  window.ManagerIsland.openEditor(w, editingWorkerId!==null&&workers.some(x=>x.id===editingWorkerId)?editingWorkerId:null);
  wov.classList.add('open');
}
// A tick of a client / supplier login in its window (stage 6d, React —
// src/manager/logins.tsx): saved at once (updateUser — the user signs in again
// with the new rights), and the users cache follows. False when it failed.
async function saveLoginField(uid, field, values){
  try{
    const json=await (await fetch(API_URL,{method:'POST', body:JSON.stringify({action:'updateUser', ...gsAuth(), id:uid, [field]:values})})).json();
    if(!json||json.error){ showToast(tr((json&&json.error)||'Save failed')); return false; }
    const key='users_'+activeTenantIdForAdmin(), list=loadAdminCache(key)||[], u=list.find(x=>x.id===uid);
    if(u){ u[field]=values; saveAdminCache(key,list); }
    showToast(tr('Saved'));
    return true;
  }catch(e){ showToast(tr('Network error')); return false; }
}
// "New client login" / "New portal login" from an editor: the user form with
// the role and the client / supplier already set (the client window is saved
// first, as on a tap outside; closing the user form brings it back).
function newLoginFor(role, id){
  if(role==='client') saveClient({auto:true}); else closeModal('supplierOverlay');
  openCreateUserForm({role, id});
}
// This month's commission payable to a supplier (the same figure as Accounting → Payable by supplier).
function supplierMonthPayable(sp){
  let payable=0;
  Object.values(salaryEntriesFor('month').byWorker||{}).forEach(e=>{ const wc=workers.find(w=>w.id===e.workerId); if(wc&&wc.supplierId===sp.id) payable+=supplierCommission(wc,e,sp.id); });
  return payable;
}
// The login rows a client / supplier window shows (the owner's users cache).
function loginsInfo(role, id){
  const users=(loadAdminCache('users_'+activeTenantIdForAdmin())||[]).filter(u=>u.role===role&&id&&(role==='client'?u.clientId:u.supplierId)===id);
  return {logins:users.map(u=>({id:u.id, name:u.fullName||u.username||'', username:u.username||'', hourPerms:u.hourPerms, supplierSections:u.supplierSections, showPay:u.showPay})),
    canEdit:isFirmAdminSession(), hourLabels:HOUR_PERM_LABELS, hourDefault:HOUR_DEFAULT};
}

// The worker window saves itself when it is closed by a tap outside
// (opts.auto) — the save is the window's (src/manager/worker-save.ts). One
// save at a time.
async function saveWorker(opts){
  if(saveWorker.busy||!window.ManagerIsland) return;
  saveWorker.busy=true;
  try{ return await window.ManagerIsland.saveWorker(opts||{}); } finally{ saveWorker.busy=false; }
}
// The window's progress while a new (or just rescanned) worker's Form 101 is
// built and uploaded (aiFillForm101 advances it at its two phases).
function renderWorkerUploadProgress(label,pct){ if(window.ManagerIsland) window.ManagerIsland.uploadProgress(label,pct); }

// Worker status: three pills in the worker card's header; a tap saves at once.
function setWorkerStatus(wi, v){
  const w=workers[wi]; if(!w||(w.status||'active')===v) return;
  w.status=v;
  render(); autoSave();
  openWorkerCard(wi);
}

// A new punch-link token (the worker window's Access): the old link stops working.
function regenerateWorkerToken(wid){
  const w=workers.find(x=>x.id===wid); if(!w) return null;
  if(!confirm(tr('Create a new token? The old link will stop working.'))) return null;
  w.token = genToken();
  autoSave();
  showToast(tr('New token created — copy the link and send it again!'));
  return w.token;
}

function buildPunchLink(w){
  // Short, stable link — the punch page resolves the worker, client name and
  // geofence (lat/lng/radius) from the database by this token.
  return 'https://odinson.ltd/worker-punch.html?t='+w.token;
}
function copyWorkerLink(wid){
  const w = workers.find(x=>x.id===wid);
  if(!w||!w.token){ showToast(tr('No token — save worker first')); return; }
  const link = buildPunchLink(w);
  if(navigator.clipboard){
    navigator.clipboard.writeText(link).then(()=>showToast(tr('Link copied!'))).catch(()=>prompt(tr('Copy this link:'),link));
  } else {
    prompt(tr('Copy this link:'), link);
  }
}
// Removes the worker, then best-effort deletes their files (Form 101 PDF,
// the scan + signature sidecar, the contract / visa / permit files).
function deleteWorkerNow(id){
  const wi=workers.findIndex(x=>x.id===id); if(wi<0) return;
  const w=workers[wi];
  const docFileIds=(w.docs||[]).map(d=>d.fileId).filter(Boolean);
  workers.splice(wi,1);
  if(w.docFileId) gsDeleteWorkerDoc(w.docFileId);
  if(w.assetsFileId) gsDeleteWorkerDoc(w.assetsFileId);
  docFileIds.forEach(gsDeleteWorkerDoc);
}

// --- Clients (stage 6d) ----------------------------------------------------------
// The Clients tab and the client window are drawn in React (src/manager/
// Clients.tsx, ClientEditor.tsx — docs/clients.md); the records, the map picker
// and the saves stay here (ManagerBridge). The window has no Cancel: a tap
// outside saves it (saveClient auto); a new client gets the next colour.
function openAddClient(){ editingClientId=null; showClientModal({name:'',color:CLIENT_COLORS[clients.length%CLIENT_COLORS.length],address:''}); }
function openEditClient(cid){ const c=clients.find(x=>x.id===cid); if(!c) return; editingClientId=cid; showClientModal(c); }
function showClientModal(c){
  if(!window.ManagerIsland) return;
  const cov=document.getElementById('clientOverlay'), id=editingClientId;
  cov.__onUserClose=()=>saveClient({auto:true});
  // Coming back to it (from the manual punch or the user form) draws it again from the saved record.
  cov.__reopen=id?()=>openEditClient(id):null;
  window.ManagerIsland.openClient(JSON.parse(JSON.stringify(c)), id);
  cov.classList.add('open');
}
function saveClient(opts){ if(window.ManagerIsland) window.ManagerIsland.saveClient(opts||{}); }
// The window's record: stored in place (unless nothing changed) or added; saved.
function commitClient(id, fields){
  if(id){
    const idx=clients.findIndex(x=>x.id===id); if(idx<0){ closeModal('clientOverlay'); return; }
    const next={...clients[idx],...fields};
    const norm=o=>JSON.stringify(Object.keys(o).sort().map(k=>[k,o[k]??null]));
    if(norm(next)===norm(clients[idx])){ closeModal('clientOverlay'); return; }  // nothing changed
    clients[idx]=next;
    showToast(tr('{0} updated!',{0:fields.name}));
  } else {
    clients.push({id:uid(),...fields});
    showToast(tr('{0} added!',{0:fields.name}));
  }
  closeModal('clientOverlay'); renderClientsPage(); render(); autoSave();
}
// Delete from a window's ⋮: the window closes without saving (and does not
// come back); the list then deletes behind its Undo snack (src/manager/Clients.tsx).
function closeEditorUnsaved(ov){ const el=document.getElementById(ov); el.__reopen=null; el.__returnTo=null; closeModal(ov); }
// The manual punch from the client window: the window is saved first (as on a
// tap outside), then the punch opens; closing it brings the client back.
function punchFromClientModal(){
  const cid=editingClientId; if(!cid) return;
  saveClient({auto:true});
  if(!document.getElementById('clientOverlay').classList.contains('open')) openManualPunch(cid);
}
// A client's Undo time is up: removed, taken off every worker and the site filter; saved.
function deleteClientsNow(ids){
  const one=ids.length===1?clients.find(c=>c.id===ids[0]):null;
  ids.forEach(cid=>{
    clients=clients.filter(x=>x.id!==cid);
    workers.forEach(w=>{ if(w.clientIds) w.clientIds=w.clientIds.filter(id=>id!==cid); if(w.clientRates&&w.clientRates[cid]) delete w.clientRates[cid]; });
    if(selectedClientId===cid) selectedClientId=null; });
  render(); autoSave(); showToast(one?tr('{0} removed',{0:one.name}):tr('{0} clients',{0:ids.length}));
}
// ── Client geolocation map picker (Google Maps JavaScript API) ─────────────
// The client window's small map opens it (ManagerBridge.pickPlace): search box
// (Places autocomplete), tap/drag pin, live radius circle, "Use my location".
// The place picked goes back to the window (onPick: lat, lng, radius and a
// maps link) — the paste-a-link field in the window still works as before. The Maps script is lazy-loaded only
// when the picker first opens. Needs GOOGLE_MAPS_API_KEY (a browser key
// restricted by HTTP referrer to this app's domains, with Maps JavaScript API,
// Places API (New) and Geocoding API enabled); without one the button falls
// back to opening Google Maps in a new tab so the link can be pasted.
const GOOGLE_MAPS_API_KEY = 'AIzaSyDlS9G5zOhg8lK88_jzHewC5BLM1QkeKwc';
const MAP_PICK_DEFAULT_CENTER = {lat:32.0853, lng:34.7818}; // Tel Aviv
let _gmapsLoading = null;
let __mapPick = { map:null, marker:null, circle:null, pos:null }, __mapPickDone = null;
function loadGoogleMaps(){
  if(window.google && google.maps && google.maps.importLibrary) return Promise.resolve();
  if(_gmapsLoading) return _gmapsLoading;
  _gmapsLoading = new Promise((resolve,reject)=>{
    window.__gmapsReady = ()=>resolve();
    const s=document.createElement('script');
    s.src='https://maps.googleapis.com/maps/api/js?key='+encodeURIComponent(GOOGLE_MAPS_API_KEY)+'&v=weekly&loading=async&callback=__gmapsReady';
    s.async=true;
    s.onerror=()=>{ _gmapsLoading=null; reject(new Error('Google Maps failed to load')); };
    document.head.appendChild(s);
  });
  return _gmapsLoading;
}
// Google calls this global on an invalid/unauthorized key.
window.gm_authFailure = function(){ showToast(tr('Google Maps key rejected — check GOOGLE_MAPS_API_KEY and its allowed domains'),5000); };
async function openMapPicker(start, onPick){
  const lat=start&&start.lat!=null?Number(start.lat):NaN, lng=start&&start.lng!=null?Number(start.lng):NaN;
  const addr=String((start&&start.addr)||'').trim();
  __mapPickDone=onPick||null;
  if(!GOOGLE_MAPS_API_KEY){
    const q = !isNaN(lat)&&!isNaN(lng) ? lat+','+lng : (addr||'Israel');
    window.open('https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(q),'_blank');
    showToast(tr('Pick the point in Google Maps, copy the link and paste it here'),4000);
    return;
  }
  document.getElementById('mapPickRadius').value = (start&&start.radius) || 100;
  document.getElementById('mapPickSave').disabled = true;
  document.getElementById('mapPickCoords').textContent = '';
  document.getElementById('mapPickOverlay').classList.add('open');
  try{ await loadGoogleMaps(); }catch(e){ showToast(e.message); closeModal('mapPickOverlay'); return; }
  const {Map, Circle} = await google.maps.importLibrary('maps');
  const {Marker} = await google.maps.importLibrary('marker');
  __mapPick = { map:null, marker:null, circle:null, pos:null };
  const hasPos = !isNaN(lat)&&!isNaN(lng);
  const map = new Map(document.getElementById('mapPickMap'), {
    center: hasPos?{lat,lng}:MAP_PICK_DEFAULT_CENTER, zoom: hasPos?17:12,
    mapTypeControl:false, streetViewControl:false, fullscreenControl:false, clickableIcons:false, gestureHandling:'greedy'
  });
  __mapPick.map = map;
  // Classic Marker (not AdvancedMarkerElement) — the advanced one requires a
  // Cloud-configured Map ID; this keeps setup to just the API key.
  __mapPick.marker = new Marker({ map, draggable:true, visible:false });
  __mapPick.circle = new Circle({ map, visible:false, strokeColor:'#4f8cff', strokeWeight:2, fillColor:'#4f8cff', fillOpacity:0.15, clickable:false });
  __mapPick.marker.addListener('dragend', e=>mapPickSetPos(e.latLng.lat(), e.latLng.lng(), false));
  map.addListener('click', e=>mapPickSetPos(e.latLng.lat(), e.latLng.lng(), false));
  if(hasPos) mapPickSetPos(lat,lng,false);
  else if(addr){
    try{
      const {Geocoder} = await google.maps.importLibrary('geocoding');
      new Geocoder().geocode({address:addr, region:'il'}, (res,status)=>{
        if(status==='OK' && res[0] && !__mapPick.pos){ map.setCenter(res[0].geometry.location); map.setZoom(17); }
      });
    }catch(e){}
  }
  // Places search box (new PlaceAutocompleteElement). Older builds fire
  // 'gmp-placeselect' with event.place, newer 'gmp-select' with
  // event.placePrediction — handle both.
  const searchHost=document.getElementById('mapPickSearch'); searchHost.innerHTML='';
  try{
    const {PlaceAutocompleteElement} = await google.maps.importLibrary('places');
    const ac = new PlaceAutocompleteElement({ includedRegionCodes:['il'] });
    ac.style.width='100%';
    searchHost.appendChild(ac);
    const onPlace = async place=>{
      if(!place) return;
      await place.fetchFields({fields:['location','formattedAddress']});
      if(place.location) mapPickSetPos(place.location.lat(), place.location.lng(), true);
    };
    ac.addEventListener('gmp-select', e=>onPlace(e.placePrediction && e.placePrediction.toPlace()));
    ac.addEventListener('gmp-placeselect', e=>onPlace(e.place));
  }catch(e){ searchHost.innerHTML='<div style="font-size:12px;color:var(--text3)">'+tr('Address search unavailable — tap the map instead')+'</div>'; }
}
function mapPickSetPos(lat,lng,recenter){
  __mapPick.pos={lat,lng};
  const p={lat,lng};
  __mapPick.marker.setPosition(p); __mapPick.marker.setVisible(true);
  __mapPick.circle.setCenter(p); __mapPick.circle.setRadius(Number(document.getElementById('mapPickRadius').value)||100); __mapPick.circle.setVisible(true);
  if(recenter){ __mapPick.map.setCenter(p); __mapPick.map.setZoom(17); }
  document.getElementById('mapPickCoords').textContent=lat.toFixed(5)+', '+lng.toFixed(5);
  document.getElementById('mapPickSave').disabled=false;
}
function mapPickSetRadius(v){ if(__mapPick.circle) __mapPick.circle.setRadius(Number(v)||100); }
function mapPickUseMyLocation(){
  if(!navigator.geolocation){ showToast(tr('Geolocation not supported on this device')); return; }
  navigator.geolocation.getCurrentPosition(
    pos=>{ mapPickSetPos(pos.coords.latitude,pos.coords.longitude,true); showToast(tr('Accuracy ±{0} m',{0:(Math.round(pos.coords.accuracy))})); },
    err=>showToast(tr('Could not get location: {0}',{0:(err.message)})),
    {enableHighAccuracy:true, timeout:15000, maximumAge:0});
}
function saveMapPick(){
  const p=__mapPick.pos; if(!p) return;
  const lat=+p.lat.toFixed(6), lng=+p.lng.toFixed(6);
  const radius=Number(document.getElementById('mapPickRadius').value)||100;
  if(__mapPickDone) __mapPickDone({lat, lng, radius, mapsUrl:'https://www.google.com/maps?q='+lat+','+lng});
  closeModal('mapPickOverlay');
}

// Hours worked this calendar month, per worker — the same canonical shift
// pairing (getWorkerMonthShifts → groupPunchesIntoShifts/analyzeDayPunches)
// the hours export uses, so the card can never disagree with it.
// The punch log is read (parsed) once and split by worker: reading it once
// per worker made the cards view take over a second at 150 workers.
function workersMonthHours(){
  const now=new Date(), y=now.getFullYear(), m=now.getMonth(), out={}, byWorker={};
  getPunchLog().forEach(e=>{ (byWorker[e.workerId]||(byWorker[e.workerId]=[])).push(e); });
  workers.forEach(w=>{ out[w.id]=getWorkerMonthShifts(w.id,y,m,byWorker[w.id]||[]).reduce((s,x)=>s+x.hours,0); });
  return out;
}
// ── The worker plate (redesign stage 3, docs/workers.md → Workers tab) ──
// The full name, cut with … when it does not fit (.wp-n, og.css).
function todayPunchLog(){ const t=new Date().toDateString(); return getPunchLog().filter(e=>new Date(e.ts).toDateString()===t); }
// A worker today: on vacation, the latest punch today (in / out and its time),
// "no punch" when today's shift started 15+ minutes ago with no punch, or nothing.
function workerToday(w, todayLog){
  if(w.status==='vacation') return {k:'vac'};
  const le=latestOf((todayLog||[]).filter(e=>e.workerId===w.id));
  if(le) return {k:le.type==='in'?'in':'out', time:le.time||''};
  if(!isActiveWorker(w)) return {k:''};
  const now=new Date(), sh=shiftOn(w,now);
  if(sh && sh.type==='work' && sh.start && now.getHours()*60+now.getMinutes() >= toMins(sh.start)+15) return {k:'none', sh};
  return {k:''};
}
function workerSiteName(w){ const c=(w.clientIds||[]).map(id=>clients.find(x=>x.id===id)).filter(Boolean)[0]; return c?c.name:''; }
// A worker's notices, urgent (red) first: a failed upload, the ID / passport
// or a document (visa, permit, contract file) expired or expiring, missing
// documents, the contract ending, no punch on today's shift. Each has a short
// word (its chip), a title and a detail line (the notices sheet) and, with the
// rights for it, the action that fixes it.
function workerNotices(w, today){
  const out=[], st=workerDocStatus(w), id=w.id, can=hasPermission('workers');
  const idx=()=>workers.findIndex(x=>x.id===id);
  const go=fn=>()=>{ closeModal('noticesOverlay'); fn(); };
  const days=d=>Math.max(0,Math.ceil((d-new Date().setHours(0,0,0,0))/864e5));
  const rescan=can?{label:tr('Upload'), icon:'ti-scan', fn:go(()=>rescanFromWorkerCard(idx()))}:null;
  const renew=can?{label:tr('Renew'), icon:'ti-refresh', fn:go(()=>openWorkerDocUpload(id))}:null;
  if(st.failed) out.push({lvl:'red', icon:'ti-cloud-off', word:tr('Upload failed'), title:tr('Upload failed'), detail:tr('Last upload to {0} failed',{0:DOC_STORE}), act:rescan});
  if(st.expiry){ const bad=st.expiry.level==='error'; out.push({lvl:bad?'red':'amber', icon:'ti-id', word:bad?tr('ID expired'):tr('ID {n}d',{n:days(st.expiry.date)}), title:tr('ID / Passport'), detail:st.expiry.text, act:rescan}); }
  st.docExpiries.forEach(x=>{ const bad=x.level==='error', label=tr(WORKER_DOC_TYPES[x.doc.type]||'Document');
    out.push({lvl:bad?'red':'amber', icon:'ti-id-badge-2', word:bad?tr('{0} expired',{0:label}):tr('{0} {n}d',{0:label,n:days(x.date)}), title:label, detail:x.text, act:renew}); });
  if(st.missing.length) out.push({lvl:'amber', icon:'ti-file-alert', word:tr('Documents'), title:tr('Missing documents'), detail:st.missing.join(', '), act:rescan});
  const ex=workerExpiryStatus(w);
  if(ex) out.push({lvl:ex.level==='overdue'?'red':'amber', icon:'ti-file-certificate', word:tr('Contract'), title:ex.level==='overdue'?tr('Contract ended'):tr('Contract ending'), detail:ex.deadline.toLocaleDateString('en-GB'),
    act:can?{label:tr('Extend'), icon:'ti-calendar-plus', fn:go(()=>openEditWorker(idx()))}:null});
  if(today && today.k==='none') out.push({lvl:'red', icon:'ti-clock-off', word:tr('No punch'), title:tr('No punch on today\'s shift'), detail:today.sh?today.sh.start+'–'+(today.sh.end||''):'',
    acts:noPunchActs(w,today.sh)});
  return out.sort((a,b)=>(a.lvl==='red'?0:1)-(b.lvl==='red'?0:1));
}
// The plate's bar (and avatar) colour: red inactive or an urgent notice, amber
// on vacation or with a notice, green otherwise.
function workerBarColor(w, ns){
  if(!isActiveWorker(w) || ns.some(n=>n.lvl==='red')) return 'var(--bad)';
  return (w.status==='vacation' || ns.length) ? 'var(--warn)' : 'var(--ok)';
}
// The Workers list is drawn in React (stage 6c-1, src/manager/Workers.tsx):
// the plates, the tabs, the search, the filters and Select live there.
function setWorkersStatus(ids, v){
  ids.forEach(id=>{ const w=workers.find(x=>x.id===id); if(w) w.status=v; });
  render(); autoSave(); showToast(tr('Saved'));
}
// The notices sheet (stage 6c-2: drawn in React into #noticesModal,
// src/manager/worker-windows.tsx): who, a plate per notice with its action,
// and "Open worker card".
function openNotices(wid){
  if(!workers.some(x=>x.id===wid)||!window.ManagerIsland) return;
  window.ManagerIsland.openNotices(wid);
  document.getElementById('noticesOverlay').classList.add('open');
  loadFirmMessages();
}
function runRowFn(k){ const fn=__rowFns.get(k); if(fn) fn(); }
// ── Workers (stage 6c-1): the list is drawn in React — src/manager/Workers.tsx.
// The page keeps the data; the tab reads it through ManagerBridge.workers().
function renderWorkersPage(){
  if(window.ManagerIsland) window.ManagerIsland.renderWorkers();
}

// The worker card (stage 6c-2): drawn in React into #workerCardModal
// (src/manager/WorkerCard.tsx). Coming back to it (a window opened from it
// was closed) draws it again from the current data, by id — nothing when the
// worker is gone; the open pane (Info / Docs / Hours) is kept.
function openWorkerCard(wi){
  const w=workers[wi]; if(!w||!window.ManagerIsland) return;
  const ov=document.getElementById('workerCardOverlay');
  ov.__reopen=()=>{ const i=workers.findIndex(x=>x.id===w.id); if(i>=0) openWorkerCard(i); };
  window.ManagerIsland.openCard(w.id);
  ov.classList.add('open');
}

// The worker card's ✎: its edit form (closing it comes back to the card).
function editFromWorkerCard(wid){ closeModal('workerCardOverlay'); openEditWorker(workers.findIndex(x=>x.id===wid)); }
// From the worker card: opens this worker's modal and the scan over it, so
// the scan's result lands in the modal (empty fields filled, nothing typed
// lost) and saving rebuilds the Form 101 from the new photos.
function rescanFromWorkerCard(wi){
  closeModal('workerCardOverlay');
  openEditWorker(wi);
  rescanFromWorkerModal();
}

// --- Worker documents (contract / visa / work permit / other) -----------------
// Separate from the Form 101 scan: uploaded from Add document (React,
// src/manager/worker-windows.tsx), stored in Storage (saveWorkerFile ->
// tenants/<t>/workers/<id>/docs), listed on the worker card with their
// expiry. Expiry reminders flow through workerDocStatus() (badges, the
// "expiring" filter) and the Today tab's expiry cards.
function openWorkerDocUpload(workerId){
  if(!workers.some(x=>x.id===workerId)||!window.ManagerIsland) return;
  window.ManagerIsland.openDocUpload(workerId);
  document.getElementById('workerDocOverlay').classList.add('open');
}

// --- Hours import (Admin/Roles plan, stage 14) ---------------------------------
// Upload PDF/photo/Excel with a worker's hours, tied to a client — parsed
// entries land in a server-side PENDING queue (savePendingHoursBatch), never
// straight into PunchLog/payroll. A human (tenant_admin/superadmin) must
// explicitly approve the batch (Accounting → Approvals → Pending hours,
// src/manager/Accounting.tsx) before it counts toward any salary calculation — this is the
// anti-fraud boundary the user explicitly asked for, which is also exactly
// why the supplier role never gets this button at all (see supplier-portal
// plan, stage 16) and the server itself rejects a supplier-role caller.
// The window is React (src/manager/worker-windows.tsx); the file reading
// below and the server calls are the page's (ManagerBridge).
function openHoursImportModal(workerId){
  if(!workers.some(x=>x.id===workerId)||!window.ManagerIsland) return;
  window.ManagerIsland.openHoursImport(workerId);
  document.getElementById('hoursImportOverlay').classList.add('open');
}
// Fixed template: a header row containing Date/In/Out (or the same three words in Russian),
// case-insensitive, in any column order. cellDates:true so an Excel date
// serial comes back as a real JS Date we can format ourselves, matching the
// dd/MM/yyyy convention PunchLog itself already uses everywhere else.
function parseHoursExcelFile(file){
  return loadXlsx().then(()=>new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onerror = ()=>reject(new Error('read failed'));
    reader.onload = ()=>{
      try{
        const wb = XLSX.read(reader.result, {type:'array', cellDates:true});
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, {header:1, defval:''});
        if(!rows.length){ resolve([]); return; }
        const header = rows[0].map(h=>String(h||'').trim().toLowerCase());
        const dateIdx = header.findIndex(h=>['date','дата'].includes(h));
        const inIdx   = header.findIndex(h=>['in','вход'].includes(h));
        const outIdx  = header.findIndex(h=>['out','выход'].includes(h));
        if(dateIdx===-1||inIdx===-1){ reject(new Error('Expected Date/In(/Out) columns')); return; }
        const fmtDate = v=>{
          if(v instanceof Date) return String(v.getDate()).padStart(2,'0')+'/'+String(v.getMonth()+1).padStart(2,'0')+'/'+v.getFullYear();
          return String(v||'').trim();
        };
        const fmtTime = v=>{
          if(v instanceof Date) return String(v.getHours()).padStart(2,'0')+':'+String(v.getMinutes()).padStart(2,'0');
          return String(v||'').trim();
        };
        const entries = rows.slice(1)
          .filter(r=>r[dateIdx]!=='' && r[dateIdx]!=null)
          .map(r=>({ date: fmtDate(r[dateIdx]), inTime: fmtTime(r[inIdx]), outTime: outIdx!==-1?fmtTime(r[outIdx]):'' }));
        resolve(entries);
      }catch(e){ reject(e); }
    };
    reader.readAsArrayBuffer(file);
  }));
}
// AI-vision path for a photographed/scanned timesheet (images only for now —
// a multi-page scan-PDF would need page rendering this feature doesn't do
// yet; a manager can screenshot/photograph each page instead as a practical
// workaround). Uses the same aiReadHoursTable backend action added alongside
// this stage; never writes anything itself — only returns entries for the
// caller to route through the approval queue below.
// One already-prepared page image ({b64,mediaType}) -> its shift entries.
async function parseHoursImagePage(pg){
  const res = await fetch(API_URL, { method:'POST', body: JSON.stringify({ action:'aiReadHoursTable', ...gsAuth(), image:pg.b64, mediaType:pg.mediaType }) });
  const json = await res.json();
  if(json.error) throw new Error(json.error);
  return json.entries||[];
}
// Detail-mode export for one worker (exportShiftsDetail): the month picker is
// React (src/manager/worker-windows.tsx).
function openHoursExportModal(workerId){
  if(!workers.some(x=>x.id===workerId)||!window.ManagerIsland) return;
  window.ManagerIsland.openHoursExport(workerId);
  document.getElementById('hoursExportOverlay').classList.add('open');
}

// The Clients and Suppliers tabs (stage 6d): drawn in React — src/manager/
// Clients.tsx; the page keeps the data and the deletes.
function renderClientsPage(){ if(window.ManagerIsland) window.ManagerIsland.renderClients(); }
function renderSuppliersPage(){ if(window.ManagerIsland) window.ManagerIsland.renderSuppliers(); }

// --- Suppliers ----------------------------------------------------------------
// A supplier is a staffing agency a worker is linked to via w.supplierId
// (single, unlike the many-to-many clientIds), see the `suppliers` global's own
// comment for the field list. The window is React (src/manager/SupplierEditor.tsx):
// one Save; a tap outside closes it without saving.
function openAddSupplier(){ editingSupplierId=null; showSupplierModal({name:'',color:CLIENT_COLORS[suppliers.length%CLIENT_COLORS.length],phone:'',bank:'',bankBranch:'',accountNumber:'',companyNumber:''}); }
function openEditSupplier(sid){ const s=suppliers.find(x=>x.id===sid); if(!s) return; editingSupplierId=sid; showSupplierModal(s); }
function showSupplierModal(s){
  if(!window.ManagerIsland) return;
  const ov=document.getElementById('supplierOverlay'), id=editingSupplierId;
  ov.__reopen=id?()=>openEditSupplier(id):null;
  window.ManagerIsland.openSupplier(JSON.parse(JSON.stringify(s)), id);
  ov.classList.add('open');
}
function commitSupplier(id, fields){
  if(id){
    const idx=suppliers.findIndex(x=>x.id===id);
    if(idx>=0) suppliers[idx]={...suppliers[idx],...fields};
    showToast(tr('{0} updated!',{0:fields.name}));
  } else {
    suppliers.push({id:uid(),...fields});
    showToast(tr('{0} added!',{0:fields.name}));
  }
  closeModal('supplierOverlay'); renderSuppliersPage(); autoSave();
}
// A supplier's Undo time is up: removed and taken off every worker; saved.
function deleteSuppliersNow(ids){
  const one=ids.length===1?suppliers.find(s=>s.id===ids[0]):null;
  ids.forEach(sid=>{
    suppliers=suppliers.filter(x=>x.id!==sid);
    workers.forEach(w=>{ if(w.supplierId===sid) w.supplierId=null; if(w.supplierRates&&w.supplierRates[sid]) delete w.supplierRates[sid]; }); });
  render(); autoSave(); showToast(one?tr('{0} removed',{0:one.name}):tr('{0} suppliers',{0:ids.length}));
}


// The manual punch (React — src/manager/ManualPunch.tsx): this client's
// workers (or every active one), IN / OUT, date, time, a note.
function openManualPunch(cid){
  if(!clients.some(x=>x.id===cid)||!window.ManagerIsland) return;
  window.ManagerIsland.openManualPunch(cid);
  document.getElementById('manualPunchOverlay').classList.add('open');
}
// The punch entered: into the local punch log and to Firestore (gsSavePunch).
function addManualPunch(entry){
  const log=getPunchLog(); log.push(entry); savePunchLog(log);
  gsSavePunch(entry);
  closeModal('manualPunchOverlay');
  showToast(tr('Punch saved — {0} {1} at {2}',{0:entry.workerName,1:entry.type.toUpperCase(),2:entry.time}));
  render(); // the open tab (Clients, Accounting, Today, Admin…) shows the new punch
}



// --- Modal close --------------------------------------------------------------
function closeModal(id){ document.getElementById(id).classList.remove('open'); }
// Every modal closes on a tap anywhere outside it — on the dark backdrop,
// including where the card or row that opened it was (per user request
// 2026-10-04, for every modal; modals have no ✕ and no Cancel button). Only
// when the press also started on the backdrop, so a drag that starts inside
// the modal (selecting text, moving a map pin) and ends outside doesn't close
// it. The topmost open overlay is the one under the tap, so a modal over
// another closes alone. An overlay whose closing must undo something sets
// overlay.__onUserClose (e.g. the client billing-rate popup reverts the rate
// mode); otherwise closeModal(id). The same code is in schedule-manager.html
// and supplier-portal.html.
let _overlayDownOn=null;
document.addEventListener('pointerdown',e=>{ _overlayDownOn=e.target; },true);
document.addEventListener('click',e=>{
  const t=e.target;
  if(!(t&&t.classList&&t.classList.contains('overlay')&&t.classList.contains('open')&&_overlayDownOn===t&&t.id)) return;
  if(typeof t.__onUserClose==='function') t.__onUserClose(); else closeModal(t.id);
});

// Phone (≤ 700 px): a window, opened from the bottom as a sheet, also closes
// with a swipe down on it (user request 2026-10-11) — the same way as a tap
// outside (__onUserClose, else closeModal). Only when the sheet and anything
// scrolled under the finger are at their top, never from a field, a map,
// a canvas or a .no-swipe surface (the scan crop editor, the avatar crop —
// a drag there moves the photo, not the sheet); while it is open the page behind does not scroll (CSS). The
// same code is in the manager app and both portals.
(function(){
  let sw=null;
  document.addEventListener('touchstart',e=>{
    sw=null;
    if(!window.matchMedia('(max-width:700px)').matches||e.touches.length!==1) return;
    const m=e.target.closest&&e.target.closest('.overlay.open>.modal');
    if(!m||e.target.closest('input,textarea,select,canvas,.leaflet-container,.no-swipe')) return;
    for(let n=e.target;n&&n!==m.parentElement;n=n.parentElement){ if(n.scrollTop>0) return; }
    sw={m, x:e.touches[0].clientX, y:e.touches[0].clientY, dy:0, on:false};
  },{passive:true});
  document.addEventListener('touchmove',e=>{
    if(!sw) return;
    const dx=e.touches[0].clientX-sw.x, dy=e.touches[0].clientY-sw.y;
    if(!sw.on){
      if(dy<0||Math.abs(dx)>Math.abs(dy)){ if(dy<-6||Math.abs(dx)>10) sw=null; return; }
      if(dy<8) return;
      sw.on=true; sw.m.style.transition='none';
    }
    sw.dy=Math.max(0,dy); sw.m.style.transform='translateY('+sw.dy+'px)';
    if(e.cancelable) e.preventDefault();
  },{passive:false});
  const end=()=>{
    if(!sw) return;
    const {m,dy,on}=sw; sw=null; if(!on) return;
    m.style.transition='transform .18s ease';
    const ov=m.parentElement;
    if(dy>90){
      m.style.transform='translateY(100%)';
      setTimeout(()=>{ m.style.transform=''; m.style.transition=''; if(typeof ov.__onUserClose==='function') ov.__onUserClose(); else closeModal(ov.id); },180);
    } else { m.style.transform=''; setTimeout(()=>{ m.style.transition=''; },200); }
  };
  document.addEventListener('touchend',end); document.addEventListener('touchcancel',end);
})();

// Back to the previous window (user request 2026-10-11): a window opened from
// another one — the first closed and the second opened by the same action
// (one batch of class changes, e.g. closeModal(a); openB()) — remembers it
// (overlay.__returnTo). When it closes and no other window opens right after
// (MODAL_CHAIN_MS), the previous one comes back — drawn again by its
// __reopen() if it has one (the worker card), else shown as it was. Chains
// stack: card → pay → … each go back one step. Watches the class of every
// .overlay, so every way of opening and closing (closeModal, a tap outside,
// __onUserClose) works.
const MODAL_CHAIN_MS=250;
let __lastModalClose=null, __reopeningModal=null;
function reopenModal(id){
  const el=document.getElementById(id); if(!el||el.classList.contains('open')) return;
  __reopeningModal=id;
  if(typeof el.__reopen==='function') el.__reopen(); else el.classList.add('open');
  if(!el.classList.contains('open')) __reopeningModal=null;  // __reopen found nothing to show
}
new MutationObserver(recs=>{
  const closedNow=[];
  recs.forEach(r=>{
    const el=r.target;
    if(!(el.classList&&el.classList.contains('overlay')&&el.id)) return;
    const wasOpen=/(^|\s)open(\s|$)/.test(r.oldValue||''), isOpen=el.classList.contains('open');
    if(wasOpen===isOpen) return;
    if(isOpen){
      if(__lastModalClose&&Date.now()-__lastModalClose.at<MODAL_CHAIN_MS) __lastModalClose.followed=true;
      if(__reopeningModal===el.id){ __reopeningModal=null; return; }  // coming back: keeps its own __returnTo
      const prev=closedNow.filter(id=>id!==el.id&&!document.getElementById(id).classList.contains('open')).pop();
      el.__returnTo=prev||null;
    } else {
      closedNow.push(el.id);
      const rec={id:el.id, at:Date.now(), followed:false};
      __lastModalClose=rec;
      const back=el.__returnTo; el.__returnTo=null;
      if(back) setTimeout(()=>{
        if(rec.followed||document.querySelector('.overlay.open')) return;  // another window opened instead
        reopenModal(back);
      },60);
    }
  });
}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['class'],attributeOldValue:true});


// --- Export dropdown ----------------------------------------------------------

// --- Export Excel / PDF / JSON: exportExcel(), exportPDF(), exportJSON() are
// src/manager/logic/exports.ts.

// --- Save / Load -------------------------------------------------------------
// The data layer — the session (getSession, gsAuth), the fetch(API_URL)
// dispatcher, load / save / cache (loadData, autoSave), the punches, the
// uploads and the telemetry — is src/manager/data/, loaded before this script
// under the same names through ../globals.ts (React migration stage 8b).

// ── The data layer's events (src/manager/data/events.ts) ──
// The data layer never draws, shows a toast or looks at the screen: it
// emits events, and this is the one place the page answers them. Its texts
// come untranslated ({text, vars}) and are translated here.
ManagerData.setHost({
  // an HR's live worker list waits while one of these is open
  workerWindowOpen:()=>['workerOverlay','workerCardOverlay','payOverlay'].some(id=>document.getElementById(id)?.classList.contains('open')),
});
ManagerData.on('data', ()=>render());
// Hours approvals compare each day with the punches: they redraw too, or a
// day could keep showing a stale "Changed after approval".
ManagerData.on('punches', ()=>{ if(currentTab==='dashboard') renderDashboard(); else if(currentTab==='accounting') renderAccounting(); else if(currentTab==='admin') renderAdmin(); });
// An open worker card shows the worker's latest hours batch live.
ManagerData.on('hours', ()=>{ updateHoursBadge(); refreshBell(); if(window.ManagerIsland) window.ManagerIsland.refreshWindows(); if(currentTab==='accounting') renderAccounting(); });
ManagerData.on('save', s=>setSaveStatus(s));
ManagerData.on('notice', ({msg, ms})=>showToast(typeof msg==='string'?msg:tr(msg.text, msg.vars), ms));
ManagerData.on('loaded', ()=>maybeRegenAfterFirmEdit());
ManagerData.on('requests', ()=>{ if(currentTab==='schedule') renderSchedulePage(); });
function setSaveStatus(s){
  const el=document.getElementById('saveIndicator');
  el.className='save-indicator '+s;
  el.querySelector('span').textContent=s==='saving'?tr('Saving...'):tr('Saved');
}
// The count of hours batches waiting for a decision, on the Accounting tab.
function updateHoursBadge(){
  const tab = document.getElementById('tabAccounting'); if(!tab) return;
  const n = pendingHoursCount();
  let el = document.getElementById('accPendingBadge');
  if(!el){ el = document.createElement('span'); el.id = 'accPendingBadge'; el.className = 'tab-badge'; tab.querySelector('.ic').appendChild(el); }
  el.textContent = n > 99 ? '99+' : String(n);
  el.style.display = n ? '' : 'none';
  el.title = tr('{0} hours batch(es) waiting for review',{0:(n)});
}

const LOGIN_FN_URL = 'https://europe-west3-schedule-odinson.cloudfunctions.net/login';

// A supplier never uses this app: its login is written as the supplier
// portal's session (supplier-portal.html, key supplierPortal_session) and the
// page moves to /supplier, already signed in.
function goToSupplierPortal(u){
  try{ localStorage.setItem('supplierPortal_session', JSON.stringify({uid:u.uid, role:'supplier', tenantId:u.tenantId, supplierId:u.supplierId, username:u.username})); }catch(e){}
  clearSession();
  location.replace('supplier-portal.html');
}
// A client login uses the client portal (client-portal.html), handed over the same way.
function goToClientPortal(u){
  try{ localStorage.setItem('clientPortal_session', JSON.stringify({uid:u.uid, role:'client', tenantId:u.tenantId, clientId:u.clientId, username:u.username})); }catch(e){}
  clearSession();
  location.replace('client-portal.html');
}
async function logout(){
  try{ localStorage.removeItem(FIRMS_CACHE_KEY); }catch(e){}
  clearAdminCaches(); clearSession();
  try{ await (await loadFirestoreBackend()).signOut(); }catch(e){}
  location.reload();
}



// The login Cloud Function checks the password and signs this device in to
// Firebase (firestore-backend.js login()); the session keeps who that is.
async function submitLogin(){
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  const btn = document.getElementById('loginBtn');
  errEl.textContent = '';
  if(!username || !password){ errEl.textContent = tr('Enter a username and password'); return; }
  btn.disabled = true; btn.textContent = tr('Signing in…');
  try{
    const t0 = Date.now();
    let backend;
    try{ backend = await loadFirestoreBackend(); }
    catch(e){ errEl.textContent = tr('Could not load Firebase — check the network'); return; }
    let fb;
    try{ fb = await backend.login(username, password); }
    catch(e){ errEl.textContent = tr('No network — try again'); return; }
    if(!fb || fb.error){ errEl.textContent = tr((fb&&fb.error)||'') || tr('Could not sign in'); return; }
    // The language this user last picked (on any device) wins over this device's.
    if(fb.language) try{ localStorage.setItem('uiLang', fb.language); }catch(e){}
    // So does the theme (Dark / Light / System).
    if(fb.theme) setTheme(fb.theme, {save:false});
    // A supplier login belongs in the supplier portal: hand the session over
    // (same origin, same Firebase sign-in) and go there.
    if(fb.role === 'supplier'){ goToSupplierPortal(fb); return; }
    if(fb.role === 'client'){ goToClientPortal(fb); return; }
    try{ sessionStorage.setItem('pendingLoginTiming', JSON.stringify({t0, loginMs:Date.now()-t0, pingMs:window.__pingMs==null?null:window.__pingMs, pingDone:window.__pingMs!=null})); }catch(e){}
    saveSession({
      uid: fb.uid, role: fb.role, tenantId: fb.tenantId, username: fb.username, tenantProfile: fb.tenantProfile,
      permissions: fb.permissions, supplierId: fb.supplierId,
      ownOnly: fb.ownOnly === true, fullName: fb.fullName || '',
      showPay: fb.showPay === true, commissionRate: Number(fb.commissionRate) || 0,
      hourPerms: Array.isArray(fb.hourPerms) ? fb.hourPerms : [],
      commissionDayRate: Number(fb.commissionDayRate) || 0,
      viewingTenantId: fb.tenantId, // a super-admin (tenantId null) picks one on the Firms screen
    });
    location.reload();
  }finally{ btn.disabled = false; btn.textContent = tr('Sign in'); }
}

// A super-admin drilling into one firm's normal view — every subsequent API
// call sends asTenantId until they switch again or log out. Also caches that
// firm's own profile (from the already-fetched Firms list — __firmsCache) as
// viewingTenantProfile, since aiFillForm101() needs it for Form 101 section א
// and a super-admin's own login never carries a tenantProfile (they have no
// fixed tenant of their own).
function switchToTenant(tenantId){
  const s = getSession();
  if(!s || s.role !== 'superadmin') return;
  const t = __firmsCache.find(x => x.tenantId === tenantId);
  s.viewingTenantId = tenantId;
  s.viewingTenantName = (t && t.companyName) || tenantId;
  s.viewingTenantProfile = t || null;
  saveSession(s);
  location.reload();
}
function backToFirmsList(){
  const s = getSession();
  if(!s || s.role !== 'superadmin') return;
  s.viewingTenantId = null;
  s.viewingTenantName = null;
  saveSession(s);
  location.reload();
}

// ── Firm profile (Form 101 section א) ──
// FIRM_PROFILE_FIELDS, activeTenantProfile(), firmProfileMissing() are
// src/manager/logic/admin.ts, like the Admin caches, the role labels,
// assignWorkersToHr / ToSupplier, the payable summary and the log periods.
// Keeps the session's cached copy of the firm profile in step with a save —
// the client only ever gets one at login, so without this a firm would have
// to log out and back in before its own edit showed up on a Form 101. Only
// touches the cache when the saved firm is the one currently being worked in.
function cacheTenantProfile(tenantId, profile){
  const s = getSession();
  if(!s || !profile) return;
  if(tenantId !== (s.viewingTenantId || s.tenantId)) return;
  if(s.role === 'superadmin'){
    s.viewingTenantProfile = profile;
    s.viewingTenantName = profile.companyName || s.viewingTenantName;
  } else {
    s.tenantProfile = profile;
  }
  saveSession(s);
  renderAccountControl(s);
}

// ── App gate: decides which of the three top-level screens to show ─────────
// (1) no/expired session → #loginScreen, nothing else runs.
// (2) super-admin with no firm picked yet → #firmsScreen.
// (3) everyone else (a tenant login, or a super-admin who picked a firm) →
//     the normal app — runInitApp() runs the pre-existing init sequence.
// Called once at startup in place of the old unconditional init block.
function gateApp(runInitApp){
  let s = getSession();
  if(s && s.role === 'supplier'){ goToSupplierPortal(s); return; }
  if(s && s.role === 'client'){ goToClientPortal(s); return; }
  if(!s){
    document.getElementById('loginScreen').style.display = 'flex';
    // Wake a cold login function while the user types, so the login request
    // itself doesn't pay the cold start.
    const pingT0=Date.now();
    fetch(LOGIN_FN_URL, {method:'POST', headers:{'Content-Type':'application/json'}, body:'{"ping":true}'})
    .then(()=>{ window.__pingMs=Date.now()-pingT0; }).catch(()=>{});
    return;
  }
  if(s.role === 'superadmin' && !s.viewingTenantId){
    document.getElementById('firmsScreen').style.display = 'block';
    // the React list loads the firms when it is drawn (now, or when the React pieces mount)
    if(window.ManagerIsland) window.ManagerIsland.renderFirmsScreen();
    return;
  }
  renderAccountControl(s);
  runInitApp();
  // A fresh firm profile for this device's Form 101s (see refreshTenantProfile),
  // once the Firebase sign-in has had time to come back.
  setTimeout(() => refreshTenantProfile(0), 4000);
}

// Small titlebar control: who's logged in, and for a super-admin currently
// viewing one firm, a way back to the Firms list (never shown to a normal
// tenant login — they have only one firm, nothing to switch to).
function renderAccountControl(s){
  const host = document.getElementById('accountControl');
  const labelHost = document.getElementById('accountLabelCenter');
  if(labelHost){
    // A firm sees its own company name, the same thing a super-admin sees for
    // it — the login name only stands in while the profile has no name yet.
    // Reading it from the profile (not the session's fixed username) is also
    // what makes a rename show up here as soon as cacheTenantProfile() lands.
    // Shows both WHO is logged in (username) and WHICH firm is active, on
    // desktop (centered) and mobile (own full-width row under the brand).
    const profile = activeTenantProfile();
    const firm = s.role === 'superadmin'
      ? (s.viewingTenantName || s.viewingTenantId || 'Super-admin')
      : ((profile && profile.companyName) || '');
    // The person's name (fullName), the login only while it has none; a
    // tap on it changes the name (editMyName).
    const who = s.fullName || s.username || '';
    labelHost.innerHTML = esc(who) + (firm ? ' <span class="firm">· ' + esc(firm) + '</span>' : '');
    const av = document.getElementById('accountAvatar'); if(av) av.textContent = (who.trim()[0] || '?');
    const head = document.getElementById('accountMenuHead');
    if(head) head.innerHTML = '<b>' + esc(who) + '</b><span>' + esc([firm, tr(USER_ROLE_LABELS[s.role] || s.role || '')].filter(Boolean).join(' · ')) + '</span>';
  }
  if(!host) return;
  const incomplete = firmProfileMissing().length > 0;
  // The gear button that used to open the separate #adminScreen modal was
  // removed 2026-09-30 (its content merged into the Admin nav tab's own
  // sub-panes — see setupAdminPaneBar()) — its "profile incomplete" amber
  // warning moves to the Admin tab's own icon instead, so the cue isn't lost.
  const tabAdminIcon = document.querySelector('#tabAdmin .ic i');
  if(tabAdminIcon) tabAdminIcon.style.color = ((s.role==='superadmin'||s.role==='tenant_admin') && incomplete) ? '#ffb020' : '';
}

// The theme (docs/redesign.md → Light theme): Dark (the default), Light — for
// outdoors — or System (the device's setting, followed live). Kept on this
// device (localStorage.uiTheme, shared by every page) and on the signed-in
// user's account (updateMyTheme; login brings it back on any device). The
// <head> script puts it on <html data-theme> before the first draw; og.css
// holds the light token values. The same functions as src/lib/theme.ts — keep them the same.
const THEME_BAR = {dark:'#10141f', light:'#eef1f7'};
function storedTheme(){ try{ const t = localStorage.getItem('uiTheme'); return t === 'light' || t === 'system' ? t : 'dark'; }catch(e){ return 'dark'; } }
function resolveTheme(c){ return c === 'system' ? (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : c; }
function applyTheme(c){
  c = c || storedTheme();
  const look = resolveTheme(c);
  document.documentElement.setAttribute('data-theme', look);
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => { m.content = THEME_BAR[look]; });
  document.querySelectorAll('.theme-seg [data-theme-v]').forEach(b => b.classList.toggle('on', b.dataset.themeV === c));
}
function setTheme(c, opts){
  c = ['dark','light','system'].includes(c) ? c : 'dark';
  try{ localStorage.setItem('uiTheme', c); }catch(e){}
  applyTheme(c);
  if(!(opts && opts.save === false) && getSession()){
    fetch(API_URL, {method:'POST', body: JSON.stringify({action:'updateMyTheme', theme: c})}).catch(()=>{});
  }
}
function pickTheme(c){ setTheme(c); }
if(window.matchMedia) matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if(storedTheme() === 'system') applyTheme('system'); });
window.addEventListener('storage', e => { if(e.key === 'uiTheme') applyTheme(); });
document.addEventListener('DOMContentLoaded', () => applyTheme());

// The account menu: a tap on the name button opens it, a tap anywhere else
// (or Escape) closes it.
function toggleAccountMenu(e){ if(e) e.stopPropagation(); document.getElementById('accountControl').classList.toggle('open'); }
function closeAccountMenu(){ const a = document.getElementById('accountControl'); if(a) a.classList.remove('open'); }
document.addEventListener('click', e => { const a = document.getElementById('accountControl'); if(a && a.classList.contains('open') && !a.contains(e.target)) closeAccountMenu(); });
document.addEventListener('keydown', e => { if(e.key === 'Escape') closeAccountMenu(); });
async function editMyName(){
  const s = getSession(); if(!s) return;
  const name = prompt(tr('Your name (shown at the top instead of the login):'), s.fullName || '');
  if(name === null) return;
  try{
    const json = await (await fetch(API_URL, {method:'POST', body: JSON.stringify({action:'updateMyName', fullName: name.trim()})})).json();
    if(!json || json.error){ showToast((json && json.error) || tr('Not saved')); return; }
    s.fullName = json.fullName; saveSession(s);
    renderAccountControl(s);
    showToast(tr('Saved'));
  }catch(e){ showToast(tr('Network error')); }
}

// ── Admin → Firms, Users, Errors, Timings (stage 6f-2) ────────────────────
// Drawn in React (src/manager/Firms.tsx, Users.tsx, Logs.tsx; the super-admin's
// landing screen into #firmsScreenRoot); the data, its caches, the saves of
// workers and the server calls that touch the page's state stay here and are
// handed over through ManagerBridge (its Admin part below).
let __firmsCache = [];
// The Admin tab and the landing screen draw again (whichever is shown).
function renderFirmsViews(){ renderAdmin(); if(window.ManagerIsland) window.ManagerIsland.renderFirmsScreen(); }
let __firmsErr='', __firmsLoaded=false;
// A super-admin's firms: the cached list first, then listTenants. An owner's
// own firm: the session's profile, then a fresh read.
async function loadFirms(){
  const s=getSession(); if(!s) return;
  if(s.role!=='superadmin'){ await refreshTenantProfile(0); renderFirmsViews(); return; }
  const cached=loadFirmsCache(), isLanding=!s.viewingTenantId;
  if(cached){ if(!__firmsLoaded) __firmsCache=cached; renderFirmsViews(); if(isLanding) markFirstContent(); }
  try{
    const json=await (await fetch(API_URL, { method:'POST', body: JSON.stringify({ action:'listTenants', ...gsAuth() }) })).json();
    if(!json || json.error){ __firmsErr=(json&&json.error)||'Load failed'; renderFirmsViews(); return; }
    __firmsErr=''; __firmsCache=json.tenants||[]; __firmsLoaded=true;
    saveFirmsCache(__firmsCache);
    renderFirmsViews();
    if(isLanding) markFreshContent('firms');
  }catch(e){ __firmsErr='No network'; renderFirmsViews(); }
}
// The firms a super-admin's snapshot shows (cached until listTenants answers), each with what Form 101 would miss.
function firmsRows(){
  const s=getSession(); if(!s||s.role!=='superadmin') return null;
  const list=__firmsLoaded?__firmsCache:(loadFirmsCache()||(__firmsCache.length?__firmsCache:null));
  return list?list.map(t=>({...t, missing:firmProfileMissing(t)})):null;
}
// Disable / Enable: flips every login of the firm (reversible).
async function setTenantsActive(ids, active){
  let ok=0;
  for(const tenantId of ids){
    try{ const json=await (await fetch(API_URL, { method:'POST', body: JSON.stringify({ action:'setTenantActive', ...gsAuth(), tenantId, active }) })).json();
      if(json && !json.error) ok++; else showToast((json&&json.error)||tr('Error')); }catch(e){ showToast(tr('No network')); }
  }
  if(ok) showToast(active ? tr('Firm enabled') : tr('Firm disabled'));
  await loadFirms();
}
// Deletes firms — irreversible: the profile, logins, schedule, punch history
// and every worker file in Storage. Runs when the Undo time is up (the React list).
async function deleteTenantsNow(ids){
  let ok=0;
  const name=ids.length===1?((__firmsCache.find(t=>t.tenantId===ids[0])||{}).companyName||''):'';
  for(const tenantId of ids){
    try{ const json=await (await fetch(API_URL, { method:'POST', body: JSON.stringify({ action:'deleteTenant', ...gsAuth(), tenantId }) })).json();
      if(json && !json.error) ok++; else showToast((json&&json.error)||tr('Error')); }catch(e){ showToast(tr('No network')); }
  }
  if(ok) showToast(ok===1 && ids.length===1 ? tr('Firm «{0}» deleted',{0:name}) : tr('{0} firms deleted',{0:ok}));
  await loadFirms();
}
// Form 101's employer block comes from the session's copy of the firm
// profile. A login keeps the copy it got at sign-in, so a change made
// elsewhere (the super-admin's Firms list) would not reach this device's
// PDFs: refresh it from the server when the app opens and before a PDF is
// built, at most once per maxAgeMs (0 = now).
let __profileFetchedAt = 0;
async function refreshTenantProfile(maxAgeMs){
  const s = getSession();
  const t = s && (s.viewingTenantId || s.tenantId);
  if(!t) return activeTenantProfile();
  if(maxAgeMs && Date.now() - __profileFetchedAt < maxAgeMs) return activeTenantProfile();
  try{
    const json = await (await fetch(API_URL, { method:'POST', body: JSON.stringify({ action:'loadTenantProfile', ...gsAuth() }) })).json();
    if(json && json.profile){ __profileFetchedAt = Date.now(); cacheTenantProfile(t, json.profile); renderAdmin(); return json.profile; }
  }catch(e){}
  return activeTenantProfile();
}

// The firm window (React, #firmModal): a new firm (with its owner's login), a
// firm of the super-admin's list, or the firm being worked in (a firm's own
// login fills in its Form 101 employer data itself). __firmWin is what it edits.
let __firmWin=null;
function showFirmWindow(mode, tenantId, profile){
  if(!window.ManagerIsland) return;
  const s=getSession(), on=!!tenantId&&tenantId===(s&&(s.viewingTenantId||s.tenantId));
  __firmWin={mode, tenantId:tenantId||null, profile:profile||{}, wa:on};
  window.ManagerIsland.openFirm();
  document.getElementById('editFirmOverlay').classList.add('open');
}
function openCreateFirmForm(){ showFirmWindow('create', null, {}); }
function openEditFirmForm(tenantId){
  const t = __firmsCache.find(x => x.tenantId === tenantId);
  if(!t){ showToast(tr('Firm not found')); return; }
  showFirmWindow('edit', tenantId, t);
}
function openMyFirmForm(){
  const s = getSession(); if(!s) return;
  const tenantId = s.viewingTenantId || s.tenantId;
  if(!tenantId){ showToast(tr('No firm selected')); return; }
  showFirmWindow('mine', tenantId, activeTenantProfile() || {});
}
// After a save: a new firm → the list; an edited firm → the session's copy of
// its profile, and every worker's Form 101 (its employer block changed) — now
// when the edited firm is the one loaded here, else when this device opens it.
function firmSaved(mode, tenantId, profile){
  closeModal('editFirmOverlay');
  if(mode==='create'){ showToast(tr('Firm created')); loadFirms(); return; }
  showToast(tr('Firm details saved'));
  cacheTenantProfile(tenantId, profile);
  if(getSession()?.role === 'superadmin') loadFirms(); else renderAdmin();
  const s=getSession(), active=s&&(s.viewingTenantId||s.tenantId);
  if(active===tenantId) regenerateAllWorkerDocs();
  else {
    try{ localStorage.setItem('form101Regen:'+tenantId,'1'); }catch(e){}
    showToast(tr('Saved. The Form 101s of this firm\'s workers update when you open it'), 5000);
  }
}

// Admin tab sub-panes (merged 2026-09-30 into the Admin nav tab — see
// docs/history.md). Punch Log for everyone who reaches the tab (the tab needs
// the `workers` permission); Firms and Users for an owner or a super-admin;
// Errors and Timings for a super-admin (listTenants / loadErrors are gated
// server-side too).
function setupAdminPaneBar(){
  const s = getSession();
  if(!s) return;
  switchAdminPane(__adminPane);
  if(s.role === 'superadmin' || s.role === 'tenant_admin') prefetchAdminUsers();
}
// Loads the Users list in the background as soon as the Admin tab opens, so
// the Users section usually draws at once; a load already in flight is shared.
let __usersFetch=null, __usersErr='';
function fetchAdminUsers(){
  if(__usersFetch) return __usersFetch;
  __usersFetch=fetch(API_URL,{method:'POST',body:JSON.stringify({action:'listUsers',...gsAuth()})})
    .then(res=>res.json())
    .finally(()=>{ __usersFetch=null; });
  return __usersFetch;
}
// The firm's logins (listUsers returns more for a super-admin: this firm's
// only), cached; then what shows them is drawn again.
function prefetchAdminUsers(){
  const tenantId=activeTenantIdForAdmin();
  return fetchAdminUsers().then(json=>{
    if(json && !json.error){
      __usersErr='';
      saveAdminCache('users_'+tenantId,(json.users||[]).filter(u=>u.tenantId===tenantId));
      if(currentTab==='admin') renderAdmin();
      // The HR names on the worker tiles come from this list.
      if(currentTab==='workers' && workers.some(w=>w.hrId)) renderWorkersPage();
      // ...and the HR commissions in Accounting → Payable by HR.
      if(currentTab==='accounting' && workers.some(w=>w.hrId)) renderAccounting();
      // ...and the HR field of a worker window already open.
      if(window.ManagerIsland) window.ManagerIsland.refreshWindows();
    } else { __usersErr=(json&&json.error)||'Load failed'; if(currentTab==='admin') renderAdmin(); }
  }).catch(()=>{ __usersErr='Network error'; if(currentTab==='admin') renderAdmin(); });
}
// The Admin tab opens with no section (the React tiles): nothing is loaded
// until a section is picked; the React section loads its own data. The
// chosen section is kept while the app stays open.
let __adminPane=null;
function switchAdminPane(pane){
  __adminPane=pane && adminPanes().includes(pane) ? pane : null;
  if(__adminPane==='errors'||__adminPane==='timings') loadLogPane(__adminPane);
  renderAdmin();
  renderCrumb();
}
// The user window (React, #userFormModal): a saved login from the list the
// Users section drew (its cache; the server only when the row isn't there),
// or a new one.
function showUserWindow(u, preset){
  if(!window.ManagerIsland) return;
  window.ManagerIsland.openUser(u, preset);
  document.getElementById('userFormOverlay').classList.add('open');
}
function openCreateUserForm(preset){ showUserWindow(null, preset); }
async function openEditUserForm(id){
  const cachedUsers = loadAdminCache('users_'+activeTenantIdForAdmin());
  let u = Array.isArray(cachedUsers) ? cachedUsers.find(x => x.id === id) : null;
  if(!u){
    const json = await fetchAdminUsers();
    u = ((json && json.users) || []).find(x => x.id === id);
  }
  if(!u){ showToast(tr('User not found')); return; }
  showUserWindow(u);
}
// After a save: a former HR's workers are no longer assigned to it, one's own
// new name shows in the header; the window closes and the list is read again.
async function userSaved(id, origRole, role, fullName){
  if(id && origRole==='hr' && role!=='hr'){
    const ids = workers.filter(w => w.hrId===id).map(w => w.id);
    if(ids.length) await assignWorkersToHr(ids, null);
  }
  const me = getSession();
  if(id && me && me.uid === id){ me.fullName = fullName; saveSession(me); renderAccountControl(me); }
  closeModal('userFormOverlay');
  showToast(tr('Saved'));
  await prefetchAdminUsers();
}
// The workers as the Users section and its windows see them (an HR's hrId, a supplier's supplierId).
function adminTeam(){ return workers.map(w=>({id:w.id, name:w.name||'', docId:String(workerDocId(w)||''), hrId:w.hrId||undefined, supplierId:w.supplierId||undefined})); }
// Logins deleted once their Undo time is up.
async function deleteUsersNow(ids){
  let ok=0;
  for(const id of ids){
    try{
      const json = await (await fetch(API_URL, { method:'POST', body: JSON.stringify({ action:'deleteUser', ...gsAuth(), id }) })).json();
      if(!json || json.error) showToast((json&&json.error)||tr('Failed')); else ok++;
    }catch(e){ showToast(tr('Network error')); }
  }
  if(ok) showToast(tr('User deleted'));
  await prefetchAdminUsers();
}

// ── HR logins and their workers (docs/admin.md → HR) ────────────────────────
// A worker's hrId is the uid of the HR login it belongs to. Only the firm's
// owner or a super-admin assigns it: here (the HR's card: list, unassign,
// "Add workers") or in the worker modal's HR field. Reassigning also moves
// the worker's past punches, days off and shift offers to the new HR (setPunchesHr).
// The HR list comes from the cached users list. It is loaded on first need
// (worker modal, a worker tile or card with an HR) — not at every app open —
// once per app open; meanwhile the cache from the last time is used.
let __hrUsersLoaded=false;
function ensureHrUsers(){
  if(__hrUsersLoaded || !isFirmAdminSession() || !activeTenantIdForAdmin()) return;
  __hrUsersLoaded=true;
  prefetchAdminUsers();
}
function hrUsers(){
  ensureHrUsers();
  const c = loadAdminCache('users_'+activeTenantIdForAdmin());
  return Array.isArray(c) ? c.filter(u => u.role==='hr') : [];
}
function hrNameOf(id){
  const u = hrUsers().find(x => x.id===id);
  return u ? (u.fullName || u.username) : '';
}
// ── Errors / Timings: the period picker (logPeriodOptions / Range / Query, src/manager/logic/admin.ts) ──
const __logPeriod={errors:'30d', timings:'30d'}, __logErr={errors:'', timings:''};
// The period's rows: the cached ones are drawn first, then loadErrors / loadTimings.
async function loadLogPane(kind){
  const pr=logPeriodRange(__logPeriod[kind]), key=kind+':'+pr.key;
  __logErr[kind]='';
  try{
    const res=await fetch(API_URL+'?action='+(kind==='errors'?'loadErrors':'loadTimings')+gsAuthQuery()+logPeriodQuery(pr));
    const json=await res.json();
    if(!json||json.error) __logErr[kind]=(json&&json.error)||'Load failed';
    else saveAdminCache(key, json.rows||[]);
  }catch(e){ __logErr[kind]='Network error'; }
  if(__adminPane===kind) renderAdmin();
}
function logPaneSnapshot(kind){
  const pr=logPeriodRange(__logPeriod[kind]), rows=loadAdminCache(kind+':'+pr.key);
  return {kind, period:pr.key, periods:logPeriodOptions(), label:pr.label, rows:Array.isArray(rows)?rows:null, error:__logErr[kind]};
}
// Reset (Errors and Timings, behind the React Alert Dialog): every error and
// every measurement, of every firm and period, deleted; the cached periods go too.
async function resetLogs(){
  try{
    const json=await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'resetLogs'})})).json();
    if(!json||json.error){ showToast(tr((json&&json.error)||'Not deleted')); return; }
    try{ Object.keys(localStorage).filter(k=>k.startsWith(ADMIN_CACHE_PREFIX+'errors')||k.startsWith(ADMIN_CACHE_PREFIX+'timings')).forEach(k=>localStorage.removeItem(k)); }catch(e){}
    showToast(tr('Deleted: {0} errors, {1} measurements',{0:json.errors||0,1:json.timings||0}));
    if(__adminPane==='timings'||__adminPane==='errors') await loadLogPane(__adminPane);
  }catch(e){ showToast(tr('Network error')); }
}
// Optimistic concurrency: the savedAt value we last loaded from the DB.





// ── Odinson Glass list pieces (docs/redesign.md → Plates) ──
// t3Line(o) draws a plate (the phone's More sheet): o.c the bar colour, o.av an
// icon avatar, o.name / o.sub / o.right HTML already escaped by the caller,
// o.cls / o.onclick. The lists themselves are React (Plate).
// rowFnKey keeps a function under a key for an onclick (the bell's actions).
const __rowFns = new Map(); let __rowFnSeq = 0;
function rowFnKey(v){
  const k = 'r' + (++__rowFnSeq); __rowFns.set(k, v);
  if(__rowFns.size > 4000) __rowFns.delete(__rowFns.keys().next().value);
  return k;
}
function t3Line(o){
  const iconAv = !!o.av && /<i class="ti /.test(o.av);
  return `<div class="t3-line${o.cls?' '+o.cls:''}" style="--c:${o.c||'var(--neutral)'}"${o.onclick?` onclick="${o.onclick}"`:''}>${iconAv?o.av:''}<div class="n"><b>${o.name}</b>${[].concat(o.sub||[]).filter(Boolean).map(x=>`<small>${x}</small>`).join('')}</div>${o.right||''}</div>`;
}
// ── Today (stage 6a): drawn in React — src/manager/Today.tsx, loaded as
// the React pieces (docs/build.md → The manager's React pieces). The page
// hands it its data and actions through ManagerBridge; renderDashboard() asks
// it to draw (render() and switchTab() call it as before).
function renderDashboard(){
  renderGreeting();
  if(window.ManagerIsland) window.ManagerIsland.renderToday();
}
// ── Schedule (stage 6b): drawn in React — src/manager/Schedule.tsx. The week
// (weekStart), the site filter (selectedClientId)
// and the data stay here; the tab reads them through ManagerBridge.schedule()
// and writes through its actions below. Opening it reads the workers'
// requests (at most once a minute).
function renderSchedulePage(){
  loadShiftRequests();
  if(window.ManagerIsland) window.ManagerIsland.renderSchedule();
}
window.addEventListener('manager-island-ready', () => { if(currentTab==='dashboard') renderDashboard(); if(currentTab==='schedule') renderSchedulePage(); if(currentTab==='workers') renderWorkersPage(); if(currentTab==='clients') renderClientsPage(); if(currentTab==='suppliers') renderSuppliersPage(); if(currentTab==='accounting') renderAccounting(); if(currentTab==='admin') renderAdmin(); if(document.getElementById('firmsScreen').style.display==='block') window.ManagerIsland.renderFirmsScreen(); renderCrumb(); });
window.ManagerBridge={
  lang:()=>currentLang(),
  dict:()=>currentDict(),
  // The snapshot Today draws from: each worker with today's shift, today's punch
  // and its notices (worked out here — they still belong to the Workers tab),
  // the suppliers, today's punches with their site.
  today(){
    const now=new Date(), t=now.toDateString(), log=getPunchLog().filter(e=>new Date(e.ts).toDateString()===t);
    return {
      ready:__dataReady,
      workers:workers.map(w=>{ const td=workerToday(w,log), sh=shiftOn(w,now);
        return {id:w.id, name:w.name||'', active:isActiveWorker(w), supplierId:w.supplierId||'', site:workerSiteName(w),
          shift:sh?{type:sh.type, start:sh.start||'', end:sh.end||''}:null, today:{k:td.k, time:td.time||''},
          notices:workerNotices(w,td).map(n=>({lvl:n.lvl, word:n.word, title:n.title}))}; }),
      suppliers:suppliers.map(x=>({id:x.id, name:x.name||'', color:x.color||''})),
      log:log.map(e=>({...e, site:punchSite(e)})),
      canAddWorker:hasPermission('workers'),
    };
  },
  openWorker:id=>openWorkerCardById(id),
  openNotices:id=>openNotices(id),
  openSuppliers:()=>switchTab('suppliers'),
  addWorker:()=>{ switchTab('workers'); openAddWorker(); },
  refresh:async()=>{ try{ await syncPunchesFromGS(); }catch(e){} render(); },
  // The Schedule tab's snapshot: the shown week, the site filter, the active
  // workers' roster and one-date changes, the sites, the workers' requests.
  schedule(){
    const off={type:'off',start:null,end:null};
    return {
      ready:__dataReady, weekStart:localYMD(weekStart), clientId:selectedClientId||null,
      workers:workers.filter(isActiveWorker).map(w=>({id:w.id, name:w.name||'', status:w.status||'active', clientIds:w.clientIds||[], site:workerSiteName(w),
        schedule:[0,1,2,3,4,5,6].map(i=>(w.schedule||[])[i]||off), dateShifts:w.dateShifts||{}})),
      clients:clients.map(c=>({id:c.id, name:c.name||'', color:c.color||''})),
      requests:__shiftReqs,
      canEdit:hasPermission('schedule'), canExport:hasPermission('exports'), canAddWorker:hasPermission('workers'),
    };
  },
  setWeek:ymd=>{ weekStart=getSundayOfWeek(new Date(ymd+'T00:00')); render(); },
  setClient:id=>filterByClient(id||null),
  // "Every <weekday>" writes the roster and drops a change of that date; "Only <date>" writes w.dateShifts.
  setShift(wid,ymd,scope,sh){
    const w=workers.find(x=>x.id===wid); if(!w) return;
    const di=new Date(ymd+'T00:00').getDay(), v={type:sh.type, start:sh.type==='work'?sh.start:null, end:sh.type==='work'?sh.end:null};
    if(scope==='date') w.dateShifts=pruneDateShifts(Object.assign({}, w.dateShifts, {[ymd]:v}));
    else {
      w.schedule=[0,1,2,3,4,5,6].map(i=>(w.schedule||[])[i]||{type:'off',start:null,end:null}); w.schedule[di]=v;
      if(w.dateShifts && w.dateShifts[ymd]){ const d=Object.assign({}, w.dateShifts); delete d[ymd]; w.dateShifts=pruneDateShifts(d); }
    }
    render(); autoSave(); showToast(tr('Shift saved'));
  },
  // One-date changes (Copy last week, Repeat for N weeks, their Undo, Back to the weekly schedule): shift null drops the change.
  applyDated(changes){
    changes.forEach(c=>{ const w=workers.find(x=>x.id===c.workerId); if(!w) return;
      const d=Object.assign({}, w.dateShifts);
      if(c.shift) d[c.date]={type:c.shift.type, start:c.shift.start||null, end:c.shift.end||null}; else delete d[c.date];
      w.dateShifts=pruneDateShifts(d); });
    render(); autoSave();
  },
  decideRequest:(id,ok)=>decideShiftRequest(id,ok),
  moveWorker(fromId,toId){
    const from=workers.findIndex(w=>w.id===fromId); if(from<0||fromId===toId) return;
    const moved=workers.splice(from,1)[0], to=workers.findIndex(w=>w.id===toId);
    workers.splice(to<0?workers.length:to,0,moved);
    render(); autoSave(); showToast(tr('Order updated'));
  },
  editWorker:id=>{ const i=workers.findIndex(w=>w.id===id); if(i>=0) openEditWorker(i); },
  // The Workers tab's snapshot (stage 6c-1): every worker's list fields, with
  // today's punch, its notices, the month's hours and the document status
  // worked out here (the card and the window that use them are still here).
  workers(){
    const now=new Date(), t=now.toDateString(), log=getPunchLog().filter(e=>new Date(e.ts).toDateString()===t), hours=workersMonthHours();
    return {
      ready:__dataReady,
      workers:workers.map(w=>{ const td=workerToday(w,log), st=workerDocStatus(w), ex=workerExpiryStatus(w);
        const badge=st.level==='ok'?'':st.failed?tr('UPLOAD FAILED'):(st.expiry&&st.expiry.level==='error')?tr('ID EXPIRED')
          :st.docExpired?tr('{0} EXPIRED',{0:tr(WORKER_DOC_TYPES[st.docExpired.doc.type]||'Document').toUpperCase()}):tr('DOCS');
        return {id:w.id, name:w.name||'', docGiven:w.docGiven||'', docSurname:w.docSurname||'', phone:w.phone||'', docId:String(workerDocId(w)||''),
          status:w.status==='vacation'||w.status==='fired'?w.status:'active', clientIds:w.clientIds||[], supplierId:w.supplierId||'', startDate:w.startDate||'',
          createdAt:w.createdAt||'', docUrl:w.docUrl||'', site:workerSiteName(w), today:{k:td.k, time:td.time||''},
          notices:workerNotices(w,td).map(n=>({lvl:n.lvl, word:n.word, title:n.title})), monthHours:hours[w.id]||0,
          docLevel:st.level, docLines:st.lines, docBadge:badge, docExpiring:!!st.expiry||st.docExpiries.length>0,
          contract:ex?{overdue:ex.level==='overdue', deadline:ex.deadline.toLocaleDateString('en-GB')}:null, canPay:!!canEditPay(w)}; }),
      clients:clients.map(c=>({id:c.id, name:c.name||'', color:c.color||'', object:c.object||''})),
      suppliers:suppliers.map(x=>({id:x.id, name:x.name||'', color:x.color||''})),
      canEdit:hasPermission('workers'),
    };
  },
  scanNew:()=>startNewScan(),
  openPay:id=>openPayModal(id),
  copyLink:id=>copyWorkerLink(id),
  setStatus:(ids,v)=>setWorkersStatus(ids,v),
  deleteWorkers(ids){
    const one=ids.length===1?workers.find(x=>x.id===ids[0]):null;
    ids.forEach(id=>deleteWorkerNow(id)); render(); autoSave();
    showToast(one?tr('{0} removed',{0:one.name}):tr('{0} workers{1}',{0:ids.length,1:''}));
  },
  // ── Clients and Suppliers (stage 6d): the tabs and their windows are React;
  // the records, the figures (salaryEntriesFor, workersMonthHours), the map
  // picker, the logins and the saves stay here.
  clients(){
    const byClient=salaryEntriesFor('month').byClient||{};
    const waiting=new Set((__hoursBatches||[]).filter(b=>b.status==='pending').flatMap(b=>(b.entries||[]).map(e=>e.clientId)));
    const empty=v=>v==null||v==='';
    return {ready:__dataReady, canEdit:hasPermission('clients'),
      clients:clients.map(c=>({id:c.id, name:c.name||'', color:c.color||'', address:c.address||'', object:c.object||'',
        workers:workers.filter(w=>isActiveWorker(w)&&(w.clientIds||[]).includes(c.id)).length, monthHours:(byClient[c.id]||{}).hours||0,
        noRate:empty(c.billRate)&&empty(c.defaultHourlyRate)&&!c.fixedBillRate&&!c.dailyBillRate, waiting:waiting.has(c.id)}))};
  },
  suppliers(){
    const hours=workersMonthHours();
    return {ready:__dataReady, canEdit:hasPermission('suppliers'),
      suppliers:suppliers.map(s=>{ const mine=workers.filter(w=>w.supplierId===s.id);
        return {id:s.id, name:s.name||'', color:s.color||'', phone:s.phone||'', workers:mine.length, monthHours:mine.reduce((t,w)=>t+(hours[w.id]||0),0)}; })};
  },
  openClient:id=>{ if(id) openEditClient(id); else openAddClient(); },
  openSupplier:id=>{ if(id) openEditSupplier(id); else openAddSupplier(); },
  manualPunch:id=>openManualPunch(id),
  deleteClients:ids=>deleteClientsNow(ids.filter(id=>clients.some(c=>c.id===id))),
  deleteSuppliers:ids=>deleteSuppliersNow(ids.filter(id=>suppliers.some(s=>s.id===id))),
  clientInfo(id){
    const c=id?clients.find(x=>x.id===id):null, e=c?((salaryEntriesFor('month').byClient||{})[c.id]||{}):{};
    return {...loginsInfo('client', c?c.id:null),
      workers:c?workers.filter(w=>isActiveWorker(w)&&(w.clientIds||[]).includes(c.id)).length:0, monthHours:e.hours||0, billed:e.total||0,
      waiting:c?(__hoursBatches||[]).filter(b=>b.status==='pending'&&(b.entries||[]).some(x=>x.clientId===c.id)).length:0,
      canDelete:hasPermission('clients'), otMult:PAY_RULES.otMult, shabbatMult:PAY_RULES.shabbatMult};
  },
  supplierInfo(id){
    const sp=id?suppliers.find(x=>x.id===id):null, hours=workersMonthHours();
    return {...loginsInfo('supplier', sp?sp.id:null),
      workers:sp?workers.filter(w=>w.supplierId===sp.id).map(w=>({id:w.id, name:w.name||'', active:isActiveWorker(w), hours:hours[w.id]||0})):[],
      payable:sp?supplierMonthPayable(sp):0, canRate:isFirmAdminSession(), canDelete:hasPermission('suppliers'), defaultRate:ManagerAcc.SUPPLIER_DEFAULT_RATE};
  },
  commitClient:(id,fields)=>commitClient(id,fields),
  commitSupplier:(id,fields)=>commitSupplier(id,fields),
  punchFromClient:()=>punchFromClientModal(),
  deleteFromEditor:kind=>closeEditorUnsaved(kind==='client'?'clientOverlay':'supplierOverlay'),
  pickPlace:(start,onPick)=>openMapPicker(start,onPick),
  saveLogin:(uid,field,value)=>saveLoginField(uid,field,value),
  newLogin:(role,id)=>newLoginFor(role,id),
  punchInfo(cid){
    const c=clients.find(x=>x.id===cid); if(!c) return null;
    const mine=workers.filter(w=>isActiveWorker(w)&&(w.clientIds||[]).includes(cid));
    return {client:{id:c.id, name:c.name||''}, workers:(mine.length?mine:workers.filter(isActiveWorker)).map(w=>({id:w.id, name:w.name||''}))};
  },
  addPunch:entry=>addManualPunch(entry),
  // ── Accounting (stage 6e): the tab and the pay window are React; the
  // period, the data, the server calls and the saves stay here.
  accounting(){
    const s=getSession()||{}, payOnly=hrPayOnly(), review=hrHourReview(), firmAdmin=isFirmAdminSession();
    const batches=(__hoursBatches||[]);
    return {
      ready:__dataReady, period:accPeriod, locale:uiLocale(), payOnly, review, reviewOnly:isHrSession()&&!hasPermission('accounting'),
      me:{uid:s.uid||'', commissionRate:Number(s.commissionRate)||0, commissionDayRate:Number(s.commissionDayRate)||0},
      canExport:hasPermission('exports'), canApprove:firmAdmin,
      canPay:Object.fromEntries(workers.map(w=>[w.id, !!canEditPay(w)])),
      hrUsers:firmAdmin?hrUsers():[],
      waiting:batches.filter(b=>b.status==='pending').length, batchesKey:batches.map(b=>(b.id||b.batchId)+':'+b.status).join(),
      openSeq:__accOpenSeq, firmName:(activeTenantProfile()||{}).companyName||'',
    };
  },
  accData:()=>accData(),
  setPeriod:async p=>{ await ensurePunchesSince(periodPunchStart(p)); accPeriod=p; renderAccounting(); renderCrumb(); },
  ensurePeriod:p=>ensurePunchesSince(periodPunchStart(p)),
  openClientWindow:id=>openEditClient(id),
  hourApprovals:async(month,fresh)=>{ const docs=await hourApprovalsOf(month,fresh); if(__punchSynced) await __punchSynced.catch(()=>{}); return docs; },
  resolveFix:async(docId,key,accept)=>{ const r=await hoursCall({action:'resolve', docId, key, accept, tenantId:fsTenantId()}); __hourApprovalsCache=null; return r.error||''; },
  openSigned:path=>openSignedHours(path),
  approveBatch:id=>approveHoursBatch(id),
  rejectBatches:ids=>ids.length===1?rejectHoursBatch(ids[0]):bulkHoursBatches(ids,false),
  hoursCall:body=>hoursCall(body),
  xlsx:async()=>{ try{ await loadXlsx(); return window.XLSX||null; }catch(e){ return null; } },
  payInfo(id){ const w=workers.find(x=>x.id===id); if(!payWindowAllowed(w)) return null; return {w:JSON.parse(JSON.stringify(w)), ro:!canEditPay(w), period:accPeriod}; },
  savePay(id,patch){
    const w=workers.find(x=>x.id===id); if(!w || !canEditPay(w)) return;
    Object.entries(patch).forEach(([k,v])=>{ if(v===undefined) delete w[k]; else w[k]=v; });
    autoSave(); closeModal('payOverlay');
    showToast(tr('Pay saved — {name}',{name:w.name||''}));
    render();
  },
  // ── Admin (stage 6f-1): the section tabs, the tiles and the Punch Log are
  // React; the punches, their saves and the server calls stay here.
  admin(){
    const s=getSession()||{}, isAdminRole=s.role==='superadmin'||s.role==='tenant_admin', from=__punchLoadedFrom;
    return {
      ready:__dataReady, pane:__adminPane, panes:adminPanes(), canClear:isAdminRole,
      firmIncomplete:isAdminRole&&firmProfileMissing().length>0,
      log:__adminPane==='punchlog'?ManagerBridge.punchLog():[],
      workers:workers.map(w=>({id:w.id, name:w.name||'', clientIds:w.clientIds||[]})),
      clients:clients.map(c=>({id:c.id, name:c.name||'', color:c.color||'', address:c.address||''})),
      loadedFrom:from&&from>ALL_PUNCHES_FROM?from.toLocaleDateString('en-GB'):null,
      // stage 6f-2
      isSuper:s.role==='superadmin', locale:uiLocale(),
      firms:firmsRows(), firmsError:__firmsErr,
      own:s.role==='superadmin'?null:{...(activeTenantProfile()||{}), missing:firmProfileMissing()},
      users:__adminPane==='users'?(()=>{ const c=loadAdminCache('users_'+activeTenantIdForAdmin()); return Array.isArray(c)?c:null; })():null,
      usersError:__usersErr,
      team:adminTeam(),
      suppliers:suppliers.map(x=>({id:x.id, name:x.name||''})),
      logs:__adminPane==='errors'||__adminPane==='timings'?logPaneSnapshot(__adminPane):null,
      firmNames:Object.fromEntries(((__firmsCache&&__firmsCache.length)?__firmsCache:(loadFirmsCache()||[])).map(t=>[t.tenantId, t.companyName||t.tenantId])),
    };
  },
  setAdminPane:p=>switchAdminPane(p),
  punchLog:()=>getPunchLog().map(e=>({...e, id:e.id, site:punchSite(e), rawSite:e.site||''})),
  loadEarlierPunches:()=>loadEarlierPunchMonth(),
  loadAllPunches:()=>ensureAllPunches().then(renderAdmin),
  exportPunches:()=>ensureAllPunches().then(exportPunchCSV),
  clearPunchMonths:months=>clearPunchMonths(months),
  savePunch:(id,ed)=>savePunchEdit(id,ed),
  deletePunches:ids=>deletePunchesNow(ids.map(String)),
  // ── Admin (stage 6f-2): Firms, Users, Errors, Timings and the landing
  // screen's firms are React; the data, the saves and the calls stay here.
  adminCall:async body=>{
    try{ return (await (await fetch(API_URL,{method:'POST', body:JSON.stringify({...body, ...gsAuth()})})).json())||{}; }
    catch(e){ return {error:'Network error'}; }
  },
  loadFirms:()=>loadFirms(),
  openFirm:id=>switchToTenant(id),
  setFirmsActive:(ids,active)=>setTenantsActive(ids,active),
  deleteFirms:ids=>deleteTenantsNow(ids),
  openFirmWindow:(mode,id)=>{ if(mode==='create') openCreateFirmForm(); else if(mode==='mine') openMyFirmForm(); else openEditFirmForm(id); },
  firmsPayable:()=>firmsPayableRows(__firmsCache),
  loadUsers:()=>prefetchAdminUsers(),
  openUserWindow:id=>{ if(id) openEditUserForm(id); else openCreateUserForm(); },
  deleteUsers:ids=>deleteUsersNow(ids),
  setLogPeriod:(kind,v)=>{ __logPeriod[kind]=v; renderAdmin(); loadLogPane(kind); },
  reloadLog:kind=>loadLogPane(kind),
  resetLogs:()=>resetLogs(),
  copyText:t=>{ copyTextToClipboard(t); },
  firmInfo:()=>__firmWin,
  loadProfile:async()=>{
    try{
      const json=await (await fetch(API_URL,{method:'POST', body:JSON.stringify({action:'loadTenantProfile', ...gsAuth()})})).json();
      if(json&&json.profile&&__firmWin){ cacheTenantProfile(__firmWin.tenantId, json.profile); return json.profile; }
    }catch(e){}
    return null;
  },
  firmMessage:async()=>{ await loadFirmMessages(true); return waTemplate(); },
  saveFirmMessage:(t,text)=>saveFirmMessage(t,text),
  firmSaved:(mode,id,profile)=>firmSaved(mode,id,profile),
  userInfo:()=>{ const hrNames={}; hrUsers().forEach(u=>{ hrNames[u.id]=u.fullName||u.username||''; });
    return {workers:adminTeam(), suppliers:suppliers.map(x=>({id:x.id, name:x.name||''})),
      clients:clients.map(c=>({id:c.id, name:c.name||'', object:c.object||''})), hrNames}; },
  hrMonthCommission:(uid,rate,dayRate)=>Object.values((salaryEntriesFor('month').byWorker)||{}).reduce((t,e)=>{ const wc=workers.find(w=>w.id===e.workerId); return wc&&wc.hrId===uid?t+commissionFor(wc,e,rate,dayRate):t; },0),
  assignWorkers:async(kind,ids,key)=>{ const n=kind==='supplier'?assignWorkersToSupplier(ids,key):await assignWorkersToHr(ids,key); prefetchAdminUsers(); return n; },
  openAssign:team=>{ if(!window.ManagerIsland) return; window.ManagerIsland.openAssign(team); document.getElementById('hrAssignOverlay').classList.add('open'); },
  userSaved:(id,orig,role,name)=>userSaved(id,orig,role,name),
  exportAs:k=>{ ({excel:exportExcel, pdf:exportPDF, json:exportJSON})[k](); },
  toast:(t,ms)=>showToast(t,ms),

  // ── The worker card, the worker window, documents and hours (stage 6c-2):
  // drawn in React into the page's overlays; the data and the uploads stay here.
  record:id=>{ const w=workers.find(x=>x.id===id); return w?JSON.parse(JSON.stringify(w)):null; },
  card(id){
    const w=workers.find(x=>x.id===id); if(!w) return null;
    const head=workerHeadOf(w), st=workerDocStatus(w), ex=workerExpiryStatus(w), sh=shiftOn(w,new Date()), b=latestHoursBatch(w.id);
    const sup=suppliers.find(s=>s.id===w.supplierId);
    return {...head, w:JSON.parse(JSON.stringify(w)), canEdit:hasPermission('workers'), canPay:!!canEditPay(w), canExport:hasPermission('exports'),
      isFirmAdmin:isFirmAdminSession(), hr:w.hrId?{name:hrNameOf(w.hrId), color:hrColor(w.hrId)}:null,
      clients:(w.clientIds||[]).map(cid=>clients.find(x=>x.id===cid)).filter(Boolean).map(c=>({id:c.id, name:c.name||'', color:c.color||''})),
      supplier:sup?{name:sup.name||'', color:sup.color||''}:null,
      shiftToday:sh&&sh.type==='work'&&sh.start?{start:sh.start, end:sh.end||''}:null,
      contract:ex?{overdue:ex.level==='overdue', deadline:ex.deadline.toLocaleDateString('en-GB')}:null,
      weekHours:workerTotalHours(w), docLevel:st.level, docLines:st.lines, docExpiry:docExpiryMap(w),
      hoursBatch:b?{status:b.status, when:(b.status==='pending'?b.uploadedAt:b.decidedAt)||''}:null};
  },
  notices:id=>{ const w=workers.find(x=>x.id===id); return w?workerHeadOf(w):null; },
  editorInfo(w,editId){
    const rec=editId?workers.find(x=>x.id===editId):null, st=workerDocStatus(rec||w);
    return {...(rec?workerHeadOf(rec):{name:w.name||'', color:'var(--neutral)', site:'', today:{k:''}, monthHours:0, notices:[]}),
      clients:clients.map(c=>({id:c.id, name:c.name||'', color:c.color||'', object:c.object||'', lat:c.lat, lng:c.lng, radius:c.radius})),
      suppliers:suppliers.map(x=>({id:x.id, name:x.name||''})),
      isFirmAdmin:isFirmAdminSession(), hrUsers:isFirmAdminSession()?hrUsers().map(u=>({id:u.id, name:u.fullName||u.username})):[],
      hasScan:workerHasScanPages(rec||null),
      liveOthers:workerScanLive(rec||null)?(window.__aiPacketOtherPages||[]).filter(x=>x&&x.b64).length:null,
      docLevel:st.level, docLines:st.lines, docMissing:st.missing, docFailed:st.failed, docExpiryText:st.expiry?st.expiry.text:'',
      docProblems:st.missing.length+(st.expiry?1:0)+st.docExpiries.length+(st.failed?1:0), docExpiry:docExpiryMap(rec||w),
      punchLink:buildPunchLink({token:(rec||w).token||''})};
  },
  closeModal:id=>closeModal(id),
  setWorkerStatus(id,v){ const i=workers.findIndex(x=>x.id===id); if(i>=0) setWorkerStatus(i,v); },
  editFromCard:id=>editFromWorkerCard(id),
  rescanFromCard:id=>{ const i=workers.findIndex(x=>x.id===id); if(i>=0) rescanFromWorkerCard(i); },
  payFromCard:id=>{ closeModal('workerCardOverlay'); openPayModal(id); },
  openDocUpload:id=>openWorkerDocUpload(id),
  openHoursImport:id=>openHoursImportModal(id),
  openHoursExport:id=>openHoursExportModal(id),
  openCard:id=>openWorkerCardById(id),
  // Delete never asks (the card's Undo snack): when its time is up the entries go, saved, and their files are deleted.
  removeDocs(wid,ids){
    const w=workers.find(x=>x.id===wid); if(!w) return;
    const gone=(w.docs||[]).filter(d=>ids.includes(String(d.id))); if(!gone.length) return;
    w.docs=(w.docs||[]).filter(d=>!gone.includes(d));
    autoSave(); render();
    gone.forEach(d=>{ if(d.fileId) gsDeleteWorkerDoc(d.fileId); });
  },
  setScanField(wid,key,v){
    const w=workers.find(x=>x.id===wid); if(!w) return;
    w[key]=v;
    if(key==='docGiven'||key==='docSurname') w.name=((w.docGiven||'')+' '+(w.docSurname||'')).trim();
    autoSave(); render();
  },
  regenerateDoc:(id,sig)=>regenerateWorkerDoc(id,sig||undefined),
  findScanFields:(editId,keys,docType)=>findScanFields(editId?workers.find(x=>x.id===editId)||null:null,keys,docType),
  rescan:()=>rescanFromWorkerModal(),
  newToken:id=>regenerateWorkerToken(id),
  findByDocId(docId){ const d=workers.find(w=>workerDocId(w)===docId); return d?{id:d.id, name:d.name||'', clientIds:d.clientIds||[]}:null; },
  isHr:()=>isHrSession(),
  async docExistsInFirm(docId,workerId){
    const r=await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'checkWorkerDoc',...gsAuth(),docId,...(workerId?{workerId}:{})})})).json();
    return !!(r&&r.exists);
  },
  liveScan:()=>!!window.__aiScanImage,
  rescannedId:()=>window.__aiRescannedWorkerId||null,
  setRescanned:id=>{ window.__aiRescannedWorkerId=id; },
  // An edit: the form over the record. Moved to a new client that has a rate: that client's rate is the
  // default again — an hourly worker's own rate is cleared (user decision 2026-10-05), only by a login
  // that may change pay. An HR change moves the worker's punches too (assignWorkersToHr).
  commitEdit(id,fields,hrPicked){
    const i=workers.findIndex(x=>x.id===id); if(i<0) return;
    const prevW=workers[i], updated={...prevW,...fields}; delete updated.avatarB64;
    const addedRated=(updated.clientIds||[]).filter(cid=>!(prevW.clientIds||[]).includes(cid))
      .some(cid=>{ const c=clients.find(x=>x.id===cid); return c&&c.defaultHourlyRate!=null&&c.defaultHourlyRate!==''; });
    if(addedRated && !isDailyPay(updated) && wOwnRate(updated)!=='' && canEditPay(updated)){ updated.hourlyRate=0; updated.regRate=null; }
    workers[i]=updated;
    if(hrPicked!==undefined && (prevW.hrId||null)!==hrPicked) assignWorkersToHr([updated.id],hrPicked);
    render(); autoSave();
  },
  // A new worker: an HR login's own; the owner may pick one.
  addRecord(rec,hrPicked){
    if(isHrSession()) rec.hrId=getSession().uid;
    else if(hrPicked) rec.hrId=hrPicked;
    workers.push(rec);
    render(); autoSave();
  },
  async uploadForm101(isId,id,sig){
    if(sig!==undefined) window.__wCapturedSigPng=sig;
    await autoUploadWithRetry(isId,id);
  },
  genToken:()=>genToken(),
  newId:()=>uid(),
  fileForStorage:f=>fileForStorage(f),
  uploadWorkerFile:(body,onProgress)=>uploadWorkerFile({...body,...gsAuth()},onProgress),
  addDocs(wid,docs){ const w=workers.find(x=>x.id===wid); if(w&&docs.length){ w.docs=[...(w.docs||[]),...docs]; autoSave(); render(); } },
  reportError:(msg,where)=>reportError(msg,where,''),
  hoursInfo(id){
    const w=workers.find(x=>x.id===id); if(!w) return null;
    const own=(w.clientIds||[]).map(cid=>clients.find(c=>c.id===cid)).filter(Boolean);
    return {name:w.name||'', daily:!!isDailyPay(w), clients:(own.length?own:clients).map(c=>({id:c.id, name:c.name||''}))};
  },
  parseHoursSheet:f=>parseHoursExcelFile(f),
  filePages:f=>fileToUploadPages(f),
  readHoursPage:pg=>parseHoursImagePage(pg),
  async sendHours(entries,fileName){
    return await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'savePendingHoursBatch',...gsAuth(),entries,fileName})})).json();
  },
  // An own-workers HR reads only its own batches (the rules).
  async loadPendingHours(){ return ((await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'loadPendingHours',...gsAuth()})})).json()).batches)||[]; },
  async exportHours(id,y,m,format){ await ensurePunchesSince(new Date(y,m,0)); exportShiftsDetail(id,y,m,format); },
};
// The head of the worker card, the notices sheet and the worker window: the
// plate's colour, site, today's punch, the month's hours and the notices with
// their actions (by rights).
function workerHeadOf(w){
  const t=workerToday(w,todayPunchLog()), ns=workerNotices(w,t);
  return {name:w.name||'', color:workerBarColor(w,ns), site:workerSiteName(w), today:{k:t.k, time:t.time||''}, monthHours:workersMonthHours()[w.id]||0,
    notices:ns.map(n=>({lvl:n.lvl, word:n.word, title:n.title, icon:n.icon||'', detail:n.detail||'',
      acts:(n.acts||(n.act?[n.act]:[])).map(a=>({label:a.label, icon:a.icon||'', wa:!!a.wa, run:a.fn}))}))};
}
function docExpiryMap(w){ const m={}; workerDocExpiries(w).forEach(x=>{ m[String(x.doc.id)]={level:x.level, text:x.text}; }); return m; }

// Per-client and per-supplier rate tables in Accounting: turned off for now
// (user request 2026-10-11). Rates already set in them still count in pay
// and commission (effectiveRates, w.supplierRates); true shows them again.
// ── Accounting (stage 6e): the tab is React (src/manager/Accounting.tsx, the
// root #accountingRoot) and its figures are src/manager/accounting.ts, which
// the React pieces hand the page as window.ManagerAcc. The period
// (accPeriod), the data, the server calls (hours approvals, pending batches)
// and the pay window's save stay here; these wrappers keep the old names for
// the page's other callers (the client and supplier windows, the user form,
// the bell).
let accPeriod='week', __accOpenSeq=0;
function accData(){ return {log:getPunchLog(), workers, clients, suppliers, tr}; }
function salaryEntriesFor(period){ return window.ManagerAcc ? ManagerAcc.salaryEntriesFor(accData(), period) : {byWorker:{}, byClient:{}, byDay:{}}; }
function commissionFor(w, e, hourRate, dayRate){ return ManagerAcc.commissionFor(w, e, hourRate, dayRate); }
function supplierCommission(w, e, sid){ return ManagerAcc.supplierCommission(w, e, sid); }
function hourApprovalSummary(doc, month){ return ManagerAcc.hourApprovalSummary(accData(), doc, month); }
function renderAccounting(){ if(window.ManagerIsland) window.ManagerIsland.renderAccounting(); }
function setAccTab(k){ if(window.ManagerIsland) window.ManagerIsland.setAccTab(k); renderCrumb(); }

// The hours function (the HR's Hours approval, the owner's approvals list and fixes).
const HOURS_REVIEW_FN_URL = 'https://europe-west3-schedule-odinson.cloudfunctions.net/hours';
async function hoursCall(body){
  const idToken = await (await loadFirestoreBackend()).idToken();
  const res = await fetch(HOURS_REVIEW_FN_URL, {method:'POST',
    headers:{'Content-Type':'application/json', Authorization:'Bearer ' + idToken}, body: JSON.stringify(body)});
  return res.json();
}
// The month's approval documents (the hours function, list) — every login's.
// Kept for a minute per month: Accounting redraws on every punch, which must
// not ask the server each time; opening the tab and an accept / reject
// drop the copy, the accountant report always reads afresh (fresh).
const HOUR_APPROVALS_TTL=60e3;
let __hourApprovalsCache=null;
async function hourApprovalsOf(month, fresh){
  const c=!fresh&&__hourApprovalsCache, key=fsTenantId()+'|'+month;
  if(c&&c.key===key&&Date.now()-c.at<HOUR_APPROVALS_TTL) return c.docs;
  const r=await hoursCall({action:'list', month, tenantId:fsTenantId()});
  if(r.error) throw new Error(r.error);
  __hourApprovalsCache={key, at:Date.now(), docs:r.docs||[]};
  return __hourApprovalsCache.docs;
}
// A client's signed month: the PDF opens in a new tab (storage.rules: the firm's managers read).
async function openSignedHours(path){
  const win=window.open('', '_blank');
  try{ const url=await (await loadFirestoreBackend()).storageUrl(path); if(win) win.location.href=url; else location.href=url; }
  catch(e){ if(win) win.close(); showToast(tr('Could not open the file')); }
}

// Hours-import approval queue (Admin/Roles plan, stage 14): only tenant_admin /
// superadmin approve or reject (the server checks the same).
async function bulkHoursBatches(ids, approve){
  if(approve){ for(const id of ids) await approveHoursBatch(id); return; }
  if(!confirm(tr('Reject {n} batch(es)?',{n:ids.length}))) return;
  let done=0;
  for(const batchId of ids){
    try{
      const json=await (await fetch(API_URL,{method:'POST', body:JSON.stringify({action:'rejectPendingHours', ...gsAuth(), batchId})})).json();
      if(json.error) showToast(json.error); else done++;
    }catch(e){ showToast(tr('Failed: {e}',{e:e.message})); }
  }
  showToast(tr('{n} batch(es) rejected',{n:done}));
}
async function approveHoursBatch(batchId){
  try{
    const res = await fetch(API_URL, { method:'POST', body: JSON.stringify({ action:'approvePendingHours', ...gsAuth(), batchId }) });
    const json = await res.json();
    if(json.error){ showToast(json.error); return; }
    showToast(tr('{n} shift(s) approved',{n:json.created}));
    // Approved hours are often for a past month, older than the live window
    // — load back to the earliest of them so they show.
    if(json.created){
      try{
        const made=await (await loadFirestoreBackend()).punchesOfBatch(fsTenantId(), batchId);
        const first=made.map(e=>new Date(e.ts)).filter(d=>!isNaN(d)).sort((a,b)=>a-b)[0];
        if(first) await ensurePunchesSince(new Date(first.getFullYear(), first.getMonth(), first.getDate()-1));
      }catch(e){ console.warn('Loading approved punches failed:', e); }
    }
    renderAccounting();
  }catch(e){ showToast(tr('Failed: {e}',{e:e.message})); }
}
async function rejectHoursBatch(batchId){
  if(!confirm(tr('Reject this batch?'))) return;
  try{
    const res = await fetch(API_URL, { method:'POST', body: JSON.stringify({ action:'rejectPendingHours', ...gsAuth(), batchId }) });
    const json = await res.json();
    if(json.error){ showToast(json.error); return; }
    showToast(tr('Batch rejected'));
  }catch(e){ showToast(tr('Failed: {e}',{e:e.message})); }
}

// ── Pay window (openPayModal; Accounting → Salary and the worker card) ────
// The one place a worker's money is set, drawn in React (src/manager/PayWindow.tsx).
// The firm owner, a super-admin and staff with Accounting edit; an HR (its
// reduced Accounting) sees its own workers' pay window read-only, and edits
// it too with "Edit own workers' pay" (permission payEdit) — its own workers
// only (w.hrId is its uid).
function canEditPay(w){
  const s=getSession();
  if(!s) return false;
  if(s.role==='tenant_admin'||s.role==='superadmin') return true;
  // (the rules let an HR write a worker only with Workers or Schedule)
  if(s.role==='hr') return hrPayOnly() && hasPermission('payEdit') && (hasPermission('workers')||hasPermission('schedule')) && (!w || w.hrId===s.uid);
  return s.role==='staff' && hasPermission('accounting');
}
function openWorkerCardById(wid){ const i=workers.findIndex(w=>w.id===wid); if(i>=0) openWorkerCard(i); }
function payWindowAllowed(w){ return !!w && (canEditPay(w) || (hrPayOnly() && w.hrId===(getSession()||{}).uid)); }
function openPayModal(wid){
  const w=workers.find(x=>x.id===wid); if(!payWindowAllowed(w) || !window.ManagerIsland) return;
  window.ManagerIsland.openPay(wid);
  document.getElementById('payOverlay').classList.add('open');
}

// --- One worker's hours → PDF / Excel: getWorkerMonthShifts(), exportShiftsDetail()
// are src/manager/logic/exports.ts.


// --- Admin Panel -------------------------------------------------------------
// True latest punch by timestamp (robust to array order / back-dated manual entries / sync).
function latestOf(entries){
  if(!entries||!entries.length) return null;
  return entries.reduce((a,b)=> new Date(b.ts).getTime() > new Date(a.ts).getTime() ? b : a);
}
// Resolve the site shown for a punch: a recorded site that matches a current
// client is kept (it was chosen on purpose); otherwise fall back to the
// worker's linked client name (so site follows client when not set manually).
function workerClientName(workerId){
  const w = workers.find(x=>x.id===workerId);
  if(!w) return '';
  const c = (w.clientIds||[]).map(id=>clients.find(x=>x.id===id)).filter(Boolean)[0];
  return c ? c.name : '';
}
function punchSite(e){
  if(e && e.clientId){ const c=clients.find(x=>x.id===e.clientId); if(c) return c.name; }
  if(e && e.site && clients.some(c=>c.name===e.site)) return e.site; // legacy entries without clientId
  return workerClientName(e && e.workerId) || (e && e.site) || '';
}

// Every list that grows (workers, clients, suppliers, firms, users, punch
// log, errors, timings, pending hours, salary and rate tables, ...) draws
// LIST_PAGE rows at first. The next LIST_PAGE rows come only when the user
// scrolls the "Show more" row into view, or taps it — exactly one page per
// reach of the end, no pre-loading. `sig` describes what is listed (filters,
// grouping): while it stays the same, a redraw (new punch, refresh) keeps
// what was already opened; a new filter starts again from the first page.
// opts.table/colspan: rows of a <tbody>; opts.grid: tiles of a CSS grid.
const LIST_PAGE = 10;
const __pagedLists = {};
function renderPagedList(el, key, sig, items, rowHtml, opts){
  if(!el) return;
  opts = opts || {};
  const st = __pagedLists[key] && __pagedLists[key].sig === sig ? __pagedLists[key] : (__pagedLists[key] = {sig, shown: LIST_PAGE});
  const n = Math.min(items.length, st.shown);
  el.innerHTML = (opts.head || '') + items.slice(0, n).map((it, i) => rowHtml(it, i)).join('') + pagedMoreHtml(items.length - n, opts);
  wirePagedMore(el, key, items, rowHtml, opts);
}
function pagedMoreHtml(left, opts){
  if(left <= 0) return '';
  const btn = `<button class="btn sm paged-more-btn" style="margin:6px auto;display:flex"><i class="ti ti-chevron-down"></i> ${tr('Show more ({0} left)',{0:(left)})}</button>`;
  if(opts.table) return `<tr class="paged-more"><td colspan="${opts.colspan||20}" style="padding:4px">${btn}</td></tr>`;
  return `<div class="paged-more" style="${opts.grid?'grid-column:1/-1;':''}">${btn}</div>`;
}
function wirePagedMore(el, key, items, rowHtml, opts){
  const st = __pagedLists[key];
  st.more = null;
  const more = el.querySelector(':scope > .paged-more');
  if(!more) return;
  st.more = more;
  st.next = () => {
    if(st.more !== more || !more.isConnected) return;
    const from = st.shown;
    st.shown += LIST_PAGE;
    const to = Math.min(items.length, st.shown);
    more.insertAdjacentHTML('beforebegin', items.slice(from, to).map((it, i) => rowHtml(it, from + i)).join(''));
    more.remove();
    el.insertAdjacentHTML('beforeend', pagedMoreHtml(items.length - to, opts));
    wirePagedMore(el, key, items, rowHtml, opts);
  };
  more.querySelector('button').onclick = () => st.next();
}
// On a user scroll (any scrolling element: the page or a modal), each list
// whose "Show more" row is now visible gets its next page — one per frame.
// Only a scroll that follows the user's own input (wheel, touch, key, click)
// counts, and each input allows one page at most: the browser also fires
// scroll when a page's height changes after a redraw, which would otherwise
// chain-load page after page.
// __pagedUp: the last input moved up (wheel up, finger down, ArrowUp…) —
// then nothing loads, even with "Show more" in view.
let __pagedScrollQueued = false, __pagedUserAt = 0, __pagedUp = false, __pagedTouchY = null;
['wheel','touchstart','touchmove','touchend','keydown','pointerdown'].forEach(t =>
  window.addEventListener(t, e => {
    __pagedUserAt = Date.now();
    // A downward wheel / swipe / key while "Show more" is already in view
    // loads the next page too: when the page is short enough not to scroll
    // (a short list on a big screen) no scroll event would ever come.
    let down = false;
    if(t === 'touchstart'){ __pagedTouchY = e.touches && e.touches[0] ? e.touches[0].clientY : null; __pagedUp = false; }
    else if(t === 'touchmove' && e.touches && e.touches[0] && __pagedTouchY != null){
      const y = e.touches[0].clientY;
      if(Math.abs(y - __pagedTouchY) > 4){ __pagedUp = y > __pagedTouchY; down = !__pagedUp; __pagedTouchY = y; }
    }
    else if(t === 'wheel' && e.deltaY){ __pagedUp = e.deltaY < 0; down = !__pagedUp; }
    else if(t === 'keydown'){
      if(['ArrowDown','PageDown','End',' '].includes(e.key)){ __pagedUp = false; down = true; }
      else if(['ArrowUp','PageUp','Home'].includes(e.key)) __pagedUp = true;
    }
    else if(t === 'pointerdown' && e.pointerType === 'mouse') __pagedUp = false;
    if(down) _pagedOnScroll();
  }, {capture:true, passive:true}));
function _pagedVisibleBottom(node){
  let bottom = window.innerHeight;
  for(let p = node.parentElement; p && p !== document.body; p = p.parentElement){
    const oy = getComputedStyle(p).overflowY;
    if(oy === 'auto' || oy === 'scroll') bottom = Math.min(bottom, p.getBoundingClientRect().bottom);
  }
  return bottom;
}
function _pagedOnScroll(){
  if(__pagedScrollQueued || __pagedUp || !__pagedUserAt || Date.now() - __pagedUserAt > 1500) return;
  __pagedScrollQueued = true;
  requestAnimationFrame(() => {
    __pagedScrollQueued = false;
    for(const k in __pagedLists){
      const st = __pagedLists[k], more = st.more;
      if(!more || !more.isConnected || !more.getClientRects().length) continue;
      if(more.getBoundingClientRect().top <= _pagedVisibleBottom(more)){ __pagedUserAt = 0; st.next(); return; }
    }
  });
}
window.addEventListener('scroll', _pagedOnScroll, {capture:true, passive:true});

// ── Admin (stage 6f-1): the section tabs, the tiles and the Punch Log are
// drawn in React — src/manager/Admin.tsx, the root #adminRoot. The punches
// (getPunchLog), their saves, Export CSV and Clear Log's server call stay
// here; ManagerBridge.admin() and its actions below hand them over.
function renderAdmin(){ if(window.ManagerIsland) window.ManagerIsland.renderAdmin(); }
// "Load earlier month": to the 1st of the month already partly loaded, or the month before it.
function loadEarlierPunchMonth(){
  const f=__punchLoadedFrom||punchWindowStart();
  return ensurePunchesSince(new Date(f.getFullYear(), f.getMonth()-(f.getDate()===1?1:0), 1)).then(renderAdmin);
}
// The punch window's save: type, time, site (a client, none = the worker's
// client name, or the stored custom site kept), notes; marked edited by admin.
function savePunchEdit(id, ed){
  const log = getPunchLog();
  const idx = log.findIndex(x=>String(x.id)===String(id));
  if(idx<0) return;
  log[idx].type = ed.type;
  // ts is what pay and the live sync use (time is rebuilt from it), so a new
  // time moves ts too — same local day, the edited hour and minute.
  const tm = /^(\d{1,2}):(\d{2})$/.exec(ed.time||''), when = new Date(log[idx].ts);
  if(tm && ed.time !== log[idx].time && !isNaN(when.getTime())){
    when.setHours(Number(tm[1]), Number(tm[2]), 0, 0);
    log[idx].ts = when.toISOString();
  }
  log[idx].time = ed.time;
  if(ed.site==='__custom__'){
    // unchanged custom text kept from before — clientId stays null
  } else if(ed.site){
    const c = clients.find(x=>x.id===ed.site);
    log[idx].clientId = c ? c.id : null;
    log[idx].site      = c ? c.name : (log[idx].site || workerClientName(log[idx].workerId));
  } else {
    log[idx].clientId = null;
    log[idx].site      = workerClientName(log[idx].workerId);
  }
  log[idx].notes = ed.notes;
  log[idx].editedBy = 'admin';
  log[idx].editedAt = new Date().toISOString();
  savePunchLog(log);
  gsUpdatePunch(log[idx]);
  render();
  showToast(tr('Record updated'));
}
// Punches deleted from the log once their Undo time is up.
function deletePunchesNow(ids){
  const gone=getPunchLog().filter(x=>ids.includes(String(x.id)));
  if(!gone.length) return;
  savePunchLog(getPunchLog().filter(x=>!ids.includes(String(x.id))));
  gone.forEach(e=>gsDeletePunch(e.id));
  render();
  showToast(tr('Record deleted'));
}

function exportPunchCSV(){
  const log = getPunchLog();
  if(!log.length){ showToast(tr('No records to export')); return; }
  const rows=[['Worker','Supplier','Type','Time','Date','Site','Distance(m)','GPS Accuracy','Notes','Edited']];
  log.forEach(e=>{
    const _w=workers.find(w=>w.id===e.workerId);
    const supName=suppliers.find(s=>s.id===_w?.supplierId)?.name||'';
    rows.push([
      e.workerName||'',
      supName,
      e.type?.toUpperCase()||'',
      e.time||'',
      new Date(e.ts).toLocaleDateString('en-GB'),
      punchSite(e),
      e.dist!=null?e.dist:'',
      e.gpsAccuracy!=null?Math.round(e.gpsAccuracy):'',
      e.notes||'',
      e.editedAt?new Date(e.editedAt).toLocaleString():''
    ]);
  });
  const csv=rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download='punch-log-'+localYMD(new Date())+'.csv'; a.click();
  URL.revokeObjectURL(url);
  showToast(tr('CSV exported!'));
}

// Admin → Punch Log → "Clear Log" (the React Alert Dialog picks whole
// months): a CSV backup of exactly the rows being deleted is downloaded
// first, then they are deleted from the database (deletePunchesByMonths) and
// the local cache. Months are keyed 'yyyy-MM' from the punch's own `date`
// (dd/MM/yyyy, the server-formatted field — same one the backend groups by),
// falling back to ts.
function punchMonthKey(e){
  const m=String(e.date||'').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(m) return m[3]+'-'+m[2].padStart(2,'0');
  const d=new Date(e.ts);
  return isNaN(d) ? null : d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
}
async function clearPunchMonths(months){
  if(!months.length) return false;
  const all=getPunchLog();
  const doomed=all.filter(e=>months.includes(punchMonthKey(e)));
  // Backup first: exportPunchCSV() reads getPunchLog(), so point it at just
  // the rows being deleted for the duration of the call.
  if(doomed.length){
    try{ savePunchLog(doomed); exportPunchCSV(); }catch(e){} finally{ savePunchLog(all); }
  }
  try{
    const res=await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'deletePunchesByMonths',...gsAuth(),months})});
    const json=await res.json();
    if(!json || json.error){ showToast(tr('Delete failed: {0}',{0:((json&&json.error)||'unknown error')})); return false; }
    savePunchLog(getPunchLog().filter(e=>!months.includes(punchMonthKey(e))));
    render();
    showToast(tr('{0} records deleted from the database (backup downloaded)',{0:(json.deleted)}),3500);
    return true;
  }catch(e){
    showToast(tr('Delete failed: {0}',{0:(e.message)})); return false;
  }
}

// --- Toast ------------------------------------------------------------------------------------------------------------------------------------
// Any toast text goes through tr(): a server message in the dictionary shows translated.
// Toast (the same in all three pages): small, an icon and a coloured edge by
// its kind, guessed from the text — error, ongoing (ends with …), warning,
// else done.
const TOAST_ICONS={ok:'ti-circle-check',warn:'ti-alert-triangle',err:'ti-alert-circle',info:'ti-info-circle'};
function toastKind(t){
  if(/fail|error|could not|couldn't|not saved|denied|refused|invalid|נכשל|שגיאה|לא נשמר|לא ניתן/i.test(t)) return 'err';
  if(/(…|\.\.\.)\s*$/.test(t)) return 'info';
  if(/⚠|warn|check|empty|missing|not found|בדקו|ריק|חסר|לא נמצא/i.test(t)) return 'warn';
  return 'ok';
}
function showToast(msg,dur){
  const t=document.getElementById('toast'), text=typeof msg==='string'?tr(msg):String(msg), k=toastKind(text);
  t.className='toast show '+k; t.innerHTML='<i class="ti '+TOAST_ICONS[k]+'"></i><span></span>'; t.lastChild.textContent=text;
  clearTimeout(t.__hide); t.__hide=setTimeout(()=>t.classList.remove('show'),dur||2500);
}
// ── New version check (2026-10-04; the same code in schedule-manager.html,
// worker-punch.html and supplier-portal.html). An app left open — a PWA in
// the background — keeps running the code it loaded, even after a deploy.
// When the page comes back to the screen, and every 30 min while it is
// shown, the files it runs are asked for their ETag (HEAD: the service
// worker only handles GET, and cache:'no-store' skips the HTTP cache). The
// first answer is the baseline; a changed ETag later means a deploy, and a
// bar offers to reload. Nothing reloads on its own (typed data stays).
function startVersionWatch(files){
  let base=null, shown=false;
  const tags=async()=>{
    const out={};
    for(const f of files()){
      const r=await fetch(f,{method:'HEAD',cache:'no-store'});
      if(!r.ok) return null;
      out[f]=r.headers.get('etag')||r.headers.get('last-modified')||'';
    }
    return out;
  };
  const check=async()=>{
    if(shown||document.visibilityState!=='visible'||navigator.onLine===false) return;
    try{
      const t=await tags(); if(!t) return;
      if(!base){ base=t; return; }
      for(const f in t){ if(!(f in base)){ base[f]=t[f]; continue; } if(t[f]&&base[f]&&t[f]!==base[f]){ shown=true; showNewVersionBar(); return; } }
    }catch(e){}
  };
  document.addEventListener('visibilitychange',check);
  setInterval(check,30*60*1000);
  check();
}
function showNewVersionBar(){
  if(document.getElementById('newVersionBar')) return;
  // One compact line at the top (per user request 2026-10-11): it never
  // covers the bottom tab bar and stays until Update or ✕.
  document.body.insertAdjacentHTML('beforeend',`<div id="newVersionBar" role="status" style="position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 10px);transform:translateX(-50%);z-index:100000;display:flex;align-items:center;gap:10px;width:max-content;max-width:calc(100% - 24px);box-sizing:border-box;padding:6px 6px 6px 12px;border-radius:999px;background:#181c27;border:1px solid rgba(79,142,247,.45);color:#eef0f8;font:600 13px/1.2 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45)">
    <span style="width:8px;height:8px;border-radius:50%;background:#4f8ef7;box-shadow:0 0 0 4px rgba(79,142,247,.2);flex:none"></span>
    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${tr('A new version is available')}</span>
    <button type="button" onclick="location.reload()" style="flex:none;border:0;border-radius:999px;padding:6px 14px;background:#4f8ef7;color:#fff;font:inherit;cursor:pointer">${tr('Update')}</button>
    <button type="button" aria-label="${tr('Close')}" onclick="this.parentElement.remove()" style="flex:none;border:0;background:none;color:#7c84a0;font:inherit;font-size:15px;cursor:pointer;padding:4px 8px 4px 2px">✕</button></div>`);
}
startVersionWatch(()=>[location.pathname,'og.css','payroll.js','firestore-backend.js',...(window.__scanPipelineReady?['scan-pipeline.js']:[])]);

const AVATAR_SIZE=160; // shared with scan-pipeline.js's cropPortraitAvatar() and confirmAvatarCrop() below (manual crop editor) — must stay in THIS file, not the lazy one, since confirmAvatarCrop() runs on every worker-photo edit regardless of scanning
// Worker avatars are black and white (per user request 2026-10-04): the
// portrait is turned to grey on the AVATAR_SIZE canvas it was cut onto, in
// both the scan's portrait crop (cropPortraitAvatar) and the manual crop
// editor (confirmAvatarCrop). Pixel math, so it works on every browser.
function grayscaleCanvas(cv){
  const ctx=cv.getContext('2d'), im=ctx.getImageData(0,0,cv.width,cv.height), d=im.data;
  for(let i=0;i<d.length;i+=4){ const y=Math.round(0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]); d[i]=d[i+1]=d[i+2]=y; }
  ctx.putImageData(im,0,0);
  return cv;
}

// ===== Lazy-loaded scan pipeline (added 2026-09-28, optimization) =====
// The AI document-scan pipeline (corner editor, alignment/OCR orchestration,
// homography/warp math, review screens — everything scanning-specific) lives
// in scan-pipeline.js, a plain <script>-tag-injected sibling file, not an ES
// module (this app has no build step/bundler and no import/export anywhere —
// see the "No modules/imports" convention below). It's fetched once, only
// when a scan actually starts, instead of parsing with the rest of this
// (already ~5000+ line) file on every single page load, most of which never
// touch scanning at all. Every function in it becomes an ordinary global
// once loaded, exactly as if it were still inline here.
let _scanPipelineLoading=null;
// --- Upload preparation (shared by every file upload) -------------------------
// downscaleForUpload(), fileToUploadPages(), filesToUploadPages(),
// fileForStorage(), _loadPdfJs() are src/manager/logic/uploads.ts (CLAUDE.md →
// Uploads).

function ensureScanPipelineLoaded(){
  if(window.__scanPipelineReady) return Promise.resolve();
  if(_scanPipelineLoading) return _scanPipelineLoading;
  _scanPipelineLoading=new Promise((resolve,reject)=>{
    const s=document.createElement('script');
    s.src='scan-pipeline.js';
    s.onload=()=>{ window.__scanPipelineReady=true; resolve(); };
    s.onerror=()=>{ _scanPipelineLoading=null; reject(new Error('scan-pipeline.js failed to load')); };
    document.head.appendChild(s);
  });
  return _scanPipelineLoading;
}
// New-scan entry point (the "Scan passport" button) — awaits the
// pipeline before calling openAiScan(), which only exists once it's loaded.
// The Cloud Function warm-up (warmCloudFunctions, SCAN_WARM_URLS, __fnWarm) and
// the functions' URLs are src/manager/logic/functions.ts.
async function startNewScan(){
  warmCloudFunctions(SCAN_WARM_URLS());
  try{ await ensureScanPipelineLoaded(); }
  catch(e){ showToast(tr('Could not load the scan module — check the connection')); return; }
  window.__aiRescanWorkerId=null;
  window.__wDraft=null;
  openAiScan();
}
// Rescan entry point — kept here (not moved into scan-pipeline.js) purely
// because it's the other real external trigger into the pipeline (called
// from the always-present worker list, see its own onclick) and needs the
// same await-before-call treatment; the function body itself is otherwise
// unchanged.
async function rescanWorkerDoc(workerId){
  warmCloudFunctions(SCAN_WARM_URLS());
  try{ await ensureScanPipelineLoaded(); }
  catch(e){ showToast(tr('Could not load the scan module — check the connection')); return; }
  window.__aiRescanWorkerId=workerId;
  window.__wDraft=null;
  openAiScan();
}

// The signature for Form 101 is drawn in the worker window (the shared
// SignaturePad, src/manager/WorkerEditor.tsx); its save hands the PNG over in
// window.__wCapturedSigPng before the upload, and aiFillForm101 reads it here.
function getSignaturePng(){ return window.__wCapturedSigPng ?? null; }

// Opens the AI scan flow tagged to an existing worker, so the resulting
// upload replaces (not duplicates) that worker's previously stored PDF —
// see the previousFileId strategy in aiFillForm101. Cleared automatically
// once the upload lands, or when a fresh untagged scan is started.
// presetAssets ({scanB64,scanMediaType,sigPng,extraPages}) is set only by
// regenerateWorkerDoc() below, to source the scan image/signature/extra
// pages from the Storage sidecar instead of the live scan globals — used for a
// background regenerate where nothing was just scanned in THIS browser
// session (the live globals could easily belong to a different worker's scan
// entirely, see regenerateWorkerDoc()'s own comment). Every plain DATA field
// (name/address/marital/etc.) comes from `targetWorker` unconditionally now
// — the unified worker modal (showWorkerModal/saveWorker) is the single
// place that writes those onto the worker record, whether the worker came
// from a scan or was entered by hand, so there's no more separate "live scan
// panel" values to branch on for those.
async function aiFillForm101(isId,mode,workerId,btnEl,presetAssets){
  mode=mode||'download';
  const isRegen=!!presetAssets;
  // Only the blocking new-worker/rescan upload path (mode==='upload' &&
  // !isRegen) shows its progress in the worker window (its save switches it
  // to the progress view first) — a background regenerate (isRegen, called
  // from regenerateWorkerDoc() after the window's already closed) never does.
  const showBlockingProgress=mode==='upload'&&!isRegen;
  // Hoisted above the try so the catch block (below) can still flag this
  // worker's failed upload for the "no document" badge even when the
  // failure happens before the assignment finishes.
  let targetWorker=(workerId||window.__aiRescanWorkerId)?workers.find(x=>x.id===(workerId||window.__aiRescanWorkerId)):null;
  const surname=(targetWorker&&targetWorker.docSurname)||'';
  const given=(targetWorker&&targetWorker.docGiven)||'';
  const dob=(targetWorker&&targetWorker.docDob)||'';
  const sex=(targetWorker&&targetWorker.docSex)||'';
  const no=workerDocId(targetWorker||{})||'';
  // No separate "nationality" field in the unified form — isId (Israeli ID
  // vs. foreign passport, matching w.docType) is the single source of truth.
  const isIsraeli=isId;
  // Explicit btnEl (or a deliberate null) takes precedence over the implicit
  // global `event` — needed when this runs in the background from saveWorker(),
  // where `event` is the Add/Save Worker button, not a Form 101 button.
  const btn=btnEl!==undefined?btnEl:(event&&event.target?event.target.closest('button'):null);
  const btnLabel=btn?btn.innerHTML:'';
  // Reported once the PDF is out — the Form 101 panel carries the same
  // warning inline, but this function also runs in the background from
  // saveWorker(), where that panel isn't on screen.
  let firmMissing=[];
  try{
    if(btn){ btn.disabled=true; btn.innerHTML='<i class="ti ti-loader-2 spin"></i> '+(mode==='upload'?'Uploading…':'Preparing…'); }

    // PDF construction itself (field placement, RTL Hebrew rendering, comb
    // fields, checkboxes, employer block, children table, signature/scan
    // pages) lives server-side now — see functions/main.py. It's a Python +
    // PyMuPDF port of what used to run here via pdf-lib, moved off the
    // client specifically because pdf-lib's own appearance-stream generator
    // has a confirmed bug that silently drops a glyph of multi-word RTL
    // (Hebrew) text; PyMuPDF has no such bug. This function still gathers
    // every value exactly as before — only "build the PDF bytes" moved.
    const profile=await refreshTenantProfile(5*60*1000);
    firmMissing=firmProfileMissing(profile);

    const signDateSrc=(targetWorker&&targetWorker.createdAt)?new Date(targetWorker.createdAt):new Date();
    const signDate=isNaN(signDateSrc)?new Date():signDateSrc;
    const signDateStr=String(signDate.getDate()).padStart(2,'0')+'/'+String(signDate.getMonth()+1).padStart(2,'0')+'/'+signDate.getFullYear();

    const payload={
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
    let addr,city,marital,workStart,fund,children;
    if(isId){
      // workerAddress(w) is the street name only (see workerAddress()'s own
      // comment) — the PDF's address box wants "street number" as one
      // string (functions/main.py's _split_street() re-splits it back
      // apart), so the house number has to be appended here explicitly.
      // Previously this line dropped w.houseNumber entirely, silently
      // omitting the house number from every Form 101 whether it came from
      // a scan or was typed in by hand.
      addr=(workerAddress(targetWorker||{})+' '+((targetWorker&&targetWorker.houseNumber)||'')).trim();
      city=(targetWorker&&targetWorker.city)||'';
      marital=(targetWorker&&targetWorker.maritalStatus)||'';
      workStart=(targetWorker&&targetWorker.workStartDate)||'';
      fund=(targetWorker&&targetWorker.healthFund)||'';
      // Children table — only the Israeli-ID branch has one (from the ID's
      // ספח, manually editable in the modal as a fallback for a failed scan).
      children=(targetWorker&&targetWorker.docChildren)||[];
      Object.assign(payload,{address:addr,city,marital,workStart,healthFund:fund,children});
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
      Object.assign(payload,{workStart,healthFund:fund,marital,address:addr,city,children});
    }
    // Form 101 section ו (spouse), either document type.
    const tw=targetWorker||{};
    if(tw.spouseSurname||tw.spouseGiven||tw.spouseId||tw.spouseDob||tw.spouseIncome){
      payload.spouse={surname:tw.spouseSurname||'',given:tw.spouseGiven||'',idNo:tw.spouseId||'',dob:tw.spouseDob||'',income:tw.spouseIncome||''};
    }

    // Signature ("חתימת המבקש/ת") — drawn server-side as an image if the
    // worker actually signed on the pad. Regenerating (isRegen) reuses
    // whatever signature was captured the first time, from the Storage
    // sidecar — there's no open modal to read a live pad from in that case.
    // getSignaturePng() already returns a data: URL, so the base64 payload
    // is just the part after the comma.
    let sigPng=isRegen?(presetAssets.sigPng||null):(typeof getSignaturePng==='function'?getSignaturePng():null);

    // Regenerating reads the scan image back from presetAssets (the Storage
    // sidecar loaded by regenerateWorkerDoc()) instead of window.__aiScanImage
    // — that global belongs to whichever scan session happens to be open in
    // the browser right now, which is a DIFFERENT worker's data if a
    // background regenerate for worker B fires while the manager is
    // mid-scanning worker A (or just finished creating worker A from a scan
    // and is now plain-adding worker B by hand — see openAddWorker()'s own
    // reset of these globals). otherPagesToUse (ספח appendix card, contract
    // pages, etc.) follows the same split: a fresh, just-saved worker reads
    // them from window.__aiPacketOtherPages, a regenerate reads them from
    // presetAssets.extraPages (persisted in the Storage sidecar by
    // saveWorkerAssets() below).
    const scanImage=isRegen?(presetAssets.scanB64?{b64:presetAssets.scanB64,mediaType:presetAssets.scanMediaType}:null):window.__aiScanImage;
    let otherPagesToUse=isRegen?(Array.isArray(presetAssets.extraPages)?presetAssets.extraPages:[]):(Array.isArray(window.__aiPacketOtherPages)?window.__aiPacketOtherPages:[]);
    // Rescanning an existing worker who already had extra pages (ספח appendix,
    // a contract, ...) saved from a PRIOR scan session, where THIS session
    // only recaptured the primary page (window.__aiPacketOtherPages is empty):
    // those previously-saved extra pages must not be silently discarded just
    // because the manager didn't re-scan them again today. Before this fix,
    // the rescan path (added 2026-09-26 to fix the primary photo going stale)
    // always wrote otherPagesToUse — even when empty — into the new Storage
    // sidecar via saveWorkerAssets(..., previousFileId: w.assetsFileId), which
    // trashes the OLD sidecar, permanently losing whatever extra pages it had.
    // Carrying the old sidecar's extraPages forward here (only when this
    // session captured none itself) preserves them across a rescan that's
    // only meant to refresh the front card.
    // The same goes for the signature: a rescan with no new signature keeps
    // the one the worker already gave.
    if(!isRegen&&(!otherPagesToUse.length||!sigPng)&&targetWorker&&targetWorker.assetsFileId){
      try{
        const oldResp=await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'loadWorkerAssets',...gsAuth(),fileId:targetWorker.assetsFileId})});
        const oldJson=await oldResp.json();
        if(oldJson&&oldJson.ok&&!otherPagesToUse.length&&Array.isArray(oldJson.extraPages)&&oldJson.extraPages.length) otherPagesToUse=oldJson.extraPages;
        if(oldJson&&oldJson.ok&&!sigPng&&oldJson.sigPng) sigPng=oldJson.sigPng;
      }catch(e){}
    }
    if(sigPng) payload.signaturePngBase64=sigPng.split(',')[1];
    const extraPages=[];
    if(scanImage) extraPages.push({b64:scanImage.b64,mediaType:scanImage.mediaType,caption:'Document scan'});
    for(const p of otherPagesToUse) extraPages.push({b64:p.b64,mediaType:p.mediaType,caption:'Document'});
    if(extraPages.length) payload.extraPages=extraPages;

    const f101t0=Date.now();
    const fnResp=await fetch(FORM101_FN_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const fnJson=await fnResp.json();
    if(!fnResp.ok||fnJson.error) throw new Error(fnJson.error||'Could not build the PDF');
    // Admin → Timings, kind "form101": what each generated form carried —
    // flags and counts only, no personal data — so a section missing from a
    // real PDF can be traced to the record or to the PDF build.
    try{ reportTiming('form101',Date.now()-f101t0,{regen:isRegen,docType:isId?'israeli_id':'passport',
      spouse:!!payload.spouse,spouseNames:!!(payload.spouse&&(payload.spouse.surname||payload.spouse.given)),
      children:(payload.children||[]).length,marital:payload.marital||'',extraPages:(payload.extraPages||[]).length}); }catch(e){}
    const out=Uint8Array.from(atob(fnJson.pdfBase64),c=>c.charCodeAt(0));
    const fileName=fnJson.fileName;

    // docType is the one thing this function itself determines (which
    // branch actually generated the PDF) rather than something the unified
    // modal collects — everything else (name/address/marital/etc.) is
    // already on targetWorker, written by saveWorker() before this ran.
    if(mode==='upload'&&targetWorker){
      targetWorker.docType=isId?'israeli_id':'passport';
    }

    if(mode==='upload'){
      // Worker (targetWorker) already resolved up top — reused here so a
      // rescan can pass along the previous file's ID: the OCR'd name/doc-
      // number baked into fileName can drift between scans, so name-based
      // dedup on the backend alone isn't reliable; a known previousFileId
      // lets it trash the exact old file.
      const fileBase64=fnJson.pdfBase64;
      const w=targetWorker;
      // Progress bar: real byte-level progress from the Storage upload.
      // docPromise/assetsPromise upload concurrently, so their progress is
      // combined by total bytes across both, not just whichever finishes
      // first; the 20-90% range leaves room for "building PDF" (0%) before
      // and "done" (100%) after, so the bar visibly moves at every stage.
      let docLoaded=0,docTotal=0,assetsLoaded=0,assetsTotal=0;
      const reportUploadProgress=()=>{
        if(!showBlockingProgress) return;
        const total=docTotal+assetsTotal;
        const frac=total>0?(docLoaded+assetsLoaded)/total:0;
        renderWorkerUploadProgress('מעלה ל-'+DOC_STORE+', נא לא לסגור…',20+Math.round(frac*70));
      };
      if(showBlockingProgress) renderWorkerUploadProgress('מעלה ל-'+DOC_STORE+', נא לא לסגור…',20);
      // saveWorkerDoc (the PDF) and saveWorkerAssets (the scan/signature
      // sidecar) write to two different Storage files and don't depend on each
      // other's result (the sidecar's own previousFileId is w.assetsFileId,
      // unrelated to the PDF's fileId) — fired concurrently (2026-09-27,
      // optimization) instead of one full round-trip after the other, since
      // this whole call runs behind a blocking "please wait" overlay for new
      // workers/rescans. Skipped on a regenerate (isRegen) same as before —
      // see the comment below that used to sit next to the sequential call.
      const docPromise=uploadWorkerFile(
        {action:'saveWorkerDoc',...gsAuth(),workerId:w&&w.id,fileBase64,fileName,mimeType:'application/pdf',previousFileId:(w&&w.docFileId)||null},
        (loaded,total)=>{ docLoaded=loaded; docTotal=total; reportUploadProgress(); });
      // Cache the scan+signature (and any extra pages — ספח appendix card,
      // contract, etc.) that actually built this PDF as a small private
      // Storage sidecar (never shown to anyone, just read back by
      // regenerateWorkerDoc()) — this is what lets a LATER edit (income
      // type, marital status, address, ...) rebuild the exact same PDF
      // with the new values without asking the manager to re-scan the
      // physical document. Best-effort: a failure here never rolls back
      // the main upload.
      // Skip this on a regenerate (isRegen): the scan/signature/extraPages
      // there came straight from loadWorkerAssets() a few seconds ago via
      // this SAME w.assetsFileId — re-uploading them as a "new" sidecar
      // would just be writing back the exact bytes just downloaded. A
      // background regenerate (triggered by editing one watched text
      // field, e.g. address) used to always pay for this redundant
      // multi-MB download-then-reupload round trip on top of the PDF
      // build itself, which is what made a single-field edit feel so slow.
      // ...except when the signature is new (drawn on an existing worker):
      // then the sidecar is written again so later rebuilds keep it — also
      // for a worker with no scan (a sidecar holding only the signature).
      const sigOnly=isRegen&&presetAssets.sigChanged;
      const assetsPromise=(w&&((scanImage&&!isRegen)||sigOnly))?uploadWorkerFile(
        {action:'saveWorkerAssets',...gsAuth(),workerId:w.id,
          scanB64:scanImage?scanImage.b64:'', scanMediaType:scanImage?scanImage.mediaType:'image/jpeg', sigPng:sigPng||null,
          extraPages:otherPagesToUse,
          fileNameBase:fileName.replace(/\.pdf$/,''), previousFileId:w.assetsFileId||null},
        (loaded,total)=>{ assetsLoaded=loaded; assetsTotal=total; reportUploadProgress(); }
      ).catch(()=>null):Promise.resolve(null);
      const [json,assetsJson]=await Promise.all([docPromise,assetsPromise]);
      if(!json||json.error) throw new Error((json&&json.error)||'The server did not answer');
      if(showBlockingProgress) renderWorkerUploadProgress('הועלה בהצלחה',100);
      if(w){
        w.docUrl=json.url; w.docSavedAt=new Date().toISOString(); w.docFileId=json.id;
        w.docUploadFailed=false;
        if(assetsJson&&assetsJson.ok) w.assetsFileId=assetsJson.id;
        // Completeness flags for workerDocStatus(): what this saved document
        // actually contains (on a regenerate these come from the sidecar).
        w.docHasSignature=!!sigPng;
        w.docExtraPages=Array.isArray(otherPagesToUse)?otherPagesToUse.length:0;
        render(); if(typeof renderWorkersPage==='function') renderWorkersPage(); autoSave();
        showToast(tr('Documents of {0} saved to {1}',{0:(w.name||''),1:(DOC_STORE)}));
        window.__aiRescanWorkerId=null;
      } else showToast(tr('File saved to {0}',{0:(DOC_STORE)}));
    } else {
      const blob=new Blob([out],{type:'application/pdf'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a'); a.href=url;
      a.download=fileName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),3000);
      showToast(tr('Form 101 downloaded'));
    }
    // After the success toast's own 2.5s, so the two don't overwrite each other.
    if(firmMissing.length) setTimeout(()=>showToast(tr('⚠ The firm profile is incomplete — empty in Form 101: {0}',{0:(firmMissing.join(', '))}),4000),2600);
    return true;
  }catch(err){
    console.error(err);
    showToast(tr('Failed: {0}',{0:(err&&err.message||'')}));
    // Flag it on the worker (if one's resolved) so the "no document" badge
    // in the workers list/card catches a silent background failure — the
    // toast alone is easy to miss, especially on mobile where a flaky
    // connection mid-upload is the most common trigger for this branch.
    if(mode==='upload'&&targetWorker){ targetWorker.docUploadFailed=true; autoSave(); render(); if(typeof renderWorkersPage==='function') renderWorkersPage(); }
    return false;
  }
  finally{ if(btn){ btn.disabled=false; btn.innerHTML=btnLabel; } window.__aiPacketOtherPages=[]; window.__wCapturedSigPng=undefined; }
}

// Auto-generation right after a worker is created from a scan runs
// unattended — nobody is watching for the failure toast — so it gets one
// retry on failure (e.g. a transient CDN hiccup loading pdf-lib on a mobile
// connection) before leaving the "no document" badge (docUploadFailed) for
// the manager to notice and retry manually via "Rescan".
async function autoUploadWithRetry(isId,workerId){
  // aiFillForm101's finally clears the extra pages and the captured
  // signature — the retry gets them back so it builds the same PDF.
  const keep={pages:window.__aiPacketOtherPages, sig:window.__wCapturedSigPng};
  let ok=await aiFillForm101(isId,'upload',workerId,null);
  if(!ok){
    await new Promise(r=>setTimeout(r,1500));
    window.__aiPacketOtherPages=keep.pages; window.__wCapturedSigPng=keep.sig;
    ok=await aiFillForm101(isId,'upload',workerId,null);
  }
  return ok;
}

// Rebuilds and re-uploads a worker's Form-101 PDF using their CURRENTLY
// saved data (address, income type, marital status, health fund, ...)
// instead of what was true when the document was last generated — without
// asking the manager to re-scan the physical ID/passport. Reads the
// scan+signature back from the Storage sidecar saveWorkerAssets() cached at
// the last successful generation, when one exists (w.assetsFileId). This is
// the SAFE way to auto-regenerate on a background edit — unlike calling
// aiFillForm101 directly with no presetAssets (the "live" path), it never
// touches window.__aiScanImage/__aiPacketOtherPages, which could easily
// belong to a completely different worker's in-progress scan session. If
// there's no sidecar yet (a worker whose document has never been generated
// at all, or one predating this feature), it still proceeds — just with an
// empty scan/signature, producing a plain data-only PDF.
// newSigPng: a signature just drawn in the worker modal — it goes into this
// PDF and is stored in the sidecar for later rebuilds.
async function regenerateWorkerDoc(workerId, newSigPng){
  const w=workers.find(x=>x.id===workerId);
  if(!w) return false;
  try{
    let assets={scanB64:null,scanMediaType:null,sigPng:null,extraPages:[]};
    if(w.assetsFileId){
      const resp=await fetch(API_URL,{
        method:'POST',
        body:JSON.stringify({action:'loadWorkerAssets',...gsAuth(),fileId:w.assetsFileId})
      });
      const json=await resp.json();
      if(json&&json.ok) assets={scanB64:json.scanB64,scanMediaType:json.scanMediaType,sigPng:json.sigPng||null,extraPages:Array.isArray(json.extraPages)?json.extraPages:[]};
    }
    if(newSigPng){ assets.sigPng=newSigPng; assets.sigChanged=true; }
    const isId=w.docType!=='passport';
    return await aiFillForm101(isId,'upload',workerId,null,assets);
  }catch(e){ return false; }
}

// A firm whose details were edited from the Firms list while another firm
// was open: rebuild its workers' Form 101s once its data is loaded here.
function maybeRegenAfterFirmEdit(){
  const s=getSession(), t=s&&(s.viewingTenantId||s.tenantId);
  if(!t) return;
  let flag=null; try{ flag=localStorage.getItem('form101Regen:'+t); }catch(e){}
  if(!flag) return;
  try{ localStorage.removeItem('form101Regen:'+t); }catch(e){}
  refreshTenantProfile(0).then(()=>regenerateAllWorkerDocs());
}
// Firm-profile edits change every worker's Form 101 employer-details row
// (section א, פרטי המעסיק — company name/address/phone/deductions number),
// so every already-generated document is now stale, not just the one worker
// being edited. Sequential (not parallel) to avoid a burst of simultaneous
// PDF builds + Storage uploads when a firm
// has many workers. Only called for the firm currently loaded into
// `workers` (see firmSaved()) — there's nothing to regenerate for a
// firm whose schedule isn't the one open right now.
async function regenerateAllWorkerDocs(){
  const targets=workers.filter(w=>w.docUrl&&w.assetsFileId);
  if(!targets.length) return;
  let done=0, failed=0;
  for(const w of targets){
    const ok=await regenerateWorkerDoc(w.id);
    done++; if(!ok) failed++;
  }
  showToast(failed
    ? (tr('Documents updated: {0}/{1} (some failed — see the marks on the workers)',{0:(done-failed),1:(done)}))
    : (tr('Documents of all workers updated ({0})',{0:(done)})));
}

// ===== Form 101: fill the fillable template from AI-scanned document data =====
// The actual PDF filling (pdf-lib + fontkit + the Heebo font, all loaded
// client-side) moved server-side into a Python/PyMuPDF Cloud Function — see
// FORM101_FN_URL above and functions/main.py. This client only assembles the
// JSON payload now; the CDN loaders and Heebo font fetch that used to live
// here are gone along with the client-side build they supported.

// --- Init ---------------------------------------------------------------------
// Caught failures (2026-10-01): window 'error'/'unhandledrejection' only see
// errors nobody handled. Most failures are handled — a toast, a console
// error, a red line in a form — and never reached the Errors sheet. These
// hooks send them too: console.error/console.warn, toasts that read like an
// error, and the error lines of the forms below (same 1-minute dedupe and
// per-session cap as reportError()).
const _origConsoleError=console.error.bind(console), _origConsoleWarn=console.warn.bind(console);
function _consoleArgsText(args){
  let stack='';
  const msg=Array.from(args).map(a=>{
    if(a instanceof Error){ stack=stack||a.stack||''; return a.message; }
    if(a && typeof a==='object'){ try{ return JSON.stringify(a).slice(0,200); }catch(e){ return String(a); } }
    return String(a);
  }).join(' ');
  return {msg,stack};
}
// The Firestore SDK logs a warning each time the live punch listener's
// connection drops — a phone in the background, a network switch, an idle
// connection cut by the carrier — and then reconnects by itself. Not a
// failure, so not reported (it filled the Errors pane every few minutes).
const SDK_RECONNECT_NOISE_RE=/@firebase\/firestore:.*(transport errored|Could not reach Cloud Firestore backend|stream .* (closed|errored))/i;
// Google Maps' notice that google.maps.Marker (the client map picker's pin)
// is deprecated — it still works, and Google gives 12 months' notice before
// removing it. Kept in the Errors log as a reminder, but at most once a day
// per device (per user request; the time is kept in localStorage).
const MAPS_MARKER_NOTICE_RE=/google\.maps\.Marker is deprecated/;
function _mapsNoticeSeenToday(){
  try{
    const last=Number(localStorage.getItem('mapsMarkerNoticeAt')||0);
    if(Date.now()-last<24*3600*1000) return true;
    localStorage.setItem('mapsMarkerNoticeAt',String(Date.now()));
  }catch(e){}
  return false;
}
const _consoleNoise=msg=>SDK_RECONNECT_NOISE_RE.test(msg)||(MAPS_MARKER_NOTICE_RE.test(msg)&&_mapsNoticeSeenToday());
console.error=function(...args){ _origConsoleError(...args); try{ const t=_consoleArgsText(args); if(!_consoleNoise(t.msg)) reportError(t.msg,'console.error',t.stack); }catch(e){} };
console.warn=function(...args){ _origConsoleWarn(...args); try{ const t=_consoleArgsText(args); if(!_consoleNoise(t.msg)) reportError(t.msg,'console.warn',t.stack); }catch(e){} };
const ERROR_TOAST_RE=/fail|could not|error|offline|denied|invalid|no network|not available|no rights|not enough rights|expired|\u26a0|⚠/i;
const _origShowToast=showToast;
showToast=function(msg,dur){ _origShowToast(msg,dur); try{ if(ERROR_TOAST_RE.test(String(msg||''))) reportError(String(msg),'toast',''); }catch(e){} };
function watchErrorLine(id){
  const el=document.getElementById(id); if(!el||typeof MutationObserver==='undefined') return;
  new MutationObserver(()=>{ const t=(el.textContent||'').trim(); if(t) reportError(t,'form:'+id,''); })
    .observe(el,{childList:true,characterData:true,subtree:true});
}
['firmEditFormError','userFormError'].forEach(watchErrorLine);
window.addEventListener('error', function(ev){ _origConsoleError('App error:', ev.error||ev.message); reportError(ev.message, (ev.filename||'')+':'+(ev.lineno||''), ev.error&&ev.error.stack); });
window.addEventListener('unhandledrejection', function(ev){ const r=ev.reason; reportError((r&&r.message)||String(r), 'promise', r&&r.stack); });
loadI18n(storedLanguage()).catch(()=>{}).then(()=>{ applyI18n(); syncLangButtons(); placeLangButton(); try{
  gateApp(function(){
    loadData();
    render();
    setSaveStatus('saved');
    applyNavPermissions();
    // Start on Dashboard (an HR login: its first tab)
    switchTab(homeTab());
    showContractNotice();
    // An HR's hours ticks as the ID token has them now (a change by the
    // owner shows on the next sign-in without a new login here).
    if(isHrSession()) loadFirestoreBackend().then(b => b.hourPerms()).then(hp => {
      const s = getSession(); if(!s || JSON.stringify(hp) === JSON.stringify(s.hourPerms || [])) return;
      saveSession(Object.assign(s, {hourPerms: hp})); applyNavPermissions();
      if(currentTab === 'accounting') renderAccounting();
    }).catch(()=>{});
    // Wake users_admin (firm profile, users, files) so its first real call
    // doesn't wait for a cold start.
    warmCloudFunctions([USERS_ADMIN_FN_URL]);
    // Check push subscription status
    setTimeout(checkPushStatus, 1000);
  });
}catch(err){
  console.error('Init failed:', err);
  try{ showToast(tr('Startup error — reload the page (F5)')); }catch(e){}
} });
document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.key==='s'){ e.preventDefault(); autoSave(); showToast(tr('Saved!')); }
});


// ── Push Notifications ────────────────────────────────────────────
const VAPID_PUBLIC_KEY = 'BBju9uoDfcpB0ZIPWhCyvUxg4lLwYVFy4QadSnvx6ImaafKK0pxalntUz5JmkH3Tc9wq9yymBucOf_U5i9o8t7w';
// Push delivery is not wired up yet (needs VAPID signing) — keep the button hidden
// so it doesn't promise alerts that won't arrive. Flip to true once a real sender exists.
const PUSH_ENABLED = false;

function urlB64ToUint8(b64){
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g,'+').replace(/_/g,'/'));
  return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}

async function subscribeToPush(){
  if(!('PushManager' in window)){ showToast(tr('Push not supported')); return; }
  try{
    const perm = await Notification.requestPermission();
    if(perm !== 'granted'){ showToast(tr('Notifications blocked in browser settings')); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8(VAPID_PUBLIC_KEY)
    });
    localStorage.setItem('pushSubscription', JSON.stringify(sub));
    showToast(tr('Shift reminders enabled!'));
    document.getElementById('pushBtn')?.remove();
  } catch(e){ showToast(tr('Failed: {0}',{0:(e.message)})); console.error(e); }
}

async function checkPushStatus(){
  if(!PUSH_ENABLED) return;
  if(!('Notification' in window)) return;
  
  // If already granted - don't show button
  if(Notification.permission === 'granted'){
    try{
      if('serviceWorker' in navigator){
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if(sub) return; // already subscribed
      }
    } catch(e){}
  }
  
  // Show button if not yet subscribed
  if(!document.getElementById('pushBtn')){
    const btn=document.createElement('button');
    btn.id='pushBtn'; btn.className='btn sm';
    btn.innerHTML='<i class="ti ti-bell" style="color:var(--green)"></i> Enable Alerts';
    btn.style.cssText='';
    btn.onclick=subscribeToPush;
    document.querySelector('.titlebar-actions')?.prepend(btn);
  }
}

// ── PWA: Service Worker ───────────────────────────────────────────
if('serviceWorker' in navigator){
  // Auto-reload once when a new version of the app takes over.
  let _swRefreshing=false;
  const _hadController=!!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    if(_swRefreshing) return; _swRefreshing=true;
    if(!_hadController) return;
    // Don't reload mid-upload (a deploy while a document is uploading used to
    // cut the upload off); wait until every upload has finished.
    const reloadWhenIdle=()=>{ if(typeof __uploadsInFlight!=='undefined' && __uploadsInFlight>0) setTimeout(reloadWhenIdle,1000); else window.location.reload(); };
    reloadWhenIdle();
  });
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('service-worker.js',{updateViaCache:'none'})
      .then(reg=>{
        console.log('[PWA] SW registered');
        reg.update();                       // check for a newer SW right away
        checkPushStatus();
      })
      .catch(e=>console.warn('[PWA] SW failed:',e));
  });
} else {
  // No SW support - still show button if Notification API available
  if('Notification' in window) checkPushStatus();
}

// ── PWA: Install button (always shown until the app is installed) ──
let _installPrompt=null;
window.addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); _installPrompt=e; ensureInstallButton(); });
window.addEventListener('appinstalled',()=>{
  _installPrompt=null;
  document.getElementById('installBtn')?.remove();
  showToast(tr('Schedule Manager installed!'));
});
function _isStandalone(){ return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone===true; }
function ensureInstallButton(){
  if(_isStandalone()){ document.getElementById('installBtn')?.remove(); return; }
  if(document.getElementById('installBtn')) return;
  const host=document.getElementById('accountInstallSlot'); if(!host) return;
  const btn=document.createElement('button');
  btn.id='installBtn'; btn.type='button'; btn.className='acct-mi install';
  btn.innerHTML='<i class="ti ti-download"></i><span>'+esc(tr('Install app'))+'</span>';
  btn.onclick=async()=>{
    closeAccountMenu();
    if(_installPrompt){
      _installPrompt.prompt();
      const{outcome}=await _installPrompt.userChoice;
      if(outcome==='accepted'){ btn.remove(); showToast(tr('App installed!')); }
      _installPrompt=null;
    } else {
      const ios=/iphone|ipad|ipod/i.test(navigator.userAgent);
      showToast(ios ? tr('Safari: Share → «Add to Home Screen»') : tr('Browser menu (⋮) → «Install app»'));
    }
  };
  host.prepend(btn);
}
window.addEventListener('load', ensureInstallButton);

