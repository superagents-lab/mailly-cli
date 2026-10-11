/**
 * Chunking for contact sync. The server caps the number of items per request, and each upsert
 * costs several D1 round trips, so oversized requests time out. The CLI splits input of any
 * size into safe chunks and submits them in order, so operators never have to split files.
 */
export const DEFAULT_CONTACT_CHUNK_SIZE = 100;
export const MAX_CONTACT_CHUNK_SIZE = 500;

export function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function resolveChunkSize(value: number | undefined): number {
  if (value == null) return DEFAULT_CONTACT_CHUNK_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > MAX_CONTACT_CHUNK_SIZE) {
    throw new Error(`--chunk-size must be an integer between 1 and ${MAX_CONTACT_CHUNK_SIZE}`);
  }
  return value;
}

/**
 * Split by CSV record, not by line: quoted fields may contain newlines, and a plain split('\n')
 * would cut a record in half.
 */
export function splitCsvRecords(source: string): string[] {
  const records: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        current += '""';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        current += character;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
      current += character;
    } else if (character === '\n') {
      records.push(current.replace(/\r$/, ''));
      current = '';
    } else {
      current += character;
    }
  }
  records.push(current.replace(/\r$/, ''));
  return records.filter((record) => record.trim().length > 0);
}

export interface CsvChunk {
  csv: string;
  /** Data row count (excluding the header); maps chunk-local row numbers from the server back to the original file. */
  rows: number;
}

/** Keeps the header and splits data rows into CSV chunks of `size` that can be submitted independently. */
export function chunkCsv(source: string, size: number): CsvChunk[] {
  const records = splitCsvRecords(source.replace(/^\uFEFF/, ''));
  if (records.length === 0) throw new Error('CSV content is empty');
  const [header, ...rows] = records;
  if (rows.length === 0) return [{ csv: `${header}\n`, rows: 0 }];
  return chunkItems(rows, size).map((chunk) => ({
    csv: `${[header, ...chunk].join('\n')}\n`,
    rows: chunk.length,
  }));
}
