import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './web/App';
import './web/styles.css';
import './web/interface-v053.css';
import './web/interface-paradigms.css';
import {bindInterfaceParadigmDocument} from './web/interface-paradigm-preferences';
import {bindInterfaceSurfaceDocument} from './web/interface-surface-preferences';
import {bindInterfaceThemeDocument} from './web/interface-theme-preferences';

// All native main/model windows share this entry, before their first render.
bindInterfaceThemeDocument(document);
bindInterfaceSurfaceDocument(document);
bindInterfaceParadigmDocument(document);
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
