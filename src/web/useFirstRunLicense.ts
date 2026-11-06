import { useEffect, useRef, useState } from 'react';
import type { FirstRunLicenseBridge, FirstRunLicenseSnapshot } from '../modeling/first-run-license';

export function useFirstRunLicense(bridge?: Partial<FirstRunLicenseBridge>) {
  const available = !!bridge?.readFirstRunLicense && !!bridge?.acknowledgeFirstRunLicense;
  const [snapshot, setSnapshot] = useState<FirstRunLicenseSnapshot | null>(null);
  const [loading, setLoading] = useState(available), [saving, setSaving] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const live = useRef(0), pending = useRef(false);
  useEffect(() => {
    const generation = ++live.current;
    if (!available) { setLoading(false); return; }
    setLoading(true); setError('');
    void bridge!.readFirstRunLicense!().then(value => { if (live.current === generation) setSnapshot(value); }).catch(cause => { if (live.current === generation) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (live.current === generation) setLoading(false); });
    return () => { live.current++; };
  }, [bridge, available, retry]);
  async function acknowledge() {
    if (!available || !snapshot || loading || pending.current) return;
    const generation = live.current; pending.current = true; setSaving(true); setError('');
    try { const value = await bridge!.acknowledgeFirstRunLicense!({ licenseSha256: snapshot.sha256 }); if (live.current === generation) setSnapshot(value); }
    catch (cause) { if (live.current === generation) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; if (live.current === generation) setSaving(false); }
  }
  return { snapshot, loading, saving, error, ready: !available || !!snapshot?.acknowledged || snapshot?.prompt === false, setupOwner: !available || snapshot?.prompt === true, acknowledge, retry: () => setRetry(value => value + 1) };
}
