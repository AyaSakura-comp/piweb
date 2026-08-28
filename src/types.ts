/** Supported pi thinking levels */
export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Explicit web-channel role; Life is a singleton outside session management. */
export type ChannelKind = 'standard' | 'life';

/** A registered channel the gateway will respond in */
export interface RegisteredChannel {
  jid: string;
  name: string;
  folder: string;
  requiresTrigger: boolean;
  isMain: boolean;
  modelOverride: string;
  thinkingOverride: ThinkingLevel | '';
  cwdOverride: string;
  /** Existing non-web transports may omit this; persistence defaults to standard. */
  kind?: ChannelKind;
}

/** Queued message row from SQLite */
export interface QueuedMessage {
  rowid: number;
  channel_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  status: 'pending' | 'processing' | 'done' | 'failed' | 'aborted';
  /** JSON array of attachment metadata, or null */
  attachments: string | null;
  /** Whether this message may pre-empt an active turn in the same channel. */
  interrupt_active: 0 | 1;
}

/** Agent invocation result */
export interface AgentResult {
  ok: boolean;
  text: string;
  error?: string;
  /** The active turn was cancelled through Pi's session-level abort API. */
  aborted?: boolean;
}
