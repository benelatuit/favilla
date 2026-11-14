import { actions, confirmDialog, getState, setUi, toast } from '../lib/store';
import { desktop } from '../lib/desktop';
import { ArrowSquareOut, ClipboardText, Copy, FileCode, FolderOpen, GitBranch, PencilSimple, PushPin, PushPinSlash, Scissors, SelectionAll, Trash } from './icons';
import { api } from '../lib/api';
import { openFile } from './FileView';
import { copyText } from '../lib/clipboard';
import type { MenuEntry } from './ui/Menu';

/** Raw text behind rendered messages, so "Copy" gives the markdown the agent wrote, not the rendered page. */
const rawText = new WeakMap<HTMLElement, string>();

export function keepRawText(card: HTMLElement | null, text: string) {
  if (!card) return;
  rawText.set(card, text);
  return () => { rawText.delete(card); };
}

type T = (key: string) => string;

const copy = (text: string, t: T) => void copyText(text, t);

function editableOf(target: Element): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
  const el = target.closest('input, textarea, [contenteditable="true"]') as HTMLElement | null;
  if (!el) return null;
  if (el instanceof HTMLInputElement && !['text', 'search', 'url', 'email', 'password', ''].includes(el.type)) return null;
  return el;
}

function selectedIn(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
  }
  return window.getSelection()?.toString() ?? '';
}

