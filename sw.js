const CACHE_NAME = "xtreme-cuentas-v2";
const ASSETS = ["./","./index.html","./styles.css","./app.js","./manifest.json","./icon-192.png","./icon-512.png"];
self.addEventListener("install",(e)=>{
  e.waitUntil((async()=>{
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(ASSETS);
    self.skipWaiting();
  })());
});
self.addEventListener("activate",(e)=>{
  e.waitUntil((async()=>{
    const keys = await caches.keys();
    await Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)));
    self.clients.claim();
  })());
});
self.addEventListener("fetch",(e)=>{
  const req = e.request;
  e.respondWith((async()=>{
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;
    try{
      const res = await fetch(req);
      if (req.method==="GET" && res && res.status===200 && res.type==="basic"){
        cache.put(req, res.clone());
      }
      return res;
    }catch(err){
      return cached || new Response("Sin conexión y recurso no está en caché.", {status: 503});
    }
  })());
});