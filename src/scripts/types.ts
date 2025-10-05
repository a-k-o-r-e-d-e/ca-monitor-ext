export interface ForwardRequest {
  ca: string;
  chatTitle: string;
  timestamp: string;
  ticker: string;
}

export interface ProcessedCAEntry {
  ticker: string;
  firstSeen: string; // when first detected
  lastSeen: string; // when most recently seen
}

export type ProcessedCAsMap = Record<string, ProcessedCAEntry>;

export interface MessageData {
  mid: string;
  timestamp: string;
  text: string;
  chatTitle: string;
}

export interface RuntimeSettings {
  watchedChats: string[];
  maxMessageAge: number; // in seconds
}
