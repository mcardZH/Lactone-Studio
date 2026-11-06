import type { PostprocessDocument } from '../results/postprocess-document';
import { notifyAnalysisProjectStateChanged } from './analysis-state';
export interface PostprocessManagedTaskReference { taskId: string; sourceSetId: string; sourceVersion: string; locationId: string; directory: string; artifactIds: string[]; archived: true; documentId: string; sourceIdentity: string }
const references = new WeakMap<PostprocessDocument, PostprocessManagedTaskReference>();
const projectRestored = new WeakSet<PostprocessDocument>();
export const postprocessTaskAssociationRestoredFromProject = (document:PostprocessDocument)=>projectRestored.has(document);
const versions = new WeakMap<PostprocessDocument, number>(); let version = 0;
export const getPostprocessTaskAssociationVersion = (document: PostprocessDocument) => versions.get(document) ?? 0;
export function getPostprocessTaskAssociation(document: PostprocessDocument): PostprocessManagedTaskReference | undefined { return references.get(document); }
export function setPostprocessTaskAssociation(document: PostprocessDocument, value: PostprocessManagedTaskReference, restoring = false): void { references.set(document, structuredClone(value)); versions.set(document, ++version);if(restoring)projectRestored.add(document);if (!restoring) notifyAnalysisProjectStateChanged(); }
