// Read-only ownership inspector. Struct prefixes follow pinned golang.org/x/sys/windows v0.46.0.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class DmJobInspector {
    [StructLayout(LayoutKind.Sequential)] struct US {public ushort Length,MaximumLength;public IntPtr Buffer;}
    [StructLayout(LayoutKind.Sequential)] struct SPI {
        public uint NextEntryOffset,NumberOfThreads;public long WorkingSetPrivateSize;
        public uint HardFaultCount,NumberOfThreadsHighWatermark;public ulong CycleTime;
        public long CreateTime,UserTime,KernelTime;public US ImageName;public int BasePriority;
        public UIntPtr UniqueProcessID,InheritedFromUniqueProcessID;public uint HandleCount,SessionID;
    }
    [StructLayout(LayoutKind.Sequential)] struct OA {public uint Length;public IntPtr RootDirectory,ObjectName;public uint Attributes;public IntPtr SecurityDescriptor,SecurityQoS;}
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNT {public long a,b,c,d;public uint faults,total,active,terminated;}
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct PE {public uint size,usage,pid;public UIntPtr heap;public uint module,threads,parent;public int priority;public uint flags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string image;}
    [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int kind,IntPtr data,uint size,out uint used);
    [DllImport("ntdll.dll")] static extern int NtOpenJobObject(out IntPtr job,uint access,ref OA attributes);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process,int kind,out uint session,uint size,out uint used);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out ACCOUNT value,uint size,IntPtr used);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern ulong GetTickCount64();
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot,ref PE entry);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot,ref PE entry);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
    [DllImport("kernel32.dll")] static extern void GetSystemTimePreciseAsFileTime(out long time);
    public class Row {public int pid,parent,session;public string createdTicks,image,identityBasis;}
    public class Job {public string path,status;public uint active;}
    public class Result {public string schema="dream-maker.windows-job-os-snapshot.v1",at,bootTicks,captureStartTicks,enumeration;public bool identitiesBound;public int processCount,bufferBytes;public Row[] processes;public Job[] jobs;}
    const long FILETIME_OFFSET=504911232000000000L;
    static string Ticks(long raw){return raw<=0?"0":checked(raw+FILETIME_OFFSET).ToString(System.Globalization.CultureInfo.InvariantCulture);}
    static List<Row> Snapshot(out int byteCount,out long boot){
        if(IntPtr.Size!=8||Marshal.OffsetOf(typeof(SPI),"UniqueProcessID").ToInt32()!=80||Marshal.OffsetOf(typeof(SPI),"SessionID").ToInt32()!=100)throw new InvalidOperationException("SNAPSHOT_LAYOUT_UNVERIFIED");
        IntPtr clock=Marshal.AllocHGlobal(48);try{uint length;int status=NtQuerySystemInformation(3,clock,48,out length);if(status!=0)throw new InvalidOperationException("OS_BOOT_QUERY_FAILED_"+unchecked((uint)status).ToString("x8")+"_"+length);boot=Marshal.ReadInt64(clock);}finally{Marshal.FreeHGlobal(clock);}
        uint size=1048576;byteCount=0;
        for(int attempt=0;attempt<6;attempt++){
            if(size>33554432)throw new InvalidOperationException("SNAPSHOT_LIMIT");IntPtr data=Marshal.AllocHGlobal(checked((int)size));
            try{
                uint used;int status=NtQuerySystemInformation(5,data,size,out used);
                if(unchecked((uint)status)==0xc0000004){size=Math.Max(checked(size*2),used);continue;}
                if(status!=0||used==0||used>size)throw new InvalidOperationException("SNAPSHOT_QUERY_FAILED");
                var rows=new List<Row>();int offset=0;long start=data.ToInt64(),end=checked(start+used);var seen=new HashSet<int>();
                while(true){
                    if(offset<0||checked(offset+Marshal.SizeOf(typeof(SPI)))>used||rows.Count>=32768)throw new InvalidOperationException("SNAPSHOT_TRUNCATED");
                    SPI s=(SPI)Marshal.PtrToStructure(IntPtr.Add(data,offset),typeof(SPI));int pid=checked((int)s.UniqueProcessID.ToUInt64()),parent=checked((int)s.InheritedFromUniqueProcessID.ToUInt64());
                    if(!seen.Add(pid)||s.ImageName.Length%2!=0||s.ImageName.MaximumLength<s.ImageName.Length)throw new InvalidOperationException("SNAPSHOT_ENTRY_INVALID");
                    string image="";if(s.ImageName.Length>0){long p=s.ImageName.Buffer.ToInt64();if(p<start||checked(p+s.ImageName.Length)>end)throw new InvalidOperationException("SNAPSHOT_NAME_OUTSIDE_BUFFER");image=Marshal.PtrToStringUni(s.ImageName.Buffer,s.ImageName.Length/2);}
                    long time=s.CreateTime;if(time<=0&&(pid==0||pid==4))time=boot;
                    rows.Add(new Row{pid=pid,parent=parent,session=checked((int)s.SessionID),createdTicks=Ticks(time),image=image});
                    if(s.NextEntryOffset==0)break;
                    if(s.NextEntryOffset<Marshal.SizeOf(typeof(SPI))||s.NextEntryOffset>used||checked(offset+s.NextEntryOffset)>=used)throw new InvalidOperationException("SNAPSHOT_NEXT_INVALID");
                    offset=checked(offset+(int)s.NextEntryOffset);
                }
                byteCount=checked((int)used);return rows;
            }finally{Marshal.FreeHGlobal(data);}
        }throw new InvalidOperationException("SNAPSHOT_CHANGED_TOO_FAST");
    }
    static Job Query(string path){
        IntPtr buffer=Marshal.StringToHGlobalUni(path),name=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(US))),handle=IntPtr.Zero;
        try{
            var text=new US{Length=checked((ushort)(path.Length*2)),MaximumLength=checked((ushort)(path.Length*2+2)),Buffer=buffer};Marshal.StructureToPtr(text,name,false);
            var attributes=new OA{Length=(uint)Marshal.SizeOf(typeof(OA)),ObjectName=name,Attributes=0x40};int code=NtOpenJobObject(out handle,4,ref attributes);
            if(unchecked((uint)code)==0xc0000034||unchecked((uint)code)==0xc000003a)return new Job{path=path,status="ABSENT",active=0};
            if(code!=0||handle==IntPtr.Zero)throw new InvalidOperationException("JOB_OPEN_UNVERIFIED_"+unchecked((uint)code).ToString("x8"));
            ACCOUNT account;if(!QueryInformationJobObject(handle,1,out account,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero))throw new InvalidOperationException("JOB_QUERY_FAILED");
            return new Job{path=path,status="QUERIED",active=account.active};
        }finally{if(handle!=IntPtr.Zero)CloseHandle(handle);Marshal.FreeHGlobal(name);Marshal.FreeHGlobal(buffer);}
    }
    static List<Row> PinnedSnapshot(long boot,long originTicks,out string captureStart){
        long begin;GetSystemTimePreciseAsFileTime(out begin);captureStart=Ticks(begin);
        IntPtr snapshot=CreateToolhelp32Snapshot(2,0);if(snapshot==new IntPtr(-1))throw new InvalidOperationException("TOOLHELP_SNAPSHOT_FAILED");
        var handles=new List<IntPtr>();var times=new List<long>();var rows=new List<Row>();var ids=new HashSet<int>();var denied=new List<PE>();
        try{
            var entry=new PE{size=(uint)Marshal.SizeOf(typeof(PE))};if(!Process32FirstW(snapshot,ref entry))throw new InvalidOperationException("TOOLHELP_FIRST_FAILED");
            do{
                if(ids.Count>=32768||!ids.Add(checked((int)entry.pid)))throw new InvalidOperationException("TOOLHELP_ENTRY_INVALID");
                long created=boot;uint session=0;
                if(entry.pid!=0&&entry.pid!=4){
                    IntPtr process=OpenProcess(0x1000,false,entry.pid);if(process==IntPtr.Zero){if(Marshal.GetLastWin32Error()!=5)throw new InvalidOperationException("SNAPSHOT_PROCESS_UNREADABLE_"+entry.pid);denied.Add(entry);continue;}handles.Add(process);
                    long exited,kernel,user;uint used;if(!GetProcessTimes(process,out created,out exited,out kernel,out user)||created<=0||created>=begin||NtQueryInformationProcess(process,24,out session,4,out used)!=0)throw new InvalidOperationException("SNAPSHOT_PROCESS_CHANGED_"+entry.pid);times.Add(created);
                }
                rows.Add(new Row{pid=checked((int)entry.pid),parent=checked((int)entry.parent),session=checked((int)session),createdTicks=Ticks(created),image=entry.image,identityBasis=entry.pid==0||entry.pid==4?"KERNEL_BOOT_IDENTITY":"HANDLE_BOUND_IDENTITY"});
                entry.size=(uint)Marshal.SizeOf(typeof(PE));
            }while(Process32NextW(snapshot,ref entry));
            if(Marshal.GetLastWin32Error()!=18)throw new InvalidOperationException("TOOLHELP_ENUMERATION_INCOMPLETE");
            // Access denial never omits a frozen entry. A post-freeze native
            // observation must bind the same PID/name/parent with birth STRICTLY
            // before capture began; a replacement object cannot satisfy that bound.
            // Membership still comes only from Toolhelp, never this NT observation.
            if(denied.Count>0){int nativeBytes;long nativeBoot;var current=Snapshot(out nativeBytes,out nativeBoot);if(nativeBoot!=boot)throw new InvalidOperationException("OS_BOOT_CHANGED_DURING_CAPTURE");foreach(var entryDenied in denied){Row found=current.Find(r=>r.pid==entryDenied.pid);long ticks;if(found==null||!long.TryParse(found.createdTicks,out ticks)||ticks<=0||ticks>=checked(begin+FILETIME_OFFSET)||found.parent!=entryDenied.parent||!String.Equals(found.image,entryDenied.image,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("PROTECTED_PROCESS_ORIGIN_UNPROVEN_"+entryDenied.pid);found.identityBasis="POST_FREEZE_BOUND_IDENTITY";rows.Add(found);}}
            for(int n=0;n<handles.Count;n++){long created,exited,kernel,user;if(!GetProcessTimes(handles[n],out created,out exited,out kernel,out user)||created!=times[n])throw new InvalidOperationException("SNAPSHOT_IDENTITY_CHANGED");}
            return rows;
        }finally{foreach(IntPtr process in handles)CloseHandle(process);CloseHandle(snapshot);}
    }
    public static Result Inspect(string jobId,string originalTicks){
        if(!System.Text.RegularExpressions.Regex.IsMatch(jobId,"^windows_job_[a-f0-9]{20}$"))throw new InvalidOperationException("JOB_ID_INVALID");
        long origin;if(!long.TryParse(originalTicks,out origin)||origin<=FILETIME_OFFSET)throw new InvalidOperationException("ORIGIN_IDENTITY_INVALID");
        int bytes;long boot;Snapshot(out bytes,out boot);if(checked(boot+FILETIME_OFFSET)>=origin)throw new InvalidOperationException("BOOT_OR_CLOCK_CHANGE_REQUIRES_SEPARATE_PROOF");string captured;var rows=PinnedSnapshot(boot,origin,out captured);var sessions=new SortedSet<int>{0,Process.GetCurrentProcess().SessionId};foreach(var row in rows)sessions.Add(row.session);
        if(sessions.Count>128)throw new InvalidOperationException("SESSION_LIMIT");var jobs=new List<Job>();foreach(int session in sessions)jobs.Add(Query("\\Sessions\\"+session+"\\BaseNamedObjects\\DreamMaker_"+jobId));jobs.Add(Query("\\BaseNamedObjects\\DreamMaker_"+jobId));
        return new Result{at=DateTime.UtcNow.ToString("o"),bootTicks=Ticks(boot),processCount=rows.Count,bufferBytes=bytes,processes=rows.ToArray(),jobs=jobs.ToArray(),captureStartTicks=captured,enumeration="TOOLHELP_FROZEN_LIST_WITH_BOUND_IDENTITIES",identitiesBound=true};
    }
    public static Row ReadIdentity(int pid){int bytes;long boot;var rows=Snapshot(out bytes,out boot);Row value=rows.Find(row=>row.pid==pid);if(value==null)throw new InvalidOperationException("SERVICE_IDENTITY_UNAVAILABLE");return value;}
    public static string UptimeMilliseconds(){return GetTickCount64().ToString(System.Globalization.CultureInfo.InvariantCulture);}
}
