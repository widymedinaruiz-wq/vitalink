// Anonymous counter: tells the site how many people saw this page and which buttons they
// used. One event name per call, no cookies, no identifiers (see /privacy.html). Skipped
// for visitors who ask not to be tracked, and for anything that isn't the real site.
var TRACK_URL = 'https://europe-west1-vitalink-widy.cloudfunctions.net/track';
function track(name){
  try{
    if(window.__vlForwarding || location.hostname !== 'vitalinks.eu') return;
    if(navigator.doNotTrack === '1' || navigator.globalPrivacyControl) return;
    navigator.sendBeacon(TRACK_URL, JSON.stringify({ e: name }));
  }catch(e){}
}
track(document.documentElement.lang === 'en' ? 'view_en' : 'view_es');
document.addEventListener('click', function(ev){
  var a = ev.target && ev.target.closest ? ev.target.closest('a[data-track]') : null;
  if(a) track(a.getAttribute('data-track'));
});

// Store links come from /config.json so they can be switched on the day each store
// approves the app, without touching this page.
(function(){
  var box = document.querySelector('[data-stores]');
  if(!box) return;
  function soon(){ box.textContent = box.getAttribute('data-soon'); }
  fetch('/config.json', {cache:'no-store'}).then(function(r){ return r.ok ? r.json() : null; }).then(function(cfg){
    var stores = (cfg && cfg.stores) || {};
    var links = [['Google Play', stores.android, 'store_android'], ['App Store', stores.ios, 'store_ios']].filter(function(s){
      return typeof s[1]==='string' && /^https:\/\/(play\.google\.com|apps\.apple\.com)\//.test(s[1]);
    });
    if(!links.length) return soon();
    box.textContent = box.getAttribute('data-label') + ' ';
    links.forEach(function(s){
      var a = document.createElement('a');
      a.className = 'btn btn-ghost btn-small'; a.href = s[1]; a.textContent = s[0]; a.rel = 'noopener';
      a.setAttribute('data-track', s[2]);
      box.appendChild(a);
    });
  }).catch(soon);
})();