/** What a right click offers at this spot. An empty list means no menu. */
export function contextEntries(target: Element, t: T): MenuEntry[] {
  const groups: MenuEntry[][] = [];
  const editable = editableOf(target);
  if (editable) {
    const selected = selectedIn(editable);
    const readOnly = (editable as HTMLInputElement).readOnly || (editable as HTMLInputElement).disabled;
    const password = editable instanceof HTMLInputElement && editable.type === 'password';
    groups.push([
      { id: 'cut', label: t('Cut'), icon: <Scissors size={16} />, keys: 'Mod+X', disabled: !selected || readOnly || password, onSelect: () => (editable.focus(), document.execCommand('cut')) },
      { id: 'copy', label: t('Copy'), icon: <Copy size={16} />, keys: 'Mod+C', disabled: !selected || password, onSelect: () => (editable.focus(), document.execCommand('copy')) },
      {
        id: 'paste',
        label: t('Paste'),
        icon: <ClipboardText size={16} />,
        keys: 'Mod+V',
        disabled: readOnly,
        onSelect: () =>
          navigator.clipboard.readText().then(
            (text) => {
              editable.focus();
              document.execCommand('insertText', false, text);
            },
            () => toast(t('Could not use the clipboard'), 'error'),
          ),
      },
      {
        id: 'all',
        label: t('Select all'),
        icon: <SelectionAll size={16} />,
        keys: 'Mod+A',
        onSelect: () => {
          editable.focus();
          if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) editable.select();
          else document.execCommand('selectAll');
        },
      },
    ]);
    return groups[0];
  }

  const selection = window.getSelection()?.toString() ?? '';
  if (selection.trim()) groups.push([{ id: 'copy', label: t('Copy'), icon: <Copy size={16} />, keys: 'Mod+C', onSelect: () => copy(selection, t) }]);

  const link = target.closest('a[href]') as HTMLAnchorElement | null;
  if (link && /^https?:/.test(link.href)) {
    groups.push([
      { id: 'open-link', label: t('Open link'), icon: <ArrowSquareOut size={16} />, onSelect: () => (desktop ? desktop.openExternal(link.href) : window.open(link.href, '_blank', 'noopener')) },
      { id: 'copy-link', label: t('Copy link'), icon: <Copy size={16} />, onSelect: () => copy(link.href, t) },
    ]);
  }

  const code = target.closest('pre.code');
  if (code) groups.push([{ id: 'copy-code', label: t('Copy code'), icon: <Copy size={16} />, onSelect: () => copy(code.querySelector('code')?.textContent ?? '', t) }]);

  const file = target.closest('[data-ctx="file"]') as HTMLElement | null;
  if (file?.dataset.file) {
    // A file an answer named: relative, or only the end of its path; the server says which file it is.
    const asked = file.dataset.file;
    const at = { line: Number(file.dataset.line) || undefined, end: Number(file.dataset.end) || undefined, session: file.dataset.session };
    const where = () => api<{ path: string }>(`/file?stat&path=${encodeURIComponent(asked)}${at.session ? `&session=${encodeURIComponent(at.session)}` : ''}`).then((f) => f.path);
    const failed = (e: unknown) => toast((e as Error).message ?? String(e), 'error');
    const items: MenuEntry[] = [{ id: 'view-file', label: t('Open'), icon: <FileCode size={16} />, onSelect: () => openFile(asked, at) }];
    if (desktop) {
      items.push(
        { id: 'open-file', label: t('Open in the editor'), icon: <ArrowSquareOut size={16} />, onSelect: () => where().then((p) => desktop!.openPath(p).then((err) => err && toast(err, 'error')), failed) },
        { id: 'show-file', label: t('Show in folder'), icon: <FolderOpen size={16} />, onSelect: () => where().then((p) => desktop!.showItem(p), failed) },
      );
    }
    items.push({ id: 'copy-path', label: t('Copy path'), icon: <Copy size={16} />, onSelect: () => where().then((p) => copy(p, t), () => copy(asked, t)) });
    groups.push(items);
  } else if (file?.dataset.path) {
    const path = file.dataset.path;
    const items: MenuEntry[] = [];
    if (desktop) {
      items.push(
        {
          id: 'open-file',
          label: t('Open file'),
          icon: <ArrowSquareOut size={16} />,
          onSelect: () => desktop!.openPath(path).then((err) => err && toast(err, 'error')),
        },
        { id: 'show-file', label: t('Show in folder'), icon: <FolderOpen size={16} />, onSelect: () => desktop!.showItem(path) },
      );
    }
    items.push({ id: 'copy-path', label: t('Copy path'), icon: <Copy size={16} />, onSelect: () => copy(path, t) });
    groups.push(items);
  }

  const tool = target.closest('[data-ctx="tool"]') as HTMLElement | null;
  if (tool?.dataset.copy) groups.push([{ id: 'copy-tool', label: t(tool.dataset.copyLabel ?? 'Copy'), icon: <Copy size={16} />, onSelect: () => copy(tool.dataset.copy!, t) }]);

  const message = target.closest('[data-ctx="message"]') as HTMLElement | null;
  const key = message?.dataset.key;
  const raw = message && rawText.get(message);
  if (message && key && raw) {
    const items: MenuEntry[] = [{ id: 'copy-message', label: t('Copy message'), icon: <Copy size={16} />, onSelect: () => copy(raw, t) }];
    // A sent message can be changed and sent again in a new branch; an answer can start a branch after its turn.
    if (message.dataset.kind === 'user') items.push({ id: 'edit-message', label: t('Edit and send again'), icon: <PencilSimple size={16} />, onSelect: () => setUi({ editing: key }) });
    else if (message.classList.contains('is-final'))
      items.push({
        id: 'branch',
        label: t('Branch from here'),
        icon: <GitBranch size={16} />,
        onSelect: () => actions.fork(key.split(':')[0], 'after').catch((e) => toast(String(e), 'error')),
      });
    groups.push(items);
  }

  const session = target.closest('[data-ctx="session"]') as HTMLElement | null;
  if (session?.dataset.id) groups.push(sessionEntries(session.dataset.id, session.dataset.title ?? '', t));

  return groups.flatMap((g, i) => (i ? [{ kind: 'separator' as const }, ...g] : g));
}

export function sessionEntries(id: string, title: string, t: T): MenuEntry[] {
  const pinned = getState().pinned.includes(id);
  return [
    pinned
      ? { id: 'unpin', label: t('Unpin'), icon: <PushPinSlash size={16} />, onSelect: () => actions.pin(id, false) }
      : { id: 'pin', label: t('Pin'), icon: <PushPin size={16} />, onSelect: () => actions.pin(id, true) },
    { id: 'rename', label: t('Rename'), icon: <PencilSimple size={16} />, onSelect: () => setUi({ renaming: id }) },
    { id: 'copy-id', label: t('Copy session ID'), icon: <Copy size={16} />, onSelect: () => copy(id, t) },
    {
      id: 'delete',
      label: t('Delete'),
      icon: <Trash size={16} />,
      danger: true,
      onSelect: async () => {
        const ok = await confirmDialog({
          title: t('Delete this session?'),
          body: `${title || t('Untitled session')}. ${t('Its conversation is removed from this computer; files the agent changed stay as they are.')}`,
          confirm: t('Delete'),
          cancel: t('Cancel'),
          danger: true,
        });
        if (ok) actions.remove(id).catch((e) => toast(String(e), 'error'));
      },
    },
  ];
}
