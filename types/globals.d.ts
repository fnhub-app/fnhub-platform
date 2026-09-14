/* ============================================================================
 * globals.d.ts - Ambient type contract for the app's browser globals.
 *
 * Phase RX1 (see PLAN.md Phase RX). This is a TYPE-ONLY file: it ships nothing,
 * changes no runtime behavior, and exists so `tsc --noEmit` can check the
 * vanilla-JS shared layer, which communicates through globals on `window`.
 *
 * Posture: precise types where they are cheap and high-value (nation config,
 * session, the role/status enums); pragmatic `any` for functions and data
 * whose shape is defined in files not yet type-checked. Tighten these as each
 * file is added to tsconfig "include" in later RX1 sub-steps.
 *
 * This is a global (non-module) declaration file: no import/export, so
 * `interface Window` merges with lib.dom and `declare var` adds true globals.
 * ==========================================================================*/

/** Per-nation configuration resolved at boot (see shared-config.js resolveNation). */
interface NationConfig {
  id?: string;
  display_name?: string;
  short?: string;
  primary_color?: string | null;
  logo?: string;
  role_labels?: Record<string, string>;
  supabase_url?: string;
  supabase_anon?: string;
  modules_licensed?: string[];
  email_domain?: string;
  portal_base?: string;
  /** Directory entries are partial and vary by nation; extra keys are allowed. */
  [k: string]: any;
}

/** The authenticated session stashed in sessionStorage and rehydrated per page. */
interface HousingSession {
  accessToken?: string;
  refreshToken?: string;
  tokenExp?: number;
  role?: string;
  name?: string;
  email?: string;
  [k: string]: any;
}

/** Optional-module registry (shared-config.js CLFN_MODULES). */
interface ClfnModules {
  isEnabled(mod: string): boolean;
  listOptional(): string[];
  _enabled: Record<string, boolean>;
  _licensed: Record<string, boolean>;
  [k: string]: any;
}

interface Window {
  // --- Supabase / platform connection (shared-config.js) ---
  SUPABASE_URL: string;
  SUPABASE_ANON: string;
  STORAGE_BUCKET: string;
  PLATFORM_REGISTRY_URL: string;
  PLATFORM_REGISTRY_ANON: string;
  CLFN_CONFIG_LOADED: boolean;
  CLFN_DEBUG: boolean;

  // --- Nation identity / branding ---
  NATIONS_DIRECTORY: Record<string, NationConfig>;
  NATION_CONFIG: NationConfig;
  _NATION: NationConfig | null;
  resolveNation: () => NationConfig;
  nationShort: () => string;
  nationDisplay: () => string;
  nationEmailDomain: () => string;
  nationId: () => string;
  nationPortalBase: () => string;
  _applyBrandDark: (...args: any[]) => any;
  CLFN_LOGO_DATA_URL: string;
  HLH_LOGO_DATA_URL: string;
  _REG_CACHE_KEY: string;
  _mapNationRow: (...args: any[]) => any;
  _mergeNationRegistry: (...args: any[]) => any;

  // --- Roles / permissions / features ---
  ROLE: Record<string, any>;
  ROLE_FORCED_DEPT: Record<string, any>;
  APP_STATUS: Record<string, string>;
  CLFN_SUPER_USERS: string[];
  _realRole: string | null;
  isSuperUser: (...args: any[]) => boolean;
  FEATURE_KEYS: Record<string, string>;
  FEATURE_REGISTRY: Record<string, any>;
  _resolveFeatureList: (...args: any[]) => any;
  canUseFeature: (...args: any[]) => boolean;
  isFeatureRestricted: (...args: any[]) => boolean;

  // --- Modules ---
  CLFN_MODULES: ClfnModules;
  moduleOn: (mod: string) => boolean;
  _moduleEnablementHydrated: boolean;
  showModuleDisabledNotice: (...args: any[]) => any;

