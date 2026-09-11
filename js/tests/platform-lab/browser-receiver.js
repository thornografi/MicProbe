/* Shared authorized application-page PCM observer. Set __micprobeCaptureConfig
 * and __micprobeReceiverPc (RTP taps) or install the technology observer (input).
 * Captures borrow the application's existing track; they never stop or alter it.
 * MediaRecorder here belongs to the lab, not the platform being measured. */
(function installReceiverCapture() {
  const config = window.__micprobeCaptureConfig;
  if (!config || location.origin !== config.origin) throw Error('Invalid capture context');
  const {runId} = config;
  const capturePoint = config.capturePoint || 'receiver';
  if (!['receiver', 'sender-outbound', 'browser-input'].includes(capturePoint)) throw Error('Unknown capture point');
  const captureId = config.captureId ?? capturePoint;
  if (![runId, captureId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 128)) throw Error('Explicit run and capture identity required');
  const registry = window.__micprobeCaptures ??= new Map();
  const key = JSON.stringify([runId, captureId]);
  if (registry.has(key)) throw Error('Capture identity already used in this page');
  const input = capturePoint === 'browser-input';
  const observer = input ? window.__micprobeTechnology : null;
  if (input && (!config.trackId || observer?.state.runId !== runId || observer.state.errors.length)) throw Error('Input requires an explicitly selected track from this run\'s technology observer');
  const pc = input ? null : window.__micprobeReceiverPc;
  const connectionId = input ? null : config.connectionId;
  if (!input && (!pc || pc.connectionState !== 'connected' || !connectionId)) throw Error('Receiver is not ready');
  const candidates = input ? observer.streams.flatMap(s => s.getAudioTracks()) :
    (capturePoint === 'receiver' ? pc.getReceivers() : pc.getSenders()).map(r => r.track);
  const availableTracks = [...new Set(candidates)].filter(t => t?.kind === 'audio' && t.readyState === 'live');
  // Multi-track platforms require an observed track ID; never choose the first
  // receive slot. Keep every audio RTP report so a later slot change is visible.
  const tracks = config.trackId === undefined ? availableTracks : availableTracks.filter(t => t.id === config.trackId);
  const mime = 'audio/webm;codecs=pcm';
  if (tracks.length !== 1 || !MediaRecorder.isTypeSupported(mime)) throw Error('Receiver is not ready');
  const track = tracks[0], recorder = new MediaRecorder(new MediaStream(tracks), {mimeType:mime});
  const databaseName = 'micprobe-capture-' + key;
  const state = {runId, captureId, collecting:true, captureActive:false, errors:[], pcmBytes:0, pcmChunks:0, statsCount:0, pending:0};
  const records = [];
  const dbReady = new Promise((resolve,reject) => {
    let created = false;
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      created=true;request.result.createObjectStore('records', {autoIncrement:true});
    };
    request.onsuccess = () => {
      const db = request.result;
      // Only the request that created this database may write to it. This also
      // excludes simultaneous collectors in another page of the same origin.
      if (!created) {db.close();reject(Error('Capture database already exists; use a new capture identity'));}
      else resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error('Capture database is blocked'));
  });
  let writes = Promise.resolve(), timer, stopTimer, stopPromise, stopped = false, sampling = Promise.resolve(), sequence = 0;
  function save(makeRow) {
    const rowSequence = sequence++;
    state.pending++;
    writes = writes.then(async () => {
      const row = {...await makeRow(), runId, captureId, sequence:rowSequence};
      const db = await dbReady;
      await new Promise((resolve,reject) => {
        const tx = db.transaction('records','readwrite',{durability:'strict'});
        tx.objectStore('records').add(row);
        tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error);
      });
      records.push(row);
      if (row.kind === 'pcm-container') { state.pcmChunks++; state.pcmBytes+=row.byteLength; }
      if (row.kind === 'stats') state.statsCount++;
    }).catch(e => state.errors.push(String(e))).finally(()=>state.pending--);
  }
  function event(name, detail={}) { save(()=>({kind:'event',name,at:Date.now(),...detail})); }
  function sample() {
    sampling = sampling.then(async () => {
      try {
        if (track.readyState !== 'live') throw Error('Observed audio track ended before capture completed');
        if (!pc) return;
        const slots = capturePoint === 'receiver' ? pc.getReceivers() : pc.getSenders();
        if (!slots.some(slot=>slot.track===track)) throw Error('Selected audio track was replaced; start a separately identified capture');
        const reports = Array.from((await pc.getStats()).values()).filter(r =>
          r.kind==='audio' || r.mediaType==='audio' || r.type==='codec' && r.mimeType?.startsWith('audio/'));
        save(()=>({kind:'stats',connectionId,at:Date.now(),reports}));
      } catch(e) { state.errors.push(String(e)); }
    });
    return sampling;
  }
  recorder.addEventListener('dataavailable', e => {
    if (!e.data.size) return;
    const at = Date.now();
    save(async()=>{
      const bytes=new Uint8Array(await e.data.arrayBuffer());
      let binary='';
      for(let i=0;i<bytes.length;i+=32768) binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
      return {kind:'pcm-container',at,byteLength:bytes.length,dataBase64:btoa(binary)};
    });
  });
  recorder.addEventListener('error', e => state.errors.push(String(e.error || e)));
  recorder.addEventListener('stop',()=>state.captureActive=false);
  const onEnded = () => {if(!stopped)state.errors.push('Observed audio track ended before stop');};
  track.addEventListener('ended',onEnded);
  save(()=>({kind:'metadata',runId,captureMime:mime,origin:location.origin,userAgent:navigator.userAgent,
    connectionId,capturePoint,databaseName,statsScope:input?'none':'peer-connection-audio',
    inputProvenance:input?{kind:'observed-getUserMedia-result',observerRunId:observer.state.runId,observerStartedAt:observer.state.startedAt}:null,
    trackId:track.id,availableTrackIds:availableTracks.map(t=>t.id),
    trackSelection:config.trackId === undefined ? 'single-live-track' : 'explicit-track-id',
    trackSettings:track.getSettings(),createdAt:Date.now()}));
  // No recording begins until its own persistent store is ready and empty.
  const starting = (async()=>{
    try {
      await dbReady;await writes;
      if (stopped || state.errors.length) return;
      event('pcm-start');recorder.start(1000);state.captureActive=true;
      await sample();timer=setInterval(sample,1000);
    } catch(e) {state.errors.push(String(e));}
  })();
  function stop(reason='operator') {
    // Automatic and operator stops must await the same final PCM/statistics
    // flush. A concurrent caller must never receive an incomplete export.
    if (!stopPromise) {
      stopped=true;clearInterval(timer);clearTimeout(stopTimer);
      stopPromise=(async()=>{
        await starting;clearInterval(timer);await sampling;
        await new Promise(resolve=>{if(recorder.state==='inactive')resolve();else {recorder.addEventListener('stop',resolve,{once:true});recorder.stop();}});
        await sample();track.removeEventListener('ended',onEnded);
        event('collector-stop',{reason});state.collecting=false;
        await writes;
        await dbReady.then(db=>db.close(),()=>{});
        return {schemaVersion:2,runId,captureId,state:{...state,errors:[...state.errors]},records:records.slice()};
      })();
    }
    return stopPromise;
  }
  const api={state,
    async status(){await starting;await sampling;await writes;return {...state,errors:[...state.errors]};},
    async stopAfter(seconds){
      await starting;
      if(stopped || !state.captureActive || state.errors.length || stopTimer !== undefined || !Number.isFinite(seconds) || seconds <= 0 || seconds > 180) throw Error('Invalid or already armed stop deadline');
      const deadline=Date.now()+seconds*1000;
      stopTimer=setTimeout(()=>{stop('armed-deadline').catch(e=>state.errors.push(String(e)));},seconds*1000);
      event('auto-stop-armed',{deadline,seconds});
      await writes;
      return {deadline,seconds};
    },
    stop(){return stop();}
  };
  registry.set(key,api);
  window.__micprobeCapture=api; // Legacy callers retain this alias immediately after installation.
})();
