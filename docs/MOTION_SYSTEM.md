# Motion system

XenonRP moves. Not decoratively — the motion in this product exists to say one
of four things:

| It says                                   | Example                                                   |
| ----------------------------------------- | --------------------------------------------------------- |
| **Something is happening**                | the navigation rail, an indeterminate loader              |
| **This much is done**                     | application completion, onboarding steps, scroll position |
| **This changed**                          | a status coming online, a counter, a saved indicator      |
| **This is the important thing on screen** | the hero headline, a section entrance                     |

If a proposed animation does not say one of those four things, it does not go
in. "It would look nice" is how a product ends up with thirty things moving at
once and no focal point.

The implementation lives in `packages/ui/src/motion/` (four files, one barrel)
and `packages/ui/src/styles/theme.css` (tokens and the named motifs).

---

## 1. Tokens

Two halves of one system. `src/motion/tokens.ts` holds the JavaScript values in
seconds; `theme.css` holds the CSS custom properties in milliseconds. **They
must stay in step** — a card that transitions in CSS next to a card that
animates in Motion has to feel like the same hand, and it will not if the
numbers drift.

| Token                             | ms   | For                                       |
| --------------------------------- | ---- | ----------------------------------------- |
| `instant`                         | 120  | press feedback, a tick appearing          |
| `fast`                            | 200  | hover, focus, colour and border changes   |
| `normal` (CSS: `--duration-base`) | 320  | tabs, dropdowns, toasts, status changes   |
| `moderate`                        | 450  | modals, drawers, list reflow              |
| `slow`                            | 620  | section entrances on scroll               |
| `cinematic`                       | 1000 | hero typography, full-bleed media reveals |

| Curve                                   | For                                                            |
| --------------------------------------- | -------------------------------------------------------------- |
| `standard` `cubic-bezier(.32,.72,0,1)`  | interface feedback that must not feel slow                     |
| `emphasized` `cubic-bezier(.16,1,.3,1)` | the cinematic one; most of the distance is covered immediately |
| `enter` `cubic-bezier(0,0,.2,1)`        | decelerate into place                                          |
| `exit` `cubic-bezier(.4,0,1,1)`         | accelerate away — always shorter than the matching entrance    |

There is no seventh duration and no fifth curve. If something needs one, it
probably needs a different idea instead.

**Never write a bare number.** `duration: 0.37` in a component is how the system
dies. Import from `@xenon/ui/motion` or use the CSS property.

### Stagger

`staggerDelay(index, count)` compresses the step as a list grows, capped by
`stagger.maxTotal` (500ms). A flat 60ms step is charming at six items and
unusable at sixty — the last row sits unanimated for a second while the
animation crawls toward it.

---

## 2. Primitives

All from `@xenon/ui/motion`.

### Entrances — `reveal.tsx`

| Component                 | Use                                                         |
| ------------------------- | ----------------------------------------------------------- |
| `Reveal`                  | fade and lift into view, once                               |
| `Stagger` / `StaggerItem` | a group arriving in sequence (6–8 items)                    |
| `MaskReveal`              | a heading with markup in it, clipped and slid up            |
| `TextReveal`              | a hero headline, clipped line by line                       |
| `WordReveal`              | one emphatic line, word by word                             |
| `AnimatedDivider`         | a hairline drawing itself across                            |
| `MediaReveal`             | a cover retracting off an image, Xenon hairline on its edge |
| `Parallax`                | scroll-linked, capped at 40% of scroll distance             |
| `KenBurns`                | 1.06 → 1.00 over 32s on a still hero                        |

### Progress and loading — `progress.tsx`

| Component           | Determinate? | Use                                                      |
| ------------------- | ------------ | -------------------------------------------------------- |
| `ProgressBar`       | yes          | any measured fraction                                    |
| `SegmentedProgress` | yes          | when the thing has real units — six sections, four steps |
| `StepProgress`      | yes          | a connected journey with named nodes                     |
| `ProgressRing`      | yes          | one headline completeness figure, sparingly              |
| `ScrollProgress`    | yes          | reading position on a long page                          |
| `LoadingRail`       | **no**       | the house loader: a segment travelling a dark rail       |
| `Spinner`           | **no**       | buttons and icon-sized slots only                        |

