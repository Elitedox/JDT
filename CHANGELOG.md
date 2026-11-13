# Changelog

## 1.1.0

### Added

**Live timecycle editor.** Timecycles now has two modes, **Library** and **Editor**. See [docs/timecycle-editor.md](docs/timecycle-editor.md).

- Open any timecycle by name, or the one of the room you are standing in.
- **All variables** lists every timecycle variable the game has, in the game's own order. The ones the timecycle doesn't set show the game default; changing one adds it. **In this timecycle** shows only the ones it sets.
- Every variable has a slider and two value fields, and the game updates while you drag.
- Each slider has a fixed range for its kind of variable (colours 0 – 1, distances −1 – 1000, frequencies 0 – 1000, and so on), widened to fit the game's own values. Typing a value outside the range widens that slider.
- Add or remove variables, or put a single one back. Changed variables are marked and show what they were. *Changed only* filters the list, *Undo all* restores the timecycle.
- **New / copy** makes a copy under a new name (or an empty timecycle), so the original stays untouched.
- **Apply to my room** uses the timecycle for the room you are in. **Show on screen** forces it on your screen anywhere, with a strength slider.
- **Export XML** writes `timecycles/timecycle_mods_<name>.xml` inside JDT, and JDT loads every file in that folder. The dialog also shows the XML and the `fxmanifest.lua` lines for shipping it in another resource.
- Edits last until you leave the server. Stopping JDT puts every timecycle back and removes the ones made in it.

**Audio for an MLO placed more than once.** Two apartments of one building are often the same MLO placed twice. JDT now notices when you walk into another copy and every export writes one occlusion `.ymt` per copy, next to the single `.dat151` they share. The copies are listed in **Audio project → Hashes**, where a wrong one can be removed.

### Changed

- Timecycles your server streams now appear in the Library by name.
- **Reset timecycle** also undoes the values changed in the Editor.
- Walking into another copy of an MLO moves the portal outlines to that copy.

### Fixed

- An MLO placed more than once only had audio in one copy: each export replaced the other copy's occlusion file.
- Restarting an MLO resource left JDT showing its old portals, room values and undo baseline.
- A teleport that failed part-way could block every later teleport and leave you frozen.
- Object tinting failed on FiveM builds that only have the newer native names.
- The outline of the selected object kept its old colour after an accent colour change.
- Looking around with the panel open rebuilt a list every frame.

## 1.0.0

