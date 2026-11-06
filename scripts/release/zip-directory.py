"""Create one fresh ZIP from a checked, ordinary portable directory."""
import argparse
import os
from pathlib import Path
import zipfile

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--root-name',required=True)
    args=parser.parse_args()
    assert args.root_name and '/'not in args.root_name and '\\'not in args.root_name and args.root_name not in('.','..')
    source=args.directory.absolute();output=args.output.absolute()
    assert not output.exists() and output.parent.is_dir() and not output.is_relative_to(source)
    rows=[]
    for path in sorted(source.rglob('*')):
        for parent in(path,*path.parents):
            assert not parent.is_symlink() and not getattr(parent,'is_junction',lambda:False)()
        if path.is_file():
            assert path.stat().st_nlink==1
            rows.append(path)
    with zipfile.ZipFile(output,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True)as archive:
        for path in rows:archive.write(path,args.root_name+'/'+path.relative_to(source).as_posix())
    with zipfile.ZipFile(output)as archive:
        assert len(archive.infolist())==len(rows) and archive.testzip()is None

if __name__=='__main__':main()