### State — `feedback.tsx`

`AnimatedCounter`, `SuccessCheck`, `AnimatedList` / `AnimatedListItem`.
`StatusDot` lives in `@xenon/ui` (it is CSS-only and renders on server pages).

### Named motifs — `theme.css`

`.x-rail-travel` · `.x-progress-complete` · `.x-status-ring` · `.x-ken-burns` ·
`.x-skeleton` · `.x-chrome-sweep` · `.x-scroll-cue` · `.x-toast-timer` ·
`.x-deeplink-pulse` · `.x-accent-sheen`

Two of these are the brand's signature and are spent, not sprinkled:

- **The travelling hairline** — a thin `#2AFD23` line moving along an edge. It
  is the leading edge of the navigation rail, the edge of a retracting media
  cover, and the segment in a loading rail. Because it is always the same
  gesture, a loading state on the control centre and a media reveal on the
  homepage read as the same machine.
- **The chrome sweep** — a light crossing a metal surface, echoing the logo's
  own gradient. Used on the mark during first entry and on the primary CTA on
  hover. A third use would stop it being special.

---

## 3. Progress: the three categories

**This is the rule that matters most.** Never lie through the UI.

### Determinate — state the real fraction

Form completion, onboarding steps, scroll position, a code's remaining
lifetime. The number must be _computed from the thing itself_.

```tsx
// The application rail counts required questions that are actually visible to
// this applicant, so a conditional branch not taken lowers the denominator.
<ProgressBar value={progress.answered} max={progress.total} />
```

### Indeterminate — refuse to guess

Navigation, a server action, an OAuth round trip. Use `LoadingRail`, which
carries no number because there is no honest number to carry.

The global navigation rail eases toward a 90% ceiling it never reaches on its
own and completes only when the route actually commits. It shows no percentage
to the user. That is the difference between an easing curve and a lie.

### Decorative — must not look operational

A moving line that is atmosphere must never read as "67% complete". If in doubt,
it is not decorative enough — remove it.

### Never fake a wait

```tsx
await sleep(1500); // so the loader can be seen
```

Forbidden, without exception. Related: the rulebook search is synchronous, so it
has **no** loading state at all — showing one would be inventing a wait in order
to have something to animate. The navigation rail waits 120ms before appearing
for the same reason in reverse: a prefetched route that resolves in 40ms should
show nothing.

---

## 4. Reduced motion

`prefers-reduced-motion: reduce` is honoured in three layers:

1. **`theme.css` base layer** flattens every CSS animation and transition with
   `!important`. This is the floor, not the answer.
2. **Every JS primitive branches on `useReducedMotion()`** and renders the final
   state. A scroll-linked transform is not fixed by a shorter duration — it has
   to be disabled in JavaScript or it still moves.
3. **Deliberate resting states.** A stopped animation lands on its _first_
   keyframe, which for the shimmer is a gradient mid-sweep and for the loading
   rail is a segment off the left edge. Both get an explicit frozen appearance.

What is removed: parallax, the first-entry sequence, the Ken Burns drift,
cursor-reactive lighting, the toast countdown bar, and every decorative sweep.

What is kept: **loading clarity, progress state, focus rings, and instant status
changes.** Reduced motion is a request to stop things moving, not a request to
stop being told what is happening.

---

## 5. Performance rules

- **Transform and opacity only.** No animated `width`, `height`, `top`, `blur`
  or `box-shadow` in a loop. The one intentional exception is `ProgressBar`,
  whose width is animated because the track is a hard container and a scaled
  child would smear its leading edge — there are never many on screen.
- **No React state at 60Hz.** The navigation rail and `AnimatedCounter` write
  directly to the DOM node. A progress bar that re-rendered a root-layout
  component sixty times a second would make navigation measurably slower in
  order to report that navigation was happening.
