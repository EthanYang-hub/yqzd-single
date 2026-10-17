/* 只缓存本站静态资源，保持角色本地存档独立。构建脚本注入版本号。 */
const REVISION='2344c564a174';
const ROOT=new URL('./',self.location.href),PUBLIC_CACHE='yqzd-public-assets-v1';
const SITE_CACHE='yqzd-site-'+encodeURIComponent(ROOT.pathname)+'-'+REVISION;
const SHELL=['index.html','web-adapter-local.js','offline-local.js','offline-assets.js','offline-unlocked.js','performance-local.js','audio-local.js','source-preload.json','initial-role.json','manifest.webmanifest','offline-assets.json'];
const canonical=request=>{const url=new URL(request.url);if(request.mode==='navigate'||url.pathname.startsWith(ROOT.pathname+'cdn/'))url.search='';else if(url.searchParams.get('v')===REVISION)url.searchParams.delete('v');if(url.pathname===ROOT.pathname)url.pathname+='index.html';return url.href;};
async function cachedResponse(request,response){
  const range=request.headers.get('Range');if(!range)return response;
  // Safari 的音频播放会请求字节范围，离线缓存也需要返回正确的206响应。
  const match=/^bytes=(\d*)-(\d*)$/.exec(range),blob=await response.blob(),length=blob.size;
  let start=0,end=length-1;
  if(match){if(match[1]){start=Number(match[1]);if(match[2])end=Math.min(Number(match[2]),end);}else if(match[2])start=Math.max(0,length-Number(match[2]));}
  if(!match||!length||start>end||start>=length)return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+length}});
  const headers=new Headers(response.headers);headers.delete('Content-Encoding');headers.set('Accept-Ranges','bytes');headers.set('Content-Range','bytes '+start+'-'+end+'/'+length);headers.set('Content-Length',String(end-start+1));
  return new Response(blob.slice(start,end+1),{status:206,headers});
}
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(SITE_CACHE);
  await Promise.all(SHELL.map(async path=>{const url=new URL(path,ROOT).href,response=await fetch(url,{cache:'reload'});if(!response.ok)throw new Error('Offline shell unavailable: '+path);await cache.put(url,response);}));
  await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  // 更新只清理本站旧代码缓存；大资源和角色存档保留。
  const prefix='yqzd-site-'+encodeURIComponent(ROOT.pathname)+'-';
  await Promise.all((await caches.keys()).filter(key=>key.startsWith(prefix)&&key!==SITE_CACHE).map(key=>caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==ROOT.origin||!url.pathname.startsWith(ROOT.pathname))return;
  const key=canonical(request),isPublic=url.pathname.startsWith(ROOT.pathname+'cdn/');
  event.respondWith((async()=>{
    const cache=await caches.open(isPublic?PUBLIC_CACHE:SITE_CACHE);
    // 在线导航取最新版页面；断网则返回完整下载时保留的页面。
    if(request.mode==='navigate'){
      try{const response=await fetch(request);if(response.ok){event.waitUntil(cache.put(key,response.clone()).catch(()=>{}));return response;}}catch{}
      const saved=await cache.match(key);return saved||Response.error();
    }
    const saved=await cache.match(key);if(saved)return cachedResponse(request,saved);
    const response=await fetch(request);
    if(response.ok&&response.type!=='opaque')event.waitUntil(cache.put(key,response.clone()).catch(()=>{}));
    return response;
  })());
});
