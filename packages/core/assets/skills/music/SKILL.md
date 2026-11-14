---
name: music
description: Writing music with the music tool so it sounds composed by a person and played on real instruments: a tune people can hum over a pulse they can tap, chords and textures with jobs, scored to a film's moments to the millisecond. How composers write and arrange, how film and animation are scored to picture, a worked score, and how to read the tool's report since you cannot hear. Read it before making any music, soundtrack, jingle or score.
---

# Music

You cannot hear what you write. The music tool plays your score on recorded instruments and tells you, bar by bar,
what a musician would hear: where the tune rubs, where a part covers it, whether the moments land, how loud it is.
Read every line of its report and fix what it names. Never synthesise sound from sine waves or noise in code: that is
the sound people call cheap at once.

## What a listener hears first

- **A tune people can hum, over a pulse they can tap.** Not a loop of chords, not arpeggios over a pad, not a
  texture. One tune per piece, carried by one part.
- **Fun, not only correct:** a lilt in the rhythm, a hook a child would sing back, another part answering each phrase,
  one chord from outside the key, a bar where the band drops out.
- **Nothing in front of the tune.** A part louder than the tune where the ear follows it, an instrument from another
  family, a bright steady tick: each is noticed at once.
- **Nothing that ticks.** Never keep time with a hi-hat, ride, rimshot, cross-stick or shaker. Keep time with
  pitched parts (bass, plucked strings, harp, marimba) and drums with skins; a cymbal only swells or crashes.
- **One family of sounds per piece:** the palette (chamber, mallets, keys) is that family.
- **Never copy a melody.** References give mood, form and tempo, never notes.

## Writing

1. **Motif first.** Two to four notes with a rhythm of their own: write the rhythm once as a cell (`cells: {hook: 1.5
   .5 1 1}`) and give it new pitches bar after bar. In tunes people hum, 60-70% of bars repeat an earlier bar's rhythm.
2. **Phrases in pairs.** A 4-bar question that ends open (on the 2nd, 5th or 7th), a 4-bar answer that closes. Form
   A A' B A. A pick-up leads into a long note.
3. **Contour.** Mostly steps. After a leap, step back the other way. One peak, about two thirds through, on a moment
   that deserves it. Long notes on the 3rd, 6th or 9th of the chord, not always the root.
4. **Harmony.** About one chord a bar, coloured: add9, maj7, sus4, 6, m9. Mostly in the key, with one borrowed chord
   (iv, bVI, bVII) every eight bars or so. A cadence at the end of each section; a held bass note (a pedal) for
   suspense. Repeat a phrase over new chords to make it grow.
5. **Layers with jobs.** Each part owns a register and a rhythm: the tune on top (C5-G6), an answer only in the
   tune's long notes and rests, a pulse (harp or marimba arpeggio, pizzicato), a pad held under everything, a bass.
   Add a layer every 4-8 bars; drop some out before a big moment so it lands.
6. **Dynamics and an ending.** Shape the whole: `1: p | 5: mp | 9: mf< | 12: f | 14: mp> | 17: p`. End with the
   last chord ringing on the last gesture (a button), never a fade from the middle of a phrase.

Favilla does the rest: it voices the chords under the tune (bass alone low, colour kept, nothing rubbing a held tune
note), plays everything a little off the grid with shaped velocities, and mixes the tune in front.

## Scoring to picture

1. **Spot.** From the cut list keep two to five moments a minute that the music should mark: a scene change, a
   reveal, the title, the end. Other events get a small gesture or nothing.
2. **Pick a tempo and meter from the mood,** then **pin** each moment to a bar: `sync: [{at: 9.1, bar: 4, name: first
   fold, hit: arrive}]`. A bar lasts 60 × beats / tempo seconds; choose bars that give whole phrases between moments.
   Favilla bends the tempo between pins so each lands to the millisecond; a step over 2-3% between sections is heard,
   so the report tells you when to move a pin.
3. **Hits:** `arrive` (a downbeat with drums), `accent` (a soft timpani touch), `swell` (a cymbal swell ending on the
   moment), `button` (the last chord). A moment without a bar is placed on the nearest 16th and reported.
4. **Animate onto the grid.** Run the tool with `plan: true` first: the beats file gives every bar's time and frame,
   so the picture's moves can land on beats too.
5. Underscore by default: the music carries the feeling and marks the big moments. Mirroring every movement
   (Mickey-mousing) is for cartoons and comedy.

## A worked cue (a 52 s film, four moments)

