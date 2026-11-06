#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0600
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <wchar.h>
#include <wctype.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>

/* Only Windows system DLLs are needed. Electron owns windows and workers;
 * this launcher retains only the cache lifecycle lease. */
static void fail(const wchar_t *message) {
  MessageBoxW(NULL, message, L"Ester Studio", MB_OK | MB_ICONERROR);
}
static int append(wchar_t *buffer, size_t capacity, size_t *length, wchar_t value) {
  if (*length + 1 >= capacity) return 0;
  buffer[(*length)++] = value; buffer[*length] = 0; return 1;
}
/* Windows argv quoting: double backslashes before quotes and closing quote. */
static int quote(wchar_t *buffer, size_t capacity, size_t *length, const wchar_t *value) {
  size_t slashes = 0, i;
  if (!append(buffer, capacity, length, L'"')) return 0;
  for (;;) {
    wchar_t c = *value++;
    if (c == L'\\') { slashes++; continue; }
    for (i = 0; i < slashes * ((c == L'"' || c == 0) ? 2 : 1); i++) if (!append(buffer, capacity, length, L'\\')) return 0;
    slashes = 0;
    if (c == 0) return append(buffer, capacity, length, L'"');
    if (c == L'"' && !append(buffer, capacity, length, L'\\')) return 0;
    if (!append(buffer, capacity, length, c)) return 0;
  }
}

/* Chromium may flush empty indexes after Electron's JS shutdown hooks. Keep a
 * shared process-lifetime lease, then reclaim only an authenticated normal
 * close after the actual host exit, with an exclusive lease. No timer/kill. */
