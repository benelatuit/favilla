---
name: paint
description: Painting pictures, illustrations, textures and page or game art by hand-drawn means with Favilla's paint tool (pencil, ink, watercolour, gouache, pastel, charcoal; hatching, washes, splatter; hair, fur, grass, leaves and form shading made in numbers; seamless tiles), and retouching existing pictures. Read it before the first paint call.
---

# Painting with the paint tool

The paint tool turns a description into a picture painted with real media on paper. Use it for pictures that should
look made by hand: illustrations, characters and creatures, scenes and backgrounds, paper and textures that repeat; to
retouch a picture (crop, levels, colour, grain, painting over it); and to cut a picture out of its ground.

Pick the means by what the picture is for:

| The picture | Made with |
|---|---|
| Interface icons: buttons, menus, states | the icon set the project uses, else one SVG icon library; never painted, never emoji |
| Charts, diagrams, data, interface chrome, anything that moves or must stay editable | code: CSS, SVG, canvas |
| A logo | the project's own file; a new one as SVG with real type |
| A photo of a real thing | a real photo; a painting never stands in for one |
| Illustrations, characters, scenes, spot art | paint |
| Painted art that also carries titles, captions or labels | paint the art without words (save to scratch), set real HTML/CSS type over it in a scratch HTML file, and export with `browser(url, width, height, out)` |
| A surface that repeats: paper, cloth, stone, grain | a small tile painted with `tile: true`; never noise made by CSS or SVG |
| A picture whose ground has to go | `paint(cut: ...)`, one call |

Hand-made marks on a page (washes behind headings, brush underlines, splatter) belong only where the page's own world is
made by hand, never on a tool or a dashboard.

## The loop

A canvas lives with Favilla between calls, by name, outside the project: no document file, and nothing is sent twice.

1. Start it: `paint(canvas: "fox", doc: <size, paper, layers>)`, with the big shapes only.
2. Look at the picture and the check sheet; the grid every 50 px gives coordinates.
3. Add work a layer at a time: `paint(canvas: "fox", layer: "fur", items: [...])`. Each call sends only the new marks,
   so make many small calls: this is how a picture gets detailed.
4. Fix what is wrong: `mode: replace` on a layer, `remove: ["#12", "old layer"]`, `undo: 1`. Each item has a number,
   reported when it is added.
5. Check fine work up close with `look: [x, y, w, h]`, which adds that part enlarged.
6. When it is good, `out: "public/fox.png"` writes the picture into the project (and keeps writing there). Before
   that nothing lands in the project.

`doc` starts the canvas over, so use it once. A project that keeps its art as documents can still paint a file with
`path`.

## How a picture gets detail

Detail comes from layers of work, from large to small, never from one big document:

1. **Big shapes**, flat: a `fill: flat` for each mass. Name each outline once under `shapes` and refer to it as
   `path: "@name"`, so the mass, its texture, its shading and its shadow all follow one silhouette. Get the silhouette
   and the composition right before anything else; look at it small. Things stand on the ground: a figure's feet or base
   overlap what it stands on, and a `cast` shadow joins them.
2. **Light and form**: pick one light for the whole picture and give each mass a `shade` with its form (a head and a
   stone are spheres, a trunk and a limb are cylinders, a dress is folds). Use `texture` for wood, stone, bark, cloth,
   water and sky.
3. **Surface in numbers**: `strands` for fur, hair, grass and feathers, following the form; `scatter` for leaves,
   petals, pebbles, stars and drops. Layer them: dark underneath, mid tones, a few light ones on top. Thousands of marks
   cost a line. Give a surface layer `clip: LAYER` to keep it on the mass below it.
4. **Small things, drawn properly**: eyes, noses, hands, flowers, buckles. Draw each in a `group` in its own frame
   (say 100 px across around 0,0), then place it with `at`, `rotate` and `scale`. A thing that repeats goes in `symbols`
   and is placed with `use`.
5. **Accents**: a few strong dark lines (`brushpen`, `ink`), the brightest lights last, and a whole-picture `adjust`.
   Look at the small things with `look` and fix them.

