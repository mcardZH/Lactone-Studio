import { useState } from 'react';
import type { HirshfeldFingerprintSnapshot } from './hirshfeld-controls-contracts';
import HirshfeldFingerprint from './HirshfeldFingerprint';

/** The same plot renderer in the common fixed-source window shell. */
export default function HirshfeldFingerprintWindow({ snapshot }: { snapshot: HirshfeldFingerprintSnapshot }) {
  const [display, setDisplay] = useState(snapshot.plotDisplay);
  const [focus, setFocus] = useState(snapshot.focus);
  return <HirshfeldFingerprint {...snapshot} focus={focus} onContact={setFocus} display={display} onDisplay={setDisplay}/>;
}