  // --- Auth layer (shared-auth.js) ---
  CLFN_AUTH: any;
  _booting: boolean;
  _accessExpired: boolean;
  _authFetchWrapped: boolean;
  _onLogout: ((...args: any[]) => any) | null;
  IDLE_TIMEOUT_MS: number;

  // --- UI / nav layer (shared-ui.js) ---
  _navStack: any[];
  _navMap: any;
  _extraViewIds: any;
  CLFN_PAGE_ROUTES: any;
  _tableRegistry: Record<string, any>;
  clfnSearchSelect: (...args: any[]) => any;
  _swipeTabsWired: boolean;
  _onSwitchRole: ((...args: any[]) => any) | null;

  // --- Session / settings ---
  HOUSING_SESSION: HousingSession | null;
  _appSettings: Record<string, any>;
  _flattenLegacyAppSettings: (...args: any[]) => any;

  // --- Application intake config + helpers ---
  APP_REQ_FIELDS: any;
  APP_REQ_SECTIONS: any;
  APP_REQ_STEPS: any;
  INCOME_TYPES: any;
  INCOME_TYPE_CANON: any;
  LIVING_SITUATIONS: any;
  livingSituationLabel: (...args: any[]) => string;
  appIsWaitlistType: (...args: any[]) => boolean;
  onRezNewAppIssue: (...args: any[]) => any;
  _isLot: (...args: any[]) => boolean;

  // --- Rent model / calculations ---
  RENT_MODEL_DEFAULTS: any;
  getRentModel: (...args: any[]) => any;
  computeRentCalc: (...args: any[]) => any;
  computeHouseholdShelterRent: (...args: any[]) => any;
  unitMarketRent: (...args: any[]) => any;
  rentAgeInfo: (...args: any[]) => any;
  roundCents: (n: number) => number;
}

// Globals referenced WITHOUT a `window.` prefix in the shared layer. These are
// all assigned as `window.X = ...`, so declaring them here as ambient vars only
// tells tsc they exist globally (no runtime redeclaration). A global `declare
// var`/`declare function` also satisfies `window.X` access (Window extends the
// global scope), so this block is the single place to register cross-file
// globals as more files opt into type-checking.
declare var NATION_CONFIG: NationConfig;
declare var nationShort: () => string;

// --- Config/enum globals also referenced bare (defined in shared-config.js) ---
declare var ROLE: Record<string, any>;
declare var SUPABASE_URL: string;

// --- Cross-file globals used by shared-sow.js (defined elsewhere in the app) ---
/** Permission helpers (shared-config.js / CLFN_PERMS). */
declare var CLFN_PERMS: any;
/** Effective role for permission checks. */
declare var currentRole: string | null;
/** SOW cache keyed by unit id: { [unitId]: { sows: any[] } } (shared-data.js). */
declare var _sowCache: Record<string, { sows: any[] } & Record<string, any>>;
declare var _sowNumbersReconciled: boolean;
/** RFQ cache keyed by rfq id (shared-data.js / rfq.js). */
declare var _rfqCache: Record<string, any>;
/** SOW list helpers (shared-data.js). */
declare function getUnitSowList(unitId: string): any[];
declare function saveSowList(unitId: string, list: any[], ...args: any[]): any;
declare function isSowCompleted(sow: any): boolean;
/** Audit + toast (shared-data.js / shared-ui.js). */
declare function auditEntry(entityId: string, action: string, detail?: any, user?: any): any;
declare function showToast(msg: string, opts?: { type?: string; duration?: number; position?: string }): any;

