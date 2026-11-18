import { beforeEach, describe, expect, it, vi } from 'vitest';

// What a click on a link to a file here does, with the desktop app's bridge and the server stood in for.
const bridge = { openPath: vi.fn(async (_file: string) => ''), showItem: vi.fn((_file: string) => {}) };
const calls = { api: [] as string[], viewer: [] as { src: string; name: string }[], toasts: [] as string[], files: [] as string[] };
let found: Record<string, string> = {};

vi.mock('../src/lib/desktop', () => ({ desktop: bridge, isMac: false }));
vi.mock('../src/lib/api', () => ({
  api: async (url: string) => {
    calls.api.push(url);
    const asked = new URLSearchParams(url.split('?')[1]).get('path') ?? '';
    if (!(asked in found)) throw new Error('No such file');
    return { path: found[asked] };
  },
}));
vi.mock('../src/components/ui/Viewer', () => ({ openViewer: (images: { src: string; name: string }[]) => calls.viewer.push(...images) }));
vi.mock('../src/lib/store', () => ({
  toast: (text: string) => calls.toasts.push(text),
  setUi: (ui: { fileView?: { path: string } }) => ui.fileView && calls.files.push(ui.fileView.path),
  useStore: () => undefined,
}));

const { openLocalLink } = await import('../src/components/FileView');

beforeEach(() => {
  bridge.openPath.mockClear();
  bridge.showItem.mockClear();
  calls.api.length = calls.viewer.length = calls.toasts.length = calls.files.length = 0;
  found = {};
});

describe('a click on a link to a file on this computer', () => {
  it('opens a video with the program the system has for it, found in the session\'s project', async () => {
    found['候鸟电台/候鸟电台.mp4'] = 'C:\\work\\mv\\候鸟电台\\候鸟电台.mp4';
    await openLocalLink('候鸟电台/候鸟电台.mp4', 's1', '成片');
    expect(calls.api).toEqual([`/file?stat&path=${encodeURIComponent('候鸟电台/候鸟电台.mp4')}&session=s1`]);
    expect(bridge.openPath).toHaveBeenCalledWith('C:\\work\\mv\\候鸟电台\\候鸟电台.mp4');
    expect(calls.toasts).toEqual([]);
  });

  it('shows a picture in the viewer under the link\'s words', async () => {
    await openLocalLink('out/cover.png', 's1', '查看封面');
    expect(calls.viewer).toEqual([{ src: '/api/image?path=out%2Fcover.png&session=s1', name: '查看封面' }]);
    expect(bridge.openPath).not.toHaveBeenCalled();
  });

  it('shows the folder of a file that would run, and never starts it', async () => {
    found['tools/setup.bat'] = 'C:\\work\\tools\\setup.bat';
    await openLocalLink('tools/setup.bat', 's1', 'setup');
    expect(bridge.showItem).toHaveBeenCalledWith('C:\\work\\tools\\setup.bat');
    expect(bridge.openPath).not.toHaveBeenCalled();
  });

  it('hands a folder or a file outside the project to the system as written, and says so when a relative one is missing', async () => {
    await openLocalLink('C:\\work\\mv\\out', 's1', 'out');
    expect(bridge.openPath).toHaveBeenCalledWith('C:\\work\\mv\\out');
    bridge.openPath.mockClear();
    await openLocalLink('gone/film.mp4', 's1', 'film');
    expect(bridge.openPath).not.toHaveBeenCalled();
    expect(calls.toasts).toEqual(['No such file: gone/film.mp4']);
  });

  it('reports what the system said when it could not open the file', async () => {
    found['a.pdf'] = 'C:\\work\\a.pdf';
    bridge.openPath.mockResolvedValueOnce('No application is associated');
    await openLocalLink('a.pdf', 's1', 'a');
    expect(calls.toasts).toEqual(['No application is associated: C:\\work\\a.pdf']);
  });
});
