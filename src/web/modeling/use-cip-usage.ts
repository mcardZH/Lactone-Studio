import {useCallback,useRef} from 'react';
import type {ModelDocument} from '../../modeling/contracts';
import type {ModelViewportProps} from './ModelViewport';
import {preparedCarbonCipUsage} from './render/stereochemistry';

export type CipViewportUsage=Parameters<NonNullable<ModelViewportProps['onCipLabelsUsed']>>[0];
/** A late render cannot attribute usage to a replacement frame/document. This
 * consumes already prepared results and never invokes the scientific worker. */
export function currentPreparedCipUsage(document:ModelDocument,receipt:CipViewportUsage):boolean {
 if(receipt.documentId!==document.id||receipt.sourceRevision!==String(document.revision))return false;
 const actual=preparedCarbonCipUsage(document.draft.structure);
 if(!actual||actual.sourceId!==receipt.sourceId||actual.version!==receipt.version||actual.operation!==receipt.operation||!receipt.assignments.length)return false;
 const assigned=new Map(actual.assignments.map(row=>[row.atomId,row.label]));
 return receipt.assignments.every(row=>row.element==='C'&&assigned.get(row.atomId)===row.label);
}
export function useCurrentCipUsage(document:ModelDocument|undefined,active:boolean,onUsed:ModelViewportProps['onCipLabelsUsed']):ModelViewportProps['onCipLabelsUsed'] {
 const latest=useRef({document,active,onUsed});latest.current={document,active,onUsed};
 return useCallback((receipt:CipViewportUsage)=>{const current=latest.current;if(current.active&&current.document&&current.onUsed&&currentPreparedCipUsage(current.document,receipt))current.onUsed(receipt);},[]);
}
