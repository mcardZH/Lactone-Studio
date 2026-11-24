export type TerminalClient = 'shell' | 'powershell' | 'codex' | 'claude' | 'dsh';
export type TerminalEvent =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode?: number | null; signal?: string | number | null; warning?: string };

export type AssistantProvider = 'deepseek' | 'openai' | 'claude' | 'gemini' | 'ollama' | 'kimi' | 'glm' | 'custom';
export type AssistantProtocol = 'chat' | 'responses' | 'messages';
export interface AssistantCapabilities { vision?: boolean; tools?: boolean; reasoningLevels?: string[]; reasoningDefault?: string }
export interface AssistantModel extends AssistantCapabilities { id: string; name?: string; modelCapabilities?: AssistantCapabilities }
export interface AssistantConnection {
  provider: AssistantProvider;
  baseUrl?: string;
  protocol?: AssistantProtocol;
  apiKey?: string;
}
export interface AssistantProfile extends AssistantCapabilities {
  model: string;
  reasoningEffort?: string;
  baseUrl: string;
  protocol: AssistantProtocol;
  keyRequired: boolean;
  hasKey: boolean;
  remembered: boolean;
  warning?: string;
}
export interface AssistantSettings {
  provider: AssistantProvider;
  profiles: Record<AssistantProvider, AssistantProfile>;
  canRemember: boolean;
  busy: boolean;
  paused: boolean;
  customInstructions: string;
  instructionsWarning?: string;
  conversationReset?: boolean;
}
export interface AssistantAttachmentReceipt { name: string; documentId?: string; recognition?: unknown; error?: string }
export interface AssistantImage { name: string; bytes: Uint8Array }
export type AssistantGuideImages = { images?: AssistantImage[]; attachments?: AssistantAttachmentReceipt[]; error?: string };
export type AssistantAttachmentPort = (file: File, signal: AbortSignal) => Promise<{ documentId: string; recognition: unknown }>;
export interface AssistantMessage { id: string; text: string; replayOf?: string; attachments?: AssistantAttachmentReceipt[]; images?: AssistantImage[] }
export interface AssistantTurnReceipt { status: 'completed' | 'incomplete' | 'cancelled' }
export type AssistantPhase = 'model' | 'tool' | 'waiting' | 'stopping' | 'paused' | 'idle';
export type AssistantEvent =
  | { type: 'assistant'; id?: string; turnId?: string; text: string }
  | { type: 'notice'; id?: string; turnId?: string; text: string }
  | { type: 'reasoning'; id: string; turnId: string; text: string; active: boolean; summary?: boolean }
  | { type: 'activity'; turnId: string; phase: AssistantPhase }
  | { type: 'guide-images'; id: string; turnId: string }
  | { type: 'guide-consumed'; id: string; turnId: string }
  | { type: 'guide-rejected'; id: string; turnId: string; text: string }
  | { type: 'reasoning-effort'; turnId: string; requested?: string; actual?: string }
  | { type: 'tool'; id: string; turnId?: string; name: string; status: 'running' | 'returned' | 'error'; arguments?: string; text?: string; receipt?: unknown; reused?: boolean };

export interface AgentPanelBridge {
  terminalStart(request: { id: string; cols: number; rows: number; client: TerminalClient }): Promise<{ id: string; pid: number }>;
  terminalWrite(id: string, data: string): Promise<void>;
  terminalResize(id: string, cols: number, rows: number): Promise<void>;
  terminalStop(id: string): Promise<void>;
  onTerminalEvent(listener: (event: TerminalEvent) => void): () => void;
  assistantSettings(): Promise<AssistantSettings>;
  assistantModels(request: AssistantConnection): Promise<{ models: AssistantModel[]; warning?: string }>;
  assistantConfigure(request: AssistantConnection & { model: string; remember: boolean; forget?: boolean; reasoningEffort?: string }): Promise<AssistantSettings>;
  assistantSend(message: string | AssistantMessage): Promise<AssistantTurnReceipt>;
  assistantContinue(): Promise<AssistantTurnReceipt>;
  assistantGuide(message: AssistantMessage, waitingForImages: boolean): Promise<boolean>;
  assistantGuideImages(id: string, update: AssistantGuideImages): Promise<boolean>;
  assistantSaveInstructions(text: string): Promise<AssistantSettings>;
  assistantCancel(): Promise<void>;
  assistantReset(): Promise<void>;
  onAssistantEvent(listener: (event: AssistantEvent) => void): () => void;
}

export interface ExternalConnectionState {
  available: boolean;
  instanceId: string;
  windowId: string;
  connections: Array<{ id: string; clientName: string; remembered: boolean }>;
  rememberedClients: Array<{ id: string; clientName: string }>;
}
export interface ExternalConnectionBridge {
  state(): Promise<ExternalConnectionState>;
  onState(listener: (state: ExternalConnectionState) => void): () => void;
  disconnect(sessionId: string): Promise<unknown>;
  forget(id: string): Promise<unknown>;
}

export function readAgentPanelBridge() {
  return (window as Window & { sciyueDesktop?: { mcpAgent?: AgentPanelBridge; mcp?: ExternalConnectionBridge } }).sciyueDesktop;
}

export const agentPanelError = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': Error: /u, '') : String(cause);
