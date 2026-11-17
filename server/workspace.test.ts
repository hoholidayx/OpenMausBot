import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";

import { ensureTaskWorkspace, ensureWorkspace, TASK_WORKSPACES_DIR, WORKSPACES_DIR, workspaceLocationsPrompt } from "./workspace.ts";

const BOT = "bot-workspace-test";

describe("workspace", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
    rmSync(TASK_WORKSPACES_DIR, { recursive: true, force: true });
  });

  it("describes current and earlier file locations without moving or exposing their contents", () => {
    const shared = ensureWorkspace(BOT);
    const thread = ensureTaskWorkspace(BOT, "thread-first");
    writeFileSync(join(shared, "old.txt"), "existing private file contents");
    const prompt = workspaceLocationsPrompt(BOT, thread, '/projects/quoted "folder"');
    expect(prompt).toContain(JSON.stringify(thread));
    expect(prompt).toContain(JSON.stringify(shared));
    expect(prompt).toContain(JSON.stringify(join(TASK_WORKSPACES_DIR, BOT)));
    expect(prompt).toContain(JSON.stringify('/projects/quoted "folder"'));
    expect(prompt).not.toContain("existing private file contents");
    expect(prompt).toContain("Do not move old files");
    expect(readFileSync(join(shared, "old.txt"), "utf8")).toBe("existing private file contents");
    expect(existsSync(join(thread, "old.txt"))).toBe(false);
    expect(workspaceLocationsPrompt(BOT, undefined)).toContain("inspect the working directory");
  });

  it("tells a bot with attach_file to deliver a file saved outside its folders, and no one else", () => {
    const thread = ensureTaskWorkspace(BOT, "thread-first");
    expect(workspaceLocationsPrompt(BOT, thread, undefined, { attachFile: true }))
      .toContain("also attach it with attach_file in the same turn");
    expect(workspaceLocationsPrompt(BOT, thread)).not.toContain("attach_file");
  });

  it("tells every bot that a picture it shows inline must be in the conversation's folders", () => {
    const thread = ensureTaskWorkspace(BOT, "thread-first");
    for (const prompt of [workspaceLocationsPrompt(BOT, thread), workspaceLocationsPrompt(BOT, thread, undefined, { attachFile: true })]) {
      expect(prompt).toContain("Chat links and inline images open only files in currentWorkingFolder and sharedBotFolder.");
    }
    expect(workspaceLocationsPrompt(BOT, thread)).toContain("Save a file or picture you want to show in chat there.");
  });

  it("creates distinct private task desks outside shared memory and refuses path traversal", () => {
    const shared = ensureWorkspace(BOT);
    const first = ensureTaskWorkspace(BOT, "thread-first");
    const second = ensureTaskWorkspace(BOT, "thread-second");
    expect(first).toBe(join(TASK_WORKSPACES_DIR, BOT, "thread-first"));
    expect(first.startsWith(shared)).toBe(false);
    expect(first).not.toBe(second);
    writeFileSync(join(first, "draft.txt"), "first thread only");
    expect(ensureTaskWorkspace(BOT, "thread-first")).toBe(first);
    expect(readFileSync(join(first, "draft.txt"), "utf8")).toBe("first thread only");
    expect(existsSync(join(second, "draft.txt"))).toBe(false);
    if (process.platform !== "win32") expect(statSync(first).mode & 0o777).toBe(0o700);
    for (const bad of ["", "..", "../other", "a/b", "a\\b", "/absolute", "a%2Fb", "x".repeat(129)]) {
      expect(() => ensureTaskWorkspace(bad, "thread")).toThrow("Invalid");
      expect(() => ensureTaskWorkspace(BOT, bad)).toThrow("Invalid");
    }
  });
});
