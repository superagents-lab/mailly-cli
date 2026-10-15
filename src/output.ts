const isTTY = process.stdout.isTTY === true;
const NO_COLOR = process.env.NO_COLOR != null && process.env.NO_COLOR !== '';
const useColor = isTTY && !NO_COLOR;

const ansi = (open: number, close: number) => (s: string) =>
  useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const c = {
  bold: ansi(1, 22),
  dim: ansi(2, 22),
  red: ansi(31, 39),
  green: ansi(32, 39),
  yellow: ansi(33, 39),
  cyan: ansi(36, 39),
  gray: ansi(90, 39),
};

export type OutputFormat = 'pretty' | 'json';

let outputFormat: OutputFormat = 'pretty';

export function setOutputFormat(format: OutputFormat) {
  outputFormat = format;
}

export function getOutputFormat(): OutputFormat {
  return outputFormat;
}

export function printJSON(data: unknown) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

export function success(message: string) {
  if (outputFormat === 'json') return;
  process.stdout.write(c.green('✔ ') + message + '\n');
}

export function info(message: string) {
  if (outputFormat === 'json') return;
  process.stdout.write(message + '\n');
}

export function hint(message: string) {
  if (outputFormat === 'json') return;
  process.stderr.write(c.dim(message) + '\n');
}

export function warn(message: string) {
  if (outputFormat === 'json') return;
  process.stderr.write(c.yellow('! ') + message + '\n');
}

export function fail(message: string, exitCode = 1, details: Record<string, unknown> = {}): void {
  if (outputFormat === 'json') {
    process.stdout.write(JSON.stringify({ success: false, error: message, ...details }) + '\n');
  } else {
    process.stderr.write(c.red('✖ ') + message + '\n');
  }
  // Let Node flush piped stdout/stderr before exiting. Calling process.exit()
  // here can truncate the JSON error envelope in non-interactive callers.
  process.exitCode = exitCode;
}

function visualWidth(s: string) {
  // strip ANSI then count code points (good enough for ASCII / latin / common CJK)
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of stripped) {
    const code = ch.codePointAt(0)!;
    // Treat CJK / fullwidth ranges as width 2
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3041 && code <= 0x33ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xa000 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function pad(s: string, width: number) {
  const diff = width - visualWidth(s);
  if (diff <= 0) return s;
  return s + ' '.repeat(diff);
}

export function printTable(headers: string[], rows: string[][]) {
  if (outputFormat === 'json') return;
  const widths = headers.map((h, i) =>
    Math.max(visualWidth(h), ...rows.map((r) => visualWidth(r[i] ?? '')))
  );
  const headerLine = headers.map((h, i) => c.bold(pad(h, widths[i]))).join('  ');
  process.stdout.write(headerLine + '\n');
  process.stdout.write(c.dim(widths.map((w) => '─'.repeat(w)).join('  ')) + '\n');
  for (const row of rows) {
    process.stdout.write(row.map((cell, i) => pad(cell ?? '', widths[i])).join('  ') + '\n');
  }
}
