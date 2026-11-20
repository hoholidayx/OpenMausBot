export interface MessageAttachmentFields {
  /** Renderers receive only the allowlisted /api/attachments URL. `file` entries are opened through the message-scoped
   * file route, never by path. `source`: a bot attach-file copy's original path on the server, for Show in folder.
   * `fromTool`: an image a tool's result returned while the bot worked, which it did not make or send. */
  attachments?: Array<
    | { kind: "image"; path: string; mime: string; name?: string; source?: string; fromTool?: true }
    | { kind: "file"; path: string; mime: string; name: string; source?: string }
    /** `text` is the words the note speaks (secret-redacted when stored): clients show it behind a
     * collapsed transcript, never as message body, and the model's replay folds it back after `text`. */
    | { kind: "audio"; path: string; mime: string; durationMs?: number; text?: string }
  >;
  /** A host-delivered image request. The remote task identifier stays on the server. */
  imageJob?: {
    state: "queued" | "running" | "done" | "failed" | "review";
    reason?: string;
    recheck?: true;
  };
}
