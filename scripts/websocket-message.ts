const decoder = new TextDecoder();

export async function websocketMessageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return decoder.decode(data);
  if (ArrayBuffer.isView(data)) {
    return decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  throw new TypeError(`Unsupported WebSocket message payload: ${Object.prototype.toString.call(data)}`);
}
