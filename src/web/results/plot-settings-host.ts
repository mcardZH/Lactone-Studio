export interface PlotSettingsConnection {
  category: string;
  close(): void;
}

export interface PlotSettingsHost {
  connect(connection: PlotSettingsConnection): HTMLElement | null;
  disconnect(connection: PlotSettingsConnection): void;
}

// Detached result windows keep their own Settings host and DOM events.
export const plotSettingsHosts = new WeakMap<Document, PlotSettingsHost>();