```yaml
cue: paper-grows
length: 52.0
fps: 24
key: D major
meter: 4/4
tempo: 78
palette: chamber
room: salon
loudness: film
cuts: cuts.yaml
sync:
  - { at: 9.10,  bar: 4,  name: first fold,      hit: arrive }
  - { at: 18.30, bar: 7,  name: second fold,     hit: arrive }
  - { at: 33.50, bar: 12, name: the world opens, hit: swell }
  - { at: 49.00, bar: 17, name: title,           hit: button }
parts:
  tune: piano
  answer: glockenspiel
  pulse: { instrument: harp, arp: "0 2 1 3 2 1 3 2", unit: 0.5, bars: 1-11 13-16 }
  pad:   { instrument: strings, pad: true }
  bass:  { instrument: pizzicato, beats: "1 3", bars: 4-16 }
chords: |
  Dmaj9 | Gmaj9/D | Dmaj9 | Dmaj9 | Bm9 | Gmaj7 | A7sus4:2 A7:2 | D/F# |
  Gmaj7 | Em9 | Cadd9:2 A7:2 | Gmaj7#11 | A/G | F#m7 | Bm9 | Gm6 | Dmaj9
cells:
  hook: 1.5 .5 1 1
tune: |
  4:  hook(A5 F#5 E5 F#5) | hook(F#5 D5 C#5 D5) | B5:1.5 A5:.5 G5:1 E5:.5 F#5:.5 | B5:3 r:1
  8:  hook(B5 A5 F#5 A5) | hook(D6 B5 A5 B5) | E6:1.5 D6:.5 B5:1 G5:.5 A5:.5 | G5:1 A5:1 B5:.5 C#6:.5 D6:.5 E6:.5
  12: F#6:3 E6:.5 D6:.5 | hook(C#6 B5 A5 B5) | hook(A5 F#5 E5 F#5) | hook(D6 C#6 B5 A5)
  16: G5:2 Bb5:1 A5:1 | F#5:4
answer: |
  2:  r:1 A6:1.5 F#6:.5 E6:1
  7:  r:2 E6:.5 C#6:.5 A6:1
dynamics: "1: p | 4: mp | 8: mp< | 11: mf< | 12: f | 13: mf> | 16: p | 17: mp"
end: { ring: true, fade: 0.8 }
```

Each line of a tune is bars: `N:` starts at bar N, `|` ends a bar, `PITCH:BEATS` a note (C4 is middle C; F#5, Bb4),
`r:BEATS` a rest, `hook(...)` the cell's rhythm on new pitches. Every bar before the last must add up to the meter (the
final bar of a line pads any remaining beats with rest automatically).

## Recipes

- **Film cue (30-90 s):** an intro of 2-4 bars that sets the pulse, the tune entering on the first big moment, the
  peak on the biggest, a button on the last image. Pin every scene change.
- **Jingle or logo (3-8 s):** the hook once, the last chord on the logo's arrival (`button`).
- **Bed under a voice:** no tune competing with speech: a pad and a soft pulse with `loudness: bed`; `tune` may be
  omitted from `parts` altogether, or enter briefly only between sentences.
- **Game music:** a tune and a pulse first; brightness and busy figuration only as rare colour. Write a turnaround in
  the last bar that leads back to the first. (The tool renders a cue with a tail, not a seamless loop yet.)

## Reading the report

- **SYNC:** each moment's bar, beat and error in ms. Within 45 ms early and 125 ms late reads as together; aim for 0.
  When pinned moments force a tempo jump past 3%, the report suggests nearby beat or bar positions that smooth it.
- **WRITING:** rubs (a tune note a semitone above an accompanying note): change the tune note or the chord. A part
  reaching up to the tune: lower it an octave. Notes outside an instrument's range.
- **TUNE:** when it enters, how often its rhythm returns (aim for 60-70% of bars), leaps answered by a step back,
  where the peak falls. A tune that comes in late or never repeats its rhythm is not yet a tune.
- **MIX:** loudness against the target, true peak, how far each part sits under the tune where the ear follows it
  (8 dB or more keeps the tune in front) and overall; anything in front of the tune is named with what to do (`level:
  -3` on that part, thin it, or move it away from the tune's register). When percussive or plucked attacks hit the
  true-peak ceiling a couple of LU below target, the report marks the file ready to deliver — stop there rather than
  re-rendering to chase loudness.
- The numbers catch faults, not dullness: before calling it done, check the list at the top of this skill. The
  person's ear decides.
