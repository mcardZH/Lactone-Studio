import type { GaussianSettings } from '../core/types';
import type { OrcaSettings } from '../core/orca/types';

/** Product availability gate; historical scientific definitions remain intact. */
export function pausedGaussianCapability(settings: GaussianSettings, hasRegionDrafts = false): string | null {
  return settings.oniom?.enabled || hasRegionDrafts
    ? '当前保存了 ONIOM / QM-MM 或区域草稿，本版本暂停此路线。原配置保留且不可生成；请明确切换为普通 Gaussian 设置后继续。'
    : null;
}

export function pausedOrcaCapability(settings: OrcaSettings): string | null {
  if (settings.task === 'esd') return 'ESD 待开发。原配置保留且不可生成，请选择其他计算任务。';
  return settings.multiscale.mode !== 'none'
    ? '当前保存了已移除的多尺度配置，原配置保留且不可生成；请明确切换为常规全 QM 设置。'
    : null;
}
