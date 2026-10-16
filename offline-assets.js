/* 按需缓存及完整资源下载；角色存档由原存档工具单独保存。 */
(function(){
  'use strict';
  const base=new URL('../',document.baseURI),revision=globalThis.LOCAL_GAME_REVISION;
  const publicCache='yqzd-public-assets-v1',siteCache='yqzd-site-'+encodeURIComponent(base.pathname)+'-'+revision;
  const panel=document.getElementById('local-tools');
  panel.style.maxHeight='calc(100vh - 24px)';panel.style.overflowY='auto';
  const section=document.createElement('section');section.style.cssText='border-top:1px solid #809180;margin-top:8px;padding-top:8px;max-width:270px';
  section.innerHTML='<strong>离线资源</strong><p style="margin:6px 0">完整下载一次，之后优先从手机缓存读取。建议使用 Wi-Fi。</p><progress style="width:100%" max="1" value="0"></progress><div role="status">正在读取资源清单…</div><p style="margin:6px 0"><button type="button">下载全部资源</button> <button type="button" disabled>暂停</button></p><small>系统可能清理网页缓存；角色进度请另行导出备份。</small>';
  panel.append(section);
  const progress=section.querySelector('progress'),label=section.querySelector('[role=status]'),[start,pause]=section.querySelectorAll('button');
  const state={running:false,pausing:false,total:0,downloaded:0,totalBytes:0,downloadedBytes:0,error:null,complete:false};
  let manifest,manifestPromise,cachesPromise,workerReady;
  const mb=bytes=>(bytes/1048576).toFixed(1)+' MiB';
  const target=item=>new URL(item.path,base).href;
  const bucket=item=>item.path.startsWith('cdn/')?publicCache:siteCache;
  function display(message){progress.value=state.total?state.downloaded/state.total:0;label.textContent=message||('已缓存 '+state.downloaded+'/'+state.total+' 个文件（'+mb(state.downloadedBytes)+'/'+mb(state.totalBytes)+'）');}
  async function loadManifest(){
    if(!manifestPromise)manifestPromise=fetch(new URL('offline-assets.json?v='+revision,base)).then(r=>{if(!r.ok)throw new Error('资源清单加载失败');return r.json();}).then(data=>{
      if(data.revision!==revision||!Array.isArray(data.files))throw new Error('网页版本已更新，请退出战斗后刷新');
      manifest=data;state.total=data.files.length;state.totalBytes=data.totalBytes;return data;
    }).catch(e=>{manifestPromise=null;throw e;});
    return manifestPromise;
  }
  async function openedCaches(){return cachesPromise||(cachesPromise=Promise.all([caches.open(publicCache),caches.open(siteCache)]).then(([assets,site])=>new Map([[publicCache,assets],[siteCache,site]])));}
  async function scan(){
    await loadManifest();const stores=await openedCaches(),known=new Map();
    await Promise.all(Array.from(stores,async([name,store])=>known.set(name,new Set((await store.keys()).map(r=>r.url)))));
    const missing=[];state.downloaded=0;state.downloadedBytes=0;
    for(const item of manifest.files){if(known.get(bucket(item)).has(target(item))){state.downloaded++;state.downloadedBytes+=item.bytes;}else missing.push(item);}
    state.complete=!missing.length;display();return missing;
  }
  function errorText(error){return error?.name==='QuotaExceededError'?'网页存储空间不足，已下载的资源仍保留，可腾出空间后继续。':error?.message==='Failed to fetch'?'下载暂时中断，已缓存资源保留，可继续下载。':(error?.message||String(error));}
  async function downloadAll(){
    if(state.running)return;
    state.running=true;state.pausing=false;state.error=null;start.disabled=true;pause.disabled=false;
    try{
      if(!('serviceWorker' in navigator)||!globalThis.caches)throw new Error('当前浏览器不支持离线资源，请用 Safari 打开 HTTPS 网页');
      await workerReady;
      const missing=await scan(),stores=await openedCaches();
      if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});
      if(navigator.storage?.estimate){const storage=await navigator.storage.estimate();if(storage.quota&&storage.quota-(storage.usage||0)<state.totalBytes-state.downloadedBytes)throw new Error('网页存储空间不足，需要再容纳约 '+mb(state.totalBytes-state.downloadedBytes)+' 的资源');}
      let cursor=0,failure=null;
      // 不把完整资源装进 JS 内存；逐个响应直接写入浏览器磁盘缓存。
      await Promise.all(Array.from({length:3},async()=>{while(!state.pausing&&!failure&&cursor<missing.length){
        const item=missing[cursor++],url=target(item);
        try{let response;for(let attempt=0;attempt<3;attempt++){try{response=await fetch(url);if(!response.ok)throw new Error('资源下载失败（'+response.status+'），可点击继续重试');break;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,400*(attempt+1)));}}await stores.get(bucket(item)).put(url,response);state.downloaded++;state.downloadedBytes+=item.bytes;display();}
        catch(error){failure=error;}
      }}));
      if(failure)throw failure;
      state.complete=state.downloaded===state.total;
      display(state.complete?'全部资源已缓存，可离线打开。':('已暂停，保留 '+state.downloaded+'/'+state.total+' 个文件，可继续下载。'));
    }catch(error){state.error=errorText(error);display(state.error);}
    finally{state.running=false;start.disabled=false;pause.disabled=true;pause.textContent='暂停';start.textContent=state.complete?'检查完整资源':'继续下载';}
  }
  start.onclick=downloadAll;
  pause.onclick=()=>{state.pausing=true;pause.disabled=true;pause.textContent='正在暂停…';};
  // 仅暴露状态，便于核对缓存完整性；不会导出角色数据。
  globalThis.localOfflineAssets={state,scan,downloadAll,pause:()=>{state.pausing=true;}};
  if('serviceWorker' in navigator&&globalThis.caches){
    workerReady=navigator.serviceWorker.register(new URL('sw-local.js?v='+revision,base),{scope:base.pathname,updateViaCache:'none'}).then(async registration=>{
      const worker=registration.installing||registration.waiting;
      if(worker&&worker.state!=='activated')await new Promise((resolve,reject)=>{
        const changed=()=>{if(worker.state==='activated')resolve();else if(worker.state==='redundant')reject(new Error('离线支持更新失败，请联网刷新后重试'));};
        worker.addEventListener('statechange',changed);changed();
      });
      return navigator.serviceWorker.ready;
    });
    workerReady.then(()=>scan()).catch(error=>display(errorText(error)));
  }else{start.disabled=true;display('当前浏览器不支持离线缓存，请用 Safari 打开 HTTPS 网页');}
})();