Curves: write `path: "M 120 300 C 200 180, 340 180, 420 300"`. It is shorter than points and comes out smooth. Give
pressure as a list along the stroke: `pressure: [0.2, 1, 0.3]`.

## A canvas, step by step

```yaml
# paint(canvas: "stone", doc:)
size: [800, 600]
seed: 4                 # another seed, another hand
paper: { type: cold-press, color: "#efe7d6" }
shapes:                 # one outline, named once, used by everything that follows it
  rock: "M 240 440 C 230 330, 330 250, 420 255 C 520 260, 590 340, 570 445 Z"
layers:
  - name: ground
    items:
      - { fill: flat, rect: [0, 420, 800, 180], color: "#5d6b3a" }
      - { strands: grass, rect: [0, 430, 800, 170], count: 1800, length: [14, 34], colors: ["#3c5226", "#5f7a34", "#8aa04a"], size: [1, 2.2] }
  - name: shadow
    items:
      - { cast: true, path: "@rock", light: upper-left, strength: 0.5, blur: 8 }
  - name: stone
    items:
      - { fill: flat, path: "@rock", color: "#7d7a70" }
      - { texture: stone, path: "@rock", color: "#5a5850", color2: "#a5a297", scale: 24, strength: 0.7 }
      - { shade: true, path: "@rock", form: sphere, light: upper-left, color: "#262234", strength: 0.7 }
```

```yaml
# paint(canvas: "stone", layer: "moss", clip: "stone", items:)   clip keeps it on the stone
- { scatter: dot, ellipse: [380, 290, 130, 40], count: 500, size: [3, 7], colors: ["#4f6a2a", "#6f8a35", "#90a848"], light: upper-left }
- { strands: fur, ellipse: [380, 285, 125, 34], count: 600, length: [4, 9], direction: up, colors: ["#3f5a22", "#7f9a3a"], size: [0.8, 1.5] }
```

## Media

- pencil, graphite: sketch lines and soft shading; they catch the paper's tooth. Sizes 2-8.
- ink, pen, brushpen: crisp lines; brushpen swells with pressure and breaks up when light and fast.
- marker, highlighter: flat strokes that darken where they overlap.
- watercolor: wet strokes with a definite edge, pigment gathering at the edge; use fill: wash for areas.
- gouache, oil: covering strokes whose hairs leave streaks; pastel, chalk, charcoal, crayon: dry and grainy.
- airbrush, soft: soft glows and shadows; eraser takes paint away.

`taper` thins a stroke's ends; `tremor` is how much a hand drifts (0 for none).

## Fills

hatch and crosshatch (angle, spacing, brush, pressure), scribble, stipple (even dots), splatter (drops of all sizes),
wash (one wet area in one colour or from `color` to `to`, with `direction` in degrees such as `90` for down or a word
such as `down`, `up`, `left`, `right`, `upper-left`), flat (opaque paint with an uneven edge, for masses that cover
what is below). Each takes `region` (a polygon or a path) or a shape (`ellipse`, `circle`, `rect`); without one it covers
the whole picture.

## Type on a painted picture

`paint` draws marks, washes and textures — never hand-stroke letters or numbers on the canvas, and never write font-parsing
or headless-browser scripts in the shell. When a finished PNG needs titles, captions, dates or callout labels over
hand-painted illustration:

1. Paint the illustration **without words** on a canvas, reserving clean tonal space where the type will sit, and write
   the painted art to the session's scratch folder (`out: "<scratch>/art.png"`).
2. Write a small HTML file in the scratch folder sized to exact `[W, H]` (`html, body { margin: 0; width: Wpx; height: Hpx; overflow: hidden; position: relative; }`),
   place `<img src="art.png" style="position:absolute;inset:0;width:100%;height:100%">`, and set the words in real
   HTML/CSS fonts (`serif` / Songti / Mingti for literary print, crisp sans for notes) with generous margins and clear
   figure-ground contrast.
3. Export the exact `1×` `W×H` PNG into the project in one call:
   `browser(url: "<scratch>/compose.html", width: W, height: H, out: "poster.png")`. Keep intermediate files in scratch so
   only the requested deliverables land in the project.

## Marks in numbers

