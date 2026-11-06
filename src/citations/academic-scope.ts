import {normalizeSelector} from './identity';
import type {CitationFact} from './types';

// Academic bibliography is separate from third-party license/NOTICE coverage.
// Exact identities keep domain software (e.g. Multiwfn, ASE, RDKit) eligible.
const generalUiSoftware=new Set([
 'react','react-dom','reactdom','react dom','lucide','lucide-react','lucide icons',
 'electron','electron.js','node','node.js','nodejs','chromium',
]);
const displayFeatures=new Set([
 'display','display-style','visual-style','style','appearance','appearance-preset',
 'display-preset','render-style','render-preset','ui-style','ui-layout',
 'palette','lighting','material','camera','layout',
]);
/** Apply to automatic usage facts before mapping or missing-evidence checks.
 * Explicit user additions are handled separately by collectCitations and are
 * preserved even when they intentionally name a general UI library. */
export function academicCitationFact(fact:CitationFact):boolean {
 if(fact.id.startsWith('citation-ui:'))return false; // v0.69 persisted facts
 const feature=normalizeSelector(fact.feature);
 if(displayFeatures.has(feature))return false;
 if(generalUiSoftware.has(normalizeSelector(fact.software)))return false;
 if((feature==='software'||feature==='runtime-dependency')&&generalUiSoftware.has(normalizeSelector(fact.method)))return false;
 return true;
}
