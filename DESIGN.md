# WHEN IT CALLS — design brief

A small (8–12 minute) first-person stealth-horror proof of concept, inspired by the dead-city
imagery of qntm's *There Is No Antimemetics Division*. Fan work: original text, names and
assets only — never quote the book.

## Fantasy

You are the last field agent still inside a dead American city. The sky glows a sick, deep red
through drifting mist. The people who lived here have been *taken*: their bodies now walk the
streets as **snatchers** — tall, gaunt figures in long dark capes whose faces are wrong
(too-wide mouths, eyes that are smeared holes, features that don't sit where they should).
High above the rooftops an **enormous Leviathan** — a thin, impossibly tall body carried on
hundred-metre stilt legs — walks slowly through the city. When it **calls** (a vast whale-like
moan), every snatcher stops, turns toward it and listens.

Goal: **get out of the city without being caught.** No combat. You can hide, sneak, distract.

## Pillars

1. **Atmosphere first.** Red sky glow, layered mist, falling ash, silhouettes, sound design.
   Every frame should look like a still from a horror film. Darkness is your friend; light is danger.
2. **Readable, fair, smart enemies.** Snatchers telegraph everything: they *notice* gradually,
   twitch their heads toward suspicious things, investigate noises, call to each other, search
   where you were last seen, and give up slowly. They chase at a **fast walk** — relentless but
   escapable if you break line of sight and hide.
3. **A few small puzzles.** Each zone asks the player to *figure something out* using a consistent
   rule set (light, line of sight, noise, distraction, the Leviathan's call).
4. **Short.** Five zones, ~400 m of street. Checkpoints at each zone. Dying costs < 1 minute.

## Rules the player can learn (keep these consistent everywhere)

| Rule | Detail |
|---|---|
| Sight | Snatchers see in a wide forward cone (~115°, ~28 m, less in mist). Detection fills gradually (faster when close, in light, moving, standing). Crouching behind cars hides you. |
| Light | Firelight / working streetlights make you much easier to see. Shadows halve detection. |
| Noise | Sprint footsteps are loud (~17 m), walking moderate (~7.5 m), crouch-walking almost silent (~2 m). Exhausted panting is audible. |
| Bottles | Pick up (E), throw (left click / F). Shatter = loud noise (~20 m). Snatchers walk over to investigate. Max 3 carried. |
| Car alarms | Some cars have a blinking red alarm LED. Hit one with a bottle (generous hit box; a smash within 2 m counts) → alarm wails ~14 s, audible ~48 m. Every snatcher who hears it goes to it and stands there staring while it wails. Re-arms a few seconds after it stops. |
| The Call | Every so often the Leviathan calls (~4.6 s). **All snatchers freeze, turn toward it and look up — they are blind and deaf to you while it calls.** Its calls are frequent when it is close. Its footfalls (deep booms + camera shake) briefly mask your footsteps too. |
| Chase | A snatcher that fully detects you shrieks (alerting others within ~26 m to investigate) and chases at a fast walk (3.9 m/s). Walking (3.0) can't escape; sprinting (6.0, ~5 s stamina) can. Break line of sight, then hide/crouch: it goes to where it last saw you, then searches nearby for ~14 s, then gives up and returns to its post. |
| Caught | Within ~1.1 m of a chasing snatcher = caught. Short horrifying grab → respawn at the zone's checkpoint. |
| After a call | A chaser frozen by a call that sees you again within ~4 s of it ending resumes at once; others search where you were heading. |
| Checkpoints | A checkpoint only saves while nothing is hunting you; cross one mid-chase and it saves once you shake them off. |
| Solid | Snatchers are solid — you cannot slip through one. |
| Sleepers | One snatcher sits slumped in the parking structure. It barely perceives a crouching player but wakes to noise or someone walking past upright. |

## Route (north = −Z). Player starts near z = 0 and exits around z ≈ −430.

0. **Z0 — The Alley (start, safe-ish).** Narrow alley behind an apartment block. Intro hint text.
   A crashed delivery van, dumpsters, a flickering lamp. One snatcher visible at the mouth of the
   alley far ahead, walking past — teaches "they're out there". First bottle here.
1. **Z1 — Main Street.** Long four-lane street, wrecked cars at angles, a jack-knifed bus, an
   overturned police car. One **patrol** walks up and down the street; one **sentry** stands by a
   lit storefront slowly scanning. Lesson: stay low behind cars, avoid the light, time the patrol.
   Street ends at a collapsed-building rubble pile; the way on is a gap through a burnt-out
   pharmacy / side passage into the plaza.
2. **Z2 — The Plaza.** Open civic square (fountain, statue plinth, bus shelter, gas station
   canopy). Three or four snatchers cluster near the exit passage (the way north). Puzzle: an
   **alarm car** parked on the far side of the plaza; bottles nearby. Throw a bottle at the
   alarm car → they all shuffle over to it → slip through the exit while the alarm wails.
   (Throwing a bottle near them pulls one at a time — a worse but possible solution.)
3. **Z3 — The Boulevard.** A wide, open park boulevard (~35 m wide, ~120 m long) with very little
   cover: a burnt bus, a statue base, planters, a news kiosk, an overturned truck. **Devout**
   snatchers stand along both sides watching the open ground. The Leviathan is straddling the
   boulevard and calls frequently (~every 11 s). Puzzle: move only during the call, freeze behind
   cover between calls. Graffiti at the entrance hints: "WHEN IT CALLS THEY LISTEN".
4. **Z4 — The Overpass / Exit.** Highway on-ramp toward the bridge out of the city, walled by
   jersey barriers and fences. A chain-locked gate blocks the road; cutting the chain (hold E,
   ~3 s) is LOUD and alerts the patrol on the ramp. Alternative quiet route: a dark parking
   structure / side path with a sleeping/idle snatcher. Either way, finish with the road out
   into the mist → the city-limits sign → **exit trigger** → ending.

Ending text (original): *"You are outside the city. The mist is thinner here. You are fairly sure
you were running from something, but you cannot remember what it looked like."* — an
antimemetic beat.

## Tone references (do not copy): the mist of *The Mist*, the tripods of *War of the Worlds* (2005),
the stilt-giants of *Silent Hill*/Dalí's *Elephants*, the slow pursuers of *It Follows*.
