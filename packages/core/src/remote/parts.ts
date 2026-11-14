interface Part {
  k?: string;
  i?: number;
  of?: number;
  s?: string;
}

interface PartialMessage {
  total: number;
  parts: Map<number, string>;
  timer?: ReturnType<typeof setTimeout>;
}

// A slow transfer keeps its place while parts arrive. A stopped one must release the waiting requests.
const IDLE_MS = 30_000;

export class RemoteParts {
  private pending = new Map<string, PartialMessage>();

  constructor(private readonly expired: () => void, private readonly limit = Infinity) {}

  take({ k, i, of, s }: Part): string | null {
    if (!k || typeof i !== 'number' || typeof of !== 'number' || !Number.isSafeInteger(i) || !Number.isSafeInteger(of)
      || of < 1 || of > this.limit || i < 0 || i >= of || typeof s !== 'string') {
      throw new Error('invalid remote message part');
    }

    const message: PartialMessage = this.pending.get(k) ?? { total: of, parts: new Map() };
    if (message.total !== of || message.parts.has(i)) throw new Error('inconsistent remote message parts');
    message.parts.set(i, s);
    clearTimeout(message.timer);

    if (message.parts.size === of) {
      this.pending.delete(k);
      return Array.from({ length: of }, (_, i) => message.parts.get(i)!).join('');
    }

    message.timer = setTimeout(() => {
      this.pending.delete(k);
      this.expired();
    }, IDLE_MS);
    this.pending.set(k, message);
    return null;
  }

  clear(): void {
    for (const message of this.pending.values()) clearTimeout(message.timer);
    this.pending.clear();
  }
}
