// Shared types for the CapCut MCP server.

/** Whether a tool changes project state. Mirrored into MCP tool annotations. */
export enum ToolKind {
  /** Reads state or catalogue data; never writes. */
  READ_ONLY = 'READ-ONLY',
  /** Changes the in-memory draft or writes CapCut project files. */
  MUTATING = 'MUTATING',
}

export type ResponseFormat = 'markdown' | 'json';

/** `POST /create_draft` output. */
export interface CreateDraftOutput {
  draft_id: string;
  draft_url?: string;
}

/** `POST /save_draft` output. */
export interface SaveDraftOutput {
  success?: boolean;
  draft_url?: string;
}

/** Entries returned by the `get_*_types` catalogue endpoints. */
export interface AssetTypeEntry {
  name: string;
  [key: string]: unknown;
}
