"""Byte transport only; each worker retains its own control state machine.

On Windows an empty-pipe CRT read holds the descriptor lock. A concurrent
library's stdio initialization can then block on the same descriptor. Poll the
native pipe handle first, and read no more than the bytes actually available.
"""
from __future__ import annotations
import os


def control_blocks(fd, done, *, max_bytes=65536, poll_seconds=.01):
    """Yield bytes, including b'' once on EOF; stop when owner sets done.

    This does not parse, validate or dispatch commands. Non-Windows retains the
    existing blocking os.read behavior. Only an already-owned pipe is accepted
    by the Windows branch; there is no console or arbitrary path fallback.
    """
    if type(max_bytes) is not int or not 1<=max_bytes<=65536 or not 0<poll_seconds<=.1:
        raise ValueError('Invalid native stdin read bounds')
    if os.name!='nt':
        while not done.is_set():
            block=os.read(fd,max_bytes);yield block
            if not block:return
        return
    import ctypes
    from ctypes import wintypes
    import msvcrt
    handle=wintypes.HANDLE(msvcrt.get_osfhandle(fd))
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    peek=kernel.PeekNamedPipe
    peek.argtypes=[wintypes.HANDLE,ctypes.c_void_p,wintypes.DWORD,ctypes.c_void_p,ctypes.POINTER(wintypes.DWORD),ctypes.c_void_p]
    peek.restype=wintypes.BOOL
    available=wintypes.DWORD()
    while not done.is_set():
        if not peek(handle,None,0,None,ctypes.byref(available),None):
            error=ctypes.get_last_error()
            if error in (109,232): # ERROR_BROKEN_PIPE / ERROR_NO_DATA
                yield b'';return
            raise OSError(error,'Owned native control pipe is unavailable')
        if available.value:
            block=os.read(fd,min(max_bytes,available.value));yield block
            if not block:return
        else:done.wait(poll_seconds)
