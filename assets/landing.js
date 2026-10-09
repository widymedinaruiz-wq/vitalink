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

// On a phone the header button installs the app from that phone's store (the badge in the
// hero is already in the page; <html> gets .os-android / .os-ios from a script in <head>).
(function(){
  var os = /\bos-(android|ios)\b/.exec(document.documentElement.className);
  var btn = document.querySelector('.top .btn-small[data-install]');
  var badge = os && document.querySelector('.store-badge.' + (os[1] === 'android' ? 'play' : 'apple'));
  if(!btn || !badge) return;
  btn.href = badge.href;
  btn.textContent = btn.getAttribute('data-install');
  btn.setAttribute('data-track', os[1] === 'android' ? 'store_android' : 'store_ios');
})();

// The header link for the section being read is highlighted. Two sections can share one
// link (data-nav), so each link counts how many of its sections are on screen. The
// observer watches a single line across the middle of the window, so only one section
// can be "current" at a time.
(function(){
  if(!('IntersectionObserver' in window)) return;
  var links = {}, onScreen = {};
  Array.prototype.forEach.call(document.querySelectorAll('.sections a'), function(a){ links[a.getAttribute('href').slice(1)] = a; });
  var key = function(el){ return el.getAttribute('data-nav') || el.id; };
  var current = new IntersectionObserver(function(entries){
    entries.forEach(function(en){
      var k = key(en.target), a = links[k];
      if(!a) return;
      onScreen[k] = Math.max(0, (onScreen[k] || 0) + (en.isIntersecting ? 1 : (en.target._seen ? -1 : 0)));
      en.target._seen = en.isIntersecting;
      if(onScreen[k]) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
    });
  }, { rootMargin:'-50% 0px -50% 0px' });
  Array.prototype.forEach.call(document.querySelectorAll('main section[id]'), function(s){ if(links[key(s)]) current.observe(s); });
})();

// Motion (see the end of landing.css). Blocks that start below the fold fade up when they
// scroll into view; anything already on screen is left alone, so nothing visible ever
// disappears, and without this script the page is simply static.
(function(){
  if(!('IntersectionObserver' in window)) return;
  if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var groups = ['.chips', '.feature > div', '.steps > li', '.feature.photo > .note', '.cards > .card', '.closing', '.social'];
  var seen = new IntersectionObserver(function(entries){
    entries.forEach(function(en){
      if(!en.isIntersecting) return;
      en.target.classList.add('in');
      seen.unobserve(en.target);
    });
  }, { rootMargin:'0px 0px -12% 0px', threshold:0.08 });
  groups.forEach(function(sel){
    Array.prototype.forEach.call(document.querySelectorAll(sel), function(el){
      if(el.getBoundingClientRect().top < window.innerHeight) return;
      // Siblings arrive a beat apart (the three photo steps, the four cards).
      var i = Array.prototype.indexOf.call(el.parentNode.children, el);
      if(sel === '.steps > li' || sel === '.cards > .card') el.style.setProperty('--d', (i % 3) * 0.12 + 's');
      el.classList.add('rv');
      seen.observe(el);
    });
  });

})();
