/* ============================================================
 * sw.js — service worker (Phase O1: offline app shell)
 *
 * Goal: let staff open the app and GENERATE forms (PDFs) with no internet.
 *  - Our own files (pages/JS/CSS/images): NETWORK-FIRST — always fresh online,
 *    fall back to the cached copy when offline. (No build/cache-busting here, so
 *    network-first avoids ever serving stale code to an online user.)
 *  - Immutable CDN libs (jsPDF, autotable, Chart.js): CACHE-FIRST so PDF/chart
 *    generation works with zero connection.
 *  - Supabase (REST / Storage / Auth / Functions): NEVER cached — pass straight
 *    through; the app's own offline save-queue handles data while offline.
 *
 * Bump CACHE to force every client to drop the old cache on next load.
 * ============================================================ */
var CACHE = 'clfn-shell-v91';

var LIB_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];

// Minimal boot shell + the libraries needed to generate forms offline.
var PRECACHE = [
  'index.html',
  'shared.js', 'shared-config.js', 'rent-age.js', 'policy-rules.js', 'arrears.js', 'shared-auth.js', 'shared-ui.js', 'shared-data.js',
  'shared.css',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js'
];

self.addEventListener('install', function(e){
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function(c){
      // Best-effort: a single failed asset must not abort the whole install.
      return Promise.all(PRECACHE.map(function(u){ return c.add(u).catch(function(){}); }));
    })
  );
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

function putInCache(req, res){
  try {
    if (res && res.ok) {
      var clone = res.clone();
      caches.open(CACHE).then(function(c){ try { c.put(req, clone); } catch(_){} });
    }
  } catch(_){}
  return res;
}

self.addEventListener('fetch', function(e){
  var req = e.request;
  if (req.method !== 'GET') return;                  // never intercept writes/uploads
  var url;
  try { url = new URL(req.url); } catch(_){ return; }

  // Supabase data layer — pass through, never cache.
  if (url.hostname.indexOf('supabase.co') !== -1) return;

  // Immutable CDN libraries — cache-first (offline PDF/chart generation).
  if (LIB_HOSTS.indexOf(url.hostname) !== -1) {
    e.respondWith(
      caches.match(req).then(function(hit){
        return hit || fetch(req).then(function(res){ return putInCache(req, res); }).catch(function(){ return hit; });
      })
    );
    return;
  }

  // Our own app shell.
  if (url.origin === self.location.origin) {
    // HTML documents / navigations: NETWORK-FIRST, so the entry document (and
    // the script URLs it references) is always fresh and SW/app updates land
    // promptly. Falls back to the cached page, then index.html, when offline.
    var isDoc = req.mode === 'navigate'
      || req.destination === 'document'
      || (url.pathname === '/' || /\.html?$/.test(url.pathname))
      || (req.headers.get('accept') || '').indexOf('text/html') !== -1;
    if (isDoc) {
      e.respondWith(
        fetch(req).then(function(res){ return putInCache(req, res); }).catch(function(){
          return caches.match(req).then(function(hit){ return hit || caches.match('/index.html'); });
        })
      );
      return;
    }
    // Static assets (JS / CSS / images / fonts): STALE-WHILE-REVALIDATE. Serve
    // the cached copy instantly and refresh it in the background for next time.
    // This is the page-to-page speed win -- navigations stop re-downloading
    // ~2.5-3 MB of JS each time. Trade-off: a just-deployed asset can be ONE
    // navigation stale (the next load picks it up). The HTML above stays fresh,
    // so a new page never references a file the SW can't then refresh, and the
    // app tolerates eventual consistency. First visit (cold cache) hits network.
    e.respondWith(
      caches.match(req).then(function(hit){
        var network = fetch(req).then(function(res){ return putInCache(req, res); }).catch(function(){ return hit || Response.error(); });
        return hit || network;
      })
    );
    return;
  }

  // Other cross-origin (map tiles, fonts, etc.) — do NOT intercept. Let the
  // browser fetch them natively. Passing cross-origin image/tile requests
  // through the SW turns them opaque and was leaving OSM map tiles blank in the
  // Set-Location picker (the TIC map works because it's an iframe, whose tile
  // requests never hit our SW). Nothing here needs SW caching — the immutable
  // CDN libs are handled above.
  return;
});
