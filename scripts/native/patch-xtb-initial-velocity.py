"""Apply the bounded ES H-only initialization patch to a materialized xTB tree."""
from pathlib import Path
import argparse, hashlib, json

def apply(root):
    target = root / 'src/dynamic.f90'
    raw = target.read_bytes()
    if hashlib.sha256(raw).hexdigest() != '32b604dfc82eb647b753cd8ff1b650547fcb686e5f1b668a70dfb472aedbfd91':
        raise ValueError('Expected exact pinned xTB 5071a886 dynamic.f90 before patch')
    source = raw.decode('utf-8')
    call = '      call mdinitu(mol%n,mol%at,velo,mass,edum)'
    if source.count(call) != 1 or 'ES_MD_INIT_V1' in source:
        raise ValueError('Expected unique unpatched automatic mdinitu call')
    helper = Path(__file__).with_name('xtb-initial-velocity.f90').read_text(encoding='utf-8')
    source = source.replace(call, call+'\n      call es_initial_velocity_cap(mol%n,mol%at,velo,mass,nfreedom,kB)')
    end = 'end subroutine mdinitu'
    if source.count(end) != 1:
        raise ValueError('Expected unique mdinitu end')
    source = source.replace(end, end+'\n\n'+helper)
    target.write_text(source, encoding='utf-8', newline='\n')
    return dict(algorithm='xtb-h-only-initial-cap-v1', path='src/dynamic.f90',
                beforeSha256=hashlib.sha256(raw).hexdigest(),
                afterSha256=hashlib.sha256(target.read_bytes()).hexdigest())

if __name__ == '__main__':
    p=argparse.ArgumentParser();p.add_argument('source', type=Path);a=p.parse_args()
    print(json.dumps(apply(a.source), indent=2))