First public release of JDT (Jack's Development Tool). It combines an MLO inspector, MLO audio and developer utilities in one standalone resource, with no dependencies, no build step and no permission setup.

### Panel

- One window opened with F5 anywhere (Esc also closes it). Drag the top bar to move it and the corner to resize it; size and position are remembered.
- Sidebar with three groups (MLO, Audio, Utilities) plus Settings. Alt 1…0 switches tabs.
- Ctrl K searches tabs, rooms, portals, saved locations and commands.
- Live x / y / z / h in the top bar; click to copy a `vector4`.
- Status bar with interior, room, a frame-time graph and the overlay state.
- Hold the right mouse button to walk and look around with the panel open.
- Notifications appear under the window: compact, with a timer bar that pauses on hover, click to dismiss, repeats grouped as ×2, ×3.
- Bundled Archivo and IBM Plex Mono fonts. Every label drawn in the world is HTML / CSS.
- English, Danish, German, Finnish, French and Turkish (`setr jdt:locale de`).

### Interior

- Interior stats and one row per room: flags, timecycle and the room you are standing in.
- Edit every room flag, the timecycle (name or hash) and the extents.
- Reset per room, plus *Undo all changes*.
- Room flags and entity flags are shown by name, not as hex.

### Portals

- Portals drawn in the world as glowing outlines with a soft fill, fading with distance.
- Labels with the fields you choose: portal id, room names, room ids, flags value, flag names, attached entities, distance.
- Colours by type (normal, one-way, mirror, MLO link, broken, highlighted), each one changeable.
- Settings for the number of nearest portals, distance, label distance, fill, outline thickness, glow, text size, and drawing only your room.
- Per portal: From / To room pickers, flags, **Highlight** and **Go to**.

### Entity sets

- **Found automatically.** For custom MLOs the server reads the MLO's `.ytyp` (binary or XML) and lists every set; names are matched from GTA's list and from your resources' files. A set without a known name takes a typed name, checked against its hash.
- GTA's own interiors list the sets known for that interior, with their on / off state.
- Turn sets on or off one by one or all at once, refresh the interior, scan again.
- Add a set by name, delete a set (it is turned off, its tint cleared, and it leaves the list), bring deleted sets back.
- Tint per set with − / + or a typed value, and **Clear tint**.
- **Interior tint** bar: tint an entity set (`tint` by default), the objects in your room, or every object in the interior. **Undo object tints** puts every object back.

### Timecycles

- The current room's timecycle, reset, and any timecycle by name or hash.
- 1,292 GTA timecycles (base game and every DLC) to search, click and apply.

### Locations

- Live coordinates; copy as `x, y, z`, `vector3` or `vector4`.
- Save, rename, filter, teleport, delete, export and import positions.
- **GTA interiors:** 141 of the game's interiors in groups (story mode, public places, apartments and houses, mansions, offices and businesses, bikers, nightlife and casino, yachts and ships, museum). Search, fold groups, teleport (loads the IPLs each one needs), save to your locations, copy coordinates.

### Floor plan

- Every room in its own cell, placed where its doorways are, one frame per floor. Works from 1 room to hundreds.
- One line per pair of connected rooms, with a count when they share several portals; one-way links in yellow.
- Exits to outside drawn to a limbo node; stairs and broken portals marked.
- Zoom, pan, drag rooms to pin them (remembered), hover a link to see its portals, click to edit.

### Entities

- Every object of the interior or within a radius, with filters, search and sorting.
- **Select automatically:** the object nearest to you or the one you aim at is outlined in the world with X / Y / Z axes and a tag, even with the panel closed.
- Inspector: visibility, collision, opacity, teleport, YMAP flags, and copying the name, hash, `vector4` or a YMAP item. *Restore changed* undoes every change.

### Export XML

- Rooms, portals and entity sets as XML, with interior-local corners for your `.ytyp`.

### Audio

- **Audio project:** group, archetype name, what will be generated, and reading an MLO's existing `.rel` / `.ymt` back in.
- **Room audio:** reverb with an echo preview and presets, room tone with **Listen**, a room ambience zone, gunshot acoustics (game presets or custom values) and the advanced room fields.
- **Occlusion:** which way sound travels through each portal, doors and glass, maximum occlusion and auto-detect.
- **Door sounds:** a sound per door model, **Test** (opens the real door), recorded preset samples, and custom doors (sound set, movement, how much a closed door blocks).
- **Audio map:** rooms and portals as a sound graph; one-way and disabled portals highlighted.
- **Emitters:** every audio emitter around you, nearest first, with direction and distance. **Locate nearest** draws a path on the floor to it. Show emitters in the world with markers, ranges and tags. Play / pause / solo your own, switch or take over the game's own.
- **Library:** GTA sounds, your own sound files, ambient zones, vanilla emitters, radios, objects and mute zones. ▶ previews; **Place it** lets you aim and place in the world.
- **Your own sounds:** upload any format from the panel (converted to WAV) or drop WAVs in `sounds/<group>/`. Packed into `.awc` (ADPCM or PCM) with a sound set. The panel plays them in 3D before the game has them.
- **Ambient zones:** box or sphere areas with their own sounds (repeat time, random extra, spawn distance, fixed spot, hours, rain, occlusion), GTA's ambience rules and directional beds, and an audio scene. They play live while you edit and are drawn in the world.
- **Placed:** everything you placed, edited live for everyone after Save. Pause, solo and mute per player.
- **Checks:** problems to fix before exporting, with buttons that take you to them.
- **Export:** native `.dat151.rel`, `.dat54.rel`, `.awc` and `.ymt` files written directly, plus a player script for sounds the game can't play alone. Install into JDT, into the MLO's resource (merged with its existing audio, with backups), or only into a stand-alone folder. Rescan keeping settings when the MLO changes.

### Utilities

- **Noclip:** a free camera. The mouse aims, W flies where you look, Shift boosts, and the mouse wheel sets the speed (0.5 – 200).
- **God mode:** no damage, no ragdoll, full health and armour.
- **Teleport** to coordinates (paste `x, y, z`, `vector3(...)` or `vector4(...)`), with recent jumps, or to the map marker (lands on the ground).
- **Weather and time:** 15 weathers, a time slider with presets, freeze time, and back to the server's weather and time. Only you see it, and it holds against weather-sync scripts.
- **Vehicles:** your vehicle's state, **Repair and clean**, **Max performance**. A spawner with 910 vehicles (search and class filter) or any add-on model name: engine, brakes, transmission, suspension and turbo maxed, optional armour and bulletproof tyres, full tank, your plate text, recent spawns.

### Settings

- Themes: Ember, Nightshift, Blackout, Harbor, Foundry, Kiln.
- Accent colour followed by every glow, outline, selection bar and scrollbar.
- Animations, smooth scrolling, density, glass, window size, opacity and text size.
- **Keybinds:** click a bind and press a key to change it live; it is saved on each player's PC. Open / close (F5), noclip (F11), map marker (F10), god mode, repair. Esc cancels, Backspace clears, *Reset all keybinds*.
- **Factory reset** puts every setting back to the server's defaults.

### Server owners

- Everything in `config.lua`: default keys, look, inspector, output, sounds, placing, playback, utilities, teleports on / off, notifications.
- Client and server exports for opening the panel, reading the interior, exporting groups and controlling emitters.
- Console command `jdt_export`; optional chat commands `/jdt` and `/jdt_save`.
- Light on performance: nothing runs while the panel is closed except features you switched on, and the panel fetches the full interior only when something changed.
