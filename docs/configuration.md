# Configuration

Everything lives in [`config.lua`](../config.lua). The defaults work without changes. There are no permissions or ACE entries: everyone on the server can use the tool, so run it on a development server.

After editing `config.lua`, restart the resource (`ensure jdt`).

## Convars

| Convar | Example | Effect |
| --- | --- | --- |
| `jdt:locale` | `setr jdt:locale "de"` | UI language (`ox:locale` is honoured too, missing strings fall back to English) |
| `jdt:loglevel` | `set jdt:loglevel "debug"` | Console verbosity (`warn` by default: only warnings and errors) |

## Sections

| Section | What it controls |
| --- | --- |
| `Config.Open` | Default open key (`F5`), focus on your room, auto-load saved projects, tab shown outside interiors |
| `Config.Commands` | Optional chat commands `/jdt` and `/jdt_save` (off by default) |
| `Config.Storage` | Project, output and elements locations, backups, auto-save |
| `Config.Output` | Which files are generated, XML copies, default install mode (`self` / `resource` / `none`), native emitters and their volumes, emitter list numbers, native ambient zones |
| `Config.Sounds` | Custom sounds: folder, max upload size, default sample rate, compression, mix category, normalise |
| `Config.Place` | Default group and range, aiming distance and offsets, rotate speed, aiming keys |
| `Config.Playback` | Streaming tick, max active elements per player, prop spawn distance, invisible anchor model |
| `Config.Packs` | Read-only element packs shipped with MLOs |
| `Config.Defaults` | Values for new interiors, rooms (or a preset) and portal entities |
| `Config.AutoDetect` | Model-name patterns for doors and glass |
| `Config.RoomPresets` | Acoustic presets, add your own |
| `Config.DebugDraw` | In-world outline colours and distance |
| `Config.Inspect` | How often the open panel checks your room, entity scan radius, aim distance, outline colour of the selected object |
| `Config.UI` | Window size, default theme and accent, animations, opacity, look-around mouse button, `allowTeleport` (false hides every teleport) |
| `Config.Player` | Utilities on / off, default keys (noclip `F11`, map marker `F10`, god mode, repair), noclip speed, plate text, removing your previous spawn |
| `Config.Notify` | Route toasts to your notification resource |
| `Config.Network` | Bandwidth of the panel's server traffic; `uploadBPS` for custom sound uploads and previews |

## Emitter list numbers

GTA only loads StaticEmitterLists named `ambient_emitter_list_NN`. Each group gets a number from 10 to 99 derived from its name. If two groups collide, force one:

```lua
Config.Output.emitterListNumber = { my_club = 42 }
```

## Exports

Client:

```lua
exports.jdt:open()
exports.jdt:close()
exports.jdt:isOpen()
exports.jdt:getInterior()
exports.jdt:SetLocalEmitterEnabled(id, state) -- nil = back to the server state
exports.jdt:IsEmitterActive(id)
exports.jdt:GetEmitters()
exports.jdt:GetPropEntity(id)
```

Server:

```lua
exports.jdt:exportGroup('my_mlo', { install = 'none' })
exports.jdt:SetEmitterEnabled(id, true)   -- for everyone, not saved (e.g. when a club opens)
exports.jdt:GetEmitters('my_mlo')
exports.jdt:listProjects()
exports.jdt:loadProject('my_mlo')
```

## Keys

Every player sets their own keys in **Settings → Keybinds** (saved on their PC). The values in `config.lua` (`Config.Open.key`, `Config.Player.*Key`) are only the defaults for players who never changed them.

## Console

`jdt_export` lists the audio groups, and `jdt_export <group> [self|none]` exports one.