// --- Cross-file app globals used by shared-data.js (RX1 slice 3) --------------
// Pragmatic `any` placeholders for functions/caches/libs defined in files not
// yet type-checked (housing-*.js, scoring.js, finance-*.js, rfq.js,
// notifications.js, the DocLibrary component, the XLSX/SheetJS lib, etc.).
// `any` satisfies both bare `X` and `window.X` access and is callable /
// indexable. Tighten these into real signatures as each defining file opts in.
declare var APPROVAL_AUTHORITY: any;
declare var DEFAULT_MATCH_PRIORITY_MODEL: any;
declare var DocLibrary: any;
declare var HOUSING_UNITS_DATA: any;
declare var SOW_CATEGORIES: any;
declare var XLSX: any;
declare var _HOUSING_TENANT_DOC_CATEGORIES: any;
declare var _SECONDARY_TYPES: any;
declare var _appStampSaved: any;
declare var _appSubmissions: any;
declare var _arrearsCache: any;
declare var _bcrRegistry: any;
declare var _cardGrid: any;
declare var _cardTile: any;
declare var _cicNotesCtId: any;
declare var _cicVisitedTabs: any;
declare var _contractors: any;
declare var _ctApprovalIdx: any;
declare var _ctDeepLinkReturn: any;
declare var _ctEditIdx: any;
declare var _ctFiles: any;
declare var _ctLastSaved: any;
declare var _ctPendingAction: any;
declare var _ctPeople: any;
declare var _ctSetView: any;
declare var _currentDetailUnitId: any;
declare var _currentExportView: any;
declare var _currentScorecardApp: any;
declare var _docSigsHidden: any;
declare var _emailEventCcRoles: any;
declare var _generateRfqPdfBase64: any;
declare var _inspections: any;
declare var _lastScoreResult: any;
declare var _matchActiveChip: any;
declare var _mergeGroups: any;
declare var _navSkipPush: any;
declare var _pendingLookupUser: any;
declare var _printPanelDoc: any;
declare var _printThemeStyles: any;
declare var _renderEmailTemplate: any;
declare var _renderLandingKpis: any;
declare var _renoBudget: any;
declare var _renoProgress: any;
declare var _renosSetView: any;
declare var _resolveActiveStaffForRoles: any;
declare var _rfqDocList: any;
declare var _rfqDocStr: any;
declare var _rfqDocSub: any;
declare var _rpAfterContractorSave: any;
declare var _rpPendingPhotos: any;
declare var _rpStoredPhotos: any;
declare var _scApp: any;
declare var _sigPads: any;
declare var _sowAfterContractorSave: any;
declare var _sowCollectWorkOrder: any;
declare var _sowEditingProjectNumber: any;
declare var _sowFiles: any;
declare var _sowForceNew: any;
declare var _sowItemIdx: any;
declare var _sowPopulateFieldEmployees: any;
declare var _sowPopulateWorkOrder: any;
declare var _sowPromptWorkOrderEmail: any;
declare var _sowRefreshStrip: any;
declare var _sowSafePreprintSave: any;
declare var _sowSeed: any;
declare var _staffCache: any;
declare var _staffFilter: any;
declare var _tenantFilesLib: any;
declare var _tenantFilesUnitId: any;
declare var _tenantMrSubmissions: any;
declare var _termsParseHtml: any;
declare var _themeAccentHex: any;
declare var _themeAccentInkHex: any;
declare var _total: any;
declare var _udpFilesLib: any;
declare var _userLookupTimer: any;
declare var _viewAsRole: any;
declare var _viewMode: any;
declare var _viewToggleHtml: any;
declare var _wlArchiveApp: any;
declare var _wlArchiveSow: any;
declare var _wlCancelRfq: any;
declare var _wlSetView: any;
declare var applications: any;
declare var arrearsAllocationBlock: any;
declare var arrearsJointMatches: any;
declare var arrearsStateForTenant: any;
declare var arrearsTenantByName: any;
declare var arrearsWorklistItems: any;
declare var auditLog: any;
declare var checked: any;
declare var contentWindow: any;
declare var contractorSearchFilter: any;
declare var currentUser: any;
declare var dataset: any;
declare var disabled: any;
declare var flushOfflineFiles: any;
declare var focus: any;
declare var formatCurrency: any;
declare var formatPhone: any;
declare var generateAppId: any;
declare var getContext: any;
declare var getTermsBody: any;
declare var height: any;
declare var housingUnits: any;
declare var href: any;
declare var indexOf: any;
declare var isBcrd: any;
declare var jspdf: any;
declare var liveMatchPriorityModel: any;
declare var liveV2Tiers: any;
declare var loadJsPdf: any;
declare var notifyApplicationApprovedWaitlist: any;
declare var notifyContractorStatusChange: any;
declare var notifyContractorSubmitted: any;
declare var notifyRfqAward: any;
declare var notifyRfqRegret: any;
declare var onclick: any;
declare var openBcrManager: any;
declare var openCommercialApp: any;
declare var openContractorSearch: any;
declare var openEditModal: any;
declare var openRenoProgress: any;
declare var openSowModal: any;
declare var openTenantMergeManager: any;
declare var options: any;
declare var renderDashTable: any;
declare var renderDashboard: any;
declare var renderInspectionsList: any;
declare var renderInventoryView: any;
declare var renderMatchView: any;
declare var renderRecentActivity: any;
declare var renderRenoApprovalsView: any;
declare var renderRubricTable: any;
declare var renderRubricTableV2: any;
declare var renderScorecardActions: any;
declare var renderSowFiles: any;
declare var renderTenantsView: any;
declare var renderV2ScoringEditor: any;
declare var saveSOW: any;
declare var sbCopyFile: any;
declare var sbDeleteFile: any;
declare var sbGetFileUrl: any;
declare var sbGetSignedUrl: any;
declare var sbListFiles: any;
declare var sbLoadFileMeta: any;
declare var sbSaveFileMeta: any;
declare var sbUploadAndSave: any;
declare var scLoadDocs: any;
declare var select: any;
declare var selectedIndex: any;
declare var sendNotification: any;
declare var setHeaderNavActive: any;
declare var setText: any;
declare var showConfirm: any;
declare var showLanding: any;
declare var showPrompt: any;
declare var src: any;
declare var srcdoc: any;
declare var substring: any;
declare var toDataURL: any;
declare var udpRenderSowTable: any;
declare var updateDashStats: any;
declare var value: any;
declare var width: any;

