/* Browser host for the user's extracted WeChat build. No production network fallback. */
(function (g) {
  'use strict';
  const NativeXHR = g.XMLHttpRequest, nativeFetch = g.fetch.bind(g);
  const NativeSocket = g.WebSocket, NativeImage = g.Image;
  const origin = location.origin, cache = new Map(), memory = new Map();
  const iosDevice=/iPhone|iPad|iPod/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  const androidDevice=/Android/i.test(navigator.userAgent),mobileDevice=iosDevice||androidDevice;
  const renderPixelRatio=g.devicePixelRatio||1;
  const assetBytes=new Map(),assetPending=new Map(),codeBytes=new Map();let assetByteCount=0;
  const assetMemoryLimit=32*1024*1024;
  let diskCachePromise;
  function assetDiskCache(){return diskCachePromise||(diskCachePromise=g.caches?g.caches.open('yqzd-public-assets-v1').catch(()=>null):Promise.resolve(null));}
  // 由页面位置识别站点前缀，同时支持本地根目录和 GitHub Pages 项目目录。
  const sitePath = new URL('../', document.baseURI).pathname.replace(/\/$/, '');
  const status = text => { const el = document.getElementById('local-status'); if (el) el.textContent = text; };
  const fail = (opts, error) => { const r = {errMsg: String(error.message || error)}; opts.fail?.(r); opts.complete?.(r); };
  const done = (opts, value = {}) => { opts.success?.(value); opts.complete?.(value); };
  function localURL(path) {
    path = String(path || '');
    if (/^(blob:|data:)/.test(path)) return path;
    if (/^wxfile:\/\/(usr|user)\//.test(path)) path = path.replace(/^wxfile:\/\/(usr|user)\//, '/user/');
    if (path === 'wxfile://usr') path = '/user/';
    const url = new URL(path.startsWith('/') || /^https?:/.test(path) ? path : '/source/' + path, origin);
    if (url.origin !== origin) throw new Error('Blocked external game request: ' + url.origin + url.pathname);
    if (sitePath && url.pathname !== sitePath && !url.pathname.startsWith(sitePath + '/')) url.pathname = sitePath + url.pathname;
    if (g.LOCAL_GAME_REVISION && url.pathname.startsWith(sitePath + '/source/') && url.pathname.endsWith('.js')) url.searchParams.set('v', g.LOCAL_GAME_REVISION);
    return url.href;
  }
  // CSP is the final boundary. These guards also make rejected requests visible.
  g.fetch = (input, options) => nativeFetch(localURL(input instanceof Request ? input.url : input), options);
  const originalOpen = NativeXHR.prototype.open;
  NativeXHR.prototype.open = function (method, url, ...args) { return originalOpen.call(this, method, localURL(url), ...args); };
  if (NativeSocket) g.WebSocket = class LocalWebSocket extends NativeSocket {
    constructor(url, protocols) {
      const parsed = new URL(url, origin); const expected = origin.replace(/^http/, 'ws');
      if (parsed.origin !== expected) throw new Error('Blocked external WebSocket: ' + parsed.origin);
      super(parsed.href, protocols);
    }
  };
  function cachedBytes(url) {
    if(codeBytes.has(url))return codeBytes.get(url);
    if (memory.has(url)) return memory.get(url).slice();
    const persisted = localStorage.getItem('yqzd-file:' + url.slice(origin.length));
    if (persisted != null) return Uint8Array.from(atob(persisted), c => c.charCodeAt(0));
    if(assetBytes.has(url)){const bytes=assetBytes.get(url);assetBytes.delete(url);assetBytes.set(url,bytes);return bytes;}
    return null;
  }
  function rememberAsset(url,bytes){
    // 同步 require 不能可靠经过 Service Worker；预读代码必须保留到后续场景加载。
    const path=new URL(url).pathname;
    if(path.startsWith(sitePath+'/source/')&&/\.(js|json)$/.test(path)){codeBytes.set(url,bytes);return;}
    if(bytes.byteLength>assetMemoryLimit)return;
    if(assetBytes.has(url)){assetByteCount-=assetBytes.get(url).byteLength;assetBytes.delete(url);}
    while(assetByteCount+bytes.byteLength>assetMemoryLimit&&assetBytes.size){const key=assetBytes.keys().next().value;assetByteCount-=assetBytes.get(key).byteLength;assetBytes.delete(key);}
    assetBytes.set(url,bytes);assetByteCount+=bytes.byteLength;
  }
  function readBytes(path) {
    const url=localURL(path),existing=cachedBytes(url);if(existing)return existing;
    const xhr = new NativeXHR(); xhr.open('GET', url, false); xhr.overrideMimeType('text/plain; charset=x-user-defined'); xhr.send();
    if (xhr.status !== 200) throw new Error('Missing local file (' + xhr.status + '): ' + url);
    const bytes=Uint8Array.from(xhr.responseText,c=>c.charCodeAt(0)&255);rememberAsset(url,bytes);return bytes;
  }
  async function readBytesAsync(path,signal) {
    const url=localURL(path),existing=cachedBytes(url);if(existing)return existing;
    if(assetPending.has(url))return assetPending.get(url);
    const pending=(async()=>{
      // 公共资源按需缓存；角色存档仍只走原有本地存储。
      const persistent=new URL(url).pathname.startsWith(sitePath+'/cdn/'),disk=persistent?await assetDiskCache():null;
      let response;
      if(disk)try{response=await disk.match(url);}catch{}
      if(!response){response=await nativeFetch(url,{signal});if(!response.ok)throw new Error('Missing local file ('+response.status+'): '+url);if(disk)disk.put(url,response.clone()).catch(()=>{});}
      const bytes=new Uint8Array(await response.arrayBuffer());rememberAsset(url,bytes);return bytes;
    })();
    assetPending.set(url,pending);
    try{return await pending;}catch(error){g.localPerformanceLogs?.resourceFailure(url,error);throw error;}finally{assetPending.delete(url);}
  }
  function decode(bytes, encoding) {
    if (!encoding || encoding === 'binary') return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    if (encoding === 'base64') { let str = ''; for (const b of bytes) str += String.fromCharCode(b); return btoa(str); }
    return new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding).decode(bytes);
  }
  function writeBytes(path, data, encoding) {
    const url = localURL(path);
    if (!new URL(url).pathname.startsWith(sitePath + '/user/')) throw new Error('Writes allowed only in local /user/ storage');
    let bytes;
    if (typeof data === 'string') bytes = encoding === 'base64' ? Uint8Array.from(atob(data), c => c.charCodeAt(0)) : new TextEncoder().encode(data);
    else bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    memory.set(url, bytes.slice());
    if(new URL(url).pathname.startsWith(sitePath + '/user/tmp/')) return;
    let str = ''; for (const b of bytes) str += String.fromCharCode(b);
    // Never overwrite the user's original WeChat profile; this origin owns these records.
    localStorage.setItem('yqzd-file:' + url.slice(origin.length), btoa(str));
  }
  const fs = {
    readFileSync: (path, encoding) => decode(readBytes(path), encoding),
    writeFileSync: writeBytes,
    mkdirSync(path) { const name=new URL(localURL(path)).pathname; if (name!==sitePath+'/user'&&!name.startsWith(sitePath+'/user/')) throw new Error('Read-only source directory'); },
    accessSync(path) { readBytes(typeof path === 'object' ? path.path : path); return {success: true}; },
    unlinkSync(path) { const url = localURL(path); memory.delete(url); localStorage.removeItem('yqzd-file:' + url.slice(origin.length)); },
    rmdirSync() { throw new Error('Recursive local cache deletion is unsupported'); },
    readFile(opts) { readBytesAsync(opts.filePath).then(bytes=>done(opts,{data:decode(bytes,opts.encoding)})).catch(e=>fail(opts,e)); },
    writeFile(opts) { Promise.resolve().then(() => { writeBytes(opts.filePath, opts.data, opts.encoding); done(opts); }).catch(e => fail(opts, e)); },
    // 离线时用同一条缓存读取路径检查文件，避免 HEAD 请求绕过缓存。
    access(opts) { readBytesAsync(opts.path).then(()=>done(opts)).catch(e=>fail(opts,e)); },
    copyFile(opts) { readBytesAsync(opts.srcPath).then(bytes=>{writeBytes(opts.destPath,bytes);done(opts);}).catch(e=>fail(opts,e)); },
    unlink(opts) { try { fs.unlinkSync(opts.filePath); done(opts); } catch (e) { fail(opts, e); } },
    readdir(opts) { fail(opts, new Error('Directory inventory is not exposed by the local HTTP server')); },
    unzip(opts) { fail(opts, new Error('Local bundle ZIP must be extracted by build_local.py before launch')); }
  };
  const canvas = document.getElementById('GameCanvas');
  if (!canvas) throw new Error('Missing GameCanvas');
  canvas.width = Math.round(innerWidth * renderPixelRatio); canvas.height = Math.round(innerHeight * renderPixelRatio);
  g.canvas = canvas; g.screencanvas = canvas; g.GameGlobal = g; g.global = g;
  // WeChat's instantiate accepts a package filename; native browsers require bytes.
  const wasmHost = Object.create(g.WebAssembly);
  wasmHost.instantiate = async function (input, imports) {
    if (typeof input === 'string') {
      const response = await nativeFetch(localURL(input));
      if (!response.ok) throw new Error('Missing local WASM: ' + input);
      input = await response.arrayBuffer();
    }
    return g.WebAssembly.instantiate(input, imports);
  };
  g.CCWebAssembly = g.WXWebAssembly = wasmHost;
  const listeners = new Map();
  function on(name, cb) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(cb); }
  function off(name, cb) { if (cb) listeners.get(name)?.delete(cb); else listeners.delete(name); }
  function emit(name, event) { for (const cb of listeners.get(name) || []) cb(event); }
  function info() { return {brand: 'local', model: iosDevice?'iPhone/iPad':'Browser', platform: iosDevice?'ios':androidDevice?'android':'windows', system: iosDevice?'iOS':androidDevice?'Android':'Windows 10', SDKVersion: '3.10.0', version: '8.0.60', language: navigator.language || 'zh_CN', pixelRatio: renderPixelRatio, devicePixelRatio:renderPixelRatio, screenWidth: innerWidth, screenHeight: innerHeight, windowWidth: innerWidth, windowHeight: innerHeight, statusBarHeight: 0, benchmarkLevel: 50, deviceOrientation: innerWidth > innerHeight ? 'landscape' : 'portrait', safeArea: {left:0, top:0, right:innerWidth, bottom:innerHeight, width:innerWidth, height:innerHeight}}; }
  function media(kind) {
    const el = document.createElement(kind), api = {destroy: () => { el.pause(); el.removeAttribute('src'); el.load(); }, play: () => el.play().catch(e => emit('audioError', e)), pause: () => el.pause(), stop: () => { el.pause(); el.currentTime = 0; }, seek: n => { el.currentTime = n; }};
    for (const key of ['src','autoplay','loop','volume','muted','currentTime','duration','paused','playbackRate']) Object.defineProperty(api, key, {get: () => el[key], set: v => { el[key] = key === 'src' ? localURL(v) : v; }});
    for (const [name,event] of Object.entries({Canplay:'canplay',Play:'play',Pause:'pause',Stop:'emptied',Ended:'ended',Error:'error',TimeUpdate:'timeupdate',Waiting:'waiting',Seeking:'seeking',Seeked:'seeked'})) { const map = new Map(); api['on'+name] = cb => { const fn = () => cb({duration:el.duration, position:el.currentTime}); map.set(cb,fn); el.addEventListener(event,fn); }; api['off'+name] = cb => { for (const [key,fn] of map) if (!cb || key === cb) {el.removeEventListener(event,fn); map.delete(key);} }; }
    return api;
  }
  const wx = g.wx = {
    env: {USER_DATA_PATH: '/user'}, getSystemInfoSync: info, getWindowInfo: info, getDeviceInfo: info, getAppBaseInfo: info,
    getSystemInfo(opts) { done(opts, info()); }, getFileSystemManager: () => fs,
    createCanvas: () => document.createElement('canvas'), createOffscreenCanvas: o => new OffscreenCanvas(o?.width || 1, o?.height || 1),
    createImage: () => new NativeImage(), createInnerAudioContext: () => g.LocalAudio?g.LocalAudio.create({read:readBytesAsync,localURL,media:()=>media('audio')}):media('audio'),
    createWebAudioContext: () => new (g.AudioContext || g.webkitAudioContext)(),
    getStorageSync(key) { const val=localStorage.getItem('yqzd-wx:'+key); return val == null ? '' : JSON.parse(val); },
    setStorageSync(key,value) { localStorage.setItem('yqzd-wx:'+key, JSON.stringify(value)); },
    removeStorageSync(key) { localStorage.removeItem('yqzd-wx:'+key); },
    clearStorageSync() { for (const key of Object.keys(localStorage)) if (key.startsWith('yqzd-wx:')) localStorage.removeItem(key); },
    getStorageInfoSync: () => ({keys:Object.keys(localStorage).filter(k=>k.startsWith('yqzd-wx:')).map(k=>k.slice(8)), currentSize:0, limitSize:5120}),
    request(opts) {
      const controller = new AbortController();
      Promise.resolve().then(() => g.fetch(opts.url, {method:opts.method || 'GET',headers:opts.header,body:opts.data == null ? undefined : typeof opts.data === 'string' ? opts.data : JSON.stringify(opts.data),signal:controller.signal})).then(async r => {let data=opts.responseType==='arraybuffer'?await r.arrayBuffer():await r.text(); if(opts.dataType!=='text' && typeof data==='string')try{data=JSON.parse(data);}catch{} done(opts,{data,statusCode:r.status,header:Object.fromEntries(r.headers)});}).catch(e=>fail(opts,e));
      return {abort:()=>controller.abort(),onHeadersReceived(){},offHeadersReceived(){}};
    },
    downloadFile(opts) {
      const controller=new AbortController(), progress=[];
      readBytesAsync(opts.url,controller.signal).then(bytes=>{const path=opts.filePath || localURL(opts.url);if(opts.filePath)writeBytes(path,bytes);for(const cb of progress)cb({progress:100,totalBytesWritten:bytes.length,totalBytesExpectedToWrite:bytes.length});done(opts,{statusCode:200,tempFilePath:path,filePath:path}); }).catch(e=>fail(opts,e));
      return {abort:()=>controller.abort(),onProgressUpdate:cb=>progress.push(cb),offProgressUpdate(){}};
    },
    saveFile(opts) { fs.copyFile({...opts,srcPath:opts.tempFilePath,destPath:opts.filePath}); },
    loadSubpackage(opts) { Promise.resolve().then(()=>{ requireLocal('/source/subpackages/'+opts.name+'/game.js');done(opts); }).catch(e=>fail(opts,e)); return {onProgressUpdate(cb){cb({progress:100});}}; },
    loadFont(path) { const family='LocalGameFont'+Math.random().toString(16).slice(2);const face=new FontFace(family,'url('+JSON.stringify(localURL(path))+')');face.load().then(f=>document.fonts.add(f)).catch(console.error);return family; },
    getLaunchOptionsSync: () => ({scene:1001,query:{},referrerInfo:{}}), getEnterOptionsSync:()=>({scene:1001,query:{}}),
    canIUse: () => false, getNetworkType: opts => done(opts,{networkType:'wifi'}),
    getOpenDataContext:()=>({postMessage(){},canvas:document.createElement('canvas')}),getSharedCanvas:()=>canvas,
    setPreferredFramesPerSecond(){},setKeepScreenOn(opts){done(opts);},setInnerAudioOption(opts){done(opts);},triggerGC(){},
    showToast(opts){status(opts.title || '');done(opts);},showLoading(opts){status(opts.title || 'Loading…');},hideLoading(){},
    showModal(opts){done(opts,{confirm:confirm((opts.title||'')+'\n'+(opts.content||'')),cancel:false});},
    showKeyboard(opts){const value=prompt('输入',opts.defaultValue||'');if(value!=null){emit('KeyboardInput',{value});emit('KeyboardConfirm',{value});}emit('KeyboardComplete',{value:value||''});done(opts);},hideKeyboard(opts){done(opts||{});},updateKeyboard(){},
    startAccelerometer(opts){done(opts||{});},stopAccelerometer(opts){done(opts||{});},
    vibrateShort(opts){navigator.vibrate?.(20);done(opts||{});},vibrateLong(opts){navigator.vibrate?.(100);done(opts||{});},
    showShareMenu(opts){done(opts||{});},hideShareMenu(opts){done(opts||{});},setEnableDebug(opts){done(opts||{});},getMenuButtonBoundingClientRect:()=>({left:innerWidth-90,right:innerWidth-10,top:8,bottom:40,width:80,height:32})
  };
  for (const name of ['TouchStart','TouchMove','TouchEnd','TouchCancel','MouseDown','MouseMove','MouseUp','Wheel','KeyDown','KeyUp','WindowResize','Show','Hide','Error','UnhandledRejection','NetworkStatusChange','AudioInterruptionBegin','AudioInterruptionEnd','DeviceOrientationChange','AccelerometerChange','KeyboardInput','KeyboardConfirm','KeyboardComplete','Message','MemoryWarning']) { wx['on'+name]=cb=>on(name,cb);wx['off'+name]=cb=>off(name,cb); }
  for (const [native,name] of [['touchstart','TouchStart'],['touchmove','TouchMove'],['touchend','TouchEnd'],['touchcancel','TouchCancel']]) canvas.addEventListener(native,e=>{e.preventDefault(); const point=t=>({identifier:t.identifier,clientX:t.clientX,clientY:t.clientY,pageX:t.pageX,pageY:t.pageY,force:t.force});emit(name,{type:native,touches:Array.from(e.touches,point),changedTouches:Array.from(e.changedTouches,point),timeStamp:e.timeStamp});},{passive:false});
  for (const [native,name] of [['mousedown','MouseDown'],['mousemove','MouseMove'],['mouseup','MouseUp'],['wheel','Wheel']]) canvas.addEventListener(native,e=>emit(name,{x:e.clientX,y:e.clientY,clientX:e.clientX,clientY:e.clientY,button:e.button,buttons:e.buttons,deltaX:e.deltaX,deltaY:e.deltaY}));
  for (const [native,name] of [['keydown','KeyDown'],['keyup','KeyUp']]) addEventListener(native,e=>emit(name,{key:e.key,code:e.code,keyCode:e.keyCode}));
  addEventListener('resize',()=>emit('WindowResize',info()));document.addEventListener('visibilitychange',()=>emit(document.hidden?'Hide':'Show',{}));
  addEventListener('error',e=>{status('启动中断：'+e.message);emit('Error',e.message);});addEventListener('unhandledrejection',e=>{status('启动中断：'+e.reason);emit('UnhandledRejection',{reason:e.reason});});
  g.__globalAdapter = {...wx,isSubContext:false,isDevTool:false,adaptSys(){},adaptView(){},adaptContainer(){}};
  g.fsUtils = {
    fs, getUserDataPath:()=>'/user',checkFsValid:()=>true,isOutOfStorage:e=>/quota/i.test(e),
    readFile:(p,e,cb)=>fs.readFile({filePath:p,encoding:e,success:r=>cb(null,r.data),fail:r=>cb(new Error(r.errMsg))}),
    readText:(p,cb)=>g.fsUtils.readFile(p,'utf8',cb),readArrayBuffer:(p,cb)=>g.fsUtils.readFile(p,'',cb),
    readJson:(p,cb)=>g.fsUtils.readText(p,(e,t)=>{if(e)return cb(e);try{cb(null,JSON.parse(t));}catch(e){cb(e);}}),
    readJsonSync(p){try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){return e;}},
    writeFileSync(p,d,e){try{writeBytes(p,d,e);return null;}catch(e){return e;}},
    writeFile:(p,d,e,cb)=>fs.writeFile({filePath:p,data:d,encoding:e,success:()=>cb?.(null),fail:r=>cb?.(new Error(r.errMsg))}),
    makeDirSync(p){try{fs.mkdirSync(p);return null;}catch(e){return e;}},rmdirSync:(p)=>new Error('Cache deletion disabled'),
    exists:(p,cb)=>fs.access({path:p,success:()=>cb(true),fail:()=>cb(false)}),
    copyFile:(s,d,cb)=>fs.copyFile({srcPath:s,destPath:d,success:()=>cb?.(null),fail:r=>cb?.(new Error(r.errMsg))}),
    deleteFile:(p,cb)=>fs.unlink({filePath:p,success:()=>cb?.(null),fail:r=>cb?.(new Error(r.errMsg))}),
    downloadFile:(url,path,header,progress,cb)=>{const task=wx.downloadFile({url,filePath:path,header,success:r=>cb?.(null,r.filePath||r.tempFilePath),fail:r=>cb?.(new Error(r.errMsg))});if(progress)task.onProgressUpdate(progress);return task;},
    saveFile:(s,d,cb)=>g.fsUtils.copyFile(s,d,cb),loadSubpackage:(name,progress,cb)=>wx.loadSubpackage({name,success:()=>cb?.(null),fail:r=>cb?.(new Error(r.errMsg))}),
    unzip:(s,d,cb)=>cb(new Error('ZIP assets must be extracted before launch'))
  };
  function resolveModule(spec,parent) {
    if(spec.startsWith('//src/'))spec='/source/'+spec.slice(2);
    if(spec.startsWith('@babel/'))spec='/source/'+spec;
    else if(!spec.startsWith('.')&&!spec.startsWith('/')&&!/^[a-z]+:/.test(spec))spec='/source/'+spec;
    let url = new URL(spec,parent || origin+'/source/game.js');
    if(url.origin!==origin)throw new Error('External module rejected: '+spec);
    if(!/\.(js|json)$/.test(url.pathname))url.pathname+='.js';
    return localURL(url.href);
  }
  function requireLocal(spec,parent) {
    const url=resolveModule(spec,parent),path=new URL(url).pathname;
    if(path.endsWith('/web-adapter.b8331.js'))return {};
    if(path.endsWith('/hortor/sdk.js')||path.endsWith('/hortor/HSDK.wx.min.js'))return g.HSDK||{};
    if(path.endsWith('/getPlugin.e750e.js'))return {};
    if(path.endsWith('/hortor/load-manifest.js')){g.loadManifest=()=>Promise.resolve(null);return {};}
    if(cache.has(url))return cache.get(url).exports;
    const module={exports:{}};cache.set(url,module);
    try {
      const source=new TextDecoder().decode(readBytes(url));
      if(path.endsWith('.json'))module.exports=JSON.parse(source);
      else new Function('require','module','exports','__filename','__dirname',source+'\n//# sourceURL='+url)(s=>requireLocal(s,url),module,module.exports,path,path.slice(0,path.lastIndexOf('/')));
      if(path.endsWith('/engine-adapter.5d553.js')) {
        g.System.import('cc').then(cc=>{
          const manager=cc.assetManager.cacheManager;manager.cacheEnabled=false;manager.autoClear=false;manager.clearLRU=()=>{};
          // 仅缓存重复的 UI 光效；战斗角色、技能和挂点动画继续按原逻辑更新。
          const names=new Set(['ui_tianshu_jueixng_guang','ui_tianshu_jueixng_guang_2','ui_zidong_anniu']);
          const proto=cc.sp.Skeleton.prototype,onEnable=proto.onEnable;
          const stats=g.LocalRender={uiSpineCache:1,prepared:0};
          proto.onEnable=function(){
            if(names.has(this.skeletonData?.name)&&!this.customMaterial&&!this.sockets.length){
              const mode=cc.sp.Skeleton.AnimationCacheMode.SHARED_CACHE;
              if(this._cacheMode!==mode){this.setAnimationCacheMode(mode);stats.prepared++;}
            }
            return onEnable.call(this);
          };
        });
      }
      if(path.endsWith('/hortor/env.js')) {Object.assign(g.env,{APP_CDN:localURL('/source'),APP_CDNS:[localURL('/source')],APP_SERVER:localURL('/local'),APP_SERVER_AUDIT:localURL('/local'),APP_MANIFEST_URL:'local/manifest'});g.LocalWX.afterEnv?.(g.env);}
      return module.exports;
    }catch(e){cache.delete(url);throw e;}
  }
  g.require = requireLocal;g.hortorRequire=s=>requireLocal(s);g.__wxRequire=requireLocal;
  g.LocalWX = {localURL,require:requireLocal,fs,wx,status,cache,beforeBoot:null,afterEnv:null,
    async boot(){
      status('正在加载游戏代码…');this.beforeBoot?.();
      try{
        const response=await nativeFetch(localURL('/source-preload.json')+'?v='+(g.LOCAL_GAME_REVISION||'local'));
        if(!response.ok)throw new Error('代码清单加载失败');
        const files=await response.json();let cursor=0,loaded=0;
        // 提前并发读取代码，原同步 require 执行时只访问内存，避免网络卡住触控。
        await Promise.all(Array.from({length:6},async()=>{while(cursor<files.length){const path=files[cursor++];await readBytesAsync('/'+path);loaded++;status('正在加载游戏代码 '+loaded+'/'+files.length+'…');}}));
        status('正在启动本地游戏…');requireLocal('/source/game.js');
      }catch(e){console.error(e);status('启动中断：'+e.message);throw e;}
    }
  };
})(globalThis);
