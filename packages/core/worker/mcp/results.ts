import type { CallToolResult } from "@modelcontextprotocol/server";

import type { AccountApiBinary } from "./account-client";

/** What a tool answers with: the MCP SDK's structured content, an object. */
type StructuredContent = NonNullable<CallToolResult["structuredContent"]>;

export function toolResult(value: StructuredContent): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

export function toolError(cause: unknown): CallToolResult {
  const message = cause instanceof Error ? cause.message : "Request failed";

  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export async function runTool(action: () => Promise<StructuredContent>) {
  try {
    return toolResult(await action());
  } catch (error) {
    return toolError(error);
  }
}

function bytesToBase64(bytes: Uint8Array) {
  const chunks: string[] = [];

  for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
    );
  }

  return btoa(chunks.join(""));
}

export async function runBinaryResourceTool(input: {
  action: () => Promise<AccountApiBinary>;
  uri: string;
  mimeType?: string;
  fallbackFilename: string;
}): Promise<CallToolResult> {
  try {
    const resource = await input.action();
    const returnedBytes = resource.bytes.byteLength;

    const nextOffsetBytes =
      resource.offsetBytes + returnedBytes < resource.totalBytes
        ? resource.offsetBytes + returnedBytes
        : null;

    const filename = resource.filename ?? input.fallbackFilename;

    const metadata = {
      filename,
      contentType: input.mimeType ?? resource.contentType,
      offsetBytes: resource.offsetBytes,
      returnedBytes,
      totalBytes: resource.totalBytes,
      nextOffsetBytes,
      complete: nextOffsetBytes === null && resource.offsetBytes === 0,
    };

    return {
      content: [
        { type: "text", text: JSON.stringify(metadata, null, 2) },
        {
          type: "resource",
          resource: {
            uri: input.uri,
            mimeType: metadata.contentType,
            blob: bytesToBase64(resource.bytes),
          },
        },
      ],
      structuredContent: metadata,
    };
  } catch (error) {
    return toolError(error);
  }
}

type ResourceLink = Extract<
  CallToolResult["content"][number],
  { type: "resource_link" }
>;

export async function runResourceLinkTool(
  action: () => Promise<{
    structuredContent: StructuredContent;
    resource: ResourceLink;
  }>
): Promise<CallToolResult> {
  try {
    const result = await action();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.structuredContent, null, 2),
        },
        result.resource,
      ],
      structuredContent: result.structuredContent,
    };
  } catch (error) {
    return toolError(error);
  }
}
