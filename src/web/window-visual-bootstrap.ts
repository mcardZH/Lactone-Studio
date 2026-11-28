import { bindInterfaceFontDocument } from './interface-font-preferences';
import { bindInterfaceParadigmDocument } from './interface-paradigm-preferences';
import { bindInterfaceSurfaceDocument } from './interface-surface-preferences';
import { bindInterfaceThemeDocument } from './interface-theme-preferences';

/** Prepare an about:blank presentation document in its own DOM realm.
 * Stylesheets own visual tokens: copying computed variables inline would freeze
 * font-dependent tokens at the size that happened to be active when it opened. */
export function bootstrapWindowVisuals(source: Document, target: Document): () => void {
  const base = target.createElement('base');
  base.href = source.baseURI;
  target.head.appendChild(base);
  for (const node of source.querySelectorAll('link[rel="stylesheet"],style')) {
    target.head.appendChild(target.importNode(node, true));
  }
  target.documentElement.className = source.documentElement.className;
  Object.assign(target.documentElement.dataset, source.documentElement.dataset);
  const disposeFont=bindInterfaceFontDocument(target),disposeTheme=bindInterfaceThemeDocument(target),disposeSurface=bindInterfaceSurfaceDocument(target),disposeParadigm=bindInterfaceParadigmDocument(target);
  return()=>{disposeFont();disposeTheme();disposeSurface();disposeParadigm();};
}
