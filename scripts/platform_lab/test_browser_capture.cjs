const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../js/tests/platform-lab/browser-receiver.js'),'utf8');

function fixture({trackIds=['audio-1'],selectedTrackId,existingDatabase=false,failWrites=false}={}) {
  const stored=[],timeouts=new Map(),databases=new Map(),recorders=[];
  let nextId=0,statsCalls=0,trackStops=0;
  class Recorder extends EventTarget {
    static isTypeSupported(){return true;}
    constructor(stream){super();recorders.push(this);this.stream=stream;this.state='inactive';this.stopCalls=0;}
    start(){this.state='recording';}
    stop(){
      this.stopCalls++;
      this.releaseStop=()=>{
        const data=new Event('dataavailable');data.data=new Blob(['last-pcm']);
        this.dispatchEvent(data);this.state='inactive';this.dispatchEvent(new Event('stop'));
      };
    }
  }
  const tracks=trackIds.map(id=>Object.assign(new EventTarget(),{kind:'audio',readyState:'live',id,
    stop(){trackStops++;this.readyState='ended';},getSettings:()=>({sampleRate:48000})}));
  const observer={state:{runId:'test',startedAt:1,errors:[]},streams:[{getAudioTracks:()=>tracks}]};
  const context=vm.createContext({window:{__micprobeCaptureConfig:{runId:'test',origin:'https://example.test',connectionId:'pc',trackId:selectedTrackId},
      __micprobeTechnology:observer,
      __micprobeReceiverPc:{connectionState:'connected',getReceivers:()=>tracks.map(track=>({track})),
        getSenders:()=>tracks.map(track=>({track})),getStats:async()=>{statsCalls++;return new Map();}}},
    location:{origin:'https://example.test'},navigator:{userAgent:'test'},MediaRecorder:Recorder,MediaStream:class{constructor(tracks){this.tracks=tracks;}},
    indexedDB:{open(name){
      const exists=existingDatabase||databases.has(name);
      const db=databases.get(name)||{rows:[],closed:false,createObjectStore(){},close(){this.closed=true;},transaction(){
        const tx={error:Error('write failed'),objectStore:()=>({add(row){
          if(!failWrites){stored.push(row);db.rows.push(row);}
          queueMicrotask(()=>failWrites?tx.onerror():tx.oncomplete());
        }})};return tx;
      }};
      databases.set(name,db);const req={result:db};
      queueMicrotask(()=>{if(!exists)req.onupgradeneeded();req.onsuccess();});return req;
    }},
    btoa:s=>Buffer.from(s,'binary').toString('base64'),
    setInterval:()=>1,clearInterval:()=>{},setTimeout:(cb,ms)=>{const id=++nextId;timeouts.set(id,{cb,ms});return id;},
    clearTimeout:id=>timeouts.delete(id)});
  function install(config){
    if(config)context.window.__micprobeCaptureConfig={runId:'test',origin:'https://example.test',connectionId:'pc',...config};
    vm.runInContext(source,context);return context.window.__micprobeCapture;
  }
  const api=install();
  return {api,install,context,stored,timeouts,databases,tracks,recorders,observer,
    get statsCalls(){return statsCalls;},get trackStops(){return trackStops;},get recorder(){return recorders[0];},
    release:()=>recorders[0].releaseStop(),tick:()=>new Promise(resolve=>setImmediate(resolve))};
}

test('deadline closes once and concurrent exports await final durable PCM',async()=>{
  const f=fixture();await f.api.status();
  await f.api.stopAfter(55);
  assert.equal([...f.timeouts.values()][0].ms,55000);
  [...f.timeouts.values()][0].cb();await f.tick();
  let settled=false;
  const first=f.api.stop(),second=f.api.stop();first.then(()=>settled=true);
  await f.tick();assert.equal(settled,false);assert.equal(f.recorder.stopCalls,1);
  f.release();const [a,b]=await Promise.all([first,second]);
  assert.equal(a,b);assert.equal(a.state.collecting,false);assert.equal(a.state.captureActive,false);
  assert.equal(a.state.pending,0);assert.equal(a.state.pcmBytes,8);assert.equal(a.state.pcmChunks,1);
  assert.equal(a.records.filter(r=>r.name==='collector-stop').length,1);
  assert.equal(a.records.find(r=>r.name==='collector-stop').reason,'armed-deadline');
  assert.equal(f.stored.length,a.records.length);
});

test('multi-track capture refuses ambiguity and stale track IDs',()=>{
  assert.throws(()=>fixture({trackIds:['idle','active']}),/Receiver is not ready/);
  assert.throws(()=>fixture({trackIds:['idle','active'],selectedTrackId:'previous-call'}),/Receiver is not ready/);
});

