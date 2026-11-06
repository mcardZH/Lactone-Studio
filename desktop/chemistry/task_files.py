"""Reclaim only an isolated, closed evaluation's exact regular members."""
import os
from pathlib import Path
import stat


def clean_evaluation(directory, *, expected_members=None, expected_directory_identity=None):
    directory = Path(directory)
    if directory.is_symlink() or os.path.normcase(os.path.realpath(directory)) != os.path.normcase(str(directory.absolute())):
        raise ValueError('Evaluation directory changed or traverses a link')
    directory_info = directory.lstat()
    if expected_directory_identity is not None and (directory_info.st_dev, directory_info.st_ino) != tuple(expected_directory_identity):
        raise ValueError('Evaluation directory identity changed')
    members = []
    for member in directory.iterdir():
        info = member.lstat()
        if member.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError('Unexpected evaluation member retained')
        members.append((member, (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)))
    if expected_members is not None:
        actual = {member.name: identity for member, identity in members}
        if set(actual) != set(expected_members) or any(actual[name] != tuple(identity) for name, identity in expected_members.items()):
            raise ValueError('Evaluation exact member manifest changed')
    # Complete preflight precedes the first unlink: a changed late member must
    # not be discovered only after earlier valid members were removed.
    for member, identity in members:
        info = member.lstat()
        if member.is_symlink() or info.st_nlink != 1 or (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != identity:
            raise ValueError('Evaluation member changed during cleanup')
    if {member.name for member in directory.iterdir()} != {member.name for member, _ in members}:
        raise ValueError('Evaluation member inventory changed during cleanup')
    for member, identity in members:
        info = member.lstat()
        if member.is_symlink() or info.st_nlink != 1 or (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != identity:
            raise ValueError('Evaluation member changed during cleanup')
        member.unlink()
    directory.rmdir()
