"""Run the pinned, privately extracted Meson wheel without installing it."""
from pathlib import Path
import argparse,os,runpy,sys
p=argparse.ArgumentParser();p.add_argument('--meson-root',type=Path,required=True);p.add_argument('--dll-dir',type=Path,action='append',default=[]);args,rest=p.parse_known_args()
handles=[os.add_dll_directory(str(d.resolve())) for d in args.dll_dir] if os.name=='nt' else []
sys.path.insert(0,str(args.meson_root.resolve()));sys.argv=['meson']+(rest[1:] if rest[:1]==['--'] else rest)
runpy.run_module('mesonbuild.mesonmain',run_name='__main__')
