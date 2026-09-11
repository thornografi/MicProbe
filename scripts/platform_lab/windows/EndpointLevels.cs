// Read-only Core Audio observer. The COM setters below are vtable declarations only.
// Notification scalars are authoritative; later dB readback can reflect a newer change.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;

namespace MicProbeLab {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class EnumeratorObject { }
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IDevices {
        [PreserveSig] int EnumAudioEndpoints(int flow, uint state, out ICollection collection);
        [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IDeviceEvents callback);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IDeviceEvents callback);
    }
    [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ICollection {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, out IDevice device);
    }
    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IDevice {
        [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object value);
        [PreserveSig] int OpenPropertyStore(uint mode, out IProperties store);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out uint state);
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PropertyKey { public Guid format; public uint pid; }
    [StructLayout(LayoutKind.Explicit, Size=24)]
    public struct PropertyValue { [FieldOffset(0)] public ushort type; [FieldOffset(8)] public IntPtr pointer; }
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IProperties {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropertyValue value);
    }
    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IVolume {
        [PreserveSig] int RegisterControlChangeNotify(IVolumeEvents callback);
        [PreserveSig] int UnregisterControlChangeNotify(IVolumeEvents callback);
        [PreserveSig] int GetChannelCount(out uint count);
        [PreserveSig] int SetMasterVolumeLevel(float db, ref Guid context);
        [PreserveSig] int SetMasterVolumeLevelScalar(float scalar, ref Guid context);
        [PreserveSig] int GetMasterVolumeLevel(out float db);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float scalar);
        [PreserveSig] int SetChannelVolumeLevel(uint channel, float db, ref Guid context);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float scalar, ref Guid context);
        [PreserveSig] int GetChannelVolumeLevel(uint channel, out float db);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float scalar);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }
    [Guid("657804FA-D6AD-4496-8A60-352752AF4F89"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IVolumeEvents { [PreserveSig] int OnNotify(IntPtr data); }
    [Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IDeviceEvents {
        [PreserveSig] int OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)] string id, uint state);
        [PreserveSig] int OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)] string id);
        [PreserveSig] int OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)] string id);
        [PreserveSig] int OnDefaultDeviceChanged(int flow, int role, [MarshalAs(UnmanagedType.LPWStr)] string id);
        [PreserveSig] int OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)] string id, PropertyKey key);
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct NotificationHeader {
        public Guid context;
        public int muted;
        public float masterScalar;
        public uint channels;
        public float firstChannel;
    }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class Notifications : IVolumeEvents, IDeviceEvents {
        public readonly ConcurrentQueue<Dictionary<string, object>> queue = new ConcurrentQueue<Dictionary<string, object>>();
        public readonly AutoResetEvent wake = new AutoResetEvent(false);
        public readonly Stopwatch clock = Stopwatch.StartNew();
        public volatile string failure;
        public readonly string endpoint;
        private int pending;
        public Notifications(string id) { endpoint = id; }
        public Dictionary<string, object> Event(string kind) {
            return new Dictionary<string, object> { {"event", kind}, {"observedAt", DateTimeOffset.UtcNow.ToString("O")}, {"elapsedMs", clock.Elapsed.TotalMilliseconds} };
        }
        private void Enqueue(Dictionary<string, object> item) {
            if (Interlocked.Increment(ref pending) > 4096) {
                Interlocked.Decrement(ref pending); failure = "notification-queue-overflow";
            } else queue.Enqueue(item);
            wake.Set();
        }
        public bool Take(out Dictionary<string, object> item) {
            if (!queue.TryDequeue(out item)) return false;
            Interlocked.Decrement(ref pending); return true;
        }
        public static Dictionary<string, object> Decode(IntPtr data) {
            if (data == IntPtr.Zero) throw new ArgumentException("null-notification");
            var h = Marshal.PtrToStructure<NotificationHeader>(data);
            if (h.channels < 1 || h.channels > 32 || !float.IsFinite(h.masterScalar) || h.masterScalar < 0 || h.masterScalar > 1)
                throw new ArgumentException("invalid-volume-notification");
            var channels = new float[h.channels];
            int offset = (int)Marshal.OffsetOf<NotificationHeader>("firstChannel");
            Marshal.Copy(IntPtr.Add(data, offset), channels, 0, channels.Length);
            foreach (float v in channels) if (!float.IsFinite(v) || v < 0 || v > 1) throw new ArgumentException("invalid-channel-scalar");
            return new Dictionary<string, object> { {"masterScalar", h.masterScalar}, {"muted", h.muted != 0}, {"channelScalars", channels},
                {"eventContext", h.context.ToString()}, {"actorProcessId", null} };
        }
        public int OnNotify(IntPtr data) {
            // Copy transient native memory only. No file IO, COM calls, waits or unregister here.
            try { var e = Event("volume-change"); e["notification"] = Decode(data); Enqueue(e); }
            catch (Exception e) { failure = e.Message; wake.Set(); }
            return 0;
        }
        public int OnDeviceStateChanged(string id, uint state) {
            if (id == endpoint) { var e=Event("device-state"); e["state"]=state; Enqueue(e); if(state != 1) failure="selected-endpoint-inactive"; }
            return 0;
        }
        public int OnDeviceAdded(string id) { return 0; }
        public int OnDeviceRemoved(string id) {
            if(id == endpoint) { failure="selected-endpoint-removed"; wake.Set(); } return 0;
        }
        public int OnDefaultDeviceChanged(int flow, int role, string id) {
            if(flow == 1) { var e=Event("default-capture-changed"); e["role"]=role; e["selectedIsDefault"]=id == endpoint; Enqueue(e); } return 0;
        }
        public int OnPropertyValueChanged(string id, PropertyKey key) { return 0; }
    }

    public static class EndpointLevels {
        [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropertyValue value);
        private static void Check(int hr) { Marshal.ThrowExceptionForHR(hr); }
        private static void Release(object value) { if(value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }
        private static string Id(IDevice device) { Check(device.GetId(out string id)); return id; }
        private static string Name(IDevice device) {
            IProperties store=null;
            try {
                Check(device.OpenPropertyStore(0, out store));
                var key=new PropertyKey {format=new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), pid=14};
                Check(store.GetValue(ref key, out PropertyValue value));
                try { if(value.type != 31) throw new InvalidDataException("missing-device-name"); return Marshal.PtrToStringUni(value.pointer); }
                finally { PropVariantClear(ref value); }
            } finally { Release(store); }
        }
        private static List<Dictionary<string,string>> Devices(IDevices devices) {
            ICollection collection=null; var rows=new List<Dictionary<string,string>>();
            try {
                Check(devices.EnumAudioEndpoints(1, 1, out collection)); Check(collection.GetCount(out uint count));
                for(uint i=0;i<count;i++) { IDevice device=null; try { Check(collection.Item(i,out device)); rows.Add(new Dictionary<string,string>{{"endpointId",Id(device)},{"name",Name(device)}}); } finally { Release(device); } }
                return rows;
            } finally { Release(collection); }
        }
        public static void List() {
            IDevices devices=(IDevices)new EnumeratorObject();
            try { Console.WriteLine(JsonSerializer.Serialize(Devices(devices))); } finally { Release(devices); }
        }
        private static object Snapshot(IVolume volume) {
            string from=DateTimeOffset.UtcNow.ToString("O");
            Check(volume.GetMasterVolumeLevel(out float db)); Check(volume.GetMasterVolumeLevelScalar(out float scalar));
            Check(volume.GetMute(out bool muted)); Check(volume.GetChannelCount(out uint count));
            if(count < 1 || count > 32) throw new InvalidDataException("unsupported-channel-count");
            var channels=new float[count]; var scalars=new float[count];
            for(uint c=0;c<count;c++) { Check(volume.GetChannelVolumeLevel(c,out channels[c])); Check(volume.GetChannelVolumeLevelScalar(c,out scalars[c])); }
            return new {sampledFromUtc=from, sampledToUtc=DateTimeOffset.UtcNow.ToString("O"), masterDb=db, masterScalar=scalar, muted=muted, channelDb=channels, channelScalars=scalars};
        }
        public static void Watch(string runId, string endpointId, int maxSeconds) {
            IDevices devices=null; IDevice device=null; IVolume volume=null;
            var sink=new Notifications(endpointId); bool registered=false, deviceRegistered=false; int sequence=0;
            string reason="deadline"; Exception failure=null;
            var stop=new ManualResetEvent(false);
            Action<Dictionary<string,object>> emit=e=> {
                e["schemaVersion"]=1; e["runId"]=runId; e["endpointId"]=endpointId; e["sequence"]=sequence++;
                Console.WriteLine(JsonSerializer.Serialize(e)); Console.Out.Flush();
            };
            Action<int> drain=limit=> { for(int i=0;i<limit && sink.Take(out var e);i++) {
                if((string)e["event"]=="volume-change") {
                    try { e["laterReadback"]=Snapshot(volume); }
                    catch(Exception error) { e["laterReadbackError"]=error.Message; sink.failure="volume-readback-failed"; }
                }
                emit(e);
            } };
            try {
                devices=(IDevices)new EnumeratorObject();
                // Select only an explicitly listed active capture endpoint, never an OS default.
                bool found=false;
                foreach(var row in Devices(devices)) if(row["endpointId"]==endpointId) found=true;
                if(!found) throw new ArgumentException("selected-active-capture-endpoint-not-found");
                Check(devices.GetDevice(endpointId,out device));
                Guid iid=typeof(IVolume).GUID; Check(device.Activate(ref iid,23,IntPtr.Zero,out object raw)); volume=(IVolume)raw;
                Check(devices.RegisterEndpointNotificationCallback(sink)); deviceRegistered=true;
                Check(volume.RegisterControlChangeNotify(sink)); registered=true;
                var ready=sink.Event("ready"); ready["name"]=Name(device); ready["state"]=Snapshot(volume); ready["maxSeconds"]=maxSeconds; emit(ready);
                var reader=new Thread(()=> { try { while(true) { string line=Console.ReadLine(); if(line==null || line.Trim()=="stop") { stop.Set(); sink.wake.Set(); return; } } } catch { stop.Set(); sink.wake.Set(); } });
                reader.IsBackground=true; reader.Start();
                var deadline=Stopwatch.StartNew(); double nextHeartbeat=0;
                while(true) {
                    drain(256);
                    if(sink.failure != null) throw new InvalidOperationException(sink.failure);
                    if(stop.WaitOne(0)) { reason="stop-request"; break; }
                    if(deadline.Elapsed.TotalSeconds >= maxSeconds) break;
                    if(deadline.Elapsed.TotalSeconds >= nextHeartbeat) { emit(sink.Event("heartbeat")); nextHeartbeat=deadline.Elapsed.TotalSeconds+1; }
                    sink.wake.WaitOne(Math.Max(1, (int)((Math.Min(nextHeartbeat,maxSeconds)-deadline.Elapsed.TotalSeconds)*1000)));
                }
            } catch(Exception e) { failure=e; reason="error"; }
            finally {
                // Unregister outside callbacks and keep the sink alive until both registrations end.
                string listeningEndedAt=DateTimeOffset.UtcNow.ToString("O");
                try { if(registered) Check(volume.UnregisterControlChangeNotify(sink)); } catch(Exception e) { failure=e; }
                try { if(deviceRegistered) Check(devices.UnregisterEndpointNotificationCallback(sink)); } catch(Exception e) { failure=e; }
                try { drain(4096); } catch(Exception e) { failure=e; }
                if(sink.failure != null) failure=new InvalidOperationException(sink.failure);
                object final=null;
                try { if(volume != null) final=Snapshot(volume); } catch(Exception e) { failure=e; }
                var ended=sink.Event("stopped"); ended["reason"]=failure==null ? reason : "error"; ended["error"]=failure?.Message;
                ended["state"]=final; ended["callbacksUnregistered"]=failure==null; ended["listeningEndedAt"]=listeningEndedAt; emit(ended);
                GC.KeepAlive(sink); Release(volume); Release(device); Release(devices);
            }
            if(failure != null) throw new InvalidOperationException("Endpoint monitoring failed: "+failure.Message);
        }
        public static void SelfTest() {
            // Exercise the native payload decoder/callback without writing any endpoint setting.
            int size=Marshal.SizeOf<NotificationHeader>()+4; IntPtr data=Marshal.AllocHGlobal(size);
            try {
                var context=Guid.NewGuid(); var sink=new Notifications("synthetic");
                var h=new NotificationHeader {context=context, muted=1, masterScalar=.25f, channels=2, firstChannel=.25f};
                Marshal.StructureToPtr(h,data,false); Marshal.Copy(new float[]{.25f,.5f},0,IntPtr.Add(data,28),2);
                sink.OnNotify(data);
                if(!sink.Take(out var e) || sink.failure != null) throw new Exception("callback-did-not-queue");
                var n=(Dictionary<string,object>)e["notification"];
                if((string)n["eventContext"] != context.ToString() || ((float[])n["channelScalars"])[1] != .5f || !(bool)n["muted"]) throw new Exception("callback-data-mismatch");
                h.channels=33; Marshal.StructureToPtr(h,data,false); sink.OnNotify(data);
                if(sink.failure==null) throw new Exception("invalid-payload-accepted");
                var flooded=new Notifications("synthetic"); h.channels=2; Marshal.StructureToPtr(h,data,false);
                for(int i=0;i<4097;i++) flooded.OnNotify(data);
                if(flooded.failure != "notification-queue-overflow") throw new Exception("overflow-not-detected");
                Console.WriteLine("{\"selfTest\":\"passed\",\"endpointSettingsWritten\":false}");
            } finally { Marshal.FreeHGlobal(data); }
        }
    }
}
