import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { promptWordsLast } from '../src/args';

const valued = new Set(['-m', '--model', '-C', '--cwd', '--summary-file']);
const takesValue = (flag: string) => valued.has(flag);
const isCommand = (word: string) => ['login', 'config'].includes(word);
const order = (args: string[]) => promptWordsLast(args, takesValue, isCommand);

describe('promptWordsLast', () => {
  it('moves a prompt that opens with a dash after "--", options and their values staying before it', () => {
    expect(order(['-p', '- You are given a state dictionary', '--cwd', 'x'])).toEqual(['-p', '--cwd', 'x', '--', '- You are given a state dictionary']);
    expect(order(['-m', 'deepseek/ds', '-p', 'Fix', '- one', '- two'])).toEqual(['-m', 'deepseek/ds', '-p', '--', 'Fix', '- one', '- two']);
  });

  it('leaves arguments alone when no word opens with a dash', () => {
    const args = ['-p', 'fix', 'the bug', '--cwd', 'x'];
    expect(order(args)).toBe(args);
  });

  it('keeps an option value that holds a space and words already after "--"', () => {
    expect(order(['--summary-file', '- odd name.json', '-p', 'go'])).toEqual(['--summary-file', '- odd name.json', '-p', 'go']);
    expect(order(['--model=a b', '-p', '- task', '--', 'tail'])).toEqual(['--model=a b', '-p', '--', '- task', 'tail']);
  });

  it('leaves a command and its arguments as they are', () => {
    const args = ['config', 'note', '- a value'];
    expect(order(args)).toBe(args);
  });

  it('gives commander the whole prompt in order', async () => {
    let got: { words: string[]; print?: boolean; cwd?: string } | undefined;
    const program = new Command()
      .exitOverride()
      .argument('[prompt...]')
      .option('-p, --print')
      .option('-C, --cwd <dir>')
      .action((words: string[], o) => {
        got = { words, print: o.print, cwd: o.cwd };
      });
    await program.parseAsync(order(['-p', '- You are given', 'a model', '-C', 'here']), { from: 'user' });
    expect(got).toEqual({ words: ['- You are given', 'a model'], print: true, cwd: 'here' });
  });
});