#define CLEAN_PATH 32768
typedef struct Guard { HANDLE handle; struct Guard *next; } Guard;
typedef struct Member { wchar_t *path; BY_HANDLE_FILE_INFORMATION info; HANDLE guard; int directory; struct Member *next; } Member;
typedef struct CacheClose {
  int enabled; HANDLE mutex, lease; wchar_t state[CLEAN_PATH], lock[CLEAN_PATH];
  char token[64]; BY_HANDLE_FILE_INFORMATION stateInfo, lockInfo;
} CacheClose;
static const wchar_t *cacheNames[] = {L"Cache",L"Code Cache",L"DawnGraphiteCache",L"DawnWebGPUCache",L"GPUCache",L"GPUPersistentCache",L"GrShaderCache",L"ShaderCache"};
static int joined(wchar_t *out,const wchar_t *root,const wchar_t *name) { size_t a=wcslen(root),b=wcslen(name);if(a+b+2>=CLEAN_PATH)return 0;wcscpy(out,root);out[a]=L'\\';wcscpy(out+a+1,name);return 1; }
static int same_id(const BY_HANDLE_FILE_INFORMATION *a,const BY_HANDLE_FILE_INFORMATION *b) {return a->dwVolumeSerialNumber==b->dwVolumeSerialNumber&&a->nFileIndexHigh==b->nFileIndexHigh&&a->nFileIndexLow==b->nFileIndexLow;}
static uint64_t file_id(const BY_HANDLE_FILE_INFORMATION *a) {return ((uint64_t)a->nFileIndexHigh<<32)|a->nFileIndexLow;}
static int same_file(const BY_HANDLE_FILE_INFORMATION *a,const BY_HANDLE_FILE_INFORMATION *b) {return same_id(a,b)&&a->nFileSizeHigh==b->nFileSizeHigh&&a->nFileSizeLow==b->nFileSizeLow&&CompareFileTime(&a->ftLastWriteTime,&b->ftLastWriteTime)==0&&CompareFileTime(&a->ftCreationTime,&b->ftCreationTime)==0;}
static HANDLE checked_dir(const wchar_t *name,BY_HANDLE_FILE_INFORMATION *info) {
  wchar_t *actual=HeapAlloc(GetProcessHeap(),0,CLEAN_PATH*sizeof(wchar_t));HANDLE h;
  if(!actual)return INVALID_HANDLE_VALUE;actual[0]=0;
  h=CreateFileW(name,FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,NULL);
  if(h!=INVALID_HANDLE_VALUE){DWORD n=GetFinalPathNameByHandleW(h,actual,CLEAN_PATH,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);const wchar_t *resolved=wcsncmp(actual,L"\\\\?\\",4)==0?actual+4:actual;
    if(!GetFileInformationByHandle(h,info)||!(info->dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)||(info->dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)||!n||n>=CLEAN_PATH||_wcsicmp(name,resolved)!=0){CloseHandle(h);h=INVALID_HANDLE_VALUE;}}
  HeapFree(GetProcessHeap(),0,actual);return h;
}
static void free_guards(Guard *g){while(g){Guard *next=g->next;CloseHandle(g->handle);HeapFree(GetProcessHeap(),0,g);g=next;}}
static int hold_chain(const wchar_t *name,Guard **guards){
  size_t n=wcslen(name),i;wchar_t *prefix;BY_HANDLE_FILE_INFORMATION info;
  if(n<3||name[1]!=L':'||name[2]!=L'\\')return 0;
  prefix=HeapAlloc(GetProcessHeap(),0,(n+1)*sizeof(wchar_t));if(!prefix)return 0;wcscpy(prefix,name);
  for(i=3;i<=n;i++)if(i==3||i==n||prefix[i]==L'\\'){
    wchar_t saved=prefix[i];HANDLE h;Guard *g;prefix[i]=0;h=checked_dir(prefix,&info);prefix[i]=saved;
    if(h==INVALID_HANDLE_VALUE){HeapFree(GetProcessHeap(),0,prefix);return 0;}g=HeapAlloc(GetProcessHeap(),0,sizeof(*g));if(!g){CloseHandle(h);HeapFree(GetProcessHeap(),0,prefix);return 0;}g->handle=h;g->next=*guards;*guards=g;
  }
  HeapFree(GetProcessHeap(),0,prefix);return 1;
}
static HANDLE checked_file(const wchar_t *name,DWORD access,DWORD share,BY_HANDLE_FILE_INFORMATION *info){
  HANDLE h=CreateFileW(name,access,share,NULL,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,NULL);
  if(h!=INVALID_HANDLE_VALUE&&(!GetFileInformationByHandle(h,info)||(info->dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT))||info->nNumberOfLinks!=1)){CloseHandle(h);h=INVALID_HANDLE_VALUE;}return h;
}
static void free_members(Member *m){while(m){Member *next=m->next;if(m->guard!=INVALID_HANDLE_VALUE)CloseHandle(m->guard);HeapFree(GetProcessHeap(),0,m->path);HeapFree(GetProcessHeap(),0,m);m=next;}}
static int collect_cache(const wchar_t *name,Member **members,unsigned *count,unsigned depth){
  BY_HANDLE_FILE_INFORMATION info;HANDLE dir,search;WIN32_FIND_DATAW found;Member *m;wchar_t *paths;
  if(depth>64||*count>=100000)return 0;
  dir=checked_dir(name,&info);if(dir==INVALID_HANDLE_VALUE)return 0;
  m=HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,sizeof(*m));if(!m){CloseHandle(dir);return 0;}
  m->path=HeapAlloc(GetProcessHeap(),0,(wcslen(name)+1)*sizeof(wchar_t));if(!m->path){CloseHandle(dir);HeapFree(GetProcessHeap(),0,m);return 0;}
  wcscpy(m->path,name);m->info=info;m->guard=dir;m->directory=1;m->next=*members;*members=m;(*count)++;
  paths=HeapAlloc(GetProcessHeap(),0,2*CLEAN_PATH*sizeof(wchar_t));if(!paths)return 0;
  if(!joined(paths,name,L"*")){HeapFree(GetProcessHeap(),0,paths);return 0;}
  search=FindFirstFileW(paths,&found);if(search==INVALID_HANDLE_VALUE){DWORD error=GetLastError();HeapFree(GetProcessHeap(),0,paths);return error==ERROR_FILE_NOT_FOUND;}
  do{
    HANDLE file;int ok=1;
    if(wcscmp(found.cFileName,L".")==0||wcscmp(found.cFileName,L"..")==0)continue;
    if((found.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)||_wcsicmp(found.cFileName,L".retain-recovery.json")==0||!joined(paths+CLEAN_PATH,name,found.cFileName)){ok=0;}
    else if(found.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)ok=collect_cache(paths+CLEAN_PATH,members,count,depth+1);
    else{
      file=checked_file(paths+CLEAN_PATH,FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,&info);
      if(file==INVALID_HANDLE_VALUE)ok=0;
      else{CloseHandle(file);if(*count>=100000)ok=0;else{m=HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,sizeof(*m));if(!m)ok=0;else{m->path=HeapAlloc(GetProcessHeap(),0,(wcslen(paths+CLEAN_PATH)+1)*sizeof(wchar_t));if(!m->path){HeapFree(GetProcessHeap(),0,m);ok=0;}else{wcscpy(m->path,paths+CLEAN_PATH);m->info=info;m->guard=INVALID_HANDLE_VALUE;m->next=*members;*members=m;(*count)++;}}}}
    }
    if(!ok){FindClose(search);HeapFree(GetProcessHeap(),0,paths);return 0;}
  }while(FindNextFileW(search,&found));
  {DWORD error=GetLastError();FindClose(search);HeapFree(GetProcessHeap(),0,paths);return error==ERROR_NO_MORE_FILES;}
}
static int delete_manifest(Member *members,uint64_t *files,uint64_t *bytes){
  Member *m;for(m=members;m;m=m->next)if(!m->directory){BY_HANDLE_FILE_INFORMATION current;FILE_DISPOSITION_INFO remove={TRUE};HANDLE file=checked_file(m->path,DELETE|FILE_READ_ATTRIBUTES,0,&current);
    if(file==INVALID_HANDLE_VALUE)return 0;
    if(!same_file(&m->info,&current)||!SetFileInformationByHandle(file,FileDispositionInfo,&remove,sizeof(remove))){CloseHandle(file);return 0;}CloseHandle(file);(*files)++;*bytes+=((uint64_t)current.nFileSizeHigh<<32)|current.nFileSizeLow;
  }
  for(m=members;m;m=m->next)if(m->directory){BY_HANDLE_FILE_INFORMATION current;if(!GetFileInformationByHandle(m->guard,&current)||!same_id(&m->info,&current))return 0;CloseHandle(m->guard);m->guard=INVALID_HANDLE_VALUE;if(!RemoveDirectoryW(m->path))return 0;}return 1;
}
static int unsigned_value(const char *text,uint64_t *value){char *end;const char *p=text;if(!*p||strlen(p)>20)return 0;while(*p)if(*p<'0'||*p++>'9')return 0;errno=0;*value=strtoull(text,&end,10);return errno==0&&*end==0&&*value>0;}
static int safe_id(const char *text){size_t n=0;for(;*text;text++,n++)if(!((*text>='a'&&*text<='z')||(*text>='A'&&*text<='Z')||(*text>='0'&&*text<='9')||*text=='_'||*text=='-'))return 0;return n>0&&n<=80;}
static int safe_tag(const char *p){int group;if(*p++!='v')return 0;for(group=0;group<3;group++){const char *start=p;while(*p>='0'&&*p<='9')p++;if(p==start)return 0;if(group<2&&*p++!='.')return 0;}if(!*p)return 1;if(!strncmp(p,"-dev.",5)){uint64_t iteration;return p[5]!='0'&&unsigned_value(p+5,&iteration)&&iteration<=65535;}if(*p++!='-'||*p++!='r')return 0;{uint64_t revision;return unsigned_value(p,&revision)&&revision>=2;}}
static int valid_run(const char *text,const char *tag,const char *runId,DWORD pid){
  char version[96],revision[32]="",prefix[384];const char *dash=strstr(tag,"-r"),*date;size_t n=dash?(size_t)(dash-tag-1):strlen(tag+1),i;
  if(n>=sizeof(version))return 0;memcpy(version,tag+1,n);version[n]=0;if(dash){if(strlen(dash+1)>=sizeof(revision))return 0;strcpy(revision,dash+1);}
  snprintf(prefix,sizeof(prefix),"{\"schema\":\"sciyue-portable-run-v1\",\"version\":\"%s\",\"revision\":\"%s\",\"runId\":\"%s\",\"pid\":%lu,\"startedAt\":\"",version,revision,runId,(unsigned long)pid);
  n=strlen(prefix);if(strncmp(text,prefix,n))return 0;date=text+n;if(strlen(date)!=24+strlen("\",\"state\":\"active\"}"))return 0;
  for(i=0;i<24;i++){char expected=0;switch(i){case 4:case 7:expected='-';break;case 10:expected='T';break;case 13:case 16:expected=':';break;case 19:expected='.';break;case 23:expected='Z';break;}if(expected?date[i]!=expected:(date[i]<'0'||date[i]>'9'))return 0;}
  return strcmp(date+24,"\",\"state\":\"active\"}")==0;
}
static void wide_ascii(wchar_t *out,const char *text){while(*text)*out++=(unsigned char)*text++;*out=0;}
static int small_read(const wchar_t *name,char *bytes,DWORD capacity,DWORD *length,BY_HANDLE_FILE_INFORMATION *info){HANDLE h=checked_file(name,GENERIC_READ,0,info);DWORD size,got;if(h==INVALID_HANDLE_VALUE)return 0;size=info->nFileSizeLow;if(info->nFileSizeHigh||size>=capacity||!ReadFile(h,bytes,size,&got,NULL)||got!=size){CloseHandle(h);return 0;}CloseHandle(h);bytes[size]=0;*length=size;return memchr(bytes,0,size)==NULL;}
static int close_marker(const wchar_t *temp,const char *active,const char *token){
  wchar_t marker[CLEAN_PATH],pending[CLEAN_PATH],leaf[128];char current[4096],closed[4096],*state;DWORD size,wrote;BY_HANDLE_FILE_INFORMATION before,again;HANDLE h;
  if(strlen(active)+2>sizeof(closed)||!joined(marker,temp,L".portable-run.json"))return 0;
  if(!small_read(marker,current,sizeof(current),&size,&before)||size!=strlen(active)+1||memcmp(current,active,strlen(active))||current[size-1]!='\n')return 0;
  strcpy(closed,active);state=strstr(closed,"\"state\":\"active\"");if(!state||strstr(state+1,"\"state\":\"active\""))return 0;memcpy(state+9,"closed",6);strcat(closed,"\n");
  wide_ascii(leaf,".post-exit-");{size_t at=wcslen(leaf);wide_ascii(leaf+at,token);wcscat(leaf,L".tmp");}if(!joined(pending,temp,leaf))return 0;
  h=CreateFileW(pending,GENERIC_WRITE,0,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL);if(h==INVALID_HANDLE_VALUE)return 0;
  if(!WriteFile(h,closed,(DWORD)strlen(closed),&wrote,NULL)||wrote!=strlen(closed)||!FlushFileBuffers(h)){CloseHandle(h);return 0;}CloseHandle(h);
  if(!small_read(marker,current,sizeof(current),&size,&again)||!same_file(&before,&again)||size!=strlen(active)+1||memcmp(current,active,strlen(active))||current[size-1]!='\n')return 0;
  return MoveFileExW(pending,marker,MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)!=0;
}
static int cache_receipt(CacheClose *c,DWORD pid,const char *status,uint64_t files,uint64_t bytes,const wchar_t *temp){
  wchar_t name[128],target[CLEAN_PATH];char text[512];HANDLE h;DWORD wrote;wide_ascii(name,".post-exit-");wide_ascii(name+wcslen(name),c->token);wcscat(name,L".result");if(!joined(target,c->state,name))return 0;
  snprintf(text,sizeof(text),"{\"schema\":\"sciyue-post-exit-result/v1\",\"token\":\"%s\",\"hostPid\":%lu,\"hostExited\":true,\"status\":\"%s\",\"runMarkerAuthoritative\":true,\"files\":%llu,\"bytes\":%llu}\n",c->token,(unsigned long)pid,status,(unsigned long long)files,(unsigned long long)bytes);
  if(temp&&!joined(target,temp,L".post-exit-cleanup-result.json"))return 0;
  h=CreateFileW(target,GENERIC_WRITE,0,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL);if(h==INVALID_HANDLE_VALUE)return 0;{int ok=WriteFile(h,text,(DWORD)strlen(text),&wrote,NULL)&&wrote==strlen(text)&&FlushFileBuffers(h);CloseHandle(h);return ok;}
}
static int archive_request(const wchar_t *temp,const wchar_t *request,const char *original,DWORD size,const BY_HANDLE_FILE_INFORMATION *expected){
  wchar_t target[CLEAN_PATH];HANDLE h;DWORD wrote,read;BY_HANDLE_FILE_INFORMATION info;FILE_DISPOSITION_INFO remove={TRUE};char checked[8192];
  if(!joined(target,temp,L".post-exit-cleanup.request"))return 0;h=CreateFileW(target,GENERIC_WRITE,0,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL);if(h==INVALID_HANDLE_VALUE)return 0;
  if(!WriteFile(h,original,size,&wrote,NULL)||wrote!=size||!FlushFileBuffers(h)){CloseHandle(h);return 0;}CloseHandle(h);
  h=checked_file(request,GENERIC_READ|DELETE|FILE_READ_ATTRIBUTES,0,&info);if(h==INVALID_HANDLE_VALUE)return 0;
  if(!same_file(expected,&info)||!ReadFile(h,checked,size,&read,NULL)||read!=size||memcmp(checked,original,size)||!SetFileInformationByHandle(h,FileDispositionInfo,&remove,sizeof(remove))){CloseHandle(h);return 0;}CloseHandle(h);return 1;
}
static int prepare_cache_close(const wchar_t *module,CacheClose *c){
  wchar_t runtime[CLEAN_PATH],marker[CLEAN_PATH],mutexName[80],token[64];BY_HANDLE_FILE_INFORMATION info;Guard *guards=NULL;HANDLE dir;DWORD attributes;uint64_t hash=1469598103934665603ULL;const wchar_t *p;LARGE_INTEGER nonce;
  c->lease=INVALID_HANDLE_VALUE;if(!joined(runtime,module,L"runtime")||!joined(marker,runtime,L"portable-layout.json"))return 0;attributes=GetFileAttributesW(marker);if(attributes==INVALID_FILE_ATTRIBUTES)return 1;if(attributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT))return 0;
  if(!joined(c->state,runtime,L"state")||!hold_chain(runtime,&guards)){free_guards(guards);return 0;}if(!CreateDirectoryW(c->state,NULL)&&GetLastError()!=ERROR_ALREADY_EXISTS){free_guards(guards);return 0;}
  dir=checked_dir(c->state,&c->stateInfo);if(dir==INVALID_HANDLE_VALUE){free_guards(guards);return 0;}CloseHandle(dir);free_guards(guards);
  for(p=c->state;*p;p++){hash^=(uint64_t)towlower(*p);hash*=1099511628211ULL;}swprintf(mutexName,80,L"Local\\SciYue.CacheClose.%016llx",(unsigned long long)hash);
  c->mutex=CreateMutexW(NULL,FALSE,mutexName);if(!c->mutex)return 0;{DWORD wait=WaitForSingleObject(c->mutex,INFINITE);if(wait!=WAIT_OBJECT_0&&wait!=WAIT_ABANDONED){CloseHandle(c->mutex);return 0;}}
  if(!joined(c->lock,c->state,L".chromium-cache.lock")){ReleaseMutex(c->mutex);CloseHandle(c->mutex);return 0;}
  c->lease=CreateFileW(c->lock,GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_ALWAYS,FILE_FLAG_OPEN_REPARSE_POINT,NULL);
  if(c->lease==INVALID_HANDLE_VALUE||!GetFileInformationByHandle(c->lease,&info)||(info.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT))||info.nNumberOfLinks!=1){if(c->lease!=INVALID_HANDLE_VALUE)CloseHandle(c->lease);ReleaseMutex(c->mutex);CloseHandle(c->mutex);return 0;}
  c->lockInfo=info;ReleaseMutex(c->mutex);QueryPerformanceCounter(&nonce);snprintf(c->token,sizeof(c->token),"L%lu-%016llx",(unsigned long)GetCurrentProcessId(),(unsigned long long)nonce.QuadPart);wide_ascii(token,c->token);if(!SetEnvironmentVariableW(L"SCIYUE_LAUNCH_CACHE_TOKEN",token)){CloseHandle(c->lease);CloseHandle(c->mutex);return 0;}c->enabled=1;return 1;
}
static void finish_cache_close(CacheClose *c,DWORD pid,DWORD code){
  wchar_t leaf[128],request[CLEAN_PATH],handoff[CLEAN_PATH],cache[CLEAN_PATH],temp[CLEAN_PATH],part[128];char raw[8192],original[8192],check[8192],*fields[9],*cursor,*end;DWORD size,index,originalSize;uint64_t values[4],files=0,bytes=0;BY_HANDLE_FILE_INFORMATION requestInfo,info;Guard *guards=NULL;Member *members=NULL;unsigned count=0;HANDLE exclusive=INVALID_HANDLE_VALUE,dir;const char *status="handoff-invalid";int haveRequest=0;
  if(!c->enabled)return;CloseHandle(c->lease);c->lease=INVALID_HANDLE_VALUE;
  {DWORD wait=WaitForSingleObject(c->mutex,INFINITE);if(wait!=WAIT_OBJECT_0&&wait!=WAIT_ABANDONED){CloseHandle(c->mutex);return;}}
  if(!hold_chain(c->state,&guards))goto done;dir=checked_dir(c->state,&info);if(dir==INVALID_HANDLE_VALUE)goto done;CloseHandle(dir);if(!same_id(&c->stateInfo,&info))goto done;
  wide_ascii(leaf,".post-exit-");wide_ascii(leaf+wcslen(leaf),c->token);wcscat(leaf,L".request");if(!joined(request,c->state,leaf))goto done;
  if(GetFileAttributesW(request)==INVALID_FILE_ATTRIBUTES)goto done;haveRequest=1;
  if(!small_read(request,raw,sizeof(raw),&size,&requestInfo))goto done;
  wcscpy(handoff,request);memcpy(original,raw,size);originalSize=size;
  cursor=raw;for(index=0;index<9;index++){fields[index]=cursor;end=strchr(cursor,'\n');if(!end)goto done;*end=0;cursor=end+1;}if(cursor!=raw+size)goto done;
  for(index=0;index<size;index++)if(raw[index]&&((unsigned char)raw[index]<32||(unsigned char)raw[index]>126))goto done;
  if(strcmp(fields[0],"SCIYUE_POST_EXIT_V1")||strcmp(fields[1],c->token)||!unsigned_value(fields[2],&values[0])||values[0]!=pid||!safe_tag(fields[3])||!safe_id(fields[4])||!unsigned_value(fields[5],&values[1])||!unsigned_value(fields[6],&values[2])||!unsigned_value(fields[7],&values[3])||file_id(&info)!=values[1]||strlen(fields[8])>4094)goto done;
  if(!valid_run(fields[8],fields[3],fields[4],pid))goto done;
  status="host-exit-unconfirmed";if(code!=0)goto done;
  status="lease-busy";exclusive=checked_file(c->lock,GENERIC_READ,0,&info);if(exclusive==INVALID_HANDLE_VALUE)goto done;if(!same_id(&c->lockInfo,&info)){status="lease-changed";goto done;}
  status="directory-identity";if(!joined(cache,c->state,L"cache"))goto done;wide_ascii(part,fields[3]);if(!joined(temp,cache,part))goto done;wcscpy(cache,temp);
  if(!hold_chain(cache,&guards))goto done;dir=checked_dir(cache,&info);if(dir==INVALID_HANDLE_VALUE)goto done;CloseHandle(dir);if(file_id(&info)!=values[2])goto done;
  if(!joined(temp,c->state,L"temp")||!joined(request,temp,part))goto done;wide_ascii(part,fields[4]);if(!joined(temp,request,part)||!hold_chain(temp,&guards))goto done;dir=checked_dir(temp,&info);if(dir==INVALID_HANDLE_VALUE)goto done;CloseHandle(dir);if(file_id(&info)!=values[3])goto done;
  status="manifest-retained";for(index=0;index<sizeof(cacheNames)/sizeof(cacheNames[0]);index++){DWORD attributes;if(!joined(request,cache,cacheNames[index]))goto done;attributes=GetFileAttributesW(request);if(attributes==INVALID_FILE_ATTRIBUTES){DWORD error=GetLastError();if(error==ERROR_FILE_NOT_FOUND||error==ERROR_PATH_NOT_FOUND)continue;goto done;}if(!collect_cache(request,&members,&count,0))goto done;}
  status="member-retained";if(!delete_manifest(members,&files,&bytes))goto done;
  status="handoff-changed";if(!small_read(handoff,check,sizeof(check),&size,&info)||!same_file(&requestInfo,&info)||size!=originalSize||memcmp(check,original,size))goto done;
  status="handoff-archive-retained";if(!archive_request(temp,handoff,original,originalSize,&requestInfo))goto done;
  status="receipt-retained";if(!cache_receipt(c,pid,"cache-cleaned",files,bytes,temp))goto done;
  status="marker-retained";if(!close_marker(temp,fields[8],c->token))goto done;
  status="cleaned";
done:
  free_members(members);if(haveRequest&&strcmp(status,"cleaned"))cache_receipt(c,pid,status,files,bytes,NULL);if(exclusive!=INVALID_HANDLE_VALUE)CloseHandle(exclusive);free_guards(guards);ReleaseMutex(c->mutex);CloseHandle(c->mutex);
}
int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, LPWSTR commandLine, int show) {
  wchar_t module[32768], host[32768], command[32768], *slash;
  DWORD count, code = 1; int argc, i; size_t length = 0;
  wchar_t **argv; STARTUPINFOW start = {0}; PROCESS_INFORMATION child = {0};CacheClose *cacheClose;
  (void)instance; (void)previous; (void)commandLine; (void)show;
  count = GetModuleFileNameW(NULL, module, 32768);
  if (!count || count >= 32768 || !(slash = wcsrchr(module, L'\\'))) { fail(L"无法确定 Ester Studio 便携程序位置。"); return 1; }
  *slash = 0;
  if (wcslen(module) + wcslen(L"\\runtime\\Ester-Studio-host.exe") >= 32768) { fail(L"Ester Studio 程序路径过长。"); return 1; }
  wcscpy(host, module); wcscat(host, L"\\runtime");
  { DWORD attributes = GetFileAttributesW(host); if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY) || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) { fail(L"Ester Studio 需要同目录下完整且独立的 runtime 文件夹。"); return 1; } }
  {
    const wchar_t *names[] = {L"Ester-Studio-host.exe", L"SY-Studio-host.exe", L"sciyue-host.exe"};
    size_t runtimeLength = wcslen(host);
    for (i = 0; i < 3; i++) {
      host[runtimeLength] = 0; wcscat(host, L"\\"); wcscat(host, names[i]);
      if (GetFileAttributesW(host) != INVALID_FILE_ATTRIBUTES) break;
    }
  }
  { DWORD attributes = GetFileAttributesW(host); if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) { fail(L"缺少 Ester Studio 内部程序。请保留 Ester-Studio.exe 与完整 runtime 目录。"); return 1; } }
  argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv) { fail(L"无法读取 Ester Studio 启动参数。"); return 1; }
  if (!quote(command, 32768, &length, host)) { LocalFree(argv); return 1; }
  for (i = 1; i < argc; i++) if (!append(command, 32768, &length, L' ') || !quote(command, 32768, &length, argv[i])) { LocalFree(argv); fail(L"Ester Studio 启动参数过长。"); return 1; }
  LocalFree(argv); start.cb = sizeof(start);
  cacheClose=HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,sizeof(*cacheClose));if(!cacheClose||!prepare_cache_close(module,cacheClose)){if(cacheClose)HeapFree(GetProcessHeap(),0,cacheClose);fail(L"Ester Studio 缓存生命周期锁不可用，已保留原文件。请稍后重试。");return 1;}
  /* Preserve caller CWD and environment; host resolves resources from execPath. */
  if (!CreateProcessW(host, command, NULL, NULL, FALSE, 0, NULL, NULL, &start, &child)) { if(cacheClose->enabled){CloseHandle(cacheClose->lease);CloseHandle(cacheClose->mutex);}HeapFree(GetProcessHeap(),0,cacheClose);fail(L"Ester Studio 内部程序无法启动，请检查完整程序目录及访问权限。"); return 1; }
  CloseHandle(child.hThread);
  if (WaitForSingleObject(child.hProcess, INFINITE) == WAIT_OBJECT_0) {GetExitCodeProcess(child.hProcess, &code);finish_cache_close(cacheClose,child.dwProcessId,code);}
  else if(cacheClose->enabled){CloseHandle(cacheClose->lease);CloseHandle(cacheClose->mutex);}
  HeapFree(GetProcessHeap(),0,cacheClose);CloseHandle(child.hProcess); return (int)code;
}
