"""Bounded retention for this session's closed, accepted MD checkpoints only."""
from __future__ import annotations
import json
import os
from pathlib import Path
import stat

from task_files import clean_evaluation

SEGMENT_FILES = frozenset(('input.coord', 'md.inp', 'mdrestart', 'process.json', 'stdout.txt', 'stderr.txt',
    'xtb.trj', 'xtbmdok', 'gfnff_charges', 'gfnff_topo', 'charges', 'wbo', 'xtbtopo.mol', 'xtbrestart'))


def directory_identity(directory):
    directory = Path(directory)
    if directory.is_symlink() or os.path.normcase(os.path.realpath(directory)) != os.path.normcase(str(directory.absolute())):
        raise ValueError('MD checkpoint path changed or traverses a link')
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError('MD checkpoint directory is not ordinary')
    return (info.st_dev, info.st_ino)


def file_identity(member):
    item = member.lstat()
    if member.is_symlink() or not stat.S_ISREG(item.st_mode) or item.st_nlink != 1:
        raise ValueError('MD checkpoint contains an unknown nonregular member')
    return (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)


def manifest(directory):
    directory = Path(directory); identity = directory_identity(directory)
    members = {}
    for member in directory.iterdir():
        members[member.name] = file_identity(member)
    return dict(directory=directory, directoryIdentity=identity, members=members)


class CheckpointFiles:
    def __init__(self, workspace, source):
        self.workspace = Path(workspace)
        self.workspace_identity = manifest(self.workspace)['directoryIdentity']
        self.completed = []
        self.completed_count = self.reclaimed_count = self.reclaimed_bytes = 0
        for name, key in (('initial.coord', 'initialInput'), ('initial-md.inp', 'initialControl')):
            with (self.workspace/name).open('x', encoding='ascii', newline='\n') as handle:
                handle.write(source[key])
        source = {key:value for key,value in source.items() if key not in ('initialInput','initialControl')}
        # Immutable original request/config/provenance, never a rolling slot.
        with (self.workspace/'source.json').open('x', encoding='utf-8') as handle:
            json.dump(source, handle, allow_nan=False, separators=(',', ':'))
        self.source_members = {name:file_identity(self.workspace/name) for name in ('initial.coord','initial-md.inp','source.json')}
        self.progress_identity = None

    def _check_source(self):
        if directory_identity(self.workspace) != self.workspace_identity:
            raise ValueError('MD workspace directory identity changed')
        if any(file_identity(self.workspace/name) != identity for name,identity in self.source_members.items()):
            raise ValueError('MD original source was changed; checkpoints retained')

    def _progress(self, latest):
        self._check_source()
        target = self.workspace/'progress.json'; pending = self.workspace/'progress.pending'
        if target.exists():
            info = target.lstat()
            identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            if target.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or identity != self.progress_identity:
                raise ValueError('MD progress summary was replaced')
        elif self.progress_identity is not None:
            raise ValueError('MD progress summary disappeared')
        value = dict(schema='ester-modeling-md-checkpoints/v1', completeTrajectoryRetained=False,
            completedCheckpoints=self.completed_count, reclaimedCheckpoints=self.reclaimed_count,
            reclaimedLogicalBytes=self.reclaimed_bytes, latest=latest,
            retained=[item['directory'].name for item in self.completed])
        with pending.open('x', encoding='utf-8') as handle:
            json.dump(value, handle, allow_nan=False, separators=(',', ':')); handle.flush(); os.fsync(handle.fileno())
        # Recheck the old exact slot after writing, before atomic replacement.
        if (target.exists() and (self.progress_identity is None or file_identity(target) != self.progress_identity)) or not target.exists() and self.progress_identity is not None:
            raise ValueError('MD progress summary changed during replacement')
        os.replace(pending, target)
        info = target.lstat(); self.progress_identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def accept(self, directory, latest, *, native_closed, restart_accepted, readers_closed):
        self._check_source()
        if not native_closed or not restart_accepted or not readers_closed:
            raise ValueError('MD checkpoint is still owned by an active writer/reader')
        directory = Path(directory)
        if directory.parent != self.workspace or not directory.name.startswith('segment-'):
            raise ValueError('MD checkpoint lies outside this session')
        item = manifest(directory)
        if not set(item['members']) <= SEGMENT_FILES:
            raise ValueError('MD checkpoint contains an unknown file; all files retained')
        if not {'input.coord', 'md.inp', 'mdrestart', 'process.json', 'stdout.txt', 'stderr.txt', 'xtb.trj', 'xtbmdok'} <= set(item['members']):
            raise ValueError('MD checkpoint has no complete accepted artifact inventory')
        if any(old['directory'] == directory for old in self.completed):
            raise ValueError('MD checkpoint already accepted')
        self.completed.append(item); self.completed_count += 1
        # Write the reliable latest receipt before reclaiming any older data.
        self._progress(latest)
        while len(self.completed) > 2:
            old = self.completed[0]
            clean_evaluation(old['directory'], expected_members=old['members'], expected_directory_identity=old['directoryIdentity'])
            self.completed.pop(0); self.reclaimed_count += 1
            self.reclaimed_bytes += sum(identity[2] for identity in old['members'].values())
        self._progress(latest)
