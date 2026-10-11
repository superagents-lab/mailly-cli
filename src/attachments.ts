import { promises as fs } from 'node:fs';
import { basename, extname } from 'node:path';

export interface EmailAttachmentPayload {
  filename: string;
  mimeType: string;
  contentBase64: string;
  contentId?: string;
}

const MAX_ATTACHMENTS = 10;
const MAX_TOTAL_BYTES = 6 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.ics': 'text/calendar',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
};

function mimeTypeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function parseInlineSpec(spec: string): { contentId: string; path: string } {
  const separator = spec.indexOf('=');
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error('--inline 格式必须是 <content-id=path>');
  }
  const contentId = spec.slice(0, separator).trim().replace(/^<+|>+$/g, '');
  const path = spec.slice(separator + 1).trim();
  if (!contentId || /[\s\r\n<>]/.test(contentId) || contentId.length > 200) {
    throw new Error('--inline 的 content-id 必须是不含空白或尖括号的短标识');
  }
  if (!path) throw new Error('--inline 必须指定文件路径');
  return { contentId, path };
}

export async function loadEmailAttachments(
  paths: string[] = [],
  inlineSpecs: string[] = [],
): Promise<EmailAttachmentPayload[]> {
  const inputs: Array<{ path: string; contentId?: string }> = [
    ...paths.map((path) => ({ path })),
    ...inlineSpecs.map((spec) => parseInlineSpec(spec)),
  ];
  if (inputs.length > MAX_ATTACHMENTS) {
    throw new Error(`附件最多 ${MAX_ATTACHMENTS} 个`);
  }

  let totalBytes = 0;
  const attachments: EmailAttachmentPayload[] = [];
  for (const input of inputs) {
    const stat = await fs.stat(input.path).catch((error: NodeJS.ErrnoException) => {
      throw new Error(`无法读取附件 ${input.path}: ${error.message}`);
    });
    if (!stat.isFile()) throw new Error(`附件路径不是普通文件: ${input.path}`);
    if (stat.size === 0) throw new Error(`附件不能为空文件: ${input.path}`);
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('附件解码后总大小不能超过 6MB');
    }
    const bytes = await fs.readFile(input.path);
    // Re-check the bytes actually read in case the file changed after stat().
    totalBytes += bytes.byteLength - stat.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('附件解码后总大小不能超过 6MB');
    }
    attachments.push({
      filename: basename(input.path),
      mimeType: mimeTypeFor(input.path),
      contentBase64: bytes.toString('base64'),
      ...(input.contentId ? { contentId: input.contentId } : {}),
    });
  }
  return attachments;
}
