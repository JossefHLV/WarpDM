#!/usr/bin/env node
/**
 * Hogra Native Messaging Host
 * Standard length-prefixed JSON IPC bridge for Chromium and Firefox browsers.
 */

import process from "node:process";

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  while (buffer.length >= 4) {
    const msgLen = buffer.readUInt32LE(0);
    if (buffer.length < 4 + msgLen) {
      break;
    }

    const jsonBuffer = buffer.subarray(4, 4 + msgLen);
    buffer = buffer.subarray(4 + msgLen);

    const text = jsonBuffer.toString("utf8");
    let msg = null;
    try {
      msg = JSON.parse(text);
    } catch (_) {}

    // Process message and send response
    const response = {
      status: "ok",
      received: true,
      echo: msg,
      timestamp: Date.now(),
    };

    sendNativeMessage(response);
  }
});

function sendNativeMessage(obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(payload.length, 0);

  process.stdout.write(Buffer.concat([lenBuf, payload]));
}
