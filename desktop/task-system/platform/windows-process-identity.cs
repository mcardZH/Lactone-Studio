// User-level external-run owner. No KILL_ON_JOB_CLOSE, breakaway, services or global limits.
using System;
using System.Text;
using System.IO;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

public static class ESProcessOwner {
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public uint pid, tid; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
    public int cb; public string reserved, desktop, title; public uint x,y,xSize,ySize,xCount,yCount,fill,flags; public ushort show,reserved2; public IntPtr reservedPtr,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
  [StructLayout(LayoutKind.Sequential)] struct US { public ushort length,maximum; public IntPtr buffer; }
  [DllImport("kernel32",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr sa,string name);
  [DllImport("kernel32",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
  [DllImport("kernel32",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,ref Accounting data,int length,IntPtr result);
  [DllImport("kernel32",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,IntPtr data,int length,out int result);
  [DllImport("kernel32",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
  [DllImport("kernel32",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
  [DllImport("kernel32",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process,int flags,StringBuilder name,ref int size);
  [DllImport("kernel32",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr sourceHandle,IntPtr target,out IntPtr targetHandle,uint access,bool inherit,uint options);
  [DllImport("advapi32",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("ntdll")] static extern int NtQueryInformationProcess(IntPtr process,int info,IntPtr data,int length,out int result);
  [DllImport("ntdll")] static extern int NtQuerySystemInformation(int info,IntPtr data,int length,out int result);
  [DllImport("kernel32",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string path,uint access,uint sharing,ref SA sa,uint disposition,uint flags,IntPtr template);
  [DllImport("shell32",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command,out int count);
  [DllImport("kernel32")] static extern IntPtr LocalFree(IntPtr memory);
  delegate bool WindowCallback(IntPtr window,IntPtr argument);
  [DllImport("user32",SetLastError=true)] static extern bool EnumWindows(WindowCallback callback,IntPtr argument);
  [DllImport("user32",SetLastError=true)] static extern bool EnumChildWindows(IntPtr window,WindowCallback callback,IntPtr argument);
  [DllImport("user32",SetLastError=true)] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32",SetLastError=true,CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int maximum);
  [DllImport("user32",SetLastError=true,CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder text,int maximum);
  [DllImport("user32")] static extern bool IsWindowVisible(IntPtr window);
  static Exception Error(string op) { return new Win32Exception(Marshal.GetLastWin32Error(),op); }
  public static string BootId() {
    IntPtr memory=Marshal.AllocHGlobal(64); try { int length; if(NtQuerySystemInformation(90,memory,64,out length)!=0) throw new Exception("BOOT_ID_UNAVAILABLE"); return ((Guid)Marshal.PtrToStructure(memory,typeof(Guid))).ToString(); } finally { Marshal.FreeHGlobal(memory); }
  }
  static string Command(IntPtr process) {
    int size; NtQueryInformationProcess(process,60,IntPtr.Zero,0,out size); if(size<Marshal.SizeOf(typeof(US)) || size>1048576) throw new Exception("COMMAND_IDENTITY_UNAVAILABLE");
    IntPtr memory=Marshal.AllocHGlobal(size); try { if(NtQueryInformationProcess(process,60,memory,size,out size)!=0) throw new Exception("COMMAND_IDENTITY_UNAVAILABLE"); US value=(US)Marshal.PtrToStructure(memory,typeof(US)); return Marshal.PtrToStringUni(value.buffer,value.length/2); } finally { Marshal.FreeHGlobal(memory); }
  }
  static Dictionary<string,object> InspectHandle(IntPtr process,uint pid) {
    long created,exited,kernel,user; if(!GetProcessTimes(process,out created,out exited,out kernel,out user)) throw Error("GetProcessTimes");
    var name=new StringBuilder(32768); int size=name.Capacity; if(!QueryFullProcessImageName(process,0,name,ref size)) throw Error("QueryFullProcessImageName");
    IntPtr token; if(!OpenProcessToken(process,8,out token)) throw Error("OpenProcessToken"); string sid; try { using(var identity=new WindowsIdentity(token)) { sid=identity.User.Value; } } finally { CloseHandle(token); }
    string command=Command(process); int count; IntPtr argv=CommandLineToArgvW(command,out count); if(argv==IntPtr.Zero) throw Error("CommandLineToArgvW"); var arguments=new string[count]; try { for(int i=0;i<count;i++) arguments[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv,i*IntPtr.Size)); } finally { LocalFree(argv); }
    return new Dictionary<string,object> { {"pid",pid},{"startedAt",DateTime.FromFileTimeUtc(created).ToString("o")},{"creationFileTime",created.ToString()},{"userId",sid},{"executableIdentity",name.ToString()},{"commandLine",command},{"argv",arguments},{"bootId",BootId()} };
  }
  public static Dictionary<string,object> Inspect(uint pid) {
    const uint queryReadSynchronize=0x101010,signaled=0,timeout=258;
    IntPtr process=OpenProcess(queryReadSynchronize,false,pid); if(process==IntPtr.Zero) { int error=Marshal.GetLastWin32Error(); return new Dictionary<string,object>{{"status",error==87 ? "dead":"unknown"},{"pid",pid},{"win32Error",error}}; }
    try {
      uint before=WaitForSingleObject(process,0);
      if(before==signaled) return new Dictionary<string,object>{{"status","dead"},{"pid",pid},{"waitResult",before}};
      if(before!=timeout) return new Dictionary<string,object>{{"status","unknown"},{"pid",pid},{"waitResult",before},{"reason","PROCESS_WAIT_UNVERIFIED"}};
      try {
        var result=InspectHandle(process,pid); uint after=WaitForSingleObject(process,0);
        result["status"]=after==signaled ? "dead":after==timeout ? "alive":"unknown"; result["waitResult"]=after;
        if(after!=signaled && after!=timeout) result["reason"]="PROCESS_WAIT_UNVERIFIED";
        return result;
      } catch(Exception error) {
        uint after=WaitForSingleObject(process,0); var nativeError=error as Win32Exception;
        return new Dictionary<string,object>{{"status",after==signaled ? "dead":"unknown"},{"pid",pid},{"waitResult",after},{"reason",after==signaled ? "PROCESS_SIGNALED_AFTER_IDENTITY_READ":"PROCESS_IDENTITY_UNREADABLE"},{"identityReadWin32Error",nativeError==null ? 0:nativeError.NativeErrorCode}};
      }
    } finally { CloseHandle(process); }
  }
  public static string Quote(string arg) {
    if(arg.IndexOf('\0')>=0) throw new Exception("NUL_ARGUMENT"); if(arg.Length>0 && arg.IndexOfAny(new char[]{' ','\t','\n','\v','"'})<0) return arg;
    var value=new StringBuilder("\""); int slashes=0; foreach(char ch in arg) { if(ch=='\\') { slashes++; continue; } if(ch=='"') { value.Append('\\',slashes*2+1); value.Append(ch); } else { value.Append('\\',slashes); value.Append(ch); } slashes=0; } value.Append('\\',slashes*2); value.Append('"'); return value.ToString();
  }
  static string CheckedWindowsFilePath(string value,bool directory=false) {
    if(String.IsNullOrEmpty(value)) throw new Exception("GAUSSIAN_WINDOWS_ABSOLUTE_PATH_REQUIRED");
    foreach(char ch in value) if(Char.IsControl(ch) || "\"<>|?*".IndexOf(ch)>=0) throw new Exception("GAUSSIAN_WINDOWS_FILE_PATH_INVALID");
    if(value.StartsWith(@"\\?\") || value.StartsWith(@"\\.\")) throw new Exception("GAUSSIAN_WINDOWS_DEVICE_PATH_REFUSED");
    bool drive=value.Length>=3 && Char.IsLetter(value[0]) && value[1]==':' && (value[2]=='\\' || value[2]=='/');
    bool unc=value.StartsWith(@"\\") && value.Length>2;
    if(!drive && !unc) throw new Exception("GAUSSIAN_WINDOWS_ABSOLUTE_PATH_REQUIRED");
    foreach(string part in value.Split(new char[]{'\\','/'})) if(part=="." || part=="..") throw new Exception("GAUSSIAN_WINDOWS_FILE_PATH_INVALID");
    string full=Path.GetFullPath(value),root=Path.GetPathRoot(full);
    if(directory && full.Length>root.Length) full=full.TrimEnd('\\');
    string rest=full.Substring(root.Length);
    if((!directory && rest.Length==0) || rest.EndsWith(@"\")) throw new Exception("GAUSSIAN_WINDOWS_FILE_PATH_INVALID");
    foreach(string part in rest.Split('\\')) {
      if(directory && rest.Length==0) break;
      if(part.Length==0 || part.EndsWith(".") || part.EndsWith(" ") || part.IndexOf(':')>=0) throw new Exception("GAUSSIAN_WINDOWS_FILE_PATH_INVALID");
      string basename=part.Split('.')[0].ToUpperInvariant();
      if(basename=="CON" || basename=="PRN" || basename=="AUX" || basename=="NUL" ||
        (basename.Length==4 && (basename.StartsWith("COM") || basename.StartsWith("LPT")) && basename[3]>='1' && basename[3]<='9')) throw new Exception("GAUSSIAN_WINDOWS_DEVICE_PATH_REFUSED");
    }
    return full;
  }
  static void CheckNoReparsePath(string value) {
    string current=value;
    while(!String.IsNullOrEmpty(current)) {
      if((File.GetAttributes(current) & FileAttributes.ReparsePoint)!=0) throw new Exception("GAUSSIAN_WINDOWS_LINK_REFUSED");
      string parent=Path.GetDirectoryName(current); if(parent==current) break; current=parent;
    }
  }
  public static string BuildCommand(string executable,string[] args,string cwd,string argumentSerialization) {
    if(String.IsNullOrEmpty(argumentSerialization)) {
      var standard=new StringBuilder(Quote(executable)); foreach(string arg in args) standard.Append(" ").Append(Quote(arg)); return standard.ToString();
    }
    if(argumentSerialization!="gaussian-windows-options-v1") throw new Exception("UNSUPPORTED_ARGUMENT_SERIALIZATION");
    string exe=CheckedWindowsFilePath(executable),directory=CheckedWindowsFilePath(cwd,true);
    if(!String.Equals(Path.GetFileName(exe),"g16w.exe",StringComparison.OrdinalIgnoreCase)) throw new Exception("GAUSSIAN_WINDOWS_EXECUTABLE_REQUIRED");
    if(args==null || args.Length!=3 || args[0]!="-run" || args[1]==null || args[2]==null || !args[1].StartsWith("-inp=",StringComparison.Ordinal) || !args[2].StartsWith("-out=",StringComparison.Ordinal)) throw new Exception("GAUSSIAN_WINDOWS_THREE_FLAGS_REQUIRED");
    string input=CheckedWindowsFilePath(args[1].Substring(5)),output=CheckedWindowsFilePath(args[2].Substring(5));
    string scope=directory.TrimEnd('\\')+@"\";
    foreach(string file in new string[]{input,output}) if(!file.StartsWith(scope,StringComparison.OrdinalIgnoreCase)) throw new Exception("GAUSSIAN_WINDOWS_OWNED_PATH_REQUIRED");
    if(String.Equals(input,output,StringComparison.OrdinalIgnoreCase)) throw new Exception("GAUSSIAN_WINDOWS_DISTINCT_FILES_REQUIRED");
    if(!File.Exists(input) || Directory.Exists(input) || File.Exists(output) || Directory.Exists(output)) throw new Exception("GAUSSIAN_WINDOWS_FRESH_INPUT_OUTPUT_REQUIRED");
    CheckNoReparsePath(input); CheckNoReparsePath(Path.GetDirectoryName(output));
    // G16W parses these option values itself. Whole-argument CRT quoting is different.
    // Only this closed three-flag mode may use this exact option-value spelling.
    return "\""+executable+"\" -run -inp=\""+args[1].Substring(5)+"\" -out=\""+args[2].Substring(5)+"\"";
  }
  public sealed class LaunchOwner : IDisposable {
    public IntPtr Job,Process; public uint Pid; public Dictionary<string,object> Identity;
    public uint Active() { return AccountingFor(Job).active; }
    public bool RootEnded() { return WaitForSingleObject(Process,0)==0; }
    public long ExitCode() { uint code; if(!RootEnded() || !GetExitCodeProcess(Process,out code)) throw new Exception("ROOT_NOT_ENDED"); return code; }
    public void Dispose() { if(Process!=IntPtr.Zero) { CloseHandle(Process); Process=IntPtr.Zero; } if(Job!=IntPtr.Zero) { CloseHandle(Job); Job=IntPtr.Zero; } }
  }
  static Accounting AccountingFor(IntPtr job) { var data=new Accounting(); if(!QueryInformationJobObject(job,1,ref data,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw Error("QueryInformationJobObject"); return data; }
  static uint[] MembersFor(IntPtr job) {
    int capacity=32;
    while(capacity<=4096) {
      int bytes=8+capacity*IntPtr.Size; IntPtr memory=Marshal.AllocHGlobal(bytes);
      try {
        int returned; bool ok=QueryInformationJobObject(job,3,memory,bytes,out returned);
        if(!ok) { int code=Marshal.GetLastWin32Error(); if(code==234) { capacity*=2; continue; } throw new Win32Exception(code,"Query Job members"); }
        uint count=(uint)Marshal.ReadInt32(memory,4);
        if(count>capacity) { capacity*=2; continue; }
        var members=new uint[count]; for(int i=0;i<count;i++) members[i]=checked((uint)Marshal.ReadIntPtr(memory,8+i*IntPtr.Size).ToInt64());
        return members;
      } finally { Marshal.FreeHGlobal(memory); }
    }
    throw new Exception("JOB_MEMBER_SNAPSHOT_UNAVAILABLE");
  }
  static bool SameArguments(string[] expected,string[] actual) {
    if(expected==null || actual==null || expected.Length!=actual.Length) return false;
    for(int i=0;i<expected.Length;i++) if(!String.Equals(expected[i],actual[i],StringComparison.Ordinal)) return false;
    return true;
  }
  static bool SameRoot(Dictionary<string,object> actual,string created,string started,string user,string executable,string command,string boot,string[] argv) {
    return (string)actual["creationFileTime"]==created && (string)actual["startedAt"]==started && (string)actual["userId"]==user &&
      String.Equals((string)actual["executableIdentity"],executable,StringComparison.OrdinalIgnoreCase) &&
      (string)actual["commandLine"]==command && (string)actual["bootId"]==boot && SameArguments(argv,(string[])actual["argv"]);
  }
  static bool CanReadTitle(string windowClass) {
    if(String.IsNullOrEmpty(windowClass)) return false;
    foreach(string inputClass in new string[]{"edit","textbox","combobox","input"})
      if(windowClass.IndexOf(inputClass,StringComparison.OrdinalIgnoreCase)>=0) return false;
    return true;
  }
  static object[] RootWindows(uint target,out bool truncated) {
    var windows=new List<object>(); bool limited=false;
    bool enumerated=EnumWindows(delegate(IntPtr window,IntPtr ignored) {
      uint pid; GetWindowThreadProcessId(window,out pid); if(pid!=target) return true;
      if(windows.Count>=64) { limited=true; return true; }
      var title=new StringBuilder(512); var cls=new StringBuilder(128);
      GetClassName(window,cls,cls.Capacity);
      bool titleRead=CanReadTitle(cls.ToString());
      if(titleRead) GetWindowText(window,title,title.Capacity);
      var labels=new List<string>(); bool labelsLimited=false;
      EnumChildWindows(window,delegate(IntPtr child,IntPtr unused) {
        uint owner; GetWindowThreadProcessId(child,out owner); if(owner!=target) return true;
        if(labels.Count>=128) { labelsLimited=true; return true; }
        var childClass=new StringBuilder(128); GetClassName(child,childClass,childClass.Capacity);
        // Do not request Edit/RichEdit/other control contents, or any other PID's text.
        if(String.Equals(childClass.ToString(),"Static",StringComparison.Ordinal)) {
          var label=new StringBuilder(1024); GetWindowText(child,label,label.Capacity); labels.Add(label.ToString());
          if(label.Length>=label.Capacity-1) labelsLimited=true;
        }
        return true;
      },IntPtr.Zero);
      windows.Add(new Dictionary<string,object>{{"handle",window.ToInt64().ToString("x")},{"title",titleRead ? title.ToString():null},{"titleRead",titleRead},{"windowClass",cls.ToString()},{"visible",IsWindowVisible(window)},{"staticLabels",labels.ToArray()},{"textTruncated",labelsLimited || title.Length>=title.Capacity-1}});
      return true;
    },IntPtr.Zero);
    if(!enumerated) throw Error("Enumerate owned root windows");
    truncated=limited; return windows.ToArray();
  }
  // The script Job is the lifetime/stop owner. Observe only a unique, pinned native
  // installation member in that exact Job; never search the machine by image name.
  public static Dictionary<string,object> OwnedNativeWindows(uint rootPid,string created,string started,string user,string executable,string command,string boot,string[] argv,string jobName,string nativeExecutable) {
    IntPtr job=IntPtr.Zero,native=IntPtr.Zero; var consoleHandles=new List<IntPtr>();
    try {
      if(!String.Equals(boot,BootId(),StringComparison.Ordinal)) throw new Exception("BOOT_IDENTITY_MISMATCH");
      job=OpenJobObject(0x0004,false,jobName); if(job==IntPtr.Zero) throw Error("Open exact native Job");
      var before=MembersFor(job); uint nativePid=0; Dictionary<string,object> identity=null; var identities=new List<object>(); var consoleHosts=new HashSet<uint>();
      foreach(uint memberPid in before) {
        IntPtr process=OpenProcess(0x101010,false,memberPid); if(process==IntPtr.Zero) throw Error("Open exact Job member");
        try {
          bool member; if(!IsProcessInJob(process,job,out member) || !member) throw new Exception("NATIVE_JOB_MEMBERSHIP_UNVERIFIED");
          var actual=InspectHandle(process,memberPid);
          identities.Add(new Dictionary<string,object>{{"pid",memberPid},{"executableIdentity",actual["executableIdentity"]},{"creationFileTime",actual["creationFileTime"]}});
          if((string)actual["userId"]==user && String.Equals((string)actual["executableIdentity"],Path.Combine(Environment.SystemDirectory,"conhost.exe"),StringComparison.OrdinalIgnoreCase)) {
            bool consoleTruncated; var consoleWindows=RootWindows(memberPid,out consoleTruncated); bool hidden=!consoleTruncated;
            foreach(Dictionary<string,object> window in consoleWindows) if((bool)window["visible"]) hidden=false;
            if(hidden) { consoleHosts.Add(memberPid); consoleHandles.Add(process); process=IntPtr.Zero; }
          }
          if(memberPid==rootPid && !SameRoot(actual,created,started,user,executable,command,boot,argv)) throw new Exception("SCRIPT_ROOT_IDENTITY_MISMATCH");
          if(memberPid!=rootPid && String.Equals((string)actual["executableIdentity"],nativeExecutable,StringComparison.OrdinalIgnoreCase) && (string)actual["userId"]==user) {
            if(nativePid!=0) throw new Exception("MULTIPLE_NATIVE_OWNERS");
            nativePid=memberPid; identity=actual; native=process; process=IntPtr.Zero;
          }
        } finally { if(process!=IntPtr.Zero) CloseHandle(process); }
      }
      if(nativePid==0) return new Dictionary<string,object>{{"status","unknown"},{"reason","NATIVE_OWNER_NOT_OBSERVED"},{"windows",new object[0]}};
      bool truncated; object[] windows=RootWindows(nativePid,out truncated);
      var after=MembersFor(job); bool nativeOnly=true;
      foreach(uint memberPid in before) if(memberPid!=rootPid && memberPid!=nativePid && !consoleHosts.Contains(memberPid)) nativeOnly=false;
      foreach(uint memberPid in after) if(memberPid!=rootPid && memberPid!=nativePid && !consoleHosts.Contains(memberPid)) nativeOnly=false;
      if(before.Length!=after.Length) nativeOnly=false;
      foreach(IntPtr console in consoleHandles) { bool member; if(!IsProcessInJob(console,job,out member) || !member || WaitForSingleObject(console,0)!=0x102) nativeOnly=false; }
      bool stillMember; if(!IsProcessInJob(native,job,out stillMember) || !stillMember || WaitForSingleObject(native,0)!=0x102) throw new Exception("NATIVE_CHANGED_DURING_WINDOW_OBSERVATION");
      var current=InspectHandle(native,nativePid);
      if((string)current["creationFileTime"]!=(string)identity["creationFileTime"] || (string)current["commandLine"]!=(string)identity["commandLine"]) throw new Exception("NATIVE_IDENTITY_CHANGED");
      return new Dictionary<string,object>{{"status","alive"},{"identityMatched",true},{"jobMembershipVerified",true},{"nativeOnly",nativeOnly},{"nativeIdentity",identity},{"memberIdentities",identities.ToArray()},{"memberPids",after},{"windows",windows},{"truncated",truncated},{"checkedAt",DateTime.UtcNow.ToString("o")}};
    } catch(Exception failure) { return new Dictionary<string,object>{{"status","unknown"},{"reason",failure.Message},{"windows",new object[0]},{"nativeOnly",false}}; }
    finally { foreach(IntPtr console in consoleHandles) CloseHandle(console); if(native!=IntPtr.Zero) CloseHandle(native); if(job!=IntPtr.Zero) CloseHandle(job); }
  }
  public static Dictionary<string,object> OwnedWindows(uint pid,string created,string started,string user,string executable,string command,string boot,string[] argv,string jobName) {
    IntPtr job=IntPtr.Zero,process=IntPtr.Zero;
    try {
      if(!String.Equals(boot,BootId(),StringComparison.Ordinal)) return new Dictionary<string,object>{{"status","conflict"},{"reason","BOOT_IDENTITY_MISMATCH"},{"windows",new object[0]}};
      job=OpenJobObject(0x0004,false,jobName); if(job==IntPtr.Zero) throw Error("Open exact Job for owned windows");
      // SYNCHRONIZE pins the verified original process while windows are enumerated.
      process=OpenProcess(0x101010,false,pid); if(process==IntPtr.Zero) throw Error("Open exact root for owned windows");
      if(!SameRoot(InspectHandle(process,pid),created,started,user,executable,command,boot,argv)) return new Dictionary<string,object>{{"status","conflict"},{"reason","ROOT_IDENTITY_MISMATCH"},{"windows",new object[0]}};
      bool member; if(!IsProcessInJob(process,job,out member)) throw Error("IsProcessInJob");
      if(!member) return new Dictionary<string,object>{{"status","unknown"},{"reason","ROOT_JOB_MEMBERSHIP_UNVERIFIED"},{"windows",new object[0]}};
      if(WaitForSingleObject(process,0)!=0x102) throw new Exception("ROOT_NOT_CONFIRMED_ALIVE");
      var before=AccountingFor(job); var membersBefore=MembersFor(job);
      bool truncated; object[] windows=RootWindows(pid,out truncated);
      var after=AccountingFor(job); var membersAfter=MembersFor(job);
      bool memberAfter; if(!IsProcessInJob(process,job,out memberAfter) || !memberAfter || WaitForSingleObject(process,0)!=0x102) throw new Exception("ROOT_CHANGED_DURING_WINDOW_OBSERVATION");
      if(!SameRoot(InspectHandle(process,pid),created,started,user,executable,command,boot,argv)) throw new Exception("ROOT_IDENTITY_CHANGED_DURING_WINDOW_OBSERVATION");
      bool rootOnly=before.active==1 && after.active==1 && membersBefore.Length==1 && membersAfter.Length==1 && membersBefore[0]==pid && membersAfter[0]==pid;
      return new Dictionary<string,object>{{"status","alive"},{"identityMatched",true},{"jobMembershipVerified",true},{"pid",pid},{"activeProcesses",after.active},{"totalProcesses",after.total},{"memberPids",membersAfter},{"rootOnly",rootOnly},{"windows",windows},{"truncated",truncated},{"checkedAt",DateTime.UtcNow.ToString("o")}};
    } catch(Exception failure) { return new Dictionary<string,object>{{"status","unknown"},{"reason",failure.Message},{"windows",new object[0]},{"rootOnly",false}}; }
    finally { if(process!=IntPtr.Zero) CloseHandle(process); if(job!=IntPtr.Zero) CloseHandle(job); }
  }
  public static LaunchOwner Launch(string executable,string[] args,string cwd,string environment,string stdin,string stdout,string stderr,string jobName) {
    return Launch(executable,args,cwd,environment,stdin,stdout,stderr,jobName,null);
  }
  public static LaunchOwner Launch(string executable,string[] args,string cwd,string environment,string stdin,string stdout,string stderr,string jobName,string argumentSerialization) {
    string serialized=BuildCommand(executable,args,cwd,argumentSerialization);
    IntPtr job=CreateJobObject(IntPtr.Zero,jobName); int jobError=Marshal.GetLastWin32Error(); if(job==IntPtr.Zero) throw Error("CreateJobObject"); if(jobError==183) { CloseHandle(job); throw new Exception("JOB_NAME_ALREADY_EXISTS"); }
    var handles=new List<IntPtr>(); IntPtr env=IntPtr.Zero; PI pi=new PI(); bool resumed=false;
    try {
      var sa=new SA { length=Marshal.SizeOf(typeof(SA)),inherit=true }; var si=new SI { cb=Marshal.SizeOf(typeof(SI)),flags=0x100 };
      string[] paths={String.IsNullOrEmpty(stdin) ? "NUL":stdin,String.IsNullOrEmpty(stdout) ? "NUL":stdout,String.IsNullOrEmpty(stderr) ? "NUL":stderr}; IntPtr[] streams=new IntPtr[3];
      for(int i=0;i<3;i++) { streams[i]=CreateFile(paths[i],i==0 ? 0x80000000u:0x40000000u,7,ref sa,i==0 || paths[i]=="NUL" ? 3u:1u,0x80,IntPtr.Zero); if(streams[i]==new IntPtr(-1)) throw Error("CreateFile stdio"); handles.Add(streams[i]); }
      si.input=streams[0]; si.output=streams[1]; si.error=streams[2];
      env=Marshal.StringToHGlobalUni(environment); var command=new StringBuilder(serialized);
      // Break away from the launcher's libuv Job (which may kill children on close).
      // An enclosing job that denies breakaway causes an explicit launch failure.
      if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x09000404,env,cwd,ref si,out pi)) throw Error("CreateProcess suspended breakaway");
      if(!AssignProcessToJobObject(job,pi.process)) throw Error("AssignProcessToJobObject");
      // Keep the name reopenable even if every ES/helper process disappears.
      // The native root owns this non-inheritable kernel handle until its actual
      // exit; it is not a kill-on-close handle and no code is injected.
      IntPtr rootJobHandle; if(!DuplicateHandle(new IntPtr(-1),job,pi.process,out rootJobHandle,0,false,2)) throw Error("Duplicate Job handle into native root");
      var identity=InspectHandle(pi.process,pi.pid); if(ResumeThread(pi.thread)==0xffffffff) throw Error("ResumeThread"); resumed=true;
      return new LaunchOwner { Job=job,Process=pi.process,Pid=pi.pid,Identity=identity };
    } catch { if(pi.process!=IntPtr.Zero) { if(!resumed) TerminateProcess(pi.process,0xe5000001); CloseHandle(pi.process); } CloseHandle(job); throw; }
    finally { if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread); if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env); foreach(IntPtr handle in handles) CloseHandle(handle); }
  }
  public static Dictionary<string,object> Job(string name,bool stop) {
    // A retained Job handle pins this exact kernel object across verification and stop.
    IntPtr job=OpenJobObject(stop ? 0x000cU:0x0004U,false,name); if(job==IntPtr.Zero) { int error=Marshal.GetLastWin32Error(); return new Dictionary<string,object>{{"status",error==2 ? "absent":"unknown"},{"win32Error",error}}; }
    try {
      var accounting=AccountingFor(job);
      if(stop) {
        if(!TerminateJobObject(job,0xe5000002)) throw Error("TerminateJobObject");
        // Retain this exact object until zero is observed, or this control lease
        // expires. This bounds only evidence collection, never science runtime.
        var until=DateTime.UtcNow.AddSeconds(5); do { accounting=AccountingFor(job); if(accounting.active==0) break; System.Threading.Thread.Sleep(10); } while(DateTime.UtcNow<until);
      }
      return new Dictionary<string,object>{{"status",accounting.active>0 ? "alive":"dead"},{"activeProcesses",accounting.active},{"totalProcesses",accounting.total},{"stopRequested",stop}};
    } finally { CloseHandle(job); }
  }
}
