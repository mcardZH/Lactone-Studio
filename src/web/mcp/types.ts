export type McpPresentationMode = 'follow' | 'foreground' | 'background';
export interface McpPresentationOrigin {
  projectEpoch: string;
  activationEpoch: number;
  module: string;
  activeTarget: string | null;
}
export const presentationFields = { presentation: { enum: ['follow', 'foreground', 'background'] as const } };

/** Optional explicit presentation is shared by both dispatchers. A legacy
 * foreground request remains an explicit request to reveal the OS window. */
export function presentationMode(args: Record<string, unknown>): McpPresentationMode {
  const mode = args.presentation;
  if (mode === undefined) return args.foreground === true ? 'foreground' : 'follow';
  if (mode !== 'follow' && mode !== 'foreground' && mode !== 'background') throw toolError('INVALID_PRESENTATION', '无效的 ES 窗口呈现方式。');
  if (args.foreground === true && mode !== 'foreground') throw toolError('INVALID_PRESENTATION', 'foreground 与 presentation 指定了不同的显示方式。');
  return mode;
}

export interface McCall {
  requestId: string;
  batchIndex?: number;
  presentationOrigin?: Readonly<McpPresentationOrigin>;
  signal: AbortSignal;
  session: { id: string; clientName: string; instanceId: string; windowId: string };
}

export interface McTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** A batch can validate its envelope here and each advertised item inside the tool. */
  argumentValidationSchema?: Record<string, unknown>;
  call(args: Record<string, unknown>, context?: McCall): unknown | Promise<unknown>;
}

export function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

export function toolError(code: string, message: string, data?: unknown) {
  return Object.assign(new Error(message), { code, data });
}
