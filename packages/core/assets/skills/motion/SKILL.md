---
name: motion
description: Making moving pictures that are animated, flow, and look designed by one hand: animated shorts, music videos, 手书 and other drawn videos, kinetic type and motion graphics, title sequences, explainers, motion posters and trailers. Never a slideshow. The idea and the look first, the medium that suits them, how to build the film as an animation page with one timeline (the film tool renders it), how things move and change shape, how scenes flow into each other, smoothness, sound, and checking with the watch tool. Read it before making any video or animation.
---

# Motion

A moving piece is judged like a film: is there one idea behind it, does it flow, does everything in it move with
intent, does every frame look designed by one hand, does the sound carry it. The most common failure is a slideshow,
and it is the first thing a viewer sees.

## The idea and the look

- **One idea** that ties the subject to its world, said in a sentence before anything is made. Every section, every line
  of the words, is that idea seen from a new side: a lyric becomes a picture nobody would have guessed, not its literal
  illustration. Something the eye did not expect arrives every few seconds.
- **One design system** from the first frame to the last: two or three colours with one accent, one or two typefaces,
  one device that recurs (a cursor, a frame, a counter, a line). Restraint reads as taste; a new style per scene reads
  as a reel of samples.
- **Type is an image.** Words set large, set as carefully as a poster and moved with the music.
- **The medium follows the idea.** What is made of type, interfaces, diagrams, maths, data, particles, light or
  geometry is drawn in code: that is its own medium, and drawn with a motion designer's craft (a grid, spacing,
  easing, restraint) it is as finished as anything painted. What should look made by hand (手书, ink, watercolour,
  paper, painted people and places) is painted with the paint tool. Neither imitates another: clay, felt, filmed
  footage or 3D renders cannot be faked in paint or code, so a direction that needs them is the wrong direction.

## Never a slideshow

- **A still picture under a camera move is a slide**, however well it is painted. So is a cut-out slid across a
  background, and so are stills joined by cuts or cross-fades. A film made of these reads as PPT.
- **Something changes shape in every shot:** lines draw themselves, shapes grow, fold, bend or turn into the next
  shape, a character changes drawings, parts move against each other, particles, light and type move. The camera
  moves on top of that, never instead of it.
- **Flow: one continuous take where the piece allows it.** Scenes change by motion: the camera travels into the next
  scene; an object grows, unfolds or turns into the next picture; a line becomes a horizon, a horizon a fold; a match
  on shape or colour; something in the world wipes the frame. A cut lands on a beat, between two moving shots, never
  between two stills; nothing fades to a blank page.

## Build it as an animation page

The film is one page with one timeline, and the film tool renders it frame by frame:

```html
<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}canvas{display:block}</style></head>
<body><canvas id="c" width="1920" height="1080"></canvas><script>
const g = document.getElementById('c').getContext('2d');
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const clamp = (x) => Math.max(0, Math.min(1, x));
const at = (t, a, b) => clamp((t - a) / (b - a));            // 0..1 over [a, b]
const pics = {};                                              // painted layers from the paint tool
window.ready = Promise.all(['sky.png', 'walker-1.png', 'walker-2.png', 'walker-3.png'].map((n) =>
  new Promise((r) => { const i = new Image(); i.onload = () => r((pics[n] = i)); i.src = 'art/' + n; })));
window.duration = 30;
window.seek = (t) => {
  // Every value comes from t: nothing reads the clock, randomness is seeded.
  const cam = ease(at(t, 0, 30));                             // one camera move across the whole film
  g.setTransform(1 + 0.15 * cam, 0, 0, 1 + 0.15 * cam, -300 * cam, 0);
  g.drawImage(pics['sky.png'], 0, 0);                         // far plane, moves least
  // A line that draws itself on the beat, boiling on twos (three seeded variants).
  // A walker in three drawings, changed every two frames; feet planted, body bobbing.
  const drawing = ['walker-1.png', 'walker-2.png', 'walker-3.png'][Math.floor(t * 12) % 3];
  g.drawImage(pics[drawing], 600 + 180 * t, 520 + 6 * Math.sin(t * Math.PI * 4));
};
</script></body></html>
```

