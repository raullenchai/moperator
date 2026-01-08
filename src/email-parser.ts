import PostalMime from "postal-mime";
import type { ParsedEmail, Attachment } from "./types";

export async function parseEmail(
  message: ForwardableEmailMessage
): Promise<ParsedEmail> {
  const rawEmail = await streamToArrayBuffer(message.raw);
  const parser = new PostalMime();
  const parsed = await parser.parse(rawEmail);

  const attachments: Attachment[] = (parsed.attachments || []).map((att) => {
    const content = att.content;
    let buffer: ArrayBuffer;

    if (typeof content === "string") {
      buffer = new TextEncoder().encode(content).buffer as ArrayBuffer;
    } else if (content instanceof Uint8Array) {
      buffer = content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength
      ) as ArrayBuffer;
    } else {
      buffer = content;
    }

    return {
      filename: att.filename || "unnamed",
      mimeType: att.mimeType,
      size: buffer.byteLength,
      content: arrayBufferToBase64(buffer),
    };
  });

  return {
    from: message.from,
    to: message.to,
    subject: parsed.subject || "(no subject)",
    textBody: parsed.text || stripHtml(parsed.html || ""),
    htmlBody: parsed.html || undefined,
    attachments,
    receivedAt: new Date().toISOString(),
  };
}

async function streamToArrayBuffer(
  stream: ReadableStream<Uint8Array>
): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result.buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
