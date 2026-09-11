/* Diagnostic observer for an explicitly authorized platform test page.
 * It records API use without changing capture constraints, SDP or media samples.
 * Observations describe this page/realm only; absence is not proof of non-use.
 */
(function installMicProbeObserver() {
  const config = window.__micprobeObserverConfig;
  const allowedOrigin = location.origin.startsWith('https:') || location.origin === 'http://localhost:8080';
  if (!config?.runId || config.origin !== location.origin || !allowedOrigin || window.__micprobeTechnology) throw Error('Invalid observer context');
  const {runId} = config;
  const state = { runId, startedAt: Date.now(), errors: [], pending: 0, rows: 0 };
  const pcs = [], streams = [], events = [], nodeIds = new WeakMap();
  const original = [], observedRecorder = MediaRecorder;
  let nodeSequence = 0, pcSequence = 0, collecting = true, timer;
  const dbReady = new Promise((resolve, reject) => {
    const req = indexedDB.open('micprobe-technology-' + runId, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('events', { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  let writes = Promise.resolve();
  function log(kind, detail) {
    if (!collecting) return;
    if (events.length >= 20000) {
      if (!state.errors.includes('Observer event limit reached')) state.errors.push('Observer event limit reached');
      return;
    }
    const row = { kind, at: Date.now(), ...detail };
    events.push(row); state.pending++;
    writes = writes.then(async () => {
      const db = await dbReady;
      await new Promise((resolve, reject) => {
        const tx = db.transaction('events', 'readwrite', { durability: 'strict' });
        tx.objectStore('events').add(row);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
      state.rows++;
    }).catch(e => state.errors.push(String(e))).finally(() => state.pending--);
  }
  function nodeId(node) {
    if (!nodeIds.has(node)) nodeIds.set(node, 'node-' + (++nodeSequence));
    return { id: nodeIds.get(node), type: node.constructor.name };
  }
  function wrap(target, key, factory) {
    if (!target || typeof target[key] !== 'function') return;
    const previous = target[key]; target[key] = factory(previous);
    original.push(() => { target[key] = previous; });
  }
  const tracks = stream => stream.getAudioTracks().map(t => ({ id: t.id, label: t.label,
    settings: t.getSettings(), constraints: t.getConstraints(), enabled: t.enabled, readyState: t.readyState }));
  wrap(navigator.mediaDevices, 'getUserMedia', previous => async function(constraints) {
    log('getUserMedia-request', { constraints: structuredClone(constraints) });
    try {
      const stream = await previous.call(this, constraints); streams.push(stream);
      log('getUserMedia-result', { tracks: tracks(stream) }); return stream;
    } catch(e) { log('getUserMedia-error', { name: e.name, message: e.message }); throw e; }
  });
  wrap(MediaStreamTrack.prototype, 'applyConstraints', previous => async function(constraints) {
    const result = await previous.call(this, constraints);
    if(this.kind === 'audio') log('applyConstraints', {trackId:this.id, requested: constraints, settings:this.getSettings()});
    return result;
  });
  wrap(window, 'RTCPeerConnection', previous => new Proxy(previous, {
    construct(target, args, newTarget) {
      const pc = Reflect.construct(target,args,newTarget); const id='pc-'+(++pcSequence); pcs.push({id,pc});
      log('peer-created', { id });
      pc.addEventListener('connectionstatechange', () => log('peer-state', { id, state: pc.connectionState }));
      pc.addEventListener('track', e => { if(e.track.kind==='audio') log('receiver-track', { id, trackId:e.track.id, settings:e.track.getSettings() }); });
      return pc;
    }
  }));
  wrap(AudioNode.prototype, 'connect', previous => function(destination,...args) {
    const result = previous.call(this,destination,...args);
    log('audio-connect', { source:nodeId(this), destination:nodeId(destination) }); return result;
  });
  wrap(AudioContext.prototype, 'createMediaStreamSource', previous => function(stream) {
    const result=previous.call(this,stream);log('audio-source', { node:nodeId(result), tracks:tracks(stream), contextSampleRate:this.sampleRate });return result;
  });
  wrap(AudioContext.prototype, 'createMediaStreamDestination', previous => function(...args) {
    const result=previous.apply(this,args);log('audio-destination',{node:nodeId(result),tracks:tracks(result.stream)});return result;
  });
  wrap(window.Worklet?.prototype, 'addModule', previous => async function(url,...args) {
    const result=await previous.call(this,url,...args);log('worklet-module',{workletType:this.constructor.name,url:String(url)});return result;
  });
  wrap(window, 'AudioWorkletNode', previous => new Proxy(previous, {
    construct(target,args,newTarget) { const node=Reflect.construct(target,args,newTarget);log('worklet-node',{node:nodeId(node),processor:args[1]});return node; }
  }));
  wrap(window, 'Worker', previous => new Proxy(previous, {
    construct(target,args,newTarget) { const worker=Reflect.construct(target,args,newTarget);log('worker-created',{url:String(args[0]),options:args[1]});return worker; }
  }));
  const reportTypes = new Set(['inbound-rtp','outbound-rtp','remote-inbound-rtp','remote-outbound-rtp','codec','media-source','media-playout']);
  async function sample() {
    for(const {id,pc} of pcs) {
      if(pc.connectionState==='closed')continue;
      try {
        const reports=Array.from((await pc.getStats()).values()).filter(r => reportTypes.has(r.type) && (r.kind==='audio'||r.mediaType==='audio'||r.type==='codec'&&r.mimeType?.startsWith('audio/')));
        if(reports.length)log('stats',{connectionId:id,reports});
      } catch(e){log('stats-error',{connectionId:id,message:String(e)});}
    }
  }
  timer=setInterval(sample,1000);
  log('observer-start',{runId,origin:location.origin,userAgent:navigator.userAgent,
    coverage:'Current page realm only. Observer does not identify proprietary algorithms or worker internals.'});
  window.__micprobeTechnology = { state, pcs, streams,
    async snapshot() {await writes;return {state:{...state},events:events.slice()};},
    status() {return { ...state, pcs:pcs.map(({id,pc})=>({id,state:pc.connectionState,
      senders:pc.getSenders().filter(s=>s.track?.kind==='audio').map(s=>({trackId:s.track.id,settings:s.track.getSettings(),parameters:s.getParameters()})),
      receivers:pc.getReceivers().filter(r=>r.track.kind==='audio').map(r=>({trackId:r.track.id,state:r.track.readyState}))})),
      streams:streams.map(tracks) };},
    async stop() {clearInterval(timer);await sample();log('observer-stop',{});collecting=false;await writes;
      for(const undo of original.reverse())undo();return {schemaVersion:1,runId,state:{...state},events:events.slice()};},
    ObserverMediaRecorder: observedRecorder
  };
})();
