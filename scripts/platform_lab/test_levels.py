"""Observer identity, transient changes, coverage failures and capture ownership."""
import copy
import io
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from platform_lab import bundle, levels, capture as capture_module
from platform_lab.report import analyze


def at(t):
    return f'2026-09-10T12:00:{t:06.3f}+00:00'


def fixture():
    def state(t, scalar=1., db=0.):
        return {'sampledFromUtc':at(t), 'sampledToUtc':at(t), 'masterScalar':scalar,
                'masterDb':db, 'channelScalars':[scalar,scalar], 'channelDb':[db,db], 'muted':False}
    rows=[]
    def add(t,event,**extra):
        rows.append(dict(schemaVersion=1,runId='run',endpointId='id',sequence=len(rows),observedAt=at(t),elapsedMs=t*1000,event=event,**extra))
    add(0,'ready',name='B1',state=state(0))
    add(1,'heartbeat')
    add(1.1,'volume-change',notification={'masterScalar':.5,'channelScalars':[.5,.5],'muted':False,'eventContext':'00000000-0000-0000-0000-000000000001','actorProcessId':None},laterReadback=state(1.2,.5,-9.))
    add(1.3,'volume-change',notification={'masterScalar':1.,'channelScalars':[1.,1.],'muted':False,'eventContext':'00000000-0000-0000-0000-000000000001','actorProcessId':None},laterReadback=state(1.4))
    add(2,'heartbeat')
    add(3,'stopped',state=state(3),error=None,reason='stop-request',callbacksUnregistered=True,listeningEndedAt=at(3))
    manifest={'runId':'run','routing':{'sourceEndpointId':'id'},'window':{'startUtc':at(.1),'endUtc':at(2.9)}}
    return rows,manifest


