import { promises as fs } from 'node:fs';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJsonInput(path: string): Promise<unknown> {
  const source = path === '-' ? await readStdin() : await fs.readFile(path, 'utf8');
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`无法解析 JSON (${path}): ${error instanceof Error ? error.message : String(error)}`);
  }
}
