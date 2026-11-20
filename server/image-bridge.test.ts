import { expect, it } from "vitest";
import { ImageBridge } from "./image-bridge.ts";
import { startFakeHttpMcp } from "./testing/fake-http-mcp-server.ts";

it("checks paginated image tools and optional size support without submitting an image", async () => {
  const task = { type: "object", required: ["task_id"], properties: { task_id: { type: "string" } } };
  const submit = {
    type: "object",
    additionalProperties: false,
    required: ["request_id", "prompt"],
    properties: { request_id: { type: "string" }, prompt: { type: "string" } },
  };
  const tools = [
    { name: "info", inputSchema: { type: "object" } },
    { name: "image_status", inputSchema: task },
    { name: "image_result", inputSchema: task },
  ];
  const server = await startFakeHttpMcp({
    pageSize: 2,
    tools: [
      ...tools,
      {
        name: "image_submit",
        inputSchema: { ...submit, properties: { ...submit.properties, size: { type: "string" } } },
      },
    ],
  });
  const bridge = new ImageBridge({ type: "http", url: server.url, headers: {} }, AbortSignal.timeout(10_000));
  try {
    await bridge.open();
    await bridge.check();
    expect(server.toolsLists).toBe(2);
    server.setTools([...tools, { name: "image_submit", inputSchema: submit }]);
    await expect(bridge.check()).rejects.toThrow("invalid_contract");
    expect(server.calls).toEqual([]);
  } finally {
    await bridge.close();
    await server.close();
  }
});
