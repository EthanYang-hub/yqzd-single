/* 高频战斗音效共享解码和混音；背景音乐、教学语音继续流式播放。 */
(function(g){
  'use strict';
  // 当前客户端 audio/config.d92c7.json 中的背景音乐与教学语音 UUID。
  const STREAM_IDS=["13c8e806-5bca-43c8-86dd-dba809035a30","156ea089-5afd-4025-825f-b10b72dad4ba","166d0d84-c82f-4926-9f92-f11be47885dd","207dc48f-baec-43cb-9a16-87df69245c83","32f09c3f-2220-475b-beb7-7c663ba58726","4f5cbf25-82c5-4551-a178-18e0ba87f7f7","516c1b2f-70a8-4a83-b6ba-60bc705a3b66","5502929f-d2a5-4a37-ab80-ea689cf5a64c","5d60c920-752f-4920-bd05-a2ee58025427","68e52768-de8c-41d0-ae41-9fea61778f88","7cf24203-5696-4575-87e3-47d74a6841b7","843e370f-502c-46a6-b7bf-b34e9214e4ae","8ead31e7-bdad-451d-8d7c-04e194bbfcf1","9150536f-e995-4ddd-b29e-ab79965f33e4","9267bb39-48ce-45ec-973c-a3680d961fce","975a8186-cc81-4b7f-b7d8-3bf8bea88561","9e2cc82c-5c48-40e7-939b-32b9336f29f2","a145233a-63b4-4203-8897-ea8078902244","a9f71e99-a8c3-49c8-b340-fcc36c5e0941","b530ec72-600a-469f-8132-1048583f3dbf","bb008112-80e9-4f11-8d97-6a5ff4a2a825","bbb2d9aa-aae4-4956-ab70-70463d0db26f","c573783a-57de-4331-a02e-89ec769a2c27","cacc043d-4435-4031-ba81-2d83c6b0bac0","d054aac3-4c2f-4afe-a7f3-8f012795516c","f05ade63-cca5-49d7-86e1-c169752d1755","fbb156f5-2840-4583-9f27-2cb1711bb0de","fbb661f7-6ee2-4823-8a10-9aa36294c4d5","fd4bd937-c7b6-4c9c-a85a-c25de5cc90de"],MAX_CACHE_BYTES=32*1024*1024,MAX_VOICES=12;
  const cache=new Map(),voices=new Set(),lastPlay=new Map();
  let context=null,cacheBytes=0;
  const stats={loads:0,decodes:0,cacheHits:0,plays:0,dropped:0,errors:0,streamLoads:0};
  function sharedContext(){
    if(!context){const C=g.AudioContext||g.webkitAudioContext;if(!C)return null;context=new C();}
    return context;
  }
  function unlock(){if(context&&context.state!=='running')context.resume().catch(()=>{});}
  for(const name of ['touchstart','mousedown','keydown'])addEventListener(name,unlock,{passive:true});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)unlock();});
  async function bufferFor(url,read){
    if(cache.has(url)){const entry=cache.get(url);cache.delete(url);cache.set(url,entry);stats.cacheHits++;return entry.promise;}
    const entry={bytes:0,promise:null};stats.loads++;
    entry.promise=(async()=>{
      const bytes=await read(url),ctx=sharedContext();
      const buffer=await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
      stats.decodes++;entry.bytes=buffer.length*buffer.numberOfChannels*4;cacheBytes+=entry.bytes;
      // 只限制解码缓存，正在播放的节点仍持有自己的音频引用。
      for(const [key,value]of cache){if(cacheBytes<=MAX_CACHE_BYTES)break;if(!value.bytes)continue;cache.delete(key);cacheBytes-=value.bytes;}
      return buffer;
    })().catch(error=>{if(cache.get(url)===entry)cache.delete(url);throw error;});
    cache.set(url,entry);return entry.promise;
  }
  function create({read,localURL,media}){
    if(!(g.AudioContext||g.webkitAudioContext))return media();
    const callbacks=new Map();let url='',stream=null,buffer=null,loading=null,node=null,gain=null;
    let destroyed=false,loadId=0,playId=0,offset=0,started=0,playing=false;
    let loop=false,volume=1,muted=false,autoplay=false,rate=1;
    function fire(name,extra={}){for(const cb of callbacks.get(name)||[])try{cb({duration:api.duration,position:api.currentTime,...extra});}catch(error){console.error(error);}}
    function position(){if(!playing||!context)return offset;const value=offset+(context.currentTime-started)*rate;return loop&&buffer?.duration?value%buffer.duration:Math.min(buffer?.duration||value,value);}
    function releaseNode(){if(!node)return;const old=node;node=null;old.onended=null;try{old.stop();}catch{}old.disconnect();gain?.disconnect();gain=null;voices.delete(api);}
    function cancel(){playId++;releaseNode();playing=false;}
    function ensureStream(){
      stream=media();stats.streamLoads++;
      stream.loop=loop;stream.volume=volume;stream.muted=muted;stream.playbackRate=rate;
      for(const name of ['Canplay','Play','Pause','Stop','Ended','Error','TimeUpdate','Waiting','Seeking','Seeked'])stream['on'+name]?.(e=>fire(name,e));
      stream.src=url;
    }
    async function play(){
      if(destroyed||!url)return;
      if(stream)return stream.play();
      const token=++playId;
      try{
        if(!buffer)await loading;
        if(destroyed||token!==playId||!buffer)return;
        const ctx=sharedContext();
        if(ctx.state!=='running')await ctx.resume();
        if(destroyed||token!==playId)return;
        // 相同受击音效在50ms内合并，限制同时发声数；不影响任何战斗伤害。
        const now=performance.now(),last=lastPlay.get(url);
        if(!loop&&last!==undefined&&now-last<50){stats.dropped++;queueMicrotask(()=>fire('Ended'));return;}
        if(lastPlay.size>128)lastPlay.clear();lastPlay.set(url,now);
        if(voices.size>=MAX_VOICES){const oldest=voices.values().next().value;stats.dropped++;oldest._evictVoice();}
        releaseNode();node=ctx.createBufferSource();gain=ctx.createGain();node.buffer=buffer;node.loop=loop;
        node.playbackRate.value=rate;gain.gain.value=muted?0:volume;node.connect(gain);gain.connect(ctx.destination);
        if(offset>=buffer.duration)offset=0;started=ctx.currentTime;playing=true;voices.add(api);
        const source=node;source.onended=()=>{if(node!==source)return;releaseNode();playing=false;offset=0;fire('Ended');};
        source.start(0,Math.max(0,offset));stats.plays++;fire('Play');
      }catch(error){stats.errors++;playing=false;fire('Error',{errMsg:String(error.message||error)});}
    }
    const api={
      play,pause(){if(stream)return stream.pause();offset=position();cancel();fire('Pause');},
      stop(){if(stream)return stream.stop();cancel();offset=0;fire('Stop');},
      seek(value){value=Math.max(0,Number(value)||0);if(stream)return stream.seek(value);const resume=playing;cancel();offset=value;fire('Seeking');if(resume)void play();fire('Seeked');},
      destroy(){if(destroyed)return;destroyed=true;loadId++;cancel();stream?.destroy();stream=null;buffer=null;loading=null;callbacks.clear();}
    };
    // 被并发上限替换的短音效也要结束回调，归还引擎的一次性播放器。
    Object.defineProperty(api,'_evictVoice',{value:()=>{cancel();offset=0;fire('Ended');}});
    Object.defineProperty(api,'src',{get:()=>url,set(value){
      const next=value?localURL(value):'';if(next===url||destroyed)return;
      cancel();stream?.destroy();stream=null;buffer=null;offset=0;url=next;const id=++loadId;
      if(!url)return;
      if(STREAM_IDS.some(uuid=>url.includes(uuid))){ensureStream();if(autoplay)void stream.play();return;}
      loading=bufferFor(url,read).then(value=>{if(destroyed||id!==loadId)return;buffer=value;fire('Canplay');if(autoplay)void play();}).catch(error=>{if(destroyed||id!==loadId)return;stats.errors++;fire('Error',{errMsg:String(error.message||error)});});
    }});
    for(const key of ['loop','volume','muted','autoplay','playbackRate'])Object.defineProperty(api,key,{
      get:()=>stream?stream[key]:({loop,volume,muted,autoplay,playbackRate:rate})[key],
      set(value){
        if(key==='loop'){loop=!!value;if(node)node.loop=loop;}
        if(key==='volume')volume=Math.max(0,Math.min(1,Number(value)||0));
        if(key==='muted')muted=!!value;
        if(key==='autoplay')autoplay=!!value;
        if(key==='playbackRate'){const next=Math.max(.25,Math.min(4,Number(value)||1));if(playing){offset=position();started=context.currentTime;}rate=next;if(node)node.playbackRate.value=rate;}
        if(gain)gain.gain.value=muted?0:volume;if(stream)stream[key]=value;
      }
    });
    Object.defineProperties(api,{currentTime:{get:()=>stream?stream.currentTime:position(),set:v=>api.seek(v)},
      duration:{get:()=>stream?stream.duration:(buffer?.duration||0)},paused:{get:()=>stream?stream.paused:!playing},
      startTime:{get:()=>offset,set:v=>api.seek(v)}});
    for(const name of ['Canplay','Play','Pause','Stop','Ended','Error','TimeUpdate','Waiting','Seeking','Seeked']){
      api['on'+name]=cb=>{if(!callbacks.has(name))callbacks.set(name,new Set());callbacks.get(name).add(cb);if(name==='Canplay'&&buffer)queueMicrotask(()=>{if(!destroyed&&callbacks.get(name)?.has(cb))cb({duration:api.duration,position:api.currentTime});});};
      api['off'+name]=cb=>{if(cb)callbacks.get(name)?.delete(cb);else callbacks.delete(name);};
    }
    return api;
  }
  g.LocalAudio={create,getStats:()=>({...stats,activeVoices:voices.size,decodedCacheBytes:cacheBytes,cachedSounds:cache.size,contextState:context?.state||'not-created',maxVoices:MAX_VOICES})};
})(globalThis);