// --- Window members also referenced bare in shared-data.js -------------------
declare var moduleOn: (mod: string) => boolean;
declare var APP_STATUS: Record<string, string>;
declare var SUPABASE_ANON: string;
declare var STORAGE_BUCKET: string;
declare var ROLE_FORCED_DEPT: Record<string, any>;
declare var nationPortalBase: () => string;
declare var nationEmailDomain: () => string;
declare var nationDisplay: () => string;

// --- DOM access pragmatics (RX1) ---------------------------------------------
// The shared layer reads inputs via document.getElementById(...).value etc.,
// which tsc rejects because getElementById returns the base HTMLElement. Rather
// than cast hundreds of call sites (churn/risk in a 10k-line file), widen the
// element types with the SPECIFIC props the code touches, as optionals. This is
// a targeted relaxation, not a blanket index signature, so genuinely unknown
// property typos are still caught. App code also stores a few expando props on
// elements (_total, _scApp) -- declared here too. Tighten with real element
// casts when these files are React-migrated (RX4+).
interface Element {
  onclick?: any;
  style?: any;
  value?: any;
  checked?: any;
  src?: any;
  href?: any;
  dataset?: any;
  selectedIndex?: any;
  options?: any;
  select?: any;
  focus?: any;
  disabled?: any;
}
interface HTMLElement {
  value?: any;
  checked?: any;
  disabled?: any;
  src?: any;
  href?: any;
  srcdoc?: any;
  selectedIndex?: any;
  options?: any;
  select?: any;
  contentWindow?: any;
  getContext?: any;
  toDataURL?: any;
  width?: any;
  height?: any;
  _total?: any;
  _scApp?: any;
  _clfnTimer?: any;
}

// App code stores a running total on a sliced array (sowItems._total).
interface Array<T> { _total?: number; }
declare var showEmployeeHome: any;
