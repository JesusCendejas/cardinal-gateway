import { Writable } from 'node:stream';

/**
 * Collects pino JSON lines in memory. Tests inspect the raw text so a leaked
 * ticket or capability token cannot hide behind a serializer.
 */
export interface LogCapture {
  stream: Writable;
  text(): string;
  lines(): string[];
}

export function createLogCapture(): LogCapture {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });

  return {
    stream,
    text(): string {
      return Buffer.concat(chunks).toString('utf8');
    },
    lines(): string[] {
      return Buffer.concat(chunks)
        .toString('utf8')
        .split('\n')
        .filter((line) => line.length > 0);
    },
  };
}

export function collectLogs(logs: LogCapture): string {
  return logs.text();
}
