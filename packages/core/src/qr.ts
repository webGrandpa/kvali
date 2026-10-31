import qrcode from 'qrcode-generator';

/** The dark modules of a QR code for `text`, row by row (browser-safe). */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let r = 0; r < n; r += 1) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c += 1) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

/**
 * A QR code for a terminal, two module rows per line with half blocks. With `color` it is
 * drawn black on white whatever the theme; without, dark modules are left as the terminal's
 * own background, which reads correctly on the usual dark terminal.
 */
export function qrTerminal(text: string, color = true): string {
  const m = qrMatrix(text);
  const n = m.length;
  const pad = 2;
  const dark = (r: number, c: number) => r >= 0 && c >= 0 && r < n && c < n && m[r]![c]!;
  const lines: string[] = [];
  for (let r = -pad; r < n + pad; r += 2) {
    let line = '';
    for (let c = -pad; c < n + pad; c += 1) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      if (color) line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
      else line += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█';
    }
    lines.push(color ? `\x1b[38;5;16;48;5;231m${line}\x1b[0m` : line);
  }
  return lines.join('\n');
}