test('explicit selection captures the observed slot and retains available IDs',async()=>{
  const f=fixture({trackIds:['idle','active'],selectedTrackId:'active'});await f.api.status();
  assert.deepEqual(Array.from(f.recorder.stream.tracks,t=>t.id),['active']);
  const metadata=f.stored.find(r=>r.kind==='metadata');
  assert.equal(metadata.trackId,'active');assert.equal(metadata.trackSelection,'explicit-track-id');
  assert.deepEqual(Array.from(metadata.availableTrackIds),['idle','active']);
  const done=f.api.stop();await f.tick();f.release();await done;
});

test('operator stop cancels deadline and still saves the last chunk',async()=>{
  const f=fixture();await f.api.stopAfter(55);const result=f.api.stop();await f.tick();
  assert.equal(f.timeouts.size,0);f.release();const a=await result;
  assert.equal(a.records.find(r=>r.name==='collector-stop').reason,'operator');
  assert.equal(a.state.pcmBytes,8);
});

test('invalid or repeated deadlines are rejected without replacing the armed stop',async()=>{
  const f=fixture();
  for(const s of [0,-1,Infinity,NaN,181])await assert.rejects(f.api.stopAfter(s));
  assert.equal(f.timeouts.size,0);await f.api.stopAfter(55);
  await assert.rejects(f.api.stopAfter(60));assert.equal(f.timeouts.size,1);
  const done=f.api.stop();await f.tick();f.release();await done;
  await assert.rejects(f.api.stopAfter(55));
});

test('concurrent input and RTP observers have isolated stores; stopping input leaves application and receiver alive',async()=>{
  const f=fixture();await f.api.status();
  const input=f.install({capturePoint:'browser-input',captureId:'pre-worklet',trackId:'audio-1'});
  await input.status();const before=f.statsCalls;
  const done=input.stop();await f.tick();f.recorders[1].releaseStop();const data=await done;
  assert.equal(f.statsCalls,before);assert.equal(data.state.statsCount,0);
  assert.equal(f.recorder.state,'recording');assert.equal(f.trackStops,0);assert.equal(f.tracks[0].readyState,'live');
  const meta=data.records[0];assert.equal(meta.statsScope,'none');assert.equal(meta.connectionId,null);
  assert.equal(meta.inputProvenance.observerRunId,'test');
  assert.equal(f.databases.size,2);assert.equal(f.databases.get(meta.databaseName).closed,true);
  for(const [index,row] of data.records.entries()){
    assert.equal(row.sequence,index);assert.equal(row.captureId,'pre-worklet');assert.equal(row.runId,'test');
  }
  const frozenErrors=data.state.errors.length;f.tracks[0].dispatchEvent(new Event('ended'));
  assert.equal(data.state.errors.length,frozenErrors); // Its listener was removed; receiver still detects the event.
  assert.ok((await f.api.status()).errors.some(e=>e.includes('ended')));
  const receiverDone=f.api.stop();await f.tick();f.release();await receiverDone;
});

test('input refuses missing provenance, old observer runs and tracks not opened by the observed application',async()=>{
  const f=fixture();await f.api.status();
  assert.throws(()=>f.install({capturePoint:'browser-input'}),/explicitly selected/);
  assert.throws(()=>f.install({capturePoint:'browser-input',trackId:'unknown'}),/not ready/);
  f.observer.state.runId='old';
  assert.throws(()=>f.install({capturePoint:'browser-input',trackId:'audio-1'}),/this run/);
  const done=f.api.stop();await f.tick();f.release();await done;
});

test('duplicate identity is refused before another recorder or database is created',async()=>{
  const f=fixture();await f.api.status();
  assert.throws(()=>f.install({capturePoint:'receiver'}),/already used/);
  assert.equal(f.recorders.length,1);assert.equal(f.databases.size,1);
  const done=f.api.stop();await f.tick();f.release();await done;
  assert.throws(()=>f.install({capturePoint:'receiver'}),/already used/);
});

test('existing persistent evidence and failed storage never start a recorder',async()=>{
  for(const options of [{existingDatabase:true},{failWrites:true}]){
    const f=fixture(options),status=await f.api.status();
    assert.ok(status.errors.length);assert.equal(status.captureActive,false);
    assert.equal(f.recorder.state,'inactive');await assert.rejects(f.api.stopAfter(55));
    const data=await f.api.stop();assert.equal(data.state.pending,0);
    assert.ok(data.state.errors.length);assert.equal(f.trackStops,0);
    assert.ok([...f.databases.values()].every(db=>db.closed));
  }
});

test('a replaced RTP slot cannot silently pair old PCM with new transport statistics',async()=>{
  const f=fixture();await f.api.status();
  f.context.window.__micprobeReceiverPc.getReceivers=()=>[];
  const done=f.api.stop();await f.tick();f.release();const data=await done;
  assert.ok(data.state.errors.some(e=>e.includes('track was replaced')));
  assert.equal(f.tracks[0].readyState,'live');assert.equal(f.trackStops,0);
});