- **strands**: `hair` follows a guide curve `along` (`spread` is how wide the lock is); `fur` and `grass` grow out from
  `along` (`side: left` or `right`) or rise from a region in a `direction`. `count`, `length [min, max]`, `size`,
  `colors`, `curl`, `jitter` (degrees). Up to 6000.
- **scatter**: `leaf`, `petal`, `stone`, `dot`, `star`, `dash`, `blade`, `drop` in a region or `along` a path; `count` or
  `density`, `size [min, max]`, `rotate` (a number, `[min, max]`, `flow` or `along`), `colors`, `light` (lighter on that
  side), `outline {color, size}`. To scatter your own shape, place a symbol with `use` several times.
- **shade**: `form: sphere | cylinder | cone | plane | fold` on a region or shape, lit from `light` (a word such as
  `upper-left`, an angle, or `[x, y]`). `axis` (degrees) for a cylinder or folds, `folds` (how many), `color` (of the
  shadow: a dark, cool one), `strength`, `core` (the band where the form turns), `reflect` (light bounced into the
  shadow), `highlight` (a colour, or false), `shine`, `method: soft` (a wash) or `hatch` (lines that follow the shadow).
- **cast**: a shadow on the ground from a shape, on a layer below the thing that casts it. `light`, `ground` (the y of
  its base), `squash`, `blur`, `strength`.
- **texture**: `wood`, `stone`, `marble`, `bark`, `cloth`, `clouds`, `water`, `grain`, between `color` and `color2`, at a
  `scale`, turned by `angle`; `byValue: true` lets the paper show through the light parts (clouds over a sky).

## Textures that repeat

`tile: true` paints so the picture repeats without seams. The check sheet shows it 2×2. Keep tiles small (256 to
512 px) and their marks even; a single big feature repeats visibly.

```yaml
size: [384, 384]
tile: true
paper: { type: kraft }
layers:
  - items:
      - { fill: crosshatch, brush: pencil, color: "#4a3a28", angle: 25, spacing: 14, size: 2, pressure: 0.4 }
      - { fill: splatter, brush: ink, color: "#2b241d", size: 4, density: 0.4 }
```

## Retouching a picture

Place it with an image item in its own layer and adjust that layer; paint over it in layers above.

```yaml
size: [1600, 1000]
layers:
  - name: photo
    items: [{ image: photo.jpg, fit: cover }]
    adjust: { levels: { black: 12, white: 245, gamma: 1.05 }, warmth: 0.15, saturation: -0.1 }
  - name: shadow
    blend: multiply
    items: [{ stroke: airbrush, color: "#3b2f4a", size: 220, opacity: 0.5, points: [[200, 900, 0.8], [1400, 920, 0.8]] }]
adjust: { grain: 0.04, vignette: 0.25 }
```

## Cutting a picture out of its ground

One call does it, with no canvas or document:

```
paint(cut: "art/fox-on-magenta.png", out: "public/fox.png", trim: true)
```

It shows the cutout on white, on near-black and on a checkerboard, where a fringe of the old ground or a hole in the
subject shows. Cut again with another `tolerance`, `soft` or `key` until it is clean. Never write a script of your own
for this. Inside a painting, `key` on an image item does the same: `key: auto` for the colour its border shares, or a colour (`"#ff00ff"`).
What is near the key by hue (darkened under a shadow too) and reaches the border goes; the edge fades and has the key
un-mixed from it, so no fringe of the old ground stays. `flood: false` also takes the key out of holes inside the
subject; `tolerance` (0.12) and `soft` (0.08) widen what counts as ground and the fading band; `edge` (2 px) is how
deep the un-mixing reaches. With `paper: { type: none }` and no background the output is the cutout itself, a PNG
with a clear ground, ready for a page or a game.

```yaml
size: [800, 800]
paper: { type: none }
layers:
  - items: [{ image: sprite-on-magenta.png, fit: contain, key: auto }]
```

A subject in the key's own colour cannot be cut this way: give it a ground of another colour first.

## Making it look made by hand

- One light for the whole picture; shadows in a cooler, darker colour, never grey.
- Marks of different weights: a few strong lines, more light ones.
- Paper shows through: leave light areas unpainted rather than painting them white.
- Look at the picture at full size before calling it done, and again small, as it will be seen.
