/**
 * 联系人同步的批量切分。服务端每个请求有条数上限，而且每条 upsert
 * 都要做几次 D1 往返，请求太大就会超时。CLI 负责把任意大小的输入切成安全的
 * 分片顺序提交，运营不用再自己拆文件。
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
    throw new Error(`--chunk-size 必须是 1-${MAX_CONTACT_CHUNK_SIZE} 之间的整数`);
  }
  return value;
}

/**
 * 按 CSV 记录（而不是按行）切分：带引号的字段里可以有换行，直接 split('\n')
 * 会把一条记录劈成两半。
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
  /** 数据行数（不含表头）；用来把服务端返回的分片内行号还原成原文件行号。 */
  rows: number;
}

/** 保留表头，把数据行按 size 切成多份可独立提交的 CSV。 */
export function chunkCsv(source: string, size: number): CsvChunk[] {
  const records = splitCsvRecords(source.replace(/^\uFEFF/, ''));
  if (records.length === 0) throw new Error('CSV 内容为空');
  const [header, ...rows] = records;
  if (rows.length === 0) return [{ csv: `${header}\n`, rows: 0 }];
  return chunkItems(rows, size).map((chunk) => ({
    csv: `${[header, ...chunk].join('\n')}\n`,
    rows: chunk.length,
  }));
}
