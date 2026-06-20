export const ansi = {
  clear: '\x1b[2J\x1b[H',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  highlight: '\x1b[30;43m',
} as const;

export const paint = (value: string, color: string): string => `${color}${value}${ansi.reset}`;

export const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

export const visibleLength = (value: string): number => stripAnsi(value).length;

export const padVisible = (value: string, width: number): string => {
  const length = visibleLength(value);
  if (length >= width) return value;
  return `${value}${' '.repeat(width - length)}`;
};

export const truncate = (value: string, width: number): string => {
  if (visibleLength(value) <= width) return value;
  const plain = stripAnsi(value);
  return `${plain.slice(0, Math.max(0, width - 3))}...`;
};

export const wrapPlain = (value: string, width: number): string[] => {
  const plain = stripAnsi(value);
  if (width <= 0 || plain.length <= width) return [plain];

  const lines: string[] = [];
  for (let index = 0; index < plain.length; index += width) {
    lines.push(plain.slice(index, index + width));
  }
  return lines;
};

export const center = (value: string, width: number): string => {
  const length = visibleLength(value);
  if (length >= width) return value;
  const left = Math.floor((width - length) / 2);
  return `${' '.repeat(left)}${value}${' '.repeat(width - length - left)}`;
};

export const formatBox = (title: string, lines: string[], width: number, height: number, color: string = ansi.bold): string[] => {
  const inner = width - 2;
  const bodyLines = height - 4;
  const box = [`+${'-'.repeat(inner)}+`, `|${center(paint(title, color), inner)}|`, `+${'-'.repeat(inner)}+`];

  for (let i = 0; i < bodyLines; i += 1) {
    const line = lines[i] ?? '';
    box.push(`|${padVisible(truncate(line, inner), inner)}|`);
  }

  box.push(`+${'-'.repeat(inner)}+`);
  return box;
};

export const joinColumns = (columns: string[][], gap = 2): string[] => {
  const height = Math.max(...columns.map((column) => column.length));
  const spacer = ' '.repeat(gap);
  const rows: string[] = [];

  for (let row = 0; row < height; row += 1) {
    rows.push(columns.map((column) => column[row] ?? '').join(spacer));
  }

  return rows;
};
