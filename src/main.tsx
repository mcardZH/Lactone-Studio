import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './web/App';
import './web/styles.css';
import './web/interface-v053.css';
import {bindInterfaceThemeDocument} from './web/interface-theme-preferences';

// All native main/model windows share this entry, before their first render.
bindInterfaceThemeDocument(document);
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
