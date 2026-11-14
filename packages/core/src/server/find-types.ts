// What the find bar's search answers with; types only, so the web page can name them without the engine's code.

/**
 * A place in the conversation that holds the words searched for, named the way the timeline names its parts: a
 * message by its id (the user's, or one sent while the agent worked), an answer or a thought by `messageId:part`, a
 * step by its call id.
 */
export interface FindHit {
  block: string;
  kind: 'user' | 'steer' | 'text' | 'reasoning' | 'tool' | 'summary';
  /** How many times the words are in it. */
  count: number;
  /** For a step: some are in what it printed or changed, which shows once the step is opened. */
  output?: boolean;
  /** For a user message: the paste to open, in attachment order starting at 0. */
  paste?: number;
}

export interface FindResult {
  hits: FindHit[];
  /** Every match, over all hits. */
  total: number;
  /** More places matched than are listed. */
  capped: boolean;
}
