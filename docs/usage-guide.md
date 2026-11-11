# Audio guide

## The idea

An MLO's audio lives in three places:

| What | File | Heard |
| --- | --- | --- |
| Room acoustics (reverb, room tone, how much outside you hear), door sounds, native emitters | `audio/<group>_game.dat151.rel` | after reconnect |
| Audio occlusion (sound muffled through walls, travelling room to room through portals) | `stream/<proxy hash>.ymt` | after reconnect |
| Gunshot acoustics, custom doors, ambient zones (native) | same `.dat151.rel` | after reconnect |
| Your own sound files | `audio/<group>_sounds.dat54.rel` + `mas_<group>/<group>_sounds.awc` | after reconnect (panel plays them before) |
| Placed sounds, radios, vanilla emitters, mute zones, objects, zone emulation | played by a script | live |

The tool reads the interior from the game, lets you edit all three and writes the native files itself.

## Workflow

1. **Open:** walk into the interior and press **F5**.
2. **Audio project:** set the group (one per MLO) and, ideally, the archetype name from your `.ytyp`. If the MLO already ships audio, pick its resource under *Start from the MLO's audio* and press **Read audio**.
3. **Room audio:**
   - Pick a room; the green dot is where you stand.
   - Choose a preset or move the reverb sliders; the echo preview shows the shape.
   - Search a **room tone** and press **Listen** to hear it in the room while you choose.
4. **Occlusion:** switch on outlines to see openings in the world. Decide which way sound can travel and mark doors and glass. **Auto-detect** does most of it.
5. **Door sounds:** each door gets a sound type. **Test** opens and closes the real door. **Door sounds** opens a shelf of every door, lift and garage sound to compare.
6. **Library:**
   - Press ▶ on anything to hear it next to you; it appears in **Now playing** with pause and stop.
   - Click a row to set it up (range, hours, object…) and press **Place it**. Aim and press **E**.
7. **Placed:** click any placed element to edit it live. Every change plays in the world right away. **Save** keeps it for everyone, **Revert** goes back. ▶/❚❚ pauses it for you only, **Solo** plays just that one.
8. **Checks:** fix anything red, read the amber items.
9. **Export:** press **Export**, then restart the server and reconnect.

Hold the right mouse button to walk and look around without closing the panel.

## Ambient zones

Library → **Ambient zones** → *Box zone* or *Sphere zone*, then **Place it**. While aiming, the wheel sets the size and the arrows the rotation; the zone is drawn on the floor where you aim.

In the zone's editor (Placed → click it):

- **Sounds** repeat every *N* seconds plus a random extra, at a random spot between *spawn from* and *spawn up to* metres from you (or a **fixed spot**: *Use my position*). A looping sound with 0 seconds is a constant hum. Hours, *stop when raining*, *muffled by walls*, *stop when you leave* and the rest are per sound.
- **Game ambience rules** add GTA's own rules (fridges, AC units, birds, crowds…), **directional ambiences** add its ambience beds.
- **Rooms that use this zone**: tick rooms of the open interior; they then play it while you are inside (the vanilla way). The same choice is in Room audio → *Room ambience*.

Your sounds play live while you edit (the spots they come from flash in the world). Game rules, directional beds and the audio scene are heard after export + reconnect, when the game plays the zone natively.

## Your own sounds

Library → **My sounds**: drop files on the box or click it. The panel converts them to 16-bit mono WAV at the chosen rate and uploads them to `sounds/<group>/` on the server. You can also copy `.wav` files there yourself and press **Rescan folder**.

Per sound: name, volume, loop, mix category, compression (ADPCM like the game, or PCM), sample rate, normalise. Buttons place it as a sound, set it as the selected room's tone, or start a zone with it.

Until a group is exported and you reconnect, custom sounds are played by the panel in 3D (panned and faded from your camera like the game would). After that the game plays them itself and the tool keeps their bank loaded where room tones or zones need it. From your own scripts:

```lua
RequestScriptAudioBank('mas_<group>/<group>_sounds', false)
PlaySoundFromCoord(-1, '<sound>', x, y, z, 'mas_<group>', false, 20, false)
```

## Gunshot acoustics and custom doors

Room audio → **Gunshot acoustics**: a game preset or *Custom values* (echo amount, how far it carries outside, brightness, echo delay, tail).

Door sounds → choose **Custom door…** to pick a door sound set, how the door moves and how much sound it blocks when closed. ▶ next to a preset plays a recording from `samples/doors/<preset>.ogg|mp3|wav` when one exists (see the README in that folder).

## Aiming keys

| Key | Action |
| --- | --- |
| E | Place / confirm a move |
| Q | Listen at the aimed point (again to stop) |
| Wheel | Range |
| Shift + wheel | Height |
| ← → | Rotate the object |
| G | Move the aimed element |
| H | Edit the aimed element |
| X (twice) | Delete the aimed element |
| TAB | Back to the panel |
| Backspace | Cancel a move / stop aiming |

Sphere colours: blue = sound, teal = vanilla emitter, orange = radio, green = mute zone, purple = object, grey = disabled. Elements that are playing are drawn bigger.

## Export options

| Install | Where | Needs |
| --- | --- | --- |
| Into this tool (default) | `jdt/audio`, `stream`, and a marked block in its `fxmanifest.lua` | restart + reconnect |
| Into the MLO | the MLO's resource: `audio/mas_<group>_game.dat151.rel`, `stream/<proxy>.ymt`, `audio/mas_<group>_player.lua`; its fxmanifest gets a marked block | `add_filesystem_permission jdt write <mlo>` in server.cfg (FiveM rule) |
| Folder only | nothing installed | copy `output/<group>/` yourself |

`output/<group>/` is always written. It is a complete resource (fxmanifest, native files, player script, XML copies, README) that works without this tool.

When installing into an MLO that already has its own `.dat151.rel` for the same interior, the files are merged. The original goes to `audio/_mas_backup/` and its manifest line is commented out. An existing `.ymt` is backed up the same way.

Placed radios and plain looping sounds become native StaticEmitters in a list named `ambient_emitter_list_NN`; GTA only loads lists named that way. Everything else (soundset sounds, random pauses, alarms, mute zones, objects) goes into the generated player script. Once a native export is loaded, the tool stops playing those elements itself so nothing plays twice.

## When the MLO changes

Open the tool inside it and use **Export → Rescan, keep settings**. Rooms are matched by name and portals by index, so your values survive.

## Optional commands

`Config.Commands.enabled = true` adds `/jdt [reload|rebuild]` and `/jdt_save [name]`. In the server console, `jdt_export` lists groups and `jdt_export <group> [self|none]` exports one.
