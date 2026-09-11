// Local codec/DTX experiment: frozen PCM -> production loopback -> PCM/RTP taps.
// No microphone permission, native routing, platform account, or profile mutation.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const BASE = 'http://localhost:8080';
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx' });
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function main() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const bytes = fs.readFileSync(config.input);
  assert.equal(digest(bytes), config.pcmSha256);
  assert.equal(bytes.length, config.frames * config.channels * 4);
  assert.equal(config.channels, 1);
  const health = await fetch(`${BASE}/js/tests/platform-lab/micprobe.html`);
  assert.ok(health.ok && (await health.text()).includes('MicProbe Platform Lab'));
  const browser = await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  try {
    for (const condition of config.runs) {
      assert.ok(condition.dtx === undefined || typeof condition.dtx === 'boolean');
      const context = await browser.newContext();
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route(url => url.origin !== BASE, route => route.abort());
      await page.route(`${BASE}/js/tests/platform-lab/frozen-input.f32`, route => route.fulfill({body:bytes,contentType:'application/octet-stream'}));
      await page.exposeFunction('persistCodecEvidence', (name, value) => {
        assert.ok(['prepared.json','play-start.json','play-end.json','sender-outbound.bundle.json','receiver.bundle.json','completion.json'].includes(name));
        save(path.join(condition.directory,name),value);
      });
      console.log(`START ${condition.name} ${condition.runId}`);
      try {
        await page.goto(`${BASE}/js/tests/platform-lab/micprobe.html`);
        const completion = await page.evaluate(async input => {
          const loopback = (await import('/js/modules/LoopbackManager.js')).default;
          const {createAndPlayActivatorAudio,cleanupActivatorAudio,stopStreamTracks} = await import('/js/modules/utils.js');
          const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
          const originalSetOpusBitrate = loopback.setOpusBitrate;
          let micCalls=0,ac,source,destination,activator,deadline,timedOut=false;
          const collectors=[];
          // Fail closed if any future imported helper tries to reopen the microphone.
          navigator.mediaDevices.getUserMedia=async()=>{micCalls++;throw Error('Microphone forbidden in codec component study');};
          const preparedAt=new Date().toISOString();
          const timeout=new Promise((_,reject)=>{deadline=setTimeout(()=>{timedOut=true;reject(Error('Codec study deadline reached'));},90000);});
          const work=(async()=>{
            ac=new AudioContext({sampleRate:input.sampleRate});await ac.resume();
            if(ac.sampleRate!==input.sampleRate)throw Error('Input sample rate changed');
            const raw=await (await fetch('./frozen-input.f32')).arrayBuffer();
            const pcm=new Float32Array(raw);
            if(pcm.length!==input.frames)throw Error('PCM frame count mismatch');
            const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),v=>v.toString(16).padStart(2,'0')).join('');
            if(hash!==input.pcmSha256)throw Error('PCM digest mismatch');
            const buffer=ac.createBuffer(1,pcm.length,ac.sampleRate);buffer.copyToChannel(pcm,0);
            destination=ac.createMediaStreamDestination();destination.channelCount=1;destination.channelCountMode='explicit';
            source=ac.createBufferSource();source.buffer=buffer;source.connect(destination);
            // WebAudio track settings initially report two channels, even with
            // mono constructor options. Wait for a rendered silent source before
            // LoopbackManager reads the actual channel count for its SDP.
            const warmup=ac.createBufferSource();warmup.buffer=ac.createBuffer(1,4800,ac.sampleRate);warmup.connect(destination);
            await new Promise(resolve=>{warmup.addEventListener('ended',resolve,{once:true});warmup.start();});warmup.disconnect();
            if(destination.stream.getAudioTracks()[0].getSettings().channelCount!==1)throw Error('Mono input not applied');
            // Only this isolated lab instance changes SDP. Apply the receive-only
            // Opus preference to both descriptions so the outgoing direction is covered.
            if (input.dtx !== undefined) loopback.setOpusBitrate = function(sdp, ...args) {
              const lines = originalSetOpusBitrate.call(this, sdp, ...args).split(/\r?\n/);
              const payload = lines.find(line => /^a=rtpmap:\d+ opus\//i.test(line))?.match(/^a=rtpmap:(\d+)/)[1];
              const index = lines.findIndex(line => line.startsWith('a=fmtp:' + payload + ' '));
              if (!payload || index < 0) throw Error('Opus parameters missing for DTX experiment');
              const parameters = new Map(lines[index].slice(lines[index].indexOf(' ') + 1).split(';').map(p => p.trim().split('=')));
              parameters.set('usedtx', input.dtx ? '1' : '0');
              lines[index] = 'a=fmtp:' + payload + ' ' + Array.from(parameters, ([k,v]) => k + '=' + v).join(';');
              return lines.join('\r\n');
            };
            // Frozen input is already post-capture. Direct feeding avoids applying EC/NS/AGC twice.
            const remote=await loopback.setup(destination.stream,{useWebAudio:false,opusBitrate:input.bitrate,runId:input.runId});
            if(timedOut)throw Error('Preparation expired');
            for(const sdp of [loopback.pc1.localDescription.sdp,loopback.pc2.localDescription.sdp,loopback.pc1.remoteDescription.sdp,loopback.pc2.remoteDescription.sdp]) {
              const payload=sdp.match(/^a=rtpmap:(\d+) opus\//mi)?.[1];
              const line=sdp.split(/\r?\n/).find(value=>value.startsWith('a=fmtp:'+payload+' '));
              const parameters=Object.fromEntries((line?.slice(line.indexOf(' ')+1)||'').split(';').map(value=>value.trim().split('=')));
              if(parameters.stereo!=='0'||parameters['sprop-stereo']!=='0')throw Error('Negotiated Opus must be mono before capture');
              if(input.dtx !== undefined && parameters.usedtx !== (input.dtx ? '1' : '0'))throw Error('DTX preference was not retained');
            }
            activator=await createAndPlayActivatorAudio(remote,'Codec component study');
            for(const [point,pc] of [['sender-outbound',loopback.pc1],['receiver',loopback.pc2]]) {
              window.__micprobeReceiverPc=pc;
              window.__micprobeCaptureConfig={runId:input.runId,origin:location.origin,connectionId:point+'-pc',capturePoint:point};
              delete window.__micprobeCapture;
              const script=document.createElement('script');script.src='./browser-receiver.js';
              try {await new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=()=>reject(Error('Collector load failed'));document.head.append(script);});}
              finally {script.remove();}
              if(!window.__micprobeCapture)throw Error('Collector did not initialize');
              collectors.push({point,api:window.__micprobeCapture});
            }
            // Persist actual PCM and statistics readiness before playing the sole input.
            await new Promise(resolve=>setTimeout(resolve,1300));
            const states=await Promise.all(collectors.map(async c=>({point:c.point,...await c.api.status()})));
            if(states.some(s=>s.errors.length||!s.captureActive||s.pcmChunks<1||s.statsCount<1))throw Error('Collectors are not durable/ready');
            if(timedOut)throw Error('Preparation expired');
            await window.persistCodecEvidence('prepared.json',{runId:input.runId,preparedAt,userAgent:navigator.userAgent,browserVersion:input.browserVersion,headless:true,inputPcmSha256:hash,sampleRate:ac.sampleRate,frames:pcm.length,trackSettings:destination.stream.getAudioTracks()[0].getSettings(),requestedBitrate:input.bitrate,requestedDtx:input.dtx??null,sourceMode:'frozen-post-capture-pcm',pipeline:'direct',microphoneCalls:micCalls,states,offer:loopback.pc1.localDescription.sdp,answer:loopback.pc2.localDescription.sdp,remoteOffer:loopback.pc2.remoteDescription.sdp,remoteAnswer:loopback.pc1.remoteDescription.sdp,senderParameters:loopback.pc1.getSenders()[0].getParameters()});
            const ended=new Promise(resolve=>source.addEventListener('ended',resolve,{once:true}));
            const start={runId:input.runId,at:new Date().toISOString(),audioContextSeconds:ac.currentTime};
            await window.persistCodecEvidence('play-start.json',start);
            source.start();await ended;
            await window.persistCodecEvidence('play-end.json',{runId:input.runId,at:new Date().toISOString(),audioContextSeconds:ac.currentTime});
            await new Promise(resolve=>setTimeout(resolve,1500));
            return {runId:input.runId,microphoneCalls:micCalls,sourceMode:'frozen-post-capture-pcm'};
          })();
          let outcome;
          try {outcome=await Promise.race([work,timeout]);}
          finally {
            clearTimeout(deadline);
            const captures=await Promise.allSettled(collectors.map(async c=>{
              const value=await c.api.stop();await window.persistCodecEvidence(c.point+'.bundle.json',value);
              return {point:c.point,state:value.state};
            }));
            try {source?.stop();}catch{}
            source?.disconnect();stopStreamTracks(destination?.stream);cleanupActivatorAudio(activator);
            await loopback.cleanup();if(ac&&ac.state!=='closed')await ac.close();
            navigator.mediaDevices.getUserMedia=originalGetUserMedia;
            loopback.setOpusBitrate=originalSetOpusBitrate;
            if(outcome) {
              outcome.captures=captures;
              outcome.liveTracks=destination?.stream.getTracks().filter(t=>t.readyState==='live').length??0;
              outcome.contextState=ac?.state;outcome.pcReleased=!loopback.pc1&&!loopback.pc2;
              outcome.finishedAt=new Date().toISOString();
            }
          }
          return outcome;
        },{...condition,sampleRate:config.sampleRate,frames:config.frames,pcmSha256:config.pcmSha256,browserVersion:browser.version()});
        completion.pageErrors=errors;
        save(path.join(condition.directory,'completion.json'),completion);
        assert.deepEqual(errors,[]);assert.equal(completion.microphoneCalls,0);
        assert.equal(completion.liveTracks,0);assert.equal(completion.contextState,'closed');assert.equal(completion.pcReleased,true);
        for(const cap of completion.captures) {
          assert.equal(cap.status,'fulfilled');assert.deepEqual(cap.value.state.errors,[]);
          assert.equal(cap.value.state.pending,0);assert.equal(cap.value.state.captureActive,false);
        }
        console.log(`DONE ${condition.name}: input verified, two captures persisted, all audio resources released`);
      } catch(error) {
        save(path.join(condition.directory,'failure.json'),{at:new Date().toISOString(),message:error.stack,pageErrors:errors});
        throw error;
      } finally {await context.close();}
    }
  } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
