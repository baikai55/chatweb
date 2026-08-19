import { describe, expect, it } from "vitest";

import { readSSE, type SSEFrame } from "@/transport/sse";

describe("readSSE", () => {
  it("CRLF 跨网络 chunk 时不会凭空拆成两个帧", async () => {
    const response = responseFromChunks([
      "data: first\r",
      "\ndata: second\r\n\r\n",
    ]);
    const frames: SSEFrame[] = [];

    for await (const frame of readSSE(response)) frames.push(frame);

    expect(frames).toEqual([{ data: "first\nsecond" }]);
  });
});

function responseFromChunks(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), {
    headers: { "content-type": "text/event-stream" },
  });
}
