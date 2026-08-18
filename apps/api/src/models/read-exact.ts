import { readSync } from "node:fs";

export function readExactSync(
  fd: number,
  buffer: Buffer,
  length: number,
  position: number,
  label: string,
) {
  let filled = 0;
  while (filled < length) {
    const bytesRead = readSync(
      fd,
      buffer,
      filled,
      length - filled,
      position + filled,
    );
    if (bytesRead === 0) {
      throw new Error(`unexpected end of ${label} file`);
    }
    filled += bytesRead;
  }
}
