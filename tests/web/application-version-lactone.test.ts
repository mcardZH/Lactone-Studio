import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { applicationVersion, modificationNotice } from '../../src/application-version';
import FirstRunLicense from '../../src/web/FirstRunLicense';
import { SETTINGS_PAGES, SettingsAboutCard } from '../../src/web/modeling/SettingsPanel';

const repoRoot = path.resolve(__dirname, '../..');

describe('Lactone Studio rebranding & LICENSE.txt Article 7/8 compliance', () => {
  it('exposes structured Lactone Studio identity and unofficial modification provenance in applicationVersion', () => {
    expect(applicationVersion.productName).toBe('Lactone Studio');
    expect(applicationVersion.shortName).toBe('LS');
    expect(applicationVersion.displayVersion).toBe('2.0.3');
    expect(modificationNotice.unofficialModification).toBe(true);
    expect(modificationNotice.unofficialLabel).toBe('非官方修改版');
    expect(modificationNotice.modifiedVersion).toBe('2.0.3-lactone.1');
    expect(modificationNotice.modifier).toBe('mcardZH');
    expect(modificationNotice.sourceRepository).toBe('https://github.com/mcardZH/Lactone-Studio');
    expect(modificationNotice.upstreamName).toBe('Ester Studio (ES)');
    expect(modificationNotice.upstreamAuthor).toBe('Zixuan Zhang');
    expect(modificationNotice.upstreamRepository).toBe('https://github.com/Ahey1/Ester-Studio');
  });

  it('registers the About & Version page in SettingsPanel and renders complete Article 7 & 8 notices', () => {
    expect(SETTINGS_PAGES.some(([id, label]) => id === 'about' && label === '关于与版本')).toBe(true);

    const html = renderToStaticMarkup(createElement(SettingsAboutCard));
    expect(html).toContain('data-testid="lactone-about-card"');
    expect(html).toContain('Lactone Studio (LS)');
    expect(html).toContain('非官方修改版');
    expect(html).toContain('v2.0.3-lactone.1');
    expect(html).toContain('mcardZH');
    expect(html).toContain('https://github.com/mcardZH/Lactone-Studio');
    expect(html).toContain('Zixuan Zhang');
    expect(html).toContain('https://github.com/Ahey1/Ester-Studio');
    expect(html).toContain('Ester Studio');
  });

  it('displays Lactone Studio and unofficial modification attribution in FirstRunLicense header', () => {
    const html = renderToStaticMarkup(
      createElement(FirstRunLicense, {
        snapshot: {
          text: 'Ester Studio（ES）免费源码公开许可协议',
          sha256: 'abc123',
          acknowledged: false,
        },
        loading: false,
        saving: false,
        error: '',
        onContinue() {},
        onRetry() {},
      }),
    );
    expect(html).toContain('Lactone Studio');
    expect(html).toContain('非官方修改版');
    expect(html).toContain('mcardZH');
    expect(html).toContain('https://github.com/mcardZH/Lactone-Studio');
  });

  it('keeps README.md, index.html, desktop/main.cjs, and LICENSE.txt aligned with license requirements', () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
    expect(readme).toContain('# Lactone Studio (LS)');
    expect(readme).toContain('非官方修改版');
    expect(readme).toContain('v2.0.3-lactone.1');
    expect(readme).toContain('https://github.com/mcardZH/Lactone-Studio');
    expect(readme).toContain('https://github.com/Ahey1/Ester-Studio');
    expect(readme).toContain('Zixuan Zhang');

    const indexHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
    expect(indexHtml).toContain('Lactone Studio');
    expect(indexHtml).toContain('非官方修改版');

    const mainCjs = fs.readFileSync(path.join(repoRoot, 'desktop/main.cjs'), 'utf8');
    expect(mainCjs).toContain("appMetadata.productName || 'Lactone Studio'");
    expect(mainCjs).toContain('（非官方修改版） · 分子建模');

    const licenseTxt = fs.readFileSync(path.join(repoRoot, 'LICENSE.txt'), 'utf8');
    expect(licenseTxt).toContain('Ester Studio（ES）免费源码公开许可协议');
    expect(licenseTxt).toContain('Copyright (c) 2026 Zixuan Zhang');
  });

  it('provides Lactone Studio custom icons, asset hashes, and automated cross-platform GitHub Actions workflow', () => {
    const svgPath = path.join(repoRoot, 'public/favicon.svg');
    const pngPath = path.join(repoRoot, 'public/brand-icon.png');
    const icnsPath = path.join(repoRoot, 'scripts/portable/assets/lactone.icns');
    const icoPath = path.join(repoRoot, 'scripts/portable/assets/sciyue.ico');
    const sourceJsonPath = path.join(repoRoot, 'scripts/portable/assets/source.json');
    const workflowPath = path.join(repoRoot, '.github/workflows/release.yml');

    expect(fs.existsSync(svgPath)).toBe(true);
    expect(fs.readFileSync(svgPath, 'utf8')).toContain('<title>Lactone Studio</title>');
    expect(fs.existsSync(pngPath)).toBe(true);
    expect(fs.statSync(pngPath).size).toBeGreaterThan(1024);
    expect(fs.existsSync(icnsPath)).toBe(true);
    expect(fs.readFileSync(icnsPath).subarray(0, 4).toString('ascii')).toBe('icns');
    expect(fs.existsSync(icoPath)).toBe(true);

    const sourceJson = JSON.parse(fs.readFileSync(sourceJsonPath, 'utf8'));
    expect(sourceJson.icns?.path).toBe('scripts/portable/assets/lactone.icns');
    expect(sourceJson.png?.path).toBe('public/brand-icon.png');

    expect(fs.existsSync(workflowPath)).toBe(true);
    const workflowYaml = fs.readFileSync(workflowPath, 'utf8');
    expect(workflowYaml).toContain('macos-15-intel');
    expect(workflowYaml).toContain('windows-latest');
    expect(workflowYaml).toContain('ubuntu-24.04');
    expect(workflowYaml).toContain('scripts/release/package-macos.mjs');
    expect(workflowYaml).toContain('scripts/release/package-windows.mjs');
    expect(workflowYaml).toContain('scripts/release/package-linux.mjs');
    expect(workflowYaml).toContain('softprops/action-gh-release@v2');
    expect(workflowYaml).toContain('安装说明 (INSTALL).txt');
  });
});
