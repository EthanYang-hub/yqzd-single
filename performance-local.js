/* 可选手机性能记录：只保存诊断计数，不读取或导出角色存档，不上传。 */
(function(){
  'use strict';
  const ENABLED='yqzd.performance.enabled.v1',DB='yqzd-performance-v1',TAIL='yqzd.performance.tail.v1';
  const MAX_SAMPLES=1200,MAX_EVENTS=200,MAX_SESSIONS=2;
  const panel=document.getElementById('local-tools'),section=document.createElement('section');
  section.style.cssText='border-top:1px solid #809180;margin-top:8px;padding-top:8px;max-width:270px';
  section.innerHTML='<strong>手机性能日志</strong><p style="margin:6px 0">卡顿时开启，正常玩几分钟，再导出日志发给我。仅保存在此浏览器，不会上传存档。</p><p style="margin:6px 0"><button type="button">开始记录</button> <button type="button" disabled>标记刚才卡顿</button></p><p style="margin:6px 0"><button type="button">导出性能日志</button> <button type="button">清除日志</button></p><div role="status">性能记录未开启</div><small>每15秒保存，重开会继续记录。每次保留最近20分钟，最多保留两次记录。</small>';
  panel.append(section);
  const [toggle,markButton,exportButton,clearButton]=section.querySelectorAll('button'),status=section.querySelector('[role=status]');
  const state={enabled:false,samples:0,last:null,storage:'pending',message:''};
  let sessions=[],current=null,cc,manager,contextClass,enginePending,dbPromise,raf=0,timer=0,saveTimer=0;
  let frameTimes=[],frameAt=0,drawPeak=0,windowAt=0,observers=[],hooks=[],world=null,starting;
  const costs={engine:{ms:0,max:0,calls:0},battle:{ms:0,max:0,calls:0},render:{ms:0,max:0,calls:0}};
  const round=n=>Number.isFinite(n)?Math.round(n*100)/100:null;
  const trim=(items,limit)=>{if(items.length>limit)items.splice(0,items.length-limit);};
  const storageFlag=value=>{try{localStorage.setItem(ENABLED,value?'1':'0');}catch{}};
  function pathOnly(value){try{const u=new URL(value,location.href);return u.origin===location.origin?u.pathname:'[external resource]';}catch{return '[unknown resource]';}}
  function safeText(value){return String(value??'').replace(/https?:\/\/[^\s)]+/g,pathOnly).slice(0,700);}
  function event(type,values={}){if(!state.enabled||!current)return;current.events.push({at:Date.now(),type,...values});trim(current.events,MAX_EVENTS);}
  function metadata(){return{revision:globalThis.LOCAL_GAME_REVISION||'local',userAgent:navigator.userAgent,
    dpr:devicePixelRatio,viewport:[innerWidth,innerHeight],canvas:canvasSize(),standalone:!!navigator.standalone,
    capabilities:{longtask:!!globalThis.PerformanceObserver?.supportedEntryTypes?.includes('longtask'),
      resource:!!globalThis.PerformanceObserver?.supportedEntryTypes?.includes('resource'),
      jsHeap:!!performance.memory,indexedDB:!!globalThis.indexedDB},
    recording:{sampleIntervalMs:1000,persistIntervalMs:15000,maxSamples:MAX_SAMPLES,maxSessions:MAX_SESSIONS},
    limits:['Frame gaps do not identify a CPU/GPU/thermal cause by themselves.','JS heap excludes GPU textures and is unavailable in many Safari versions.']};}
  function canvasSize(){const c=document.getElementById('GameCanvas');return c?[c.width,c.height]:null;}
  function database(){
    if(!dbPromise)dbPromise=new Promise((resolve,reject)=>{
      if(!globalThis.indexedDB)return reject(new Error('当前浏览器无法保存性能日志'));
      const req=indexedDB.open(DB,1);
      req.onupgradeneeded=()=>req.result.createObjectStore('logs');
      req.onsuccess=()=>{const db=req.result;db.onversionchange=()=>db.close();resolve(db);};
      req.onerror=()=>reject(req.error);req.onblocked=()=>reject(new Error('性能日志存储正被占用'));
    });return dbPromise;
  }
  function paint(){
    toggle.textContent=state.enabled?'停止记录':'开始记录';markButton.disabled=!state.enabled;
    if(!panel.open)return;
    const row=state.last;
    status.textContent=state.message||(state.enabled?('记录中 · '+state.samples+'秒'+(row?' · '+row.fps+'帧/秒 · 最慢帧 '+row.maxFrameMs+'ms':'')+(state.storage==='error'?' · 仅本次页面内保存，请及时导出':'')):'性能记录未开启，可导出已有日志');
  }
  const ready=database().then(db=>new Promise((resolve,reject)=>{
    const req=db.transaction('logs').objectStore('logs').get('recent');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  })).then(data=>{
    if(data?.format===1&&Array.isArray(data.sessions))sessions=data.sessions.filter(x=>x&&Array.isArray(x.samples)&&Array.isArray(x.events)).slice(-MAX_SESSIONS);
    sessions.forEach(s=>{trim(s.samples,MAX_SAMPLES);trim(s.events,MAX_EVENTS);});state.storage='ready';
  }).catch(()=>{state.storage='error';}).then(()=>{
    // Safari 退出页面时异步数据库事务可能中止，用少量同步尾记录补回最后几秒。
    try{const data=JSON.parse(localStorage.getItem(TAIL)||'null'),tail=data?.session;
      if(data?.format!==1||!tail?.id||!Array.isArray(tail.samples)||!Array.isArray(tail.events))return;
      const found=sessions.find(s=>s.id===tail.id);
      if(found){found.samples=[...new Map([...found.samples,...tail.samples].map(x=>[x.at,x])).values()].sort((a,b)=>a.at-b.at);found.events=[...new Map([...found.events,...tail.events].map(x=>[JSON.stringify(x),x])).values()].sort((a,b)=>a.at-b.at);trim(found.samples,MAX_SAMPLES);trim(found.events,MAX_EVENTS);}
      else{sessions.push(tail);trim(sessions,MAX_SESSIONS);}
    }catch{}
  });
  function stashTail(){
    if(!current)return;
    try{localStorage.setItem(TAIL,JSON.stringify({format:1,session:{id:current.id,startedAt:current.startedAt,stoppedAt:current.stoppedAt,environment:current.environment,samples:current.samples.slice(-8),events:current.events.slice(-12)}}));}catch{}
  }
  let saving=false,saveAgain=false;
  async function persist(){
    if(saving){saveAgain=true;return;}
    saving=true;
    try{
      await ready;const db=await database(),begin=performance.now();let submitMs=0;
      await new Promise((resolve,reject)=>{const tx=db.transaction('logs','readwrite'),submitAt=performance.now();tx.objectStore('logs').put({format:1,sessions},'recent');submitMs=performance.now()-submitAt;tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
      event('log-save',{elapsedMs:round(performance.now()-begin),submitMs:round(submitMs)});
      state.storage='ready';
    }catch{state.storage='error';}
    finally{saving=false;if(saveAgain){saveAgain=false;void persist();}paint();}
  }
  function hook(object,key,cost){
    if(!object||typeof object[key]!=='function')return;
    const original=object[key],own=Object.prototype.hasOwnProperty.call(object,key);
    const wrapper=function(...args){const t=performance.now();try{return original.apply(this,args);}finally{const ms=performance.now()-t;cost.ms+=ms;cost.calls++;cost.max=Math.max(cost.max,ms);}};
    object[key]=wrapper;hooks.push(()=>{if(object[key]===wrapper){if(own)object[key]=original;else delete object[key];}});
  }
  function unhook(){hooks.forEach(fn=>fn());hooks=[];world=null;}
  async function attachEngine(){
    if(cc||enginePending||!globalThis.localGame?.state.ready)return;
    enginePending=true;
    try{const modules=await Promise.all([System.import('cc'),System.import('chunks:///_virtual/battle-manager.ts'),System.import('chunks:///_virtual/comp-battle-context.ts')]);
      cc=modules[0];manager=modules[1].BattleManager.ins;contextClass=modules[2].CompBattleContext;
    }catch(error){event('engine-monitor-unavailable',{message:safeText(error.message)});}
    finally{enginePending=false;}
  }
  function frame(at){
    if(!state.enabled)return;
    if(!document.hidden){if(frameAt)frameTimes.push(at-frameAt);frameAt=at;drawPeak=Math.max(drawPeak,cc?.director.root?.device?.numDrawCalls||0);}
    else frameAt=0;
    raf=requestAnimationFrame(frame);
  }
  function sample(){
    if(!state.enabled||!current)return;
    const begin=performance.now(),elapsed=begin-windowAt;
    if(elapsed<250)return;
    windowAt=begin;
    if(document.hidden){frameTimes=[];return;}
    void attachEngine();
    if(cc&&!hooks.length){hook(cc.director,'tick',costs.engine);hook(cc.director.root,'frameMove',costs.render);}
    const next=manager?.getCurrentBattleForDebug?.()||null;
    if(next!==world){unhook();world=next||null;hook(cc?.director,'tick',costs.engine);hook(cc?.director.root,'frameMove',costs.render);hook(world,'update',costs.battle);event(world?'battle-enter':'battle-leave',{stage:world?.options?.battleData?.stageId||null});}
    const times=frameTimes.sort((a,b)=>a-b);frameTimes=[];
    const ctx=world?.sceneEntity?.getComponent(contextClass),device=cc?.director.root?.device;
    const row={at:Date.now(),elapsedMs:round(elapsed),fps:round(times.length*1000/elapsed),
      p50FrameMs:round(times[Math.floor(times.length*.5)]),p95FrameMs:round(times[Math.floor(times.length*.95)]),maxFrameMs:round(times.at(-1)),
      framesOver33ms:times.filter(t=>t>33.4).length,framesOver50ms:times.filter(t=>t>50).length,
      stage:world?.options?.battleData?.stageId||null,tick:world?.battleTime?.battleTick??null,battleState:world?.battleState?.curState??null,speed:world?.battleTime?.timeScale??null,
      enemies:ctx?.awakenedEnemies.length??null,bullets:ctx?.awakenedBullets.length??null,effects:ctx?.awakenedEffects.length??null,
      drawCallsPeak:drawPeak,triangles:device?.numTris??null,jsHeapBytes:performance.memory?.usedJSHeapSize??null,
      textureBytes:device?.memoryStatus?.textureSize??null,canvas:canvasSize(),
      engineMs:round(costs.engine.ms),engineMaxMs:round(costs.engine.max),audio:globalThis.LocalAudio?.getStats()||null,
      battleMs:round(costs.battle.ms),battleMaxMs:round(costs.battle.max),renderMs:round(costs.render.ms),renderMaxMs:round(costs.render.max),recorderMs:round(performance.now()-begin)};
    drawPeak=0;Object.values(costs).forEach(c=>{c.ms=c.max=c.calls=0;});
    current.samples.push(row);trim(current.samples,MAX_SAMPLES);state.samples=current.samples.length;state.last=row;
    if(row.maxFrameMs>100)event('frame-gap',{ms:row.maxFrameMs,stage:row.stage,tick:row.tick});paint();
  }
  function observe(type,callback){
    if(!globalThis.PerformanceObserver?.supportedEntryTypes?.includes(type))return;
    try{const obs=new PerformanceObserver(list=>{if(state.enabled)list.getEntries().forEach(callback);});obs.observe({entryTypes:[type]});observers.push(obs);}catch{}
  }
  async function start(){
    if(state.enabled)return;if(starting)return starting;
    starting=(async()=>{await ready;current={id:Date.now()+'-'+Math.random().toString(16).slice(2,8),startedAt:Date.now(),environment:metadata(),samples:[],events:[]};sessions.push(current);trim(sessions,MAX_SESSIONS);
      state.enabled=true;state.message='';state.samples=0;state.last=null;storageFlag(true);frameAt=0;windowAt=performance.now();frameTimes=[];drawPeak=0;Object.values(costs).forEach(c=>{c.ms=c.max=c.calls=0;});
      event('start');observe('longtask',e=>event('longtask',{durationMs:round(e.duration)}));
      observe('resource',e=>{if(e.duration>1500||e.responseStatus>=400)event('resource',{path:pathOnly(e.name),durationMs:round(e.duration),status:e.responseStatus??null,transferBytes:e.transferSize??null});});
      raf=requestAnimationFrame(frame);timer=setInterval(sample,1000);saveTimer=setInterval(persist,15000);void persist();paint();})();
    try{await starting;}finally{starting=null;}
  }
  async function stop(){
    if(starting)await starting;if(!state.enabled)return;
    sample();event('stop');current.stoppedAt=Date.now();state.enabled=false;storageFlag(false);cancelAnimationFrame(raf);clearInterval(timer);clearInterval(saveTimer);observers.forEach(o=>o.disconnect());observers=[];unhook();state.message='记录已停止，可以导出日志';paint();await persist();
  }
  function mark(){event('user-mark',{message:'玩家标记刚才出现卡顿'});state.message='已标记刚才卡顿';paint();void persist();setTimeout(()=>{state.message='';paint();},2000);}
  function snapshot(){return{format:1,kind:'yqzd-performance-log',exportedAt:Date.now(),sessions};}
  async function exportLog(){
    await ready;if(!sessions.length){state.message='还没有日志，请先开始记录';paint();return;}
    const name='遗弃之地-性能日志-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json',blob=new Blob([JSON.stringify(snapshot())],{type:'application/json'});
    try{if(typeof File==='function'&&navigator.canShare&&navigator.share){const file=new File([blob],name,{type:'application/json'});if(navigator.canShare({files:[file]})){await navigator.share({files:[file],title:'游戏性能日志'});return;}}}
    catch(error){if(error.name==='AbortError')return;}
    const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  async function clear(){await stop();await ready;sessions=[];current=null;try{localStorage.removeItem(TAIL);}catch{}state.samples=0;state.last=null;state.message='性能日志已清除，角色存档保留';await persist();paint();}
  toggle.onclick=()=>state.enabled?void stop():void start();markButton.onclick=mark;exportButton.onclick=exportLog;clearButton.onclick=clear;
  panel.addEventListener('toggle',paint);
  document.addEventListener('visibilitychange',()=>{event('visibility',{hidden:document.hidden});frameAt=0;frameTimes=[];windowAt=performance.now();if(document.hidden){stashTail();void persist();}});
  addEventListener('pagehide',()=>{event('pagehide');stashTail();void persist();});
  addEventListener('pageshow',e=>event('pageshow',{restored:!!e.persisted}));
  addEventListener('error',e=>{const target=e.target;if(target&&target!==window)event('resource-error',{path:pathOnly(target.src||target.href||''),tag:target.tagName});else event('error',{message:safeText(e.message),path:pathOnly(e.filename||''),line:e.lineno,stack:safeText(e.error?.stack)});},true);
  addEventListener('unhandledrejection',e=>event('unhandledrejection',{message:safeText(e.reason?.message||e.reason),stack:safeText(e.reason?.stack)}));
  addEventListener('webglcontextlost',()=>event('webglcontextlost'),true);addEventListener('webglcontextrestored',()=>event('webglcontextrestored'),true);
  globalThis.localPerformanceLogs={state,start,stop,mark,exportLog,clear,getSnapshot:snapshot,
    resourceFailure:(url,error)=>event('resource-error',{path:pathOnly(url),message:safeText(error?.message||error)})};
  ready.then(()=>{let enabled=false;try{enabled=localStorage.getItem(ENABLED)==='1';}catch{}if(enabled)void start();else paint();});
})();
