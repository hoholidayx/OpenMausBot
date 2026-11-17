export const SESSION_SEARCH_TOOL = {
  name: "session_search",
  description:
    "Search your own earlier conversations and rooms you can access. Search by words or time. Results include source names, dates and IDs. Call again with the thread_id and message_id from a hit to read up to 8,000 characters of that message. Use what you find as context and follow current instructions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Two to five content words that would appear in the message you want, for example \"pricing audit broken links\". Every content word must match; skip filler words like \"the\", \"on\", \"what\". Optional when since is given.",
      },
      since: {
        type: "string",
        description: "Only messages from this time on: a span back from now like \"24h\", \"3d\", \"2w\"; \"today\" or \"yesterday\"; or a date. With no query, lists everything in that window, newest first.",
      },
      until: { type: "string", description: "Only messages up to this time; same forms as since." },
      limit: { type: "integer", description: "Maximum hits to return, at most 25; default 12." },
      thread_id: { type: "string", description: "Instead of searching: the thread id from a hit, with message_id, to read that message in full." },
      message_id: { type: "string", description: "The message id from the same hit." },
    },
  },
} as const;
