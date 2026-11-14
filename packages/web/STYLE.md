# Favilla interface style

The interface is a drafting room in a machine shop. It should read as one calm, precise instrument: the
same hand in every corner, nothing that looks like a stock web widget.

## World and materials
- **Board**: the drawing board under everything. Sidebar, title bar and side panel sit on it
  (`--board`, cold-pressed board texture).
- **Vellum**: the sheet the conversation is written on (`--paper`, hot-pressed vellum texture, relief 0.18:
  felt up close, never speckle at reading distance).
- **Plates**: raised, flat sheets for things you act on: the composer, user messages (work orders),
  menus, dialogs (`--sheet`, no texture). Their tints: `--sheet-2` for highlight in lists and for inline
  code; `--sheet-3` for tracks and disabled fills. Tables are ruled, never boxed or shaded.
- **Wells**: code, terminal output and diffs sit in a well a shade darker than the paper, in every theme
  (`--code-bg`).
- **Inks**: graphite for text (`--ink` … `--ink-4`): ink and ink-2 for what is read, ink-3 the lightest ink
  any text takes (WCAG AA on every surface of its theme), ink-4 for marks only (rails, ticks, gutters,
  placeholders, what is disabled). Blueprint cobalt for what is active or chosen (`--accent`, the only
  accent; never decoration: a folder's mark, an icon at rest and the composer's focus edge stay in ink),
  green ink for additions, red pencil for removals, amber for warnings.
- **Veils**: hover and press are the theme's own ink at 6% and 10% (`--hover`, `--press`).
- Textures come from `design/favilla-materials.easel.yaml` (Easel). Nothing else is drawn in code.

## Light
One light from the upper left. Plates catch it on their top edge (`--highlight`) and cast a short shadow
right and down in the ink's hue (`--shadow-1` for resting plates, `--shadow-2` for floating ones); fields
are pressed in (`--inset`, dark in every theme). No glows, no gradients on surfaces.

## Type
- IBM Plex Sans for interface and prose, IBM Plex Mono for code, paths, counts and keys. Chinese falls
  back to the system UI face (Microsoft YaHei UI, PingFang SC).
- Sizes, and no others: 11.5 meta (`--fs-xs`), 12.5 secondary (`--fs-sm`), 13.5 interface (`--fs-ui`),
  15 prose (`--fs-body`), 17 titles (`--fs-title`), 20 a figure read at a glance (`--fs-display`), 30 the
  welcome title (`--fs-hero`). Code that is read (blocks, terminals, diffs, search results) is 12.5; a command
  quoted beside a step's words, and the last lines of one still running, 11.5; inline code is 0.86 of its line.
- Weights 400, 500 for labels, 600 for titles. Numbers that change use tabular figures; prose and tables
  use lining figures in every face.
- Shortcuts are written, not drawn: their keys as plain characters in ink-3, never key caps.
- Sentence case everywhere; no tracked capitals. Technical names (models, effort levels, flags, paths)
  stay exactly as the tools write them.

## Shape
- Radius scale: 4 (keys, inline code, small marks), 6 (rows, menu items), 8 (buttons, inputs, plates
  inside the timeline), 12 (composer, dialogs, menus). Nothing is round except spinners and the
  window-controls' own buttons.
- Hairline rules (`--rule`) separate; `--rule-strong` outlines controls.

## Components
- Title bar: 40 px on the board, one sheet of texture with the docked sidebar and panel under it; the window
  buttons (drawn by the system on Windows) take its right end in the board's colour. It follows the columns
  below: with the sidebar docked open, the lead (sidebar button, mark, name) is as wide as the sidebar and the
  place (folder / session) starts 16 px into the paper; over a docked side panel the tools take the panel's
  column. Search is a field pressed into the board; on a phone only its glass is left, as a plain button.
- Tool calls form a process line: a thin rail with one mark per step; exploring steps (reads, searches,
  plain commands) fold into one line once the turn is over; edits always stay visible.
- Menus, selects, tooltips, confirmations and the context menu are the app's own; no browser or system
  widgets inside the window. Toasts come in centred under the title bar, over no control.
- Icons are one family (Phosphor), regular unless a state calls for fill or bold, in five sizes: 11 and 12 inside
  a line, 14 in small controls and beside small text, 16 in rows, menus, tabs and buttons, 20 for an empty panel.
  A stroke grows with its icon, so two sizes side by side are two weights of line.
- Spacing: a 2 px grid inside controls; 4 px steps between blocks (4, 8, 12, 16, 24, 32, 40, 48).
- Motion eases out and stops for `prefers-reduced-motion`: 120 ms for a change of state (`--fast`), every
  control the same way; 180 ms for what appears (`--slow`); 1.6 s for a mark that fades (`--linger`).
  Lists moved through with the keys light their rows at once. What streams in never animates, and what is
  already there does not animate again when a session opens.

## Themes
A theme is one file of colour variables in `src/themes` plus its textures in `src/themes/assets`.
Page styles use only the variables, so a new theme is a new file, not an edit.

- **Drafting** (`drafting.css`, the default light) and **Night shift** (its dark): vellum on a steel board, cobalt.
- **Daylight** (`daylight.css`, light): the common white interface, white paper and plates, a light grey sidebar,
  thin cool grey rules, one blue accent, no texture.
- **Porcelain** (`porcelain.css`, light): a blue-white glaze, smoother than vellum, a deeper cobalt.
- **Plain** (`plain.css`, light): neutral greys with no tint, flat white paper on a matte board, the accent is the ink.
- **Kiln** and **Kiln at night** (`kiln.css`): unbleached cold-pressed paper on a sandier board, sepia ink, fired
  clay, a book serif for prose and titles.

A new theme also gets its window colours in `packages/desktop/src/main.ts` (`BARS`), its name in the settings and
the command palette, and AA contrast for ink-3 on every surface.