class LevelTests(unittest.TestCase):
    def test_transient_change_is_kept_even_if_initial_and_final_match(self):
        rows,m=fixture(); report=levels.summarize(rows,m)
        self.assertEqual(report['status'],'covered')
        self.assertEqual(report['notificationCount'],2)
        self.assertTrue(report['levelVariationObserved'])
        self.assertEqual(report['readbackDbRange'],[-9.,0.])
        self.assertIsNone(report['actorProcessId'])
        self.assertEqual(report['initial']['masterDb'],report['final']['masterDb'])

    def test_missing_identity_sequence_or_closure_is_rejected(self):
        rows,m=fixture()
        for mutate in (lambda r:r[1].update(runId='other'),lambda r:r[1].update(endpointId='other'),
                       lambda r:r[1].update(sequence=3),lambda r:r.pop(),lambda r:r[0].update(event='heartbeat')):
            bad=copy.deepcopy(rows); mutate(bad)
            with self.assertRaises(ValueError): levels.summarize(bad,m)

    def test_gap_error_clock_jump_and_short_window_are_not_covered(self):
        rows,m=fixture()
        for mutate in (lambda r:r[-1].update(error='disconnect'),lambda r:r[-1].update(callbacksUnregistered=False),
                       lambda r:r[-1].update(elapsedMs=10000),lambda r:r[1].update(observedAt=at(1.8)),
                       lambda r:r[-1].update(listeningEndedAt=at(2))):
            bad=copy.deepcopy(rows); mutate(bad)
            self.assertEqual(levels.summarize(bad,m)['status'],'incomplete')

    def test_preparation_notifications_are_not_counted_in_measurement_window(self):
        rows,m=fixture(); m['window']['startUtc']=at(2)
        r=levels.summarize(rows,m)
        self.assertEqual(r['notificationCount'],2)
        self.assertEqual(r['measurementWindowNotificationCount'],0)

    def test_unknown_history_never_means_constant_level(self):
        self.assertEqual(levels.analyze(Path('.'),{'artifacts':[]})['status'],'unavailable')

    def test_invalid_readbacks_and_invented_actor_are_rejected(self):
        rows,m=fixture()
        for mutate in (lambda r:r[0]['state'].update(masterDb=float('nan')),
                       lambda r:r[0]['state'].update(channelDb=[]),
                       lambda r:r[2]['notification'].update(actorProcessId=123),
                       lambda r:r[2]['notification'].update(eventContext='not-a-guid')):
            bad=copy.deepcopy(rows);mutate(bad)
            with self.assertRaises(ValueError):levels.summarize(bad,m)

    def test_device_state_integer_does_not_get_parsed_as_a_volume_snapshot(self):
        rows,m=fixture()
        rows[1].update(event='device-state',state=2)
        self.assertIn('endpoint-invalidated-or-readback-failed',levels.summarize(rows,m)['reasons'])

    def test_run_report_uses_immutable_level_artifact(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); run=root/'run'; manifest=bundle.init(run,'other','desktop-app','observer-selftest')
            rows,m=fixture()
            for r in rows:r['runId']=manifest['runId']
            with bundle.edit_run(run) as (_,data):data['routing']=m['routing'];data['window']=m['window']
            source=root/'events.jsonl'
            source.write_text(''.join(json.dumps(r)+'\n' for r in rows),encoding='utf-8')
            bundle.attach(run,source,levels.ROLE,levels.FORMAT)
            result=analyze(run)
            self.assertTrue(result['coverage']['sourceLevelHistory'])
            self.assertFalse(result['coverage']['sourcePcm'])
            self.assertEqual(result['sourceLevels']['readbackDbRange'],[-9.,0.])

    def test_start_failure_does_not_launch_pcm(self):
        with tempfile.TemporaryDirectory() as temp:
            run=Path(temp)/'run';bundle.init(run,'other','desktop-app','selftest')
            with patch.object(capture_module,'list_endpoints',return_value=[{'name':'B1','endpointId':'id'}]), \
                 patch.object(capture_module,'EndpointMonitor') as monitor, patch.object(capture_module.subprocess,'Popen') as proc:
                monitor.return_value.start.side_effect=ValueError('not-ready')
                with self.assertRaisesRegex(ValueError,'not-ready'):
                    capture_module.capture(run,'B1',source_endpoint_id='id',source_only=True)
                proc.assert_not_called()

    def test_storage_failure_never_establishes_readiness(self):
        rows,_=fixture()
        with tempfile.TemporaryDirectory() as temp:
            run=Path(temp)/'run';manifest=bundle.init(run,'other','desktop-app','selftest')
            rows[0]['runId']=manifest['runId']
            monitor=levels.EndpointMonitor(run,'id');monitor.folder.mkdir()
            monitor.proc=SimpleNamespace(stdout=io.StringIO(json.dumps(rows[0])+'\n'),wait=lambda:0)
            with patch.object(levels.os,'fsync',side_effect=OSError('disk-failure')):monitor._read()
            self.assertIsNone(monitor.initial)
            self.assertEqual(monitor.error,'disk-failure')

    def test_last_line_flush_failure_cannot_make_complete_looking_history_green(self):
        rows,m=fixture()
        with tempfile.TemporaryDirectory() as temp:
            run=Path(temp)/'run';manifest=bundle.init(run,'other','desktop-app','selftest')
            for row in rows:row['runId']=manifest['runId']
            with bundle.edit_run(run) as (_,data):data['routing']=m['routing'];data['window']=m['window']
            monitor=levels.EndpointMonitor(run,'id');monitor.folder.mkdir()
            monitor.proc=SimpleNamespace(stdout=io.StringIO(''.join(json.dumps(r)+'\n' for r in rows)),wait=lambda:0)
            outcomes=[None]*(len(rows)-1)+[OSError('last-flush-failed')]
            with patch.object(levels.os,'fsync',side_effect=outcomes):monitor._read()
            monitor.proc=None
            monitor.close()
            _,current=bundle.load(run)
            self.assertEqual(current['artifacts'][0]['collectionStatus'],'failed')
            self.assertEqual(levels.analyze(run,current)['status'],'incomplete')

    def test_source_only_pcm_is_bracketed_by_observer_and_released_on_stop(self):
        events=[]
        class Monitor:
            artifact={'id':'level-proof'};error=None
            def __init__(self,*args,**kwargs):pass
            def start(self):events.append('observer-ready');return self
            def close(self):events.append('observer-closed')
        class Process:
            def __init__(self,cmd,**kwargs):
                self.done=threading.Event();self.returncode=None
                self.stdin=self
                self.stdout=self.output()
                events.append('pcm-opened')
                Path(cmd[-1]).write_bytes(b'RIFF'+bytes(100))
            def output(self):
                yield 'out_time_us=1000000\n'
                self.done.wait(3)
            def write(self,text):events.append('pcm-stop');self.returncode=0;self.done.set()
            def flush(self):pass
            def poll(self):return self.returncode
            def wait(self,timeout=None):self.done.wait(timeout);return self.returncode
        with tempfile.TemporaryDirectory() as temp:
            run=Path(temp)/'run';bundle.init(run,'other','desktop-app','selftest')
            with patch.object(capture_module,'list_endpoints',return_value=[{'name':'B1','endpointId':'id'}]), \
                 patch.object(capture_module,'EndpointMonitor',Monitor),patch.object(capture_module.subprocess,'Popen',Process), \
                 patch.object(capture_module.sys,'stdin',io.StringIO('stop\n')):
                result=capture_module.capture(run,'B1',source_endpoint_id='id',source_only=True)
            self.assertEqual(result['status'],'captured')
            self.assertEqual(events,['observer-ready','pcm-opened','pcm-stop','observer-closed'])
            self.assertEqual([a['role'] for a in bundle.load(run)[1]['artifacts']],['source-audio'])


if __name__=='__main__':unittest.main()
