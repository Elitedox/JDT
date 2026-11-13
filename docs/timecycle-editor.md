# Timecycle editor

**Timecycles → Editor** changes a timecycle while you watch it in the game, then writes it as a timecycle XML file.

## Open a timecycle

- Type a name and press **Open**, or press **My room's** for the timecycle of the room you stand in.
- **New / copy** makes a copy under a new name, or an empty timecycle. Edit the copy and the original stays as it was.

## Change values

- **All variables** lists every timecycle variable the game has, in the game's own order. The ones this timecycle doesn't set are greyed and show the game default; changing one adds it.
- **In this timecycle** lists only the variables it sets.
- Every variable has a slider and two value fields. The slider moves both values while they are equal; when they differ it moves value 1 only. The game updates while you drag.
- Each slider has a fixed range for its kind of variable: colours 0 – 1, distances −1 – 1000, frequencies 0 – 1000, intensities and multipliers 0 – 10, and so on. It is widened to fit the game's own values. Type a value outside the range and that slider widens to fit it.
- ✕ removes a variable from the timecycle, ↺ puts one variable back. Changed rows show what they were.
- **Changed only** filters the list to your changes. **Undo all** puts the whole timecycle back.

## See it

- **Apply to my room** uses the timecycle for the room you stand in. **Reset timecycle** (top of the tab) puts the room back on its own timecycle and undoes the values you changed.
- **Show on screen** forces the timecycle on your screen anywhere, also outside, with a strength slider.

## Export

**Export XML** writes `timecycles/timecycle_mods_<name>.xml` inside JDT on the server. JDT loads every file in that folder, so after `refresh` and `ensure jdt` everyone on the server has the timecycle.

To ship it with an MLO instead, copy the file into the MLO's resource and add to its `fxmanifest.lua`:

```lua
files { 'timecycle_mods_<name>.xml' }
data_file 'TIMECYCLEMOD_FILE' 'timecycle_mods_<name>.xml'
```

The export dialog shows these lines and the XML, with a button to copy it.

## Good to know

- Edits live in the game's memory until you leave the server. Export to keep them.
- Stopping JDT puts every timecycle back and removes the ones made in JDT.
- **Delete** only removes timecycles made in JDT.
