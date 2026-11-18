import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DesktopSession, desktopTool, type DesktopAction } from '../src/tools/desktop';
import type { ToolContext } from '../src/tools/types';

function fixture() {
  const d = new DesktopSession();
  d.view = { x: -400, y: 50, width: 240, height: 140, scale: 0.5 };
  const call = vi.spyOn(d, 'call').mockResolvedValue(true);
  const shot = vi.spyOn(d, 'shot').mockResolvedValue({
    image: { type: 'image', mediaType: 'image/png', data: '', name: 'screen.png' },
    info: { X: -400, Y: 50, W: 480, H: 280, Width: 240, Height: 140, Scale: 0.5, CursorX: 0, CursorY: 100 },
    scope: 'fixture',
  });
  const ctrl = new AbortController();
  const run = (actions: DesktopAction[]) => desktopTool.execute({ actions }, {
    desktop: () => d, signal: ctrl.signal, model: { vision: true },
  } as unknown as ToolContext);
  return { d, ctrl, call, shot, run };
}

describe.runIf(process.platform === 'win32')('Windows strokes without a desktop', () => {
  it('sends one timed screen path per stroke and preserves old input packets', async () => {
    const { d, run, call, shot } = fixture();
    try {
      const result = await run([
        { click: [12, 8], double: true }, { drag: [[5, 6], [10, 20]] },
        { stroke: [[20, 40], [50, 10], [80, 40]], ms: 400 },
        { stroke: [[5, 8], [20, 8]] }, { scroll: 3, at: [4, 9] },
      ]);
      expect(result.isError).toBeFalsy();
      expect(call.mock.calls.map(([op]) => op)).toEqual(['click', 'drag', 'stroke', 'stroke', 'wheel']);
      expect(call.mock.calls[0][1]).toEqual({ x: -376, y: 66, button: 'left', count: 2 });
      expect(call.mock.calls[1][1]).toEqual({ x1: -390, y1: 62, x2: -380, y2: 90 });
      expect(call.mock.calls[4][1]).toEqual({ x: -392, y: 68, clicks: -3 });
      const { samples, permit } = call.mock.calls[2][1] as { samples: number[]; permit: string };
      expect(samples.slice(0, 3)).toEqual([-360, 130, 0]);
      expect(samples.slice(-3)).toEqual([-240, 130, 400]);
      const points = samples.filter((_, i) => i % 3 === 0).map((_, i) => samples.slice(i * 3, i * 3 + 3));
      expect(points.some(([x, y]) => x === -300 && y === 70)).toBe(true);
      expect(points.length).toBeGreaterThan(3);
      expect(points.slice(1).every((p, i) => p[2] > points[i][2])).toBe(true);
      expect(fs.existsSync(permit)).toBe(false);
      expect(shot).toHaveBeenCalledTimes(1);
      expect(result.images).toHaveLength(1);
    } finally { d.close(); }
  });

  it('rejects a bad final knot before sending input', async () => {
    const { d, call, ctrl } = fixture();
    try {
      await expect(d.stroke({ stroke: [[10, 15], [9, 140]] }, ctrl.signal)).rejects.toThrow(/outside/);
      expect(call).not.toHaveBeenCalled();
    } finally { d.close(); }
  });

  it.each(['abort', 'corner'] as const)('stops the batch on %s, without capturing a desktop image', async mode => {
    const { d, ctrl, run, call, shot } = fixture();
    call.mockImplementation(async (_op, args) => {
      const permit = args?.permit as string;
      expect(fs.existsSync(permit)).toBe(true);
      if (mode === 'abort') {
        ctrl.abort();
        expect(fs.existsSync(permit)).toBe(false);
        throw new Error('The stroke was cancelled.');
      }
      throw new Error('STOP: top-left corner');
    });
    try {
      const work = run(Array.from({ length: 2 }, () => ({ stroke: [[24, 8], [68, 14]] })));
      if (mode === 'abort') await expect(work).rejects.toMatchObject({ name: 'AbortError' });
      else expect((await work).content).toContain('Do not use the desktop again');
      expect(call).toHaveBeenCalledTimes(1);
      expect(shot).not.toHaveBeenCalled();
    } finally { d.close(); }
  });

  it('replays the actual helper stroke functions against a recording mouse', () => {
    // Parse the asset, never run it. Only the two stroke functions are installed, with a fake FavillaDesk.
    const asset = fileURLToPath(new URL('../assets/desktop/windows.ps1', import.meta.url));
    const program = `
      $ErrorActionPreference = 'Stop'
      class FavillaDesk {
        static [string] $mode
        static [string] $log
        static [bool] Stopped() { return [FavillaDesk]::mode -eq 'stop' -and [FavillaDesk]::log.EndsWith('2,3 ') }
        static [void] StrokeMove([int]$x,[int]$y) {
          if ([FavillaDesk]::mode -eq 'fail' -and $x -eq 2) { throw 'move failed' }
          [FavillaDesk]::log += "$x,$y "
        }
        static [void] Button([string]$b,[bool]$down) { [FavillaDesk]::log += "$b=$down " }
      }
      $errors = $null
      $ast = [Management.Automation.Language.Parser]::ParseFile($env:STROKE_ASSET,[ref]$null,[ref]$errors)
      if ($errors) { throw $errors[0] }
      foreach ($name in 'Check-Stroke','Invoke-Stroke') {
        $fn = $ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$false)
        . ([ScriptBlock]::Create($fn.Extent.Text))
      }
      foreach ($mode in 'ok','stop','fail') {
        [FavillaDesk]::mode = $mode
        [FavillaDesk]::log = ''
        try { Invoke-Stroke @{ samples = 1,2,0,2,3,8,3,4,16; permit = $env:STROKE_ASSET } }
        catch { if ($mode -eq 'stop' -and !$_.Exception.Message.StartsWith('STOP:')) { throw }; if ($mode -eq 'ok') { throw } }
        [Console]::WriteLine([FavillaDesk]::log.Trim())
      }`;
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], {
      env: { ...process.env, STROKE_ASSET: asset }, windowsHide: true, encoding: 'utf8', timeout: 15_000,
    });
    expect(output.trim().split(/\r?\n/)).toEqual([
      '1,2 left=True 2,3 3,4 left=False', '1,2 left=True 2,3 left=False', '1,2 left=True left=False',
    ]);
  }, 20_000);
});
