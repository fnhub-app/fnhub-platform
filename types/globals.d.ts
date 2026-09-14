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
  tokenExp?: string | number;
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
declare var _realRoleForPermissions: any;
/** SOW cache keyed by unit id: { [unitId]: { sows: any[] } } (shared-data.js). */
declare var _sowCache: Record<string, { sows: any[] } & Record<string, any>>;
declare var _sowNumbersReconciled: boolean;
/** RFQ cache keyed by rfq id (shared-data.js / rfq.js). */
declare var _rfqCache: Record<string, any>;
/** Supabase auth headers object for REST calls (shared-auth.js). */
declare var HOUSING_HEADERS: Record<string, string>;
/** SOW list helpers (shared-data.js). */
declare function getUnitSowList(unitId: string): any[];
declare function saveSowList(unitId: string, list: any[], ...args: any[]): any;
declare function isSowCompleted(sow: any): boolean;
/** Audit + toast (shared-data.js / shared-ui.js). */
declare function auditEntry(entityId: string, action: string, detail?: any, user?: any): any;
declare function showToast(msg: string, opts?: { type?: string; duration?: number; position?: string }): any;
