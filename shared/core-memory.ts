export type CoreMemoryEdit =
  | { action: "add"; text: string }
  | { action: "update"; oldText: string; text: string }
  | { action: "remove"; oldText: string };

export interface CoreMemoryView {
  entries: string[];
  bytes: number;
  maxEntries: number;
  maxBytes: number;
}
