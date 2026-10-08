/* ============================================================
 * finance-utils.js — Finance Module Utilities
 *
 * Pure helpers: formatting, display pills, tenant lookup.
 * No side effects at load time. All functions are called lazily
 * from event handlers after the page and data layer are ready.
 *
 * Loaded before the main finance.html inline script so every
 * module in that block can call these without forward-declaration.
 * ============================================================ */

function toast(msg, duration) {
  // Classify by content so legacy finance callers (which never pass a type)
  // surface failures as errors and confirmations as info instead of being
  // silently suppressed by the type-less-toast rule.
  var _isErr = /fail|error|cannot|could not|invalid|missing|denied|required|not permitted|unable|please|no longer|try again/i.test(String(msg || ''));
  if (typeof showToast === 'function') { showToast(msg, {duration: duration || 2500, type: _isErr ? 'error' : 'info'}); return; }
  console.log(msg);
}

function seedIfEmpty(){
  // Phase F3: no-op. Real tenant data comes from the housing → tenants
  // trigger-sync installed by the F2 migration. Demo/dev data should be
  // inserted directly in Supabase via the SQL editor if needed.
}
function fmt(n){ return formatCurrency(n); }
function today(){return new Date().toISOString().slice(0,10);}
function tenantName(t){return t.first+' '+t.last;}
function tenantNameHtml(t){return escapeHtml(tenantName(t));}
// Person identity. The tenant-sync trigger inserts a new tenants row per
// assignment and never matches by name, so one person can hold several rows;
// merged_into points a duplicate at its canonical row (see migration
// 20260624_tenants_merged_into.sql). These helpers roll every surface up under
// the canonical person. Child-row tenantIds are canonicalized in memory at load
// (_finCanonicalizeTenantRefs), so most per-tenant filters already aggregate
// correctly; these cover the tenant-object lookups and list/picker displays.

// Follow the merged_into chain to the canonical (person) tenant id. Cycle- and
// self-loop-guarded; returns the input id unchanged if it's canonical/unknown.
function finCanonTenantId(id){
  if (!id) return id;
  var list = getData().tenants || [];
  var byId = {}; list.forEach(function(t){ if (t && t.id) byId[t.id] = t; });
  var seen = {}, cur = id;
  for (var i = 0; i < 25 && cur && !seen[cur]; i++){
    seen[cur] = 1;
    var t = byId[cur];
    if (!t || !t.mergedInto) return cur;
    cur = t.mergedInto;
  }
  return cur;
}
// Tenants to SHOW in lists, pickers and counts: canonical persons only (rows
// merged into another person are hidden; their data rolls up under the keeper).
function finVisibleTenants(){
  return (getData().tenants || []).filter(function(t){ return t && !t.mergedInto; });
}
// Resolve a tenant object, following a merged id to its canonical person so a
// child row (or an old deep link) keyed to a merged-away id still finds them.
function getTenant(id){
  var list = getData().tenants || [];
  var cid = finCanonTenantId(id);
  var found = null;
  for (var i = 0; i < list.length; i++){ if (list[i].id === cid){ found = list[i]; break; } }
  if (found) return found;
  for (var j = 0; j < list.length; j++){ if (list[j].id === id){ return list[j]; } }
  return null;
}
function methodLabel(m){
  var map={cash:'Cash',debit:'Debit',credit:'Credit Card',etransfer:'E-Transfer','online-banking':'Online Banking',cheque:'Cheque',auto:'Auto Payment',eft:'EFT (Auto)',payroll:'Payroll Deduction'};
  return map[m]||m||'';
}
function typePill(type){
  var map={'band-on':'<span class="pill pill-blue">Band On-Reserve</span>','band-off':'<span class="pill pill-gray">Band Off-Reserve</span>','band-staff':'<span class="pill pill-yellow">Band Staff</span>','clea':'<span class="pill pill-green">CLEA</span>','community':'<span class="pill pill-gray">Community</span>','business':'<span class="pill pill-blue">Business</span>','department':'<span class="pill pill-yellow">Department</span>'};
  return map[type]||type;
}
function statusPill(s){
  var map={approved:'<span class="pill pill-green">Approved</span>',posted:'<span class="pill pill-green">Posted</span>','pending-ed':'<span class="pill pill-yellow">Pending ED</span>',pending:'<span class="pill pill-yellow">Pending</span>',reversed:'<span class="pill pill-red">Reversed</span>',nsf:'<span class="pill pill-red">NSF</span>','pending-reversal':'<span class="pill pill-orange">Rev. Pending</span>',active:'<span class="pill pill-green">Active</span>','paid-off':'<span class="pill pill-blue">Paid Off</span>',resolved:'<span class="pill pill-blue">Resolved</span>'};
  return map[s]||'<span class="pill pill-gray">'+s+'</span>';
}
function isInCollections(tenantId){
  return getData().collections.some(function(c){return c.tenantId===tenantId&&(c.status==='approved'||c.status==='pending-ed');});
}
function collectionsBadge(tenantId){
  return isInCollections(tenantId)?'<span class="collections-badge" style="margin-left:6px;">&#128680; Collections</span>':'';
}
