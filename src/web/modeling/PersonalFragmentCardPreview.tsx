import { useMemo } from 'react';
import type { Structure } from '../../core/types';
import { saturateNewSitesInPrivateCandidate } from '../../core/modeling/hydrogen-policy';
import type { PersonalFragmentTemplate } from '../../modeling/personal-fragments';
import { LibraryModelThumbnail } from './LibraryModelThumbnail';
import { useLibraryThumbnail } from './use-library-thumbnail';

const inferableElements = new Set(['B', 'C', 'N', 'O', 'F', 'Si', 'Cl', 'Br', 'I']);

export function personalFragmentThumbnailStructure(fragment: PersonalFragmentTemplate): Structure {
  const structure: Structure = { id: fragment.id, name: fragment.name, dimension: 3, format: '个人片段',
    charge: null, multiplicity: null, notes: [], atoms: fragment.atoms.map(atom => ({ ...atom })),
    bonds: fragment.bonds.map(bond => ({ ...bond })) };
  const ambiguous = new Set(fragment.ports.map(port => port.hostAtomId));
  for (const edge of structure.bonds ?? []) {
    if (edge.kind === 'coordination' || edge.orderKnown === false || edge.fractional) {
      ambiguous.add(fragment.atoms[edge.a].id!); ambiguous.add(fragment.atoms[edge.b].id!);
    }
  }
  const candidates = structure.atoms.flatMap(atom => inferableElements.has(atom.element) && atom.hydrogenMode !== 'explicit'
    && !ambiguous.has(atom.id!) ? [atom.id!] : []);
  try {
    saturateNewSitesInPrivateCandidate(structure, candidates);
  } catch {
    // Known atoms and any already fitted H are displayable even if a later
    // fixed local geometry offers no clash-free hydrogen position.
  }
  return structure;
}

function PersonalSpatialThumbnail({ fragment }: { fragment: PersonalFragmentTemplate }) {
  const structure = useMemo(() => personalFragmentThumbnailStructure(fragment), [fragment]);
  return <LibraryModelThumbnail structure={structure} label={`${fragment.name}三维球棍缩略图`} sourceAtomCount={fragment.atoms.length}
    activeAtomIndex={fragment.activeIndex}/>;
}

export default function PersonalFragmentCardPreview({ fragment }: { fragment: PersonalFragmentTemplate }) {
  const { ref, visible } = useLibraryThumbnail<HTMLDivElement>();
  return <div ref={ref} className="personal-fragment-card-preview" data-testid="personal-fragment-card-preview">
    {visible && <PersonalSpatialThumbnail fragment={fragment}/>}
  </div>;
}
