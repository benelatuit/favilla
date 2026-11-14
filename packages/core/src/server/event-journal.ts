const EVENTS = 4096;
const BYTES = 4 * 1024 * 1024;

interface Frame {
  id: string;
  wire: string;
  bytes: number;
  /** Deltas for a main session, which a window receives only while it shows that session. */
  active?: string;
}

/** A short history for windows that temporarily lose their event connection. */
export class EventJournal {
  private frames: (Frame | undefined)[] = new Array(EVENTS);
  private last = 0;
  private first = 1;
  private bytes = 0;

  constructor(private readonly epoch: string) {}

  get cursor(): string {
    return this.id(this.last);
  }

  private id(n: number): string {
    return `${this.epoch}.${n}`;
  }

  append(line: string, active?: string): Frame {
    const n = ++this.last;
    const id = this.id(n);
    const bytes = Buffer.byteLength(line) + id.length + 5;
    const frame = { id, wire: `id: ${id}\n${line}`, bytes, active };
    while (this.first < n && (n - this.first >= EVENTS || this.bytes + bytes > BYTES)) {
      const slot = this.first++ % EVENTS;
      this.bytes -= this.frames[slot]!.bytes;
      this.frames[slot] = undefined;
    }
    if (bytes > BYTES) {
      this.first = n + 1;
    } else {
      this.frames[n % EVENTS] = frame;
      this.bytes += bytes;
    }
    return frame;
  }

  since(cursor: string | null, active?: string): Frame[] | undefined {
    if (!cursor) return undefined;
    const [epoch, sequence, extra] = cursor.split('.');
    const n = Number(sequence);
    if (epoch !== this.epoch || extra !== undefined || !Number.isSafeInteger(n) || String(n) !== sequence || n < this.first - 1 || n > this.last) return undefined;
    const frames: Frame[] = [];
    for (let i = n + 1; i <= this.last; i++) {
      const frame = this.frames[i % EVENTS]!;
      if (!frame.active || frame.active === active) frames.push(frame);
    }
    return frames;
  }
}
