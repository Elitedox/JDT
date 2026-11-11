--[[
    jdt - configuration
    ---------------------------------------------------------------------------
    Everything the tool does can be tuned from this one file. No dependencies,
    no build step, no permissions and no chat commands are required: press the
    open key (F5 by default; every player can change it in Settings > Keybinds).

    Most options can also be overridden per-server with convars, e.g.
        setr jdt:locale "de"
        set  jdt:loglevel "debug"
]]

Config = {}

-- ===========================================================================
-- General
-- ===========================================================================

--- Language file in locales/ (falls back to English for missing keys).
--- Convar override: `setr jdt:locale <code>` (also honours `ox:locale`).
Config.Locale = 'en'

--- Console log level: 'error' | 'warn' | 'info' | 'verbose' | 'debug'
Config.LogLevel = 'warn'   -- only warnings and errors in the console; 'info' shows saves / loads, 'debug' everything


-- ===========================================================================
-- Opening the tool (no commands needed)
-- ===========================================================================

Config.Open = {
    --- Default key; every player can change it live in Settings > Keybinds (saved on their PC). false = no default.
    key = 'F5',

    --- Re-open on the room you are standing in (instead of the last selected one).
    focusCurrentRoom = true,

    --- Try to load the saved file for an interior the first time it is opened in a session.
    autoLoadSaved = true,

    --- Tab shown when the tool opens outside an interior.
    outsideTab = 'locations',
}

--- Optional chat commands (off by default - everything is available from the key + UI).
Config.Commands = {
    enabled = false,
    open = 'jdt',           -- /jdt [rebuild|reload]
    save = 'jdt_save',      -- /jdt_save [filename]
}

-- ===========================================================================
-- Saving / output
-- ===========================================================================

Config.Storage = {
    savedDir = 'saved_interiors',     -- tool project files (.json)
    legacyDirs = { 'saved_mlos' },    -- old save folders that are imported automatically
    outputDir = 'output',             -- ready-to-copy audio resources, one folder per group
    elementsFile = 'data/elements.json', -- placed sounds / radios / objects
    backups = 5,                      -- keep N previous versions of a save file (0 = off)
    autoSaveOnClose = true,           -- write the project file every time the UI is closed
    autoSaveIntervalMinutes = 0,      -- periodic save while the UI is open (0 = off)
}

Config.Output = {
    ymt = true,                 -- stream/<proxy hash>.ymt          audio occlusion (native binary)
    dat151 = true,              -- audio/<group>_game.dat151.rel    room acoustics (native binary)
    doors = true,               -- door sounds (DoorAudioSettingsLink, same .rel)
    xml = true,                 -- also write CodeWalker XML copies in xml/ (for inspection / manual edits)
    debugComments = false,      -- annotate the XML copies
    maxPathDistance = 5,        -- how many rooms deep audio paths are generated (game default 5)

    --- Where Export installs the files besides output/<group>/:
    ---   'self'     -> into this resource (works after restart + reconnect, nothing to copy)  [default]
    ---   'none'     -> only build output/<group>/ (copy it into your resources yourself)
    ---   'resource' -> into the MLO's own resource (needs `add_filesystem_permission <this> write <mlo>`)
    install = 'self',

    --- Placed sounds / radios the game can play by itself are written as native StaticEmitters.
    nativeEmitters = true,
    nativeMusicVolume = 12.0,   -- dB, radios and TV / music emitters (vanilla radio emitters are +12 dB)
    nativeSoundVolume = 0.0,    -- dB, single sounds
    --- GTA only loads emitter lists named ambient_emitter_list_NN. Default: derived from the group name.
    --- Two groups must not share a number; force one here if needed: { my_club = 42 }
    emitterListNumber = {},

    --- Placed ambient zones are written as native AmbientZone + AmbientRule items (listed in ambient_zone_list).
    nativeZones = true,
}

