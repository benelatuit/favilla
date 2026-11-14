import { describe, expect, it } from 'vitest';
import { asksForArt, drawLook, lookNote, parseBrief, parseLooks, parseReview, visualAsk } from '../src/agent/brief';
import { goalTool } from '../src/tools/goal';
import type { Goal } from '../src/types';
import type { ToolContext } from '../src/tools/types';

const BRIEF = `KIND: 手书风格的音乐动画短片（选定：水墨手书）
FOR: 喜欢手书的普通观众
LOOKED AT:
- 某手书作品 | bilibili.com/video/x | 线条逐帧抖动、字幕跟拍
DIRECTIONS:
1. 水墨手书: 墨线抖动……
2. 剪纸皮影: ……
3. 浮世绘: ……
CHOSEN: 1 | 最贴近手书的手绘感
BAR:
- [look] 每个镜头的线条都是逐帧重画的手绘线，不是几何图形
- [measure] 成片至少 60 秒，1920x1080，24 fps
- [run] ffprobe 能读出视频流和音频流
- [look] 至少 8 个镜头，镜头或主体在动
FIRST: 两张关键帧
SKILLS: motion, paint
`;

describe('a brief and its review', () => {
  it('reads a brief, its bar with how each criterion is checked', () => {
    const b = parseBrief(BRIEF)!;
    expect(b.criteria.map((c) => c.check)).toEqual(['look', 'measure', 'run', 'look']);
    expect(b.criteria[1].text).toBe('成片至少 60 秒，1920x1080，24 fps');
    expect(b.skills).toEqual(['motion', 'paint']);
    expect(b.first).toBe('两张关键帧');
    expect(b.objective).toContain('手书风格的音乐动画短片');
    expect(parseBrief('I made a nice video for you.')).toBeNull();
    // A brief that explains its skills keeps their names (GLM wrote this, 2026-11-02).
    expect(parseBrief(BRIEF.replace('SKILLS: motion, paint', 'SKILLS: motion、paint（先motion：踩点、分镜与节奏是骨架；后paint：笔触、纸纹与关键帧原画）'))!.skills).toEqual(['motion', 'paint']);
  });

  it("reads a reviewer's verdicts and gaps", () => {
    const r = parseReview('1: PASS | lines boil on every frame\n2: FAIL | 16 seconds, not 60\n3: PASS | both streams\nGAPS:\n1. Make it 60 seconds.\n2. Add shots.');
    expect([...r.verdicts.entries()].map(([n, v]) => [n, v.pass])).toEqual([[1, true], [2, false], [3, true]]);
    expect(r.verdicts.get(2)!.why).toBe('16 seconds, not 60');
    expect(r.gaps).toContain('Make it 60 seconds.');
  });

  it('draws a rarer look from the request’s own world, the same for the same seed', () => {
    expect(visualAsk('帮我做一个视频吧，大概是手书那种类型的')).toBe(true);
    expect(visualAsk('make a poster for our gig')).toBe(true);
    expect(visualAsk('fix the flaky test in auth.go')).toBe(false);
    expect(asksForArt('请把这张图片抠图，导出透明底 PNG')).toBe(true);
    expect(asksForArt('帮商品主图去背景并裁切')).toBe(true);
    expect(asksForArt('fix the flaky test in auth.go')).toBe(false);
    const listed = parseLooks('**FIXED:** 整首原曲，不查参考\nLOOKS:\n1. 终端日志随鼓点刷新 | 开发者终端 | 常常\n2. **数据集缩略图与标注框** | 训练集与标注 | 有时\n3. 潜空间里聚散的色团 | embedding 可视化 | rarely.\n');
    expect(listed.fixed).toBe('整首原曲，不查参考');
    expect(listed.looks.map((l) => l.often)).toEqual([true, false, false]);
    expect(listed.looks[1]).toMatchObject({ look: '数据集缩略图与标注框', from: '训练集与标注' });
    const a = drawLook('s1:做个视频', listed.looks)!;
    expect(a.often).toBe(false);
    expect(drawLook('s1:做个视频', listed.looks)).toEqual(a);
    // Every look common: one of them still, never none.
    expect(drawLook('s1', [{ look: 'a', from: 'b', often: true }])?.look).toBe('a');
    expect(drawLook('s1', [])).toBeNull();
    expect(lookNote('', a)).toContain('The request fixes: nothing.');
    expect(lookNote(listed.fixed, a)).toContain(`${a.look} (from ${a.from})`);
  });

  it("keeps a brief's goal: the maker's marks are claims, and the bar cannot be rewritten or cleared", async () => {
    let goal: Goal | undefined = { objective: 'a film', criteria: [{ text: 'at least 60 seconds', done: false, check: 'measure' }, { text: 'hand-drawn lines', done: false, check: 'look' }], by: 'brief', updated: 0 };
    const ctx = { goal: () => goal, setGoal: (g: Goal | undefined) => (goal = g) } as unknown as ToolContext;
    const claimed = await goalTool.execute({ done: [1], evidence: 'ffprobe says 61 s' }, ctx);
    expect(goal!.criteria[0]).toMatchObject({ done: false, claimed: true, evidence: 'ffprobe says 61 s' });
    expect(claimed.content).toContain('[~] 1. at least 60 seconds (claimed, for the review)');
    expect(claimed.content).toContain('only the review marks them met');
    expect((await goalTool.execute({ criteria: ['it renders'] }, ctx)).isError).toBe(true);
    expect((await goalTool.execute({ clear: true }, ctx)).isError).toBe(true);
    expect(goal!.criteria.map((c) => c.text)).toEqual(['at least 60 seconds', 'hand-drawn lines']);
  });
});
