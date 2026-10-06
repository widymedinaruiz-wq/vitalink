// Anonymous counter: tells the site how many people saw this page and which buttons they
// used. One event name per call, no cookies, no identifiers (see /privacy.html). Skipped
// for visitors who ask not to be tracked, and for anything that isn't the real site.
// Guide pages load this file only for the store links below: <html data-uncounted> keeps
// them out of the count, which covers the landing page alone.
var TRACK_URL = 'https://europe-west1-vitalink-widy.cloudfunctions.net/track';
var COUNTED = !document.documentElement.hasAttribute('data-uncounted');
function track(name){
  try{
    if(!COUNTED || window.__vlForwarding || location.hostname !== 'vitalinks.eu') return;
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
  var EN = document.documentElement.lang === 'en';
  var PLAY_BADGE = EN
    ? { src:'/assets/google-play-badge-en.png', alt:'Get it on Google Play', height:71, ratio:646/250 }
    : { src:'/assets/google-play-badge-es.png', alt:'Disponible en Google Play', height:62, ratio:646/250, pad:true };
  // Apple's official badge has no built-in margin, so it is shown at 48px with its own.
  var APPLE_BADGE = EN
    ? { src:'/assets/app-store-badge-en.svg', alt:'Download on the App Store', height:48, ratio:119.66407/40, pad:true }
    : { src:'/assets/app-store-badge-es.svg', alt:'Consíguelo en el App Store', height:48, ratio:119.66407/40, pad:true };
  fetch('/config.json', {cache:'no-store'}).then(function(r){ return r.ok ? r.json() : null; }).then(function(cfg){
    var stores = (cfg && cfg.stores) || {};
    var links = [['Google Play', stores.android, 'store_android'], ['App Store', stores.ios, 'store_ios']].filter(function(s){
      return typeof s[1]==='string' && /^https:\/\/(play\.google\.com|apps\.apple\.com)\//.test(s[1]);
    });
    if(!links.length) return soon();
    box.textContent = box.getAttribute('data-label') + ' ';
    links.forEach(function(s){
      var a = document.createElement('a');
      // Apple sends a link with no country to its US, English store page, so the Spanish
      // page asks for the Spanish one. On an iPhone either link opens the visitor's own store.
      a.href = EN ? s[1] : s[1].replace('//apps.apple.com/app/', '//apps.apple.com/es/app/');
      a.rel = 'noopener';
      a.setAttribute('data-track', s[2]);
      var badge = s[2] === 'store_android' ? PLAY_BADGE : APPLE_BADGE;
      if(badge){
        // Each store's official badge, used unmodified. Google's two language files come with
        // different built-in margins, so each gets the height that shows the badge at 48px.
        var img = document.createElement('img');
        img.src = badge.src; img.alt = badge.alt; img.height = badge.height; img.width = Math.round(badge.height * badge.ratio);
        a.className = 'store-badge' + (badge.pad ? ' pad' : '');
        a.appendChild(img);
      }else{
        a.className = 'btn btn-ghost btn-small'; a.textContent = s[0];
      }
      box.appendChild(a);
    });
  }).catch(soon);
})();
