// Hardware-free observer integration: Chrome file-backed fake microphone ->
// known 0.5 gain Worklet -> local Opus loopback. Never connects to Webex.
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const BASE='http://localhost:8080';
const root=path.resolve(process.argv[2]||'.tmp/platform-lab/2026-09-11/capture-points-validation-v2');
const save=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value),{flag:'wx'});
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

async function main(){
  const health=await fetch(BASE+'/js/tests/platform-lab/micprobe.html');
  assert.ok(health.ok&&(await health.text()).includes('MicProbe Platform Lab'));
  fs.mkdirSync(root); // Never overwrite an earlier experiment.
  const tracked=require('node:child_process').execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
  const protectedFiles=Object.fromEntries(tracked.filter(file=>fs.existsSync(file)).map(file=>[file,digest(fs.readFileSync(file))]));
  save('protected-before.json',protectedFiles);
  const wav=Buffer.alloc(44+48000*10*2);
  wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(48000,24);wav.writeUInt32LE(96000,28);
  wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  for(let i=0;i<48000*10;i++)wav.writeInt16LE(Math.round(32767*(0.125*Math.sin(2*Math.PI*1000*i/48000)+0.03125*Math.sin(2*Math.PI*2300*i/48000))),44+i*2);
  const inputPath=path.join(root,'fake-input.wav');fs.writeFileSync(inputPath,wav,{flag:'wx'});
  const observer=fs.readFileSync('scripts/platform_lab/browser-observer.js','utf8');
  const collector=fs.readFileSync('js/tests/platform-lab/browser-receiver.js','utf8');
  for(const file of ['scripts/platform_lab/browser-observer.js','js/tests/platform-lab/browser-receiver.js','js/tests/platform-lab/half-gain-processor.js',__filename]){
    fs.copyFileSync(file,path.join(root,path.basename(file)),fs.constants.COPYFILE_EXCL);
  }
  const browser=await chromium.launch({channel:'chrome',headless:true,args:[
    '--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',
    '--use-file-for-fake-audio-capture='+inputPath
  ]});
  try{
    save('experiment.json',{scope:'synthetic local observer validation; not Webex',browserVersion:browser.version(),
      inputSha256:digest(wav),sampleRate:48000,channels:1,workletGain:0.5,conditions:['control','with-input-tap'],
      note:'Each isolated browser context requests one file-backed fake microphone; observers reuse that track.'});
    for(const condition of ['control','with-input-tap']){
      const context=await browser.newContext({permissions:['microphone']});
      const page=await context.newPage(),errors=[],runId=crypto.randomUUID();
      page.on('pageerror',e=>errors.push(e.message));
      await page.route(url=>url.origin!==BASE,route=>route.abort());
      try{
        await page.goto(BASE+'/js/tests/platform-lab/micprobe.html');
        await page.evaluate(runId=>{window.__micprobeObserverConfig={runId,origin:location.origin};},runId);
        await page.addScriptTag({content:observer});
        const output=await page.evaluate(async({runId,condition,collector})=>{
          const loopback=(await import('/js/modules/LoopbackManager.js')).default;
          const {createAndPlayActivatorAudio,cleanupActivatorAudio}=await import('/js/modules/utils.js');
          const captures=[],bundles={},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
          let stream,ac,worklet,destination,activator,lastWorkletFrame=0;
          try{
            stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,
              autoGainControl:false,channelCount:1,sampleRate:48000},video:false});
            const track=stream.getAudioTracks()[0],initialSettings=JSON.stringify(track.getSettings());
            if(!track.label.toLowerCase().includes('fake'))throw Error('Expected Chrome fake microphone');
            ac=new AudioContext({sampleRate:48000});await ac.resume();
            await ac.audioWorklet.addModule('./half-gain-processor.js');
            worklet=new AudioWorkletNode(ac,'lab-half-gain',{outputChannelCount:[1]});
            worklet.port.onmessage=e=>{lastWorkletFrame=e.data;};
            destination=ac.createMediaStreamDestination();destination.channelCount=1;destination.channelCountMode='explicit';
            ac.createMediaStreamSource(stream).connect(worklet).connect(destination);
            await sleep(300);
            const remote=await loopback.setup(destination.stream,{useWebAudio:false,opusBitrate:64000,runId});
            activator=await createAndPlayActivatorAudio(remote,'Capture points validation');
            const points=condition==='with-input-tap'?['browser-input','sender-outbound','receiver']:['sender-outbound','receiver'];
            for(const point of points){
              window.__micprobeReceiverPc=point==='receiver'?loopback.pc2:loopback.pc1;
              window.__micprobeCaptureConfig={runId,origin:location.origin,connectionId:point+'-pc',capturePoint:point,
                captureId:point,trackId:point==='browser-input'?track.id:undefined};
              const script=document.createElement('script');script.textContent=collector;document.head.append(script);script.remove();
              const api=window.__micprobeCaptures.get(JSON.stringify([runId,point]));
              if(!api)throw Error('Missing capture '+point);captures.push({point,api});
            }
            await sleep(2300);
            const ready=await Promise.all(captures.map(async c=>({point:c.point,...await c.api.status()})));
            if(ready.some(s=>s.errors.length||!s.captureActive||s.pcmChunks<2||(s.point!=='browser-input'&&s.statsCount<2)))throw Error('Capture not durably ready');
            await sleep(3000);
            const input=captures.find(c=>c.point==='browser-input');
            if(input)bundles[input.point]=await input.api.stop();
            const beforeFrames=lastWorkletFrame;
            const remaining=captures.filter(c=>c!==input);
            const before=await Promise.all(remaining.map(c=>c.api.status()));
            await sleep(2200);
            const after=await Promise.all(remaining.map(c=>c.api.status()));
            const continuity={trackStillLive:track.readyState==='live',sameSettings:JSON.stringify(track.getSettings())===initialSettings,
              sameSenderTrack:loopback.pc1.getSenders().some(s=>s.track===destination.stream.getAudioTracks()[0]),
              contextState:ac.state,workletAdvanced:lastWorkletFrame>beforeFrames,
              otherCollectorsAdvanced:after.every((s,i)=>s.pcmChunks>before[i].pcmChunks&&s.statsCount>before[i].statsCount&&!s.errors.length)};
            if(!continuity.trackStillLive||!continuity.sameSettings||!continuity.sameSenderTrack||!continuity.workletAdvanced||!continuity.otherCollectorsAdvanced)throw Error('Observer changed or interrupted application path');
            for(const c of remaining)bundles[c.point]=await c.api.stop();
            const technology=await window.__micprobeTechnology.stop();
            const requests=technology.events.filter(e=>e.kind==='getUserMedia-request');
            if(requests.length!==1||technology.state.errors.length)throw Error('Unexpected capture request or technology observer error');
            return {runId,condition,ready,continuity,bundles,technology,microphoneRequests:requests.length,
              selectedInputTrackId:track.id,inputSettings:track.getSettings(),syntheticMicrophone:true};
          }finally{
            for(const c of captures)await c.api.stop();
            cleanupActivatorAudio(activator);await loopback.cleanup();
            for(const t of stream?.getTracks()||[])t.stop();
            for(const t of destination?.stream.getTracks()||[])t.stop();
            worklet?.disconnect();worklet?.port.close();if(ac&&ac.state!=='closed')await ac.close();
            window.__capturePointsCleanup={liveTracks:[...stream?.getTracks()||[],...destination?.stream.getTracks()||[]].filter(t=>t.readyState==='live').length,
              contextState:ac?.state,pcReleased:!loopback.pc1&&!loopback.pc2};
          }
        },{runId,condition,collector});
        const cleanup=await page.evaluate(()=>window.__capturePointsCleanup);
        assert.deepEqual(cleanup,{liveTracks:0,contextState:'closed',pcReleased:true});assert.deepEqual(errors,[]);
        const databaseChecks=[];
        // A new page has none of the collector's JS objects. Read durable data there.
        await page.close();const recovery=await context.newPage();await recovery.goto(BASE+'/js/tests/platform-lab/micprobe.html');
        for(const [point,bundle] of Object.entries(output.bundles)){
          assert.equal(bundle.state.pending,0);assert.deepEqual(bundle.state.errors,[]);assert.equal(bundle.state.captureActive,false);
          const rows=await recovery.evaluate(name=>new Promise((resolve,reject)=>{
            const request=indexedDB.open(name);request.onerror=()=>reject(request.error);
            request.onsuccess=()=>{const db=request.result,tx=db.transaction('records'),all=tx.objectStore('records').getAll();
              tx.oncomplete=()=>{db.close();resolve(all.result);};tx.onerror=()=>reject(tx.error);};
          }),bundle.records[0].databaseName);
          assert.deepEqual(rows,bundle.records);
          databaseChecks.push({point,recordCount:rows.length,exactMatch:true});
          save(condition+'-'+point+'.json',bundle);
        }
        save(condition+'-technology.json',output.technology);
        delete output.bundles;delete output.technology;
        save(condition+'-completion.json',{...output,cleanup,pageErrors:errors,databaseChecks});
        console.log(condition+': PCM stores recovered exactly; application audio remained live; cleanup passed');
      }catch(e){save(condition+'-failure.json',{error:e.stack,pageErrors:errors});throw e;}
      finally{await context.close();}
    }
    const changed=Object.keys(protectedFiles).filter(file=>!fs.existsSync(file)||digest(fs.readFileSync(file))!==protectedFiles[file]);
    assert.deepEqual(changed,[]);save('protected-check.json',{filesChecked:Object.keys(protectedFiles).length,changed});
  }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
