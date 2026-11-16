/** `answer` is what POST /api/keys/test returned, or null when that request failed. */
export function keyTestResult(answer: { ok?: unknown; reason?: unknown } | null | undefined): "ok" | "rejected" | "unverified" {
  if (answer?.ok === true) return "ok";
  return answer?.reason === "rejected" ? "rejected" : "unverified";
}
