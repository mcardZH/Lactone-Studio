import { useRef } from 'react';
import type { CSSProperties } from 'react';
import { assignmentBadgeClickAllowed, assignmentDisplayKey, type AssignmentDisplayBadge, type AssignmentDisplayRegion } from '../../modeling/application/assignment-display';
import './assignment-badges.css';

export interface AssignmentBadgesProps {
  badges: readonly AssignmentDisplayBadge[];
  onRegionSelect(region: AssignmentDisplayRegion): void;
  selectedRegionKey?: string;
  /** Document ID + activation epoch + revision from the owning workspace. */
  contextKey?: string;
  disabled?: boolean;
  fontSize?: number;
}

export default function AssignmentBadges({ badges, onRegionSelect, selectedRegionKey, contextKey, disabled = false, fontSize }: AssignmentBadgesProps) {
  const press = useRef<{ key: string; contextKey?: string; pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  return <div className="model-assignment-badges" data-testid="model-assignment-badges" aria-label="原子区域标记" style={fontSize ? { fontSize } : undefined}>
    {badges.map(badge => <button type="button" key={badge.key} className="model-assignment-badge" data-testid="model-assignment-badge" data-region-id={badge.region.id} data-region-category={badge.region.category} data-atom-id={badge.atomId} aria-label={`选择${badge.region.description}`} title={badge.region.description} aria-pressed={selectedRegionKey === assignmentDisplayKey(badge.region)} disabled={disabled} style={{ left: badge.x, top: badge.y, '--assignment-color': badge.region.color } as CSSProperties}
      onPointerDown={event => { event.stopPropagation(); press.current = event.button === 0 ? { key: badge.key, contextKey, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false } : null; }}
      onPointerMove={event => { event.stopPropagation(); const current = press.current; if (current?.key === badge.key && current.pointerId === event.pointerId && Math.hypot(event.clientX - current.x, event.clientY - current.y) >= 4) current.moved = true; }}
      onPointerUp={event => { event.stopPropagation(); const current = press.current; if (current?.key === badge.key && Math.hypot(event.clientX - current.x, event.clientY - current.y) >= 4) current.moved = true; }}
      onPointerCancel={event => { event.stopPropagation(); if (press.current?.key === badge.key) press.current.moved = true; }}
      onDoubleClick={event => event.stopPropagation()}
      onContextMenu={event => { event.stopPropagation(); event.preventDefault(); }}
      onClick={event => { event.stopPropagation(); const current = press.current?.key === badge.key && press.current.contextKey === contextKey ? press.current : null; press.current = null; if (!disabled && assignmentBadgeClickAllowed(current, { x: event.clientX, y: event.clientY }, event.detail, current?.moved)) onRegionSelect(badge.region); }}
    >{badge.region.shortLabel}</button>)}
  </div>;
}
