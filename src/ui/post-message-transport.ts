import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
  type MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";

export function isJsonRpcCandidate(data: unknown): boolean {
  return typeof data === "object"
    && data !== null
    && "jsonrpc" in data
    && (data as { jsonrpc?: unknown }).jsonrpc === "2.0";
}

export class FilteredPostMessageTransport implements Transport {
  private readonly eventTarget: Window;
  private readonly eventSource: MessageEventSource;
  private readonly messageListener: (event: MessageEvent) => void;

  constructor(eventTarget: Window = window.parent, eventSource: MessageEventSource = window.parent) {
    this.eventTarget = eventTarget;
    this.eventSource = eventSource;
    this.messageListener = (event) => {
      if (event.source !== this.eventSource) {
        console.debug("Ignoring message from unknown source", event);
        return;
      }

      if (!isJsonRpcCandidate(event.data)) return;

      const parsed = JSONRPCMessageSchema.safeParse(event.data);
      if (parsed.success) {
        console.debug("Parsed message", parsed.data);
        this.onmessage?.(parsed.data);
        return;
      }

      console.error("Failed to parse message", parsed.error.message, event);
      this.onerror?.(new Error(`Invalid JSON-RPC message received: ${parsed.error.message}`));
    };
  }

  async start(): Promise<void> {
    window.addEventListener("message", this.messageListener);
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!("method" in message) || message.method !== "ui/notifications/tool-input-partial") {
      console.debug("Sending message", message);
    }
    this.eventTarget.postMessage(message, "*");
  }

  async close(): Promise<void> {
    window.removeEventListener("message", this.messageListener);
    this.onclose?.();
  }

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;
}

