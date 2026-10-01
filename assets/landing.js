// Store links come from /config.json so they can be switched on the day each store
// approves the app, without touching this page.
(function(){
  var box = document.querySelector('[data-stores]');
  if(!box) return;
  function soon(){ box.textContent = box.getAttribute('data-soon'); }
  fetch('/config.json', {cache:'no-store'}).then(function(r){ return r.ok ? r.json() : null; }).then(function(cfg){
    var stores = (cfg && cfg.stores) || {};
    var links = [['Google Play', stores.android], ['App Store', stores.ios]].filter(function(s){
      return typeof s[1]==='string' && /^https:\/\/(play\.google\.com|apps\.apple\.com)\//.test(s[1]);
    });
    if(!links.length) return soon();
    box.textContent = box.getAttribute('data-label') + ' ';
    links.forEach(function(s){
      var a = document.createElement('a');
      a.className = 'btn btn-ghost btn-small'; a.href = s[1]; a.textContent = s[0]; a.rel = 'noopener';
      box.appendChild(a);
    });
  }).catch(soon);
})();
