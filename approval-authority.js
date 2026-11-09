/**
 * approval-authority.js — CLFN Housing Suite
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Single source of truth for all approval authorities in the housing system.
 *
 * USAGE:
 *   APPROVAL_AUTHORITY.can('reviewApplication', role)    → true/false
 *   APPROVAL_AUTHORITY.who('finalApproveApp')            → ['ed']
 *   APPROVAL_AUTHORITY.get('sowEdThreshold')             → 25000
 *
 * LOADING:
 *   Defaults are defined here. At login, initApprovalAuthority() is called
 *   which merges any overrides saved in housing_settings (key: 'approval_authority')
 *   on top of the defaults, so ED changes persist across sessions.
 *
 * TO ADD A NEW AUTHORITY:
 *   1. Add a default entry below in the DEFAULTS block
 *   2. Add a row to the Settings UI in housing.html sec_approval section
 *   3. Replace inline role checks in code with APPROVAL_AUTHORITY.can(...)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

var APPROVAL_AUTHORITY = (function() {

  // ── DEFAULTS ────────────────────────────────────────────────────────────
  // These are the baseline rules. All values are overridable via Settings UI.
  // roles must match values in shared-config.js ROLE constants.

  var DEFAULTS = {

    // ── Housing Application workflow ──────────────────────────────────────
    // Who can review a submitted application (first level)
    reviewApplication:        ['housing_manager'],
    // Who can give final approval for housing
    finalApproveApp:          ['ed'],
    // Who can decline an application
    declineApplication:       ['housing_manager', 'ed'],
    // Who can return an application for more info
    returnApplication:        ['housing_manager', 'ed'],
    // Who can delete (archive) an application from the Match list / worklist
    deleteApplication:        ['ed'],

    // ── File Update workflow ──────────────────────────────────────────────
    // File updates only need HM approval — no ED sign-off required
    reviewFileUpdate:         ['housing_manager'],
    approveFileUpdate:        ['housing_manager'],

    // ── Unit Assignment ───────────────────────────────────────────────────
    // Who can assign a unit to an applicant
    assignUnit:               ['housing_manager', 'ed'],
    // Who can override the top match recommendation
    overrideMatch:            ['ed'],
    // Who can override a CALCULATED monthly rent (documented reason required)
    overrideRent:             ['ed'],
    // Who can assign within the tied score band (notes required)
    assignTiedBand:           ['housing_manager', 'ed'],
    // Who can set / edit a unit's monthly rent amount on the Inventory forms
    assignRentAmount:         ['housing_manager', 'ed'],
    // Who can edit the age-adjustment band schedule (Settings > Rent Model)
    editRentAgeFactors:       ['housing_manager', 'ed'],

    // ── Arrears & policy (Policy s.8 / s.12) ──────────────────────────────
    // Who can edit the nation's Policy Rules parameters (Settings)
    editPolicyRules:          ['ed'],
    // Who can create repayment arrangements / record reviews & final notices
    manageArrears:            ['housing_manager', 'ed'],
    // Who approves a repayment arrangement (starts the protected window)
    approveArrangement:       ['ed'],
    // Who can authorize an arrears eviction (after the 12.4 precondition gate)
    authorizeEviction:        ['ed'],

    // ── Application signatures ────────────────────────────────────────────
    // Who can unlock (override) applicant signatures after an app is submitted
    unlockSignatures:         ['housing_manager', 'ed'],

    // ── SOW / Renovation Budget ───────────────────────────────────────────
    // Dollar threshold — above this, ED approval required
    sowEdThreshold:           25000,
    // Who can approve SOW under the threshold
    approveSowUnderThreshold: ['housing_manager'],
    // Who can approve SOW over the threshold
    approveSowOverThreshold:  ['ed'],
    // Who can lock a completed SOW
    lockSow:                  ['ed'],
    // Who can assign a work order to the in-house field crew (a key person).
    // Field Employees only see work orders assigned to them.
    assignWorkOrder:          ['housing_manager', 'ed'],

    // ── Contractor approvals ──────────────────────────────────────────────
    // Who can recommend a contractor for final approval. HE-L2 included so
    // senior employees can move new contractors forward without HM having to
    // be the bottleneck. The recommend step is retained, but final approval is
    // held by the HM or the ED (either can grant it).
    recommendContractor:      ['housing_employee_l2', 'housing_manager'],
    // Who gives final contractor approval — HM or ED.
    approveContractor:        ['housing_manager', 'ed'],
    // Who can decline a contractor
    declineContractor:        ['housing_manager', 'ed'],
    // Who can UNLOCK adding files to contractor emails after a contract has
    // been emailed (the RFQ Documents "attach to email" list locks once the
    // contract is sent, to freeze what was shared).
    unlockEmailAttachments:   ['housing_manager', 'ed'],

    // ── Score model ───────────────────────────────────────────────────────
    // Who can edit the scoring model criteria and weights
    editScoreModel:           ['ed'],
    // Who can apply a manual score adjustment on an application
    applyScoreAdjustment:     ['ed'],
    // Who can edit the Match Priority weights (Housing Placement Order) —
    // deliberately separate from editScoreModel so this can be delegated on
    // its own: it decides WHO gets matched first (reserve/house status,
    // Temporary/Transition unit type), not the application's need/urgency score.
    editMatchPriority:        ['ed'],

    // ── Settings & config ─────────────────────────────────────────────────
    // Who can access the Settings page
    accessSettings:           ['housing_manager', 'ed'],
    // Who can edit approval authorities (this panel)
    editApprovalAuthority:    ['ed'],
    // Who can add/edit staff
    manageStaff:              ['housing_manager', 'ed'],

    // ── Inventory ─────────────────────────────────────────────────────────
    // Who can archive a unit (soft-delete from Inventory)
    archiveUnit:              ['ed'],
    // Who can set a unit's GPS coordinates and house photo
    setUnitLocation:          ['housing_manager', 'ed'],

    // ── Inspections ───────────────────────────────────────────────────────
    // Who can approve / sign off a completed unit inspection report
    approveInspection:        ['housing_manager', 'ed'],

    // ── Tenants ───────────────────────────────────────────────────────────
    // Who can add to / lift from the BCR (banished, housing-ineligible) list
    manageBcr:                ['housing_manager', 'ed'],
    // Who can merge duplicate tenant records into one person
    mergeTenants:             ['housing_manager', 'ed'],
    // Who can archive (soft-hide, recoverable) and restore tenant files
    archiveTenantFiles:       ['ed', 'housing_manager'],

    // ── Staff management ──────────────────────────────────────────────────
    // Who can edit / deactivate an existing staff record
    manageStaffRecord:        ['ed'],
    // Who can assign / change roles for ANY staff member (vs. only HE roles)
    manageAllStaffRoles:      ['ed'],

    // ── Application visibility & scoring ──────────────────────────────────
    // Who can see the numeric application score (HE_L1 hidden by default)
    viewApplicationScore:     ['ed', 'housing_manager', 'housing_employee_l2', 'cfo', 'finance_l1'],

    // ── Renovation Progress ───────────────────────────────────────────────
    // Who can edit progress percentages and notes on a renovation. Includes the
    // Field Employee (maintenance crew) who performs and reports the work.
    editRenoProgress:         ['ed', 'housing_manager', 'housing_employee_l2', 'field_employee'],

    // ── Finance module ────────────────────────────────────────────────────
    viewFinanceCard:          ['ed', 'housing_manager', 'housing_employee_l2', 'housing_employee_l1', 'cfo', 'finance_l1'],
    recordPayment:            ['housing_manager', 'cfo', 'finance_l1', 'ed'],
    createInvoice:            ['housing_manager', 'cfo', 'finance_l1', 'ed'],
    createArrangement:        ['housing_manager', 'ed'],
    manageLoan:               ['ed'],
    reverseTransaction:       ['housing_manager', 'ed'],

    // ── Leadership / reporting ────────────────────────────────────────────
    // Who can open the Chief & Council (leadership) KPI dashboard. Read-only
    // cross-app metrics, no data edits. ED + HM by default; editable here.
    accessLeadershipDashboard: ['ed', 'housing_manager'],

    // ── Capital Projects ──────────────────────────────────────────────────
    // Who can create/edit capital projects (milestones, expenses, lots, and
    // creating/linking units). Everyone else with housing access views
    // read-only.
    manageProjects:           ['housing_manager', 'ed'],
    // Who can run "Allocate Costs to Units" — divides the project total
    // across its linked units and rewrites each unit's Construction Cost.
    allocateProjectCosts:     ['ed'],

    // ── Documents & Files ─────────────────────────────────────────────────
    // Who can DELETE, ARCHIVE or permanently purge documents and photos in the
    // shared Document library (application docs, tenant/unit files, inspection
    // and work-order photos, RFQ docs, finance profiles, etc). Uploading and
    // viewing are NOT gated by this — only the destructive actions. Restoring a
    // file from the recycle bin / archive stays available (recovery is safe).
    deleteDocuments:          ['housing_manager', 'ed'],

  };

  // ── LIVE CONFIG (defaults + any saved overrides) ──────────────────────
  var _live = JSON.parse(JSON.stringify(DEFAULTS));

  // ── DISABLED APPROVALS ────────────────────────────────────────────────
  // Approval STEPS that the ED has switched OFF in Settings. When a step is
  // off, the workflow that owns it auto-approves instead of routing to a
  // person (recorded under "System — approval disabled"). Keyed by action.
  // Only the sign-off gates in TOGGLEABLE below may be disabled; capability
  // and view gates are not toggleable. Persisted in the same housing_settings
  // 'approval_authority' blob under the reserved __disabled key.
  var _disabled = {};

  // The approval gates that support an on/off (auto-approve) toggle, and the
  // per-workflow approval CHAINS used to decide when an item auto-approves.
  // "Any step in the chain off" => the whole item auto-approves on submit.
  var TOGGLEABLE = [
    'reviewApplication', 'finalApproveApp',
    'reviewFileUpdate', 'approveFileUpdate',
    'approveSowUnderThreshold', 'approveSowOverThreshold',
    'recommendContractor', 'approveContractor',
    'approveInspection'
  ];
  var CHAINS = {
    application: ['reviewApplication', 'finalApproveApp'],
    file_update: ['reviewFileUpdate', 'approveFileUpdate'],
    sow_under:   ['approveSowUnderThreshold'],
    sow_over:    ['approveSowUnderThreshold', 'approveSowOverThreshold'],
    contractor:  ['recommendContractor', 'approveContractor'],
    inspection:  ['approveInspection']
  };

  // ── PUBLIC API ────────────────────────────────────────────────────────

  return {

    /**
     * Check if a role can perform an action.
     * @param {string} action  — key from DEFAULTS
     * @param {string} role    — current role string (e.g. 'ed', 'housing_manager')
     * @returns {boolean}
     *
     * Super User inheritance: anyone with role='super_user' is treated as
     * having every grant ED has. Saved overrides can still target 'super_user'
     * explicitly to grant access to actions ED doesn't have (rare).
     */
    can: function(action, role) {
      if (!action || !role) return false;
      var allowed = _live[action];
      if (!Array.isArray(allowed)) return false;
      if (allowed.indexOf(role) !== -1) return true;
      // Super User inherits everything granted to ED. If admin later removes
      // ED's authority for an action, super_user loses it too — they're a tier.
      if (role === 'super_user' && allowed.indexOf('ed') !== -1) return true;
      return false;
    },

    // ── Approval on/off (auto-approve) ────────────────────────────────────

    /**
     * Is a human sign-off still REQUIRED for this approval step?
     * Returns false when the ED has switched the step OFF in Settings (the
     * workflow then auto-approves). Non-toggleable / unknown actions are
     * always required (true).
     */
    required: function(action) {
      return !_disabled[action];
    },

    /** Turn an approval step on (required=true) or off (auto-approve). */
    setRequired: function(action, isRequired) {
      if (TOGGLEABLE.indexOf(action) === -1) return; // only sign-off gates toggle
      if (isRequired) delete _disabled[action];
      else _disabled[action] = true;
    },

    /**
     * Does this item's approval CHAIN have ANY step switched off? If so the
     * whole item auto-approves on submit ("any off = fully approved").
     * @param {Array<string>|string} chain — action keys, or a CHAINS key
     */
    chainDisabled: function(chain) {
      var gates = (typeof chain === 'string') ? (CHAINS[chain] || []) : (chain || []);
      for (var i = 0; i < gates.length; i++) {
        if (_disabled[gates[i]]) return true;
      }
      return false;
    },

    /** List of currently-disabled approval steps. */
    disabledList: function() { return Object.keys(_disabled); },

    /** Which gates support the on/off toggle. */
    toggleable: TOGGLEABLE.slice(),
    isToggleable: function(action) { return TOGGLEABLE.indexOf(action) !== -1; },

    /** The per-workflow approval chains (read-only copy). */
    chains: JSON.parse(JSON.stringify(CHAINS)),

    /**
     * Get the list of roles allowed for an action, or a threshold value.
     * @param {string} action
     * @returns {Array|number}
     */
    get: function(action) {
      return _live[action] !== undefined ? _live[action] : null;
    },

    /**
     * Get all role-list entries (excludes numeric thresholds).
     * Used by the Settings UI to render the editor.
     * @returns {Object}
     */
    allRoleEntries: function() {
      var out = {};
      Object.keys(_live).forEach(function(k) {
        if (Array.isArray(_live[k])) out[k] = _live[k].slice();
      });
      return out;
    },

    /**
     * Get all threshold entries (numeric values).
     * @returns {Object}
     */
    allThresholds: function() {
      var out = {};
      Object.keys(_live).forEach(function(k) {
        if (typeof _live[k] === 'number') out[k] = _live[k];
      });
      return out;
    },

    /**
     * Merge saved overrides on top of defaults.
     * Called at login after housing_settings loads.
     * @param {Object} saved — parsed JSON from housing_settings 'approval_authority' key
     */
    loadOverrides: function(saved) {
      if (!saved || typeof saved !== 'object') return;
      var self = this;
      Object.keys(saved).forEach(function(k) {
        if (DEFAULTS[k] !== undefined) {
          _live[k] = saved[k];
        }
      });
      // Disabled approval steps (reserved __disabled key — an array of action
      // names). Only accept known toggleable gates so stale/bad data can't
      // silently switch off something that isn't meant to be toggleable.
      if (Array.isArray(saved.__disabled)) {
        _disabled = {};
        saved.__disabled.forEach(function(a) {
          if (TOGGLEABLE.indexOf(a) !== -1) _disabled[a] = true;
        });
      }
      console.info('[APPROVAL_AUTHORITY] Loaded overrides:', Object.keys(saved).length, 'keys');
    },

    /**
     * Serialize current live config for saving to housing_settings.
     * Only saves keys that differ from defaults.
     * @returns {Object}
     */
    serialize: function() {
      var out = {};
      Object.keys(_live).forEach(function(k) {
        var liveVal = JSON.stringify(_live[k]);
        var defVal  = JSON.stringify(DEFAULTS[k]);
        if (liveVal !== defVal) out[k] = _live[k];
      });
      var off = Object.keys(_disabled);
      if (off.length) out.__disabled = off;
      return out;
    },

    /**
     * Update a single authority entry and persist.
     * @param {string}        action  — key to update
     * @param {Array|number}  value   — new value
     */
    update: function(action, value) {
      if (DEFAULTS[action] === undefined) {
        console.warn('[APPROVAL_AUTHORITY] Unknown action:', action);
        return;
      }
      _live[action] = value;
    },

    /**
     * Reset a single entry (or all) back to defaults.
     * @param {string} [action] — omit to reset all
     */
    reset: function(action) {
      if (action) {
        _live[action] = JSON.parse(JSON.stringify(DEFAULTS[action]));
        delete _disabled[action];
      } else {
        _live = JSON.parse(JSON.stringify(DEFAULTS));
        _disabled = {};
      }
    },

    /** Expose defaults for display in Settings UI */
    defaults: DEFAULTS,

    /**
     * Returns all available roles in display order, using CLFN_PERMS if available.
     * Falls back to the known static list if shared.js hasn't loaded yet.
     */
    allRoles: function() {
      if (window.CLFN_PERMS && window.CLFN_PERMS.ROLE_LABELS) {
        return Object.keys(window.CLFN_PERMS.ROLE_LABELS).map(function(k) {
          return { value: k, label: window.CLFN_PERMS.ROLE_LABELS[k] };
        });
      }
      // Static fallback
      return [
        { value: 'ed',                  label: 'Executive Director' },
        { value: 'housing_manager',     label: 'Housing Manager' },
        { value: 'housing_employee_l2', label: 'Housing Employee L2' },
        { value: 'housing_employee_l1', label: 'Housing Employee L1' },
        { value: 'cfo',                 label: 'CFO' },
        { value: 'finance_l1',          label: 'Finance Clerk L1' },
        { value: 'super_user',          label: 'Super User' },
      ];
    },

    /** Human-readable labels for each action key */
    labels: {
      reviewApplication:        'Review submitted application',
      finalApproveApp:          'Final approval — housing application',
      declineApplication:       'Decline application',
      returnApplication:        'Return application for more info',
      deleteApplication:        'Delete / archive an application',
      reviewFileUpdate:         'Review file update',
      approveFileUpdate:        'Approve file update',
      assignUnit:               'Assign unit to applicant',
      overrideMatch:            'Override top match recommendation',
      overrideRent:             'Override calculated monthly rent',
      assignTiedBand:           'Assign within tied score band',
      assignRentAmount:         'Set / edit unit rent amount',
      editRentAgeFactors:       'Edit rent age-adjustment schedule',
      editPolicyRules:          'Edit Policy Rules parameters',
      manageArrears:            'Manage repayment arrangements & arrears reviews',
      approveArrangement:       'Approve repayment arrangements',
      authorizeEviction:        'Authorize arrears eviction (Policy 12.4 gate)',
      unlockSignatures:         'Unlock applicant signatures after submission',
      sowEdThreshold:           'Maintenance Request dollar threshold for ED approval ($)',
      approveSowUnderThreshold: 'Approve Maintenance Request under threshold',
      approveSowOverThreshold:  'Approve Maintenance Request over threshold',
      lockSow:                  'Lock completed Maintenance Request',
      assignWorkOrder:          'Assign work order to field crew',
      recommendContractor:      'Approve contractor (first stage — HM)',
      approveContractor:        'Final contractor approval',
      declineContractor:        'Decline contractor',
      unlockEmailAttachments:   'Unlock adding files to contractor emails',
      editScoreModel:           'Edit scoring model',
      applyScoreAdjustment:     'Apply manual score adjustment',
      editMatchPriority:        'Edit housing placement order (Match Priority)',
      accessSettings:           'Access settings page',
      editApprovalAuthority:    'Edit approval authorities',
      manageStaff:              'Add / edit staff',
      archiveUnit:              'Archive a unit',
      setUnitLocation:          'Set unit GPS location &amp; house photo',
      approveInspection:        'Approve inspection report',
      manageBcr:                'Manage BCR / ineligibility list',
      mergeTenants:             'Merge duplicate records (tenants & applications)',
      archiveTenantFiles:       'Archive / restore tenant files',
      manageStaffRecord:        'Edit / deactivate a staff record',
      manageAllStaffRoles:      'Assign any role to staff',
      viewApplicationScore:     'View application score',
      editRenoProgress:         'Edit renovation progress',
      viewFinanceCard:          'View Financial Information Card',
      recordPayment:            'Record rent / arrangement / loan payments',
      createInvoice:            'Create invoices and charges',
      createArrangement:        'Create payment arrangements',
      manageLoan:               'Create and manage loans',
      reverseTransaction:       'Reverse posted transactions',
      accessLeadershipDashboard:'Access the Chief &amp; Council dashboard',
      manageProjects:           'Create / edit capital projects',
      allocateProjectCosts:     'Allocate project costs to units',
      deleteDocuments:          'Delete / archive documents &amp; photos',
    },

    /** Group labels for the Settings UI sections */
    groups: {
      'Housing Application':  ['reviewApplication','finalApproveApp','declineApplication','returnApplication','deleteApplication','unlockSignatures','viewApplicationScore'],
      'File Update':          ['reviewFileUpdate','approveFileUpdate'],
      'Unit Assignment':      ['assignUnit','overrideMatch','assignTiedBand','assignRentAmount','overrideRent','editRentAgeFactors'],
      'Arrears & Policy':     ['editPolicyRules','manageArrears','approveArrangement','authorizeEviction'],
      'Maintenance Request & Renovation': ['sowEdThreshold','approveSowUnderThreshold','approveSowOverThreshold','lockSow','assignWorkOrder','editRenoProgress'],
      'Contractors':          ['recommendContractor','approveContractor','declineContractor','unlockEmailAttachments'],
      'Scoring':              ['editScoreModel','applyScoreAdjustment','editMatchPriority'],
      'Inventory':            ['archiveUnit', 'setUnitLocation'],
      'Inspections':          ['approveInspection'],
      'Tenants':              ['manageBcr','mergeTenants','archiveTenantFiles'],
      'System':               ['accessSettings','editApprovalAuthority','manageStaff','manageStaffRecord','manageAllStaffRoles'],
      'Finance':              ['viewFinanceCard','recordPayment','createInvoice','createArrangement','manageLoan','reverseTransaction'],
      'Leadership Dashboard': ['accessLeadershipDashboard'],
      'Capital Projects':     ['manageProjects','allocateProjectCosts'],
      'Documents & Files':    ['deleteDocuments'],
    },

  };

})();

/**
 * initApprovalAuthority()
 * Called at login after window._appSettings is populated.
 * Merges any saved overrides from housing_settings into the live config.
 */
function initApprovalAuthority() {
  try {
    var saved = window._appSettings && window._appSettings['approval_authority'];
    if (saved) {
      var parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
      APPROVAL_AUTHORITY.loadOverrides(parsed);
    }
  } catch(e) {
    console.warn('[APPROVAL_AUTHORITY] Could not load overrides:', e);
  }
}
