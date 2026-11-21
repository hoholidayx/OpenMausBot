import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { ATTACHMENTS_DIR, validateAttachmentUploadId } from "../attachments.ts";
import { attachmentTagCandidates } from "../turn-images.ts";
import { mimeFor } from "../message-file.ts";

export interface DotsUpload { path: string; name: string; mime: string }
const MAX_BYTES = 20 * 1024 * 1024;
export class DotsInputError extends Error { readonly status = 400; }

export function dotsInput(text: string, handoff?: readonly DotsUpload[]) {
  const files: DotsUpload[] = [];
  if (handoff) files.push(...handoff);
  else {
    const tags = attachmentTagCandidates(text);
    for (const tag of tags) files.push({ path: tag.path, name: tag.name || basename(tag.path), mime: mimeFor(tag.path) });
    for (const tag of tags.reverse()) text = text.slice(0, tag.start) + text.slice(tag.end);
  }
  for (const file of files) {
    if (file.path !== resolve(ATTACHMENTS_DIR, basename(file.path)) || !validateAttachmentUploadId(basename(file.path, extname(file.path)))) {
      throw new DotsInputError("Dots accepts only uploaded files from this conversation.");
    }
  }
  text = text.trim();
  if (files.length > 4 || [...text].length > 16000 || (!text && !files.length)) {
    throw new DotsInputError("Dots accepts up to 16,000 characters and four files per request.");
  }
  return { text, files };
}

async function withOriginal<T>(file: DotsUpload, read: (fd: Awaited<ReturnType<typeof open>>, size: number) => Promise<T>) {
  const fd = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Dots files must be regular files up to 20 MiB.");
    return await read(fd, stat.size);
  } finally { await fd.close(); }
}

export async function forwardedOriginal(source: string, path: string) {
  const tag = attachmentTagCandidates(source).find(one => one.path === path);
  if (!tag) return;
  const file = { path, name: tag.name || basename(path), mime: mimeFor(path) };
  dotsInput("", [file]);
  const bytes = await withOriginal(file, async (_fd, size) => size);
  return { attachment: { kind: tag.kind, ...file }, bytes };
}

export async function uploadBytes(file: DotsUpload) {
  return withOriginal(file, async (fd, size) => {
    const data = new Uint8Array(size);
    let at = 0;
    while (at < data.length) {
      const { bytesRead } = await fd.read(data, at, data.length - at, at);
      if (!bytesRead) throw new Error("The attachment changed before Dots could send it.");
      at += bytesRead;
    }
    if ((await fd.stat()).size !== size) throw new Error("The attachment changed before Dots could send it.");
    return data;
  });
}
