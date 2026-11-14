import { describe, expect, it } from 'vitest';
import { chord, DesktopSession } from '../src/tools/desktop';

describe('computer control', () => {
  it('turns key chords into virtual-key codes', () => {
    expect(chord('ctrl+s')).toEqual([0x11, 0x53]);
    expect(chord('Ctrl+Shift+T')).toEqual([0x11, 0x10, 0x54]);
    expect(chord('alt+f4')).toEqual([0x12, 0x73]);
    expect(chord('enter')).toEqual([0x0d]);
    expect(chord('win+.')).toEqual([0x5b, 0xbe]);
    expect(() => chord('ctrl+banana')).toThrow(/Unknown key "banana"/);
  });

  it('maps points read off a scaled screenshot back to screen pixels', () => {
    const d = new DesktopSession();
    expect(() => d.toScreen([10, 10])).toThrow(/Look at the screen first/);
    // A 3840x2160 screen shown at 1280x720, and a window shot whose origin is not the screen's.
    d.view = { x: 0, y: 0, scale: 1 / 3, width: 1280, height: 720 };
    expect(d.toScreen([640, 360])).toEqual([1920, 1080]);
    d.view = { x: -1920, y: 200, scale: 0.5, width: 800, height: 600 };
    expect(d.toScreen([100, 50])).toEqual([-1720, 300]);
    expect(() => d.toScreen([900, 10])).toThrow(/outside the last screenshot/);
  });
});