- **`IntersectionObserver` over scroll handlers.** Where a scroll listener is
  unavoidable (the header's solid state), it is `{ passive: true }` and calls
  `setState` only on the frame the threshold is crossed.
- **Cap layout animation by list size.** The rulebook disables Motion's layout
  animation above 60 visible rules: it measures every participant on every
  change, which is free for thirty and a dropped frame per keystroke for three
  hundred.
- **`will-change` on the two elements that need it**, never as a habit.

---

## 6. Motion budget

**One primary focal point per viewport**, a few secondary interactions, and
nothing else. The target is "this feels alive", not "everything is moving".

Concretely: one masked heading, one media reveal, and a stagger is a section.
Two masked headings competing in one viewport is a section with no subject.

Sections have temperature. The underworld block on the homepage runs its media
reveal at nearly double length with the copy trailing it, so it reads as
something surfacing — different from the brisk arrival of every other block.
That contrast is only available because the rest of the page is consistent.

---

## 7. Two traps that fail silently

Both of these were hit while building this system. Neither throws; both just
quietly produce a broken page for a subset of visitors.

### Never branch the element tree on `useReducedMotion()`

```tsx
// Wrong. Looks obviously correct.
if (reduced) return <div className={className}>{children}</div>;
return <motion.div initial={{ opacity: 0 }} …>{children}</motion.div>;
```

The server cannot know the preference, so it always renders the animated
branch — including the inline `opacity: 0` Motion emits for `initial`. A
visitor with reduced motion set then hydrates the _other_ branch over it and
gets a hydration mismatch. Their reward for setting an accessibility
preference is a console full of React errors.

Keep the tree and `initial` identical; change only the transition, via
`instant(reduced, …)` from the tokens.

The one exception is scroll-linked motion, where the movement is the value
rather than the transition. `Parallax` multiplies its transform by a motion
value that drops to zero after hydration — same markup, no travel.

### Never put `whileInView` on an element that starts outside its own clip

```tsx
// Wrong. The heading never appears.
<span className="overflow-hidden">
  <motion.span initial={{ y: '108%' }} whileInView={{ y: '0%' }}>
    …
  </motion.span>
</span>
```

`IntersectionObserver` measures an element _after_ ancestor overflow has
clipped it. The content starts fully below the clip box, so its intersection
ratio is zero: it cannot become visible until it moves, and it cannot move
until it is visible. Deadlock, silently — a gap on the page where a headline
should be.

Put the trigger on the clip wrapper, which never moves and is never clipped,
and drive the child through variants. `MaskReveal`, `WordReveal` and
`MediaReveal` all do this.

---

## 8. What not to do

- Do not add a fade-in to every component and call it a motion system.
- Do not animate letters individually. It destroys the word shape a reader
  scans by, and it is the cheesiest thing on the web.
- Do not replay entrances. `once: true`, always — a long page that re-animates
  is a slot machine.
- Do not lift cards 12px on a giant shadow. Use the variants: editorial cards
  push the image in and draw an accent hairline; operational cards change their
  border.
- Do not make everything glow green. The accent marks progress, activation,
  focus, completion and live state. Everywhere else, depth and chrome carry it.
- Do not build a custom cursor.
- Do not fire confetti at an administrative outcome.
- Do not use a spinner where a rail fits. The rail is the brand; a spinning
  circle is every other website.
- Do not add a new duration. There are six.

---

## 9. Adding motion to a new screen

1. What is the **one** thing on this screen that matters most? That gets the
   mask or the media reveal. Everything else fades and lifts.
2. Is there anything **measured**? If yes it gets a determinate indicator; if it
   is a wait of unknown length it gets `LoadingRail`; if neither, it gets
   nothing.
3. Does the screen have a **known shape** while loading? If yes, a skeleton that
   matches it exactly. If no — a hero, an article, a legal page — the navigation
   rail alone. A grey rectangle standing in for something it does not resemble
   is worse than an empty frame, because the reader tries to read it.
4. Check it with `prefers-reduced-motion: reduce` set. Not "does it still work"
   — does it still tell you what is happening?