-- ===========================================================================
-- Custom sounds (your own audio files packed into the game's format)
-- ===========================================================================

Config.Sounds = {
    dir = 'sounds',             -- sources live in sounds/<group>/<name>.wav (drop .wav files there and press Rescan)
    maxUploadMB = 25,           -- largest file the panel uploads (after conversion to mono 16-bit)
    sampleRate = 32000,         -- default rate the panel converts uploads to (8000 - 48000)
    codec = 'adpcm',            -- 'adpcm' (4x smaller, what the game uses) or 'pcm' (lossless, 4x bigger)
    category = 'scripted',      -- default mix category of a custom sound
    normalize = true,           -- default: raise quiet files to full level when packing
}

-- ===========================================================================
-- Placing sounds, radios and objects
-- ===========================================================================

Config.Place = {
    defaultGroup = 'default',   -- used outside a known interior (inside one, its project group is used)
    defaultRange = 15.0,
    rayDistance = 60.0,
    surfaceOffset = 0.15,       -- sound point offset from the aimed surface
    propSoundOffset = 0.35,     -- sound point height above a placed object
    drawDistance = 80.0,
    rotateSpeed = 90.0,         -- degrees / second with the arrow keys
    --- GTA control indexes while aiming
    keys = {
        place = 38,  -- E          place / confirm a move
        grab = 47,   -- G          move the aimed element
        delete = 73, -- X          delete the aimed element (press twice)
        edit = 74,   -- H          edit the aimed element
        listen = 44, -- Q          preview at the aimed point
        menu = 37,   -- TAB        reopen the panel
        close = 177, -- BACKSPACE  cancel a move / stop aiming
        shift = 21,  -- SHIFT      + wheel = height instead of range
        up = 15, down = 14,        -- mouse wheel
        rotL = 174, rotR = 175,    -- arrow keys
    },
}

-- ===========================================================================
-- Playing placed elements in game
-- ===========================================================================

Config.Playback = {
    tickMs = 250,               -- streaming update rate
    maxActive = 24,             -- audio elements active at once per player (closest first)
    streamMargin = 5.0,         -- extra metres before a playing sound is cut (no flicker)
    propDistance = 120.0,       -- spawn distance for placed objects
    supportModel = 'prop_boombox_01', -- invisible anchor for radios / emitters placed without an object
}

--- Read-only element packs shipped with MLOs (JSON exported from the Placed tab).
Config.Packs = {
    -- 'packs/my_club.json',
}

-- ===========================================================================
-- Defaults applied to freshly scanned interiors
-- ===========================================================================

Config.Defaults = {
    interior = {
        flags = '0xAAAAA044',
        wallaSoundSet = '0xD4855127',
        reflections = '0x00000000',
    },

    --- Dat151 InteriorRoom fields for every new room ("preset" picks one from Config.RoomPresets first).
    room = {
        preset = nil,
        flags = '0xAAAAAAAA',
        ambientZone = '',
        interiorType = 0,
        reverbSmall = 0.35,
        reverbMedium = 0.0,
        reverbLarge = 0.0,
        roomToneSound = 'null_sound',
        rainType = 0,
        exteriorAudibility = 0.0,
        roomOcclusionDamping = 0.0,
        nonMarkedPortalOcclusion = 0.7,
        distanceFromPortalForOcclusion = 0.0,
        distanceFromPortalFadeDistance = 50.0,
        weaponMetrics = '',
        interiorWallaSoundSet = 'hash_D4855127',
    },

    entity = {
        linkType = 1,
        maxOcclusion = 0.7,
        doorMaxOcclusion = 0.7,
        glassMaxOcclusion = 0.4,
    },
}

--- Model names containing these (case-insensitive Lua patterns) are flagged by "Auto-detect".
Config.AutoDetect = {
    door = { 'door', '_dr_', 'gate', 'hatch', 'shutter' },
    glass = { 'glass', 'window', 'wndw', 'win_', 'pane' },
    applyOnScan = true, -- run auto-detection automatically when an interior is scanned for the first time
}

-- ===========================================================================
-- Room acoustic presets (selectable in the Rooms tab, extend freely)
-- ===========================================================================

Config.RoomPresets = {
    { id = 'default',   label = 'Default',            values = { reverbSmall = 0.35, reverbMedium = 0.0,  reverbLarge = 0.0,  exteriorAudibility = 0.0, nonMarkedPortalOcclusion = 0.7 } },
    { id = 'small',     label = 'Small room / office', values = { reverbSmall = 0.5,  reverbMedium = 0.1,  reverbLarge = 0.0,  exteriorAudibility = 0.0, nonMarkedPortalOcclusion = 0.7 } },
    { id = 'bathroom',  label = 'Bathroom / tiled',    values = { reverbSmall = 0.8,  reverbMedium = 0.3,  reverbLarge = 0.0,  exteriorAudibility = 0.0, nonMarkedPortalOcclusion = 0.8 } },
    { id = 'corridor',  label = 'Corridor / stairs',   values = { reverbSmall = 0.45, reverbMedium = 0.35, reverbLarge = 0.1,  exteriorAudibility = 0.0, nonMarkedPortalOcclusion = 0.7 } },
    { id = 'hall',      label = 'Large hall / lobby',  values = { reverbSmall = 0.2,  reverbMedium = 0.6,  reverbLarge = 0.3,  exteriorAudibility = 0.1, nonMarkedPortalOcclusion = 0.6 } },
    { id = 'warehouse', label = 'Warehouse / hangar',  values = { reverbSmall = 0.1,  reverbMedium = 0.5,  reverbLarge = 0.7,  exteriorAudibility = 0.2, nonMarkedPortalOcclusion = 0.5 } },
    { id = 'garage',    label = 'Garage / parking',    values = { reverbSmall = 0.2,  reverbMedium = 0.55, reverbLarge = 0.45, exteriorAudibility = 0.3, nonMarkedPortalOcclusion = 0.5 } },
    { id = 'club',      label = 'Club / bar',          values = { reverbSmall = 0.3,  reverbMedium = 0.4,  reverbLarge = 0.2,  exteriorAudibility = 0.0, nonMarkedPortalOcclusion = 0.9 } },
    { id = 'studio',    label = 'Dead / studio',       values = { reverbSmall = 0.0,  reverbMedium = 0.0,  reverbLarge = 0.0,  exteriorAudibility = 0.0, nonMarkedPortalOcclusion = 0.9 } },
    { id = 'tunnel',    label = 'Tunnel / sewer',      values = { reverbSmall = 0.3,  reverbMedium = 0.6,  reverbLarge = 0.8,  exteriorAudibility = 0.0, nonMarkedPortalOcclusion = 0.6 } },
}

-- ===========================================================================
-- In-world debug drawing
-- ===========================================================================

-- Portal outlines, fill, labels and colours are set per player in MLO > Portals > Settings.
Config.DebugDraw = {
    entityOutlineColor = { 255, 137, 0, 200 },   -- outline of portal-attached entities (Occlusion tab)
    arrowColor = nil,                            -- point-to path + chevron; nil = the panel's accent colour, or e.g. { 255, 122, 26 }
}

-- ===========================================================================
-- Live interior inspector (Interior / Entities / Locations tabs)
-- ===========================================================================

Config.Inspect = {
    pollMs = 500,               -- how often the open panel checks your room / position (only while an inspector tab is shown)
    scanRadius = 40.0,          -- default radius of an entity scan outside an interior (metres)
    aimDistance = 30.0,         -- 'Pick aimed' ray length
    boxColor = nil,                  -- outline of the selected object; nil = the panel's accent colour, or e.g. { 255, 196, 0 }
}

-- ===========================================================================
-- UI
-- ===========================================================================

Config.UI = {
    width = 980,            -- window size in px (drag the corner to resize, the top bar to move; both are remembered)
    height = 640,
    -- the look every player starts with; each player can change it in Settings (Factory reset comes back here)
    theme = 'blackout',     -- ember | nightshift | blackout | harbor | foundry | kiln
    accent = '#58c98b',     -- accent colour: glows, outlines, selection, scrollbars
    animations = true,      -- Animations switch
    smoothScroll = true,    -- Smooth scrolling switch
    compact = true,         -- Compact density
    glass = false,          -- Glass (see-through) panel
    opacity = 1.0,
    freeMoveButton = 2,     -- hold this mouse button to walk/look around with the UI open (0 left, 1 middle, 2 right)
    blockAttackWhileOpen = true,
    allowTeleport = true,   -- every teleport (portals, entities, saved locations); false hides the buttons
    rememberLayout = true,  -- remember tab / size / position per player (stored in the browser cache)
}

--- Utilities (Player / World / Vehicles tabs): noclip, god mode, teleport, weather and time, vehicles.
Config.Player = {
    enabled = true,         -- false hides the Utilities tabs and blocks every tool
    noclipKey = 'F11',      -- default keys; players change them live in Settings > Keybinds ('' = not bound)
    godKey = '',
    repairKey = '',
    markerKey = 'F10',
    noclipSpeed = 8.0,      -- free camera, metres per second; Shift boosts x4, Ctrl x0.25, the mouse wheel changes it while flying (0.5 - 200)
    plate = 'JDT',          -- plate text on spawned vehicles ('' keeps the random plate)
    deletePrevious = true,  -- a new spawn removes the last vehicle you spawned (if nobody is sitting in it)
}

--- Notification hook. Return true to suppress the built-in NUI toast.
--- Example for another notify resource:
---   Config.Notify = function(kind, title, text) exports['my_notify']:Notify(title, text, kind) return true end
---@type fun(kind: 'success'|'error'|'warning'|'info', title: string, text: string?): boolean?
Config.Notify = nil

-- ===========================================================================
-- Network
-- ===========================================================================

Config.Network = {
    serverToClientBPS = 50000,
    clientToServerBPS = 50000,
    uploadBPS = 1000000,        -- custom sound uploads / previews
}
