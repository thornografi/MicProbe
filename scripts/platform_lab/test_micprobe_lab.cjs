const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../../js/tests/platform-lab/micprobe-lab.js'),'utf8').replace(/^import .+;\r?\n/gm,'');
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function fixture({input,collectorStatus,flush}={}){
  const track={readyState:'live',stop(){this.readyState='ended';}};
  const stream={getTracks:()=>[track]};
  const timers=new Map();let timerId=0,cleanups=0,stops=0;
  const context={location:{origin:'http://localhost:8080'},AbortController,structuredClone,Date,Promise,
    document:{getElementById:()=>({}),createElement:()=>({remove(){}}),head:{append(script){
      context.__micprobeCapture={status:()=>collectorStatus?.promise??Promise.resolve({errors:[]}),
        async stop(){stops++;if(flush)await flush.promise;return {state:{captureActive:false,collecting:false,errors:[]}};}};
      script.onload();
    }}},navigator:{userAgent:'test',mediaDevices:{enumerateDevices:async()=>[]}},
    PROFILES:{'meeting-call':{canTest:true,values:{ec:true,ns:true,agc:true,sampleRate:48000,channelCount:1,pipeline:'worklet',bitrate:48000}}},
    PIPELINE_TYPES:{DIRECT:'direct'},requestStream:()=>input?.promise??Promise.resolve(stream),
    createRunSnapshot:()=>({}),completeRunSnapshot:s=>s,
    createAndPlayActivatorAudio:async()=>({paused:false}),cleanupActivatorAudio(){},
    stopStreamTracks:s=>s?.getTracks().forEach(t=>t.stop()),
    loopback:{pc1:{},pc2:{},actualPipeline:'worklet',audioCtx:{sampleRate:48000},setup:async()=>stream,cleanup:async()=>{cleanups++;}},
    setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)};
  context.window=context;vm.runInNewContext(source,context);
  return {api:context.micprobeLab,stream,track,timers,get cleanups(){return cleanups;},get stops(){return stops;}};
}
const args={runId:'r',deviceId:'explicit-b1'};
test('deadline and operator stop share the same flushed result and release input',async()=>{
  const flush=deferred(),f=fixture({flush});await f.api.prepare(args);f.api.arm(55);
  f.timers.forEach(t=>{if(t.ms===55000)t.fn();});
  const stopped=f.api.stop();assert.equal(f.stops,2);assert.equal(f.track.readyState,'live');
  flush.resolve();await stopped;
  assert.equal(f.api.export().liveInputTracks,0);assert.equal(f.api.export().stopReason,'reference-deadline');
  await f.api.stop();assert.equal(f.cleanups,1);assert.equal(f.stops,2);assert.equal(f.timers.size,0);
});
test('input that resolves after cancellation is stopped and cannot become a ready run',async()=>{
  const input=deferred(),f=fixture({input});const prepared=f.api.prepare(args);
  const rejected=assert.rejects(prepared,/expired/);
  await f.api.stop();input.resolve(f.stream);await rejected;
  assert.equal(f.track.readyState,'ended');assert.equal((await f.api.status()).phase,'stopped');assert.equal(f.stops,0);
});
test('cancellation during collector readiness cannot resurrect capturing state',async()=>{
  const collectorStatus=deferred(),f=fixture({collectorStatus});const prepared=f.api.prepare(args);
  const rejected=assert.rejects(prepared,/expired/);
  // Advance promise continuations until the collector has been installed.
  for(let i=0;i<12;i++)await Promise.resolve();
  await f.api.stop();collectorStatus.resolve({errors:[]});await rejected;
  assert.equal((await f.api.status()).phase,'stopped');assert.equal(f.api.export().liveInputTracks,0);
});
