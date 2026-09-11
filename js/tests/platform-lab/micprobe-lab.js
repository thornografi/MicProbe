/* Local measurement adapter. Reuses the production capture/loopback modules;
 * changes orchestration and recording taps, never platform/profile settings. */
import loopback from '../../modules/LoopbackManager.js';
import { requestStream } from '../../modules/StreamHelper.js';
import { PROFILES } from '../../modules/Config.js';
import { PIPELINE_TYPES } from '../../modules/constants.js';
import { createRunSnapshot, completeRunSnapshot } from '../../modules/RunSnapshot.js';
import { createAndPlayActivatorAudio, cleanupActivatorAudio, stopStreamTracks } from '../../modules/utils.js';

if (location.origin !== 'http://localhost:8080') throw Error('Platform Lab only runs on localhost:8080');
const statusNode=document.getElementById('status');
let run;
function show(value) { statusNode.textContent=JSON.stringify(value,null,2);return value; }
async function collector(pc,capturePoint,runId) {
  window.__micprobeReceiverPc=pc;
  window.__micprobeCaptureConfig={runId,origin:location.origin,connectionId:capturePoint+'-pc',capturePoint};
  delete window.__micprobeCapture;
  const script=document.createElement('script');script.src='./browser-receiver.js';
  try {
    await new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=()=>reject(Error('Collector load failed'));document.head.append(script);});
    if(!window.__micprobeCapture)throw Error('Collector initialization failed');
    return window.__micprobeCapture;
  } finally { script.remove(); }
}
async function finish(reason='operator') {
  if(!run)throw Error('No active run');
  if(!run.finishPromise) {
    const current=run;
    current.finishPromise=(async()=>{
      current.abort.abort();clearTimeout(current.deadlineTimer);clearTimeout(current.watchdog);
      const stopped=await Promise.allSettled(current.collectors.map(c=>c.api.stop()));
      try {
        stopped.forEach((result,i)=>{
          if(result.status==='fulfilled')current.exports[current.collectors[i].point]=result.value;
          else current.errors.push(String(result.reason));
        });
      } finally {
        stopStreamTracks(current.stream);cleanupActivatorAudio(current.activator);
        await loopback.cleanup();
        current.phase='stopped';current.stoppedAt=new Date().toISOString();current.stopReason=reason;
      }
      return show({phase:current.phase,stopReason:reason,errors:current.errors,
        captures:Object.fromEntries(Object.entries(current.exports).map(([k,v])=>[k,v.state]))});
    })();
  }
  return run.finishPromise;
}
window.micprobeLab={
  async devices(){return (await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audioinput').map(d=>({id:d.deviceId,label:d.label}));},
  async prepare({runId,deviceId,profileId='meeting-call'}) {
    if(run)throw Error('One run per page; export then reload for another condition');
    if(!runId || !deviceId || !PROFILES[profileId]?.canTest)throw Error('Explicit run, device and call profile required');
    const profile=PROFILES[profileId],v=profile.values;
    const constraints={deviceId:{exact:deviceId},echoCancellation:v.ec,noiseSuppression:v.ns,
      autoGainControl:v.agc,sampleRate:v.sampleRate,channelCount:v.channelCount};
    run={runId,profileId,phase:'preparing',createdAt:new Date().toISOString(),collectors:[],exports:{},errors:[],constraints,abort:new AbortController(),
      settingsContext:{basis:'local-profile',defaultEvidence:null,overrides:{}},profile:structuredClone(profile)};
    // Bounds capture if the operator is interrupted. It does not release an
    // external routing harness; that remains isolated until explicitly restored.
    run.watchdog=setTimeout(()=>{run.errors.push('Preparation/capture watchdog reached');finish('watchdog').catch(e=>show(String(e)));},120000);
    try {
      run.stream=await requestStream(constraints,{signal:run.abort.signal});
      if(run.finishPromise){stopStreamTracks(run.stream);throw Error('Preparation expired');}
      const snapshot={...createRunSnapshot({profile,requestedSettings:{...constraints,pipeline:v.pipeline,bitrate:v.bitrate,loopback:true},captureGuide:{enabled:false,noiseCheck:false}}),runId};
      const remote=await loopback.setup(run.stream,{useWebAudio:v.pipeline!==PIPELINE_TYPES.DIRECT,opusBitrate:v.bitrate,pipeline:v.pipeline,runId});
      if(run.finishPromise)throw Error('Preparation expired');
      run.snapshot=completeRunSnapshot(snapshot,run.stream,{pipeline:loopback.actualPipeline,
        audioContext:{sampleRate:loopback.audioCtx?.sampleRate??null}});
      run.activator=await createAndPlayActivatorAudio(remote,'Platform Lab');
      if(run.finishPromise){cleanupActivatorAudio(run.activator);throw Error('Preparation expired');}
      if(run.activator.paused)throw Error('Remote activation failed');
      for(const [pc,point] of [[loopback.pc1,'sender-outbound'],[loopback.pc2,'receiver']]){
        const api=await collector(pc,point,runId);
        if(run.finishPromise){await api.stop();throw Error('Preparation expired');}
        run.collectors.push({point,api});
        const state=await api.status();if(state.errors.length)throw Error(state.errors.join('; '));
        if(run.finishPromise)throw Error('Preparation expired');
      }
      run.phase='capturing';return show({phase:run.phase,runId,snapshot:run.snapshot,settingsContext:run.settingsContext});
    } catch(e) {run.errors.push(String(e));await finish('prepare-failed');throw e;}
  },
  async status(){return show({phase:run?.phase??'idle',runId:run?.runId,errors:run?.errors??[],
    captures:run?await Promise.all(run.collectors.map(async c=>({point:c.point,...await c.api.status()}))):[]});},
  arm(seconds=55){
    if(run?.phase!=='capturing' || run.deadlineTimer || !Number.isFinite(seconds) || seconds<45 || seconds>70)throw Error('Invalid recording deadline');
    run.armedAt=new Date().toISOString();run.stopAfterSeconds=seconds;
    run.deadlineTimer=setTimeout(()=>finish('reference-deadline').catch(e=>show(String(e))),seconds*1000);
    return show({runId:run.runId,armedAt:run.armedAt,seconds});
  },
  stop:finish,
  export(){
    if(run?.phase!=='stopped')throw Error('Stop and flush before export');
    return {schemaVersion:1,runId:run.runId,profile:run.profile,snapshot:run.snapshot,
      settingsContext:run.settingsContext,createdAt:run.createdAt,armedAt:run.armedAt,
      stoppedAt:run.stoppedAt,stopReason:run.stopReason,errors:run.errors,
      captures:run.exports,userAgent:navigator.userAgent,
      liveInputTracks:run.stream?.getTracks().filter(t=>t.readyState==='live').length??0};
  }
};
show({phase:'idle',ready:true,note:'Explicit device/run required. Existing profile values stay unchanged.'});
