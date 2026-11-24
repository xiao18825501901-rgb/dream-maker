// Trusted controller process lifetime boundary. Not a filesystem/network sandbox.
// The child is suspended until assigned; descendants cannot request breakaway from this Job.
using System;
using System.Text;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Threading;
public static class DreamMakerOwnedJob {
    const uint KILL_ON_CLOSE=0x2000,ACTIVE_LIMIT=8,MEMORY_LIMIT=0x200,CREATE_SUSPENDED=4,CREATE_NO_WINDOW=0x08000000;
    [StructLayout(LayoutKind.Sequential)] struct IO {public ulong a,b,c,d,e,f;}
    [StructLayout(LayoutKind.Sequential)] struct BASIC {public long a,b;public uint flags;public UIntPtr min,max;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
    [StructLayout(LayoutKind.Sequential)] struct LIMIT {public BASIC basic;public IO io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNT {public long a,b,c,d;public uint faults,total,active,terminated;}
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUP {public uint cb;public string reserved,desktop,title;public uint x,y,xsize,ysize,xc,yc,fill,flags;public ushort show,reservedSize;public IntPtr reservedPtr,stdin,stdout,stderr;}
    [StructLayout(LayoutKind.Sequential)] struct PROC {public IntPtr process,thread;public uint pid,tid;}
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref LIMIT limit,uint length);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out ACCOUNT value,uint length,IntPtr returned);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr psecurity,IntPtr tsecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUP startup,out PROC process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint millis);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Check(bool ok){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error());}
    public static string Quote(string value){
        var result=new StringBuilder("\"");int slashes=0;
        foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='\"'){result.Append('\\',slashes*2+1).Append(c);slashes=0;continue;}result.Append('\\',slashes).Append(c);slashes=0;}
        return result.Append('\\',slashes*2).Append('"').ToString();
    }
    static uint Active(IntPtr job){ACCOUNT value;Check(QueryInformationJobObject(job,1,out value,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero));return value.active;}
    static bool ParentAlive(int pid,long ticks){try{var p=Process.GetProcessById(pid);return !p.HasExited&&p.StartTime.ToUniversalTime().Ticks==ticks;}catch{return false;}}
    public static string Status(string name,int sessionId){
        if(Process.GetCurrentProcess().SessionId!=sessionId)throw new InvalidOperationException("WINDOWS_SESSION_CHANGED");
        IntPtr job=OpenJobObject(4,false,name);
        if(job==IntPtr.Zero){int error=Marshal.GetLastWin32Error();if(error==2)return "ABSENT";throw new Win32Exception(error);}
        try{return Active(job).ToString(System.Globalization.CultureInfo.InvariantCulture);}finally{CloseHandle(job);}
    }
    public static int Run(string binary,string[] args,string cwd,string jobName,string marker,int parentPid,long parentTicks,string requestHash){
        IntPtr job=CreateJobObject(IntPtr.Zero,jobName);Check(job!=IntPtr.Zero);
        if(Marshal.GetLastWin32Error()==183){CloseHandle(job);throw new InvalidOperationException("JOB_NAME_COLLISION");}
        PROC child=new PROC();bool assigned=false;
        try{
            var limit=new LIMIT();limit.basic.flags=KILL_ON_CLOSE|ACTIVE_LIMIT|MEMORY_LIMIT;limit.basic.active=64;limit.jobMemory=new UIntPtr(1073741824UL);
            Check(SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(typeof(LIMIT))));
            var startup=new STARTUP();startup.cb=(uint)Marshal.SizeOf(typeof(STARTUP));startup.flags=0x100;startup.stdin=GetStdHandle(-10);startup.stdout=GetStdHandle(-11);startup.stderr=GetStdHandle(-12);
            var command=new StringBuilder(Quote(binary));foreach(var arg in args)command.Append(' ').Append(Quote(arg));
            foreach(var key in new[]{"DM_OWNED_JOB_REQUEST","DM_OWNED_JOB_REQUEST_SHA256","DM_OWNED_JOB_SOURCE","DM_OWNED_JOB_SOURCE_SHA256"})Environment.SetEnvironmentVariable(key,null);
            Check(CreateProcess(binary,command,IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_NO_WINDOW,IntPtr.Zero,cwd,ref startup,out child));
            Check(AssignProcessToJobObject(job,child.process));assigned=true;
            // Publish before running the child. Values are controller-generated ASCII identities.
            string json="{\"schema\":\"dream-maker.windows-owned-job.v1\",\"jobName\":\""+jobName.Replace("\\","\\\\")+"\",\"wrapperPid\":"+Process.GetCurrentProcess().Id+",\"sessionId\":"+Process.GetCurrentProcess().SessionId+",\"wrapperTicks\":\""+Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks+"\",\"childPid\":"+child.pid+",\"parentPid\":"+parentPid+",\"parentTicks\":\""+parentTicks+"\",\"requestSha256\":\""+requestHash+"\",\"assignedBeforeResume\":true,\"killOnClose\":true,\"breakawayAllowed\":false,\"maxProcesses\":64,\"maxMemoryBytes\":1073741824}";
            using(var file=new FileStream(marker,FileMode.CreateNew,FileAccess.Write,FileShare.Read)){var bytes=new UTF8Encoding(false).GetBytes(json);file.Write(bytes,0,bytes.Length);file.Flush(true);}
            if(ResumeThread(child.thread)==0xffffffff)throw new Win32Exception(Marshal.GetLastWin32Error());
            uint code=75;
            while(WaitForSingleObject(child.process,250)==258){if(!ParentAlive(parentPid,parentTicks)){Check(TerminateJobObject(job,75));break;}}
            GetExitCodeProcess(child.process,out code);
            // A root can exit while an orphaned descendant keeps running. Terminate this Job only.
            Check(TerminateJobObject(job,75));
            for(int i=0;i<100&&Active(job)>0;i++)Thread.Sleep(25);
            if(Active(job)>0)throw new InvalidOperationException("JOB_CLEANUP_UNPROVEN");
            return unchecked((int)code);
        }finally{
            if(child.process!=IntPtr.Zero&&!assigned)TerminateProcess(child.process,75);
            if(child.thread!=IntPtr.Zero)CloseHandle(child.thread);
            if(child.process!=IntPtr.Zero)CloseHandle(child.process);
            CloseHandle(job);
        }
    }
}