- **Canvas, SVG or the DOM**, whatever draws it best: SVG paths draw themselves with `stroke-dasharray` and
  `stroke-dashoffset`; shapes morph by interpolating their points; CSS animations are paused and set from `t`
  (`el.getAnimations().forEach((a) => (a.currentTime = t * 1000))`).
- **A hand-made look is painted:** its characters, plates, props and textures are painted with the paint tool on clear
  grounds (`paper: {show: false}` keeps the paper's tooth) and become layers in the page. Paint a character in several
  drawings (key poses, a walk or a turn in 3-8 drawings) and change them on twos. Code draws motion, lines that draw
  on, particles, light and type; in such a film it never stands in for drawing a face, a hand or a tree. A look made
  of code draws everything in code, with the same care.
- **Time it to the music:** read the music tool's beats file (bar times and frames) in the page; moves start and land
  on beats, accents on the hits.
- Size the canvas to the film (1920x1080 unless the brief says otherwise) and fill it edge to edge.

## The pipeline

1. **Treatment and cut list.** One sentence of story; the look; real works of the genre asked for (a 手书 is drawings
   cut to a song: many drawings, bold poses, the lyrics drawn on with the beat); the length. A `cuts.yaml` beside the
   page that the music and the watch tool read: `fps`, `size`, `shots` (start times), `hits` ({at, what}), `holds`.
2. **The music's timing.** Write the score with the music tool (read the music skill) and run it with `plan: true`
   first: its beats file gives every bar's time.
3. **Style frames.** Make two or three key frames at full size (painted, or drawn in code for a look made of code) and set them beside the references. Only when they
   hold up does the rest begin.
4. **A moving animatic.** The page with rough shapes doing the real moves, timed to the beats: render it with the
   film tool and watch it. If it reads as a slideshow now, the final will too.
5. **The final.** The page with the painted layers, every shot animated, the camera carrying one scene into the next.
   Use `preview: true` to see twelve frames on a sheet while working, and render parts (`from`, `to`) to watch them
   move. Render the whole with the score (`sound`) and `blur: 2` or more if things move fast.
6. **Check.** `watch` the film with the cut list and look at its frames at full size, the twelve in a row above all:
   if they are one picture shifted or scaled, the shot is a slide; animate it.

## Moving well

- Ease every move in and out; arrivals overshoot a little and settle; anticipation before a big move; overlap between
  the parts of one move (a 2-4 frame delay per part); arcs, not straight lines; hold still frames on purpose and list
  them as holds.
- 24 fps for drawn looks: drawings change on twos (12 a second) with a boil, while the camera, light and particles move
  on every frame. Positions are fractional, never rounded to whole pixels.
- A pan faster than about a 160th of the width a frame strobes: slow it or blur it (`blur`).
- Boil on purpose: two or three seeded variants of a drawing, cycled every two or three frames, 1-2 px; never
  re-randomised every frame.
- Depth: near layers move faster than far ones; each step back lighter, cooler and lower in contrast; one light;
  things stand on the ground (bases planted, contact shadows at the base); a sway bends from the base.
- For drawn and 手书-style work: big expressive poses, smears on fast moves, impact frames on the hits (a few frames
  of bold flat colour or inverted line), a short eased shake on accents, the lyrics or title drawn on in sync.

## Finish

- One colour grade over everything (in the page, over the frame); for a hand-made look, moving grain or paper texture.
- Titles in the audience's language, in a face that belongs to the film's world (a brush or Kai face for ink and paper
  looks, a sharp grotesque or a monospace for interfaces and code, never the system UI face), set as carefully as a poster and animated with the music.
- End on an image that answers the opening; the last shot moves too, or is a listed hold.
