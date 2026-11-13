--[[
    Interior data model (pure Lua 5.4, no game natives).

    An interior is a plain, JSON-serialisable table:

    interior = {
        version, toolVersion, createdAt, updatedAt,
        saveName, archetypeName, name, notes,
        nameHash, uintNameHash,
        location = { x, y, z }, rotation = { x, y, z, w },
        originalProxyHash, proxyHashOverride?, proxyHash, uintProxyHash,
        settings = { flags, wallaSoundSet, reflections },
        group,                                   -- export group (defaults to saveName)
        output = { rooms, occlusion, doors },    -- what this interior contributes to an export
        doors = { ['<u32 model hash>'] = { model, preset, kind, how } },
        rooms   = { { index, name, displayName, nameHash, uintNameHash, roomKey, uintRoomKey, portalCount, preset?, dat151 = {...} } },
        portals = { { index, fromRoomIndex, toRoomIndex, flags, isMirror, isInteriorConnector, isEnabled = { a, b },
                      globalPortalIndices = { a, b }, corners = { {x,y,z} x4 }, centroid = {x,y,z},
                      entities = { { index, linkType, maxOcclusion, modelHashKey, modelName, isDoor, isGlass, position? } } } },
    }

    rooms[1] is always limbo (room index 0), exactly like the game.
]]

JDT = JDT or {}

local Hash = JDT.Hash
local Lib = JDT.Lib

local Model = {}
JDT.Model = Model

Model.SCHEMA_VERSION = 3

Model.DAT151_FIELDS = {
    -- key,                              type,     min,  max
    { 'occlRoomName',                    'string' },
    { 'flags',                           'string' },
    { 'ambientZone',                     'string' },
    { 'interiorType',                    'int',    0,    255 },
    { 'reverbSmall',                     'float',  0.0,  1.0 },
    { 'reverbMedium',                    'float',  0.0,  1.0 },
    { 'reverbLarge',                     'float',  0.0,  1.0 },
    { 'roomToneSound',                   'string' },
    { 'rainType',                        'int',    0,    255 },
    { 'exteriorAudibility',              'float',  0.0,  1.0 },
    { 'roomOcclusionDamping',            'float',  0.0,  1.0 },
    { 'nonMarkedPortalOcclusion',        'float',  0.0,  1.0 },
    { 'distanceFromPortalForOcclusion',  'float',  0.0,  1000.0 },
    { 'distanceFromPortalFadeDistance',  'float',  0.0,  1000.0 },
    { 'weaponMetrics',                   'string' },   -- '' / vanilla INTERIOR_WEAPON_* / 'custom'
    { 'interiorWallaSoundSet',           'string' },
    -- custom gunshot acoustics (InteriorWeaponMetrics), used when weaponMetrics == 'custom'
    { 'weaponWetness',                   'float',  0.0,  1.0 },
    { 'weaponVisibility',                'float',  0.0,  1.0 },
    { 'weaponLpf',                       'int',    100,  24000 },
    { 'weaponPreDelay',                  'int',    0,    1000 },
    { 'weaponHold',                      'float',  0.0,  10.0 },
}

local FALLBACK_ROOM = {
    flags = '0xAAAAAAAA', ambientZone = '', interiorType = 0, reverbSmall = 0.35, reverbMedium = 0.0,
    reverbLarge = 0.0, roomToneSound = 'null_sound', rainType = 0, exteriorAudibility = 0.0,
    roomOcclusionDamping = 0.0, nonMarkedPortalOcclusion = 0.7, distanceFromPortalForOcclusion = 0.0,
    distanceFromPortalFadeDistance = 50.0, weaponMetrics = '', interiorWallaSoundSet = 'hash_D4855127',
    weaponWetness = 0.4, weaponVisibility = 0.5, weaponLpf = 23900, weaponPreDelay = 20, weaponHold = 0.6,
}

local function cfg(path, default)
    local node = Config
    for part in path:gmatch('[^%.]+') do
        if type(node) ~= 'table' then return default end
        node = node[part]
    end
    if node == nil then return default end
    return node
end

local function now()
    return os and os.time and os.time() or 0
end

-- ##### Presets ##### --

function Model.getPreset(id)
    for _, preset in ipairs(cfg('RoomPresets', {})) do
        if preset.id == id then return preset end
    end
end

--- Default dat151 values for a new room.
function Model.defaultDat151(presetId)
    local d = Lib.deepcopy(FALLBACK_ROOM)
    Lib.merge(d, cfg('Defaults.room', {}))
    d.preset = nil
    local preset = Model.getPreset(presetId or cfg('Defaults.room.preset'))
    if preset then Lib.merge(d, preset.values) end
    d.occlRoomName = ''
    return d
end

-- ##### Sanitising ##### --

local function sanitizeField(kind, value, lo, hi, fallback)
    if kind == 'string' then
        if value == nil then return fallback end
        return tostring(value):sub(1, 128)
    elseif kind == 'int' then
        local n = tonumber(value)
        if not n then return fallback end
        return math.tointeger(Lib.trunc(Lib.clamp(n, lo, hi))) or fallback
    else
        local n = tonumber(value)
        if not n then return fallback end
        return Lib.clamp(n + 0.0, lo, hi)
    end
end

function Model.sanitizeDat151(input, base)
    base = base or Model.defaultDat151()
    local out = {}
    for _, f in ipairs(Model.DAT151_FIELDS) do
        local key, kind, lo, hi = f[1], f[2], f[3], f[4]
        local v = input and input[key]
        if v == nil then v = base[key] end
        out[key] = sanitizeField(kind, v, lo, hi, base[key] or FALLBACK_ROOM[key] or (kind == 'string' and '' or 0))
    end
    return out
end

-- ##### Hashes ##### --

--- Recalculate the proxy hash, interior name and every room key.
function Model.computeHashes(interior)
    interior.nameHash = Hash.toInt32(interior.nameHash)
    interior.uintNameHash = Hash.toUInt32(interior.nameHash)

    local loc = interior.location
    local x = math.tointeger(Lib.trunc(loc.x * 100))
    local y = math.tointeger(Lib.trunc(loc.y * 100))
    local z = math.tointeger(Lib.trunc(loc.z * 100))

    interior.originalProxyHash = Hash.toInt32(interior.nameHash ~ x ~ y ~ z)
    interior.proxyHash = interior.proxyHashOverride and Hash.toInt32(interior.proxyHashOverride) or interior.originalProxyHash
    interior.uintProxyHash = Hash.toUInt32(interior.proxyHash)

    local arch = interior.archetypeName
    if type(arch) == 'string' and arch ~= '' and Hash.joaat(arch) == interior.nameHash then
        interior.name = arch:lower()
    else
        interior.name = 'hash_' .. Hash.hex(interior.nameHash)
    end

    for _, room in ipairs(interior.rooms) do
        local isLimbo = room.index == 0 or room.name == 'limbo'
        room.nameHash = isLimbo and Hash.joaat('outside') or Hash.joaat(room.name)
        room.uintNameHash = Hash.toUInt32(room.nameHash)
        room.roomKey = isLimbo and room.nameHash or Hash.toInt32(interior.proxyHash ~ room.nameHash)
        room.uintRoomKey = Hash.toUInt32(room.roomKey)
    end
end

--- True when the typed archetype name actually hashes to the interior's archetype hash.
function Model.archetypeNameMatches(interior)
    local arch = interior.archetypeName
    if type(arch) ~= 'string' or arch == '' then return nil end
    return Hash.joaat(arch) == Hash.toInt32(interior.nameHash)
end

--- Name used for dat151 room items when the user leaves it blank.
function Model.occlRoomName(interior, room)
    local name = room.dat151 and room.dat151.occlRoomName
    if name and name ~= '' then return name end
    local prefix = Model.archetypeNameMatches(interior) and interior.archetypeName:lower() or Hash.hex(interior.nameHash)
    return ('%s_%s'):format(prefix, room.name:lower())
end

-- ##### Topology ##### --

--- Recount portals per room and assign the two global portal-info indices of every portal.
--- Ordering MUST match Encoders.ymt (rooms in order, then portals in order, mirrors skipped).
function Model.computeTopology(interior)
    for _, room in ipairs(interior.rooms) do room.portalCount = 0 end

    for _, portal in ipairs(interior.portals) do
        portal.globalPortalIndices = { -1, -1 }
        local from = interior.rooms[portal.fromRoomIndex + 1]
        local to = interior.rooms[portal.toRoomIndex + 1]
        if from then from.portalCount = from.portalCount + 1 end
        if to and to ~= from then to.portalCount = to.portalCount + 1 end
    end

    local global = 0
    for _, room in ipairs(interior.rooms) do
        for _, portal in ipairs(interior.portals) do
            if not portal.isMirror then
                local dir = (portal.fromRoomIndex == room.index and 1) or (portal.toRoomIndex == room.index and 2) or nil
                if dir then
                    portal.globalPortalIndices[dir] = global
                    global = global + 1
                end
            end
        end
    end
    interior.globalPortalCount = global
end

-- ##### Entities ##### --

--- Flag doors / glass from model names. Returns how many entities changed.
function Model.autoDetectEntities(interior, onlyPortal)
    local doors = cfg('AutoDetect.door', {})
    local glass = cfg('AutoDetect.glass', {})
    local defaults = cfg('Defaults.entity', {})
    local changed = 0

    local function matches(name, patterns)
        name = tostring(name or ''):lower()
        for _, p in ipairs(patterns) do
            if name:find(p:lower()) then return true end
        end
        return false
    end

    for pi, portal in ipairs(interior.portals) do
        if onlyPortal == nil or onlyPortal == pi - 1 then
            for _, e in ipairs(portal.entities) do
                local isDoor = matches(e.modelName, doors)
                local isGlass = not isDoor and matches(e.modelName, glass)
                if isDoor ~= e.isDoor or isGlass ~= e.isGlass then
                    e.isDoor, e.isGlass = isDoor, isGlass
                    if isDoor then e.maxOcclusion = defaults.doorMaxOcclusion or e.maxOcclusion end
                    if isGlass then e.maxOcclusion = defaults.glassMaxOcclusion or e.maxOcclusion end
                    changed = changed + 1
                end
            end
        end
    end

    return changed
end

-- ##### Doors & output ##### --

local function defaultOutput()
    local o = cfg('Output', {})
    return { rooms = o.dat151 ~= false, occlusion = o.ymt ~= false, doors = o.doors ~= false }
end

local function sanitizeDoor(d, key)
    if type(d) ~= 'table' then return nil end
    local preset = d.preset and tostring(d.preset):sub(1, 96) or nil
    if not preset or preset == '' then return nil end
    return {
        model = tostring(d.model or ('0x' .. Hash.hex(tonumber(key) or 0))):sub(1, 64),
        preset = preset,
        kind = d.kind and tostring(d.kind):sub(1, 16) or nil,
        how = d.how and tostring(d.how):sub(1, 16) or nil,
        custom = (preset == 'custom' and type(d.custom) == 'table') and {
            sounds = tostring(d.custom.sounds or 'door_swing_exit_wood_no_mech'):sub(1, 96),
            tuning = tostring(d.custom.tuning or 'dtp_default_swing'):sub(1, 96),
            maxOcclusion = Lib.clamp(tonumber(d.custom.maxOcclusion) or 0.7, 0.0, 1.0),
        } or nil,
    }
end

local function doorKey(k)
    local n = tonumber(k)
    if not n then return nil end
    local u = Hash.toUInt32(math.tointeger(math.floor(n)) or 0)
    if u == 0 then return nil end
    return tostring(u)
end
Model.doorKey = doorKey

function Model.sanitizeDoors(input)
    local out, n = {}, 0
    for k, d in pairs(type(input) == 'table' and input or {}) do
        local key = doorKey(k)
        local door = key and sanitizeDoor(d, key)
        if door and n < 256 then
            out[key] = door
            n = n + 1
        end
    end
    return out
end

--- Adds door entries for portal entities flagged as doors and for detected door props.
--- Existing entries are kept. Returns how many were added.
function Model.syncDoors(interior, detected)
    interior.doors = interior.doors or {}
    local added = 0
    local function add(hash, model, size)
        local key = doorKey(hash)
        if key and not interior.doors[key] then
            interior.doors[key] = JDT.Doors.guess(model, size)
            added = added + 1
        end
    end
    for _, p in ipairs(interior.portals) do
        for _, e in ipairs(p.entities) do
            if e.isDoor then add(e.modelHashKey, e.modelName) end
        end
    end
    for _, d in ipairs(detected or {}) do add(d.hash, d.model, d.size) end
    return added
end

-- ##### Placements ##### --
-- The same MLO can be placed more than once (two apartments of one building). The game looks its
-- audio settings up by archetype, so one .dat151 serves every copy, but the occlusion .ymt is
-- named after each copy's position: every placement needs its own.

local MAX_PLACEMENTS = 32

local function samePlace(a, b)
    return math.abs(a.x - b.x) < 0.5 and math.abs(a.y - b.y) < 0.5 and math.abs(a.z - b.z) < 0.5
end

--- Other positions this MLO was found at (the main one is interior.location).
function Model.sanitizePlacements(list, primary)
    local out = {}
    if type(list) ~= 'table' then return out end
    for _, p in ipairs(list) do
        if type(p) == 'table' then
            local loc = { x = tonumber(p.x), y = tonumber(p.y), z = tonumber(p.z) }
            if loc.x and loc.y and loc.z and loc.x == loc.x and loc.y == loc.y and loc.z == loc.z
                and math.abs(loc.x) < 1e5 and math.abs(loc.y) < 1e5 and math.abs(loc.z) < 1e5
                and not (primary and samePlace(loc, primary)) then
                local dup = false
                for _, o in ipairs(out) do if samePlace(o, loc) then dup = true break end end
                if not dup then out[#out + 1] = loc end
                if #out >= MAX_PLACEMENTS then break end
            end
        end
    end
    return out
end

--- Remembers another position of this MLO. Returns true when it was new.
function Model.addPlacement(interior, loc)
    if not loc or samePlace(loc, interior.location) then return false end
    interior.placements = interior.placements or {}
    for _, p in ipairs(interior.placements) do if samePlace(p, loc) then return false end end
    if #interior.placements >= MAX_PLACEMENTS then return false end
    interior.placements[#interior.placements + 1] = { x = loc.x + 0.0, y = loc.y + 0.0, z = loc.z + 0.0 }
    return true
end

--- The interior once per placement, each with its own proxy hash and room keys (for the .ymt files).
function Model.instances(interior)
    local out = { interior }
    for _, p in ipairs(interior.placements or {}) do
        local copy = Lib.deepcopy(interior)
        copy.location = { x = p.x, y = p.y, z = p.z }
        copy.placements, copy.proxyHashOverride = nil, nil
        Model.computeHashes(copy)
        out[#out + 1] = copy
    end
    return out
end

-- ##### Construction ##### --

--[[
    scan = {
        nameHash, location = {x,y,z}, rotation = {x,y,z,w},
        rooms   = { { index, name } },
        portals = { { index, fromRoomIndex, toRoomIndex, flags, corners = {..}, entities = { { index, modelHashKey, modelName, position } } } }
    }
]]
function Model.fromScan(scan)
    local entityDefaults = cfg('Defaults.entity', {})
    local interiorDefaults = cfg('Defaults.interior', {})

    local interior = {
        version = Model.SCHEMA_VERSION,
        toolVersion = Lib.version,
        createdAt = now(),
        updatedAt = now(),
        nameHash = scan.nameHash,
        location = { x = scan.location.x, y = scan.location.y, z = scan.location.z },
        placements = {},
        rotation = scan.rotation and { x = scan.rotation.x, y = scan.rotation.y, z = scan.rotation.z, w = scan.rotation.w } or nil,
        archetypeName = scan.archetypeName or '',
        notes = '',
        settings = {
            flags = interiorDefaults.flags or '0xAAAAA044',
            wallaSoundSet = interiorDefaults.wallaSoundSet or '0xD4855127',
            reflections = interiorDefaults.reflections or '0x00000000',
        },
        rooms = {},
        portals = {},
    }

    for i, r in ipairs(scan.rooms) do
        local name = tostring(r.name or ('room' .. (i - 1)))
        interior.rooms[i] = {
            index = r.index or (i - 1),
            name = name,
            displayName = (name:gsub('^%l', string.upper)),
            preset = cfg('Defaults.room.preset'),
            dat151 = Model.defaultDat151(),
        }
    end

    for i, p in ipairs(scan.portals) do
        local flags = math.tointeger(p.flags or 0) or 0
        local portal = {
            index = p.index or (i - 1),
            fromRoomIndex = p.fromRoomIndex,
            toRoomIndex = p.toRoomIndex,
            flags = flags,
            isMirror = (flags & 4) ~= 0,
            isInteriorConnector = (flags & 2) ~= 0,
            isEnabled = { true, true },
            corners = p.corners,
            entities = {},
        }
        Model.computePortalGeometry(portal)

        for ei, e in ipairs(p.entities or {}) do
            portal.entities[ei] = {
                index = e.index or (ei - 1),
                linkType = entityDefaults.linkType or 1,
                maxOcclusion = entityDefaults.maxOcclusion or 0.7,
                modelHashKey = Hash.toInt32(e.modelHashKey or 0),
                modelName = e.modelName or tostring(e.modelHashKey),
                isDoor = false,
                isGlass = false,
                position = e.position,
            }
        end
        interior.portals[i] = portal
    end

    interior.saveName = scan.saveName or Hash.hex(interior.nameHash)
    interior.group = interior.saveName
    interior.output = defaultOutput()
    interior.doors = {}

    Model.computeHashes(interior)
    Model.computeTopology(interior)

    if cfg('AutoDetect.applyOnScan', true) then Model.autoDetectEntities(interior) end
    Model.syncDoors(interior, scan.doors)

    return interior
end

function Model.computePortalGeometry(portal)
    local c = portal.corners
    if type(c) ~= 'table' or #c < 4 then
        portal.corners = nil
        return
    end
    portal.centroid = {
        x = (c[1].x + c[3].x) / 2,
        y = (c[1].y + c[3].y) / 2,
        z = (c[1].z + c[3].z) / 2,
    }
end

-- ##### Migration (v1 / v2 save files -> v3) ##### --

local V1_ROOM_MAP = {
    occlRoomName = 'occlRoomName', flags = 'flags', ambientZone = 'zone', interiorType = 'unk02',
    reverbSmall = 'unk03', reverbMedium = 'reverb', reverbLarge = 'echo', roomToneSound = 'sound',
    rainType = 'unk07', exteriorAudibility = 'unk08', roomOcclusionDamping = 'unk09',
    nonMarkedPortalOcclusion = 'unk10', distanceFromPortalForOcclusion = 'unk11',
    distanceFromPortalFadeDistance = 'unk12', weaponMetrics = 'unk13', interiorWallaSoundSet = 'soundSet',
}

local function migrateRoom(r, i)
    local dat
    if type(r.dat151) == 'table' then
        dat = r.dat151
    else
        dat = {}
        for key, old in pairs(V1_ROOM_MAP) do dat[key] = r[old] end
    end

    local name = tostring(r.name or ('room' .. (i - 1)))
    return {
        index = math.tointeger(r.index) or (i - 1),
        name = name,
        displayName = r.displayName or (name:gsub('^%l', string.upper)),
        preset = r.preset,
        dat151 = Model.sanitizeDat151(dat),
    }
end

local function migratePortal(p, i)
    local flags = math.tointeger(tonumber(p.flags) or 0) or 0
    local enabled = type(p.isEnabled) == 'table' and p.isEnabled or { true, true }
    local portal = {
        index = math.tointeger(p.index or p.interiorPortalIndex or p.mloPortalIndex) or (i - 1),
        fromRoomIndex = math.tointeger(p.fromRoomIndex) or 0,
        toRoomIndex = math.tointeger(p.toRoomIndex) or 0,
        flags = flags,
        isMirror = p.isMirror == true or (flags & 4) ~= 0,
        isInteriorConnector = (flags & 2) ~= 0,
        isEnabled = { enabled[1] ~= false, enabled[2] ~= false },
        corners = p.corners,
        entities = {},
        -- v2 saves did not store flags; the client refreshes geometry from the game after loading.
        needsGeometry = p.flags == nil or p.corners == nil,
    }
    Model.computePortalGeometry(portal)

    for ei, e in ipairs(p.entities or {}) do
        portal.entities[ei] = {
            index = math.tointeger(e.index) or (ei - 1),
            linkType = math.tointeger(tonumber(e.linkType) or 1) or 1,
            maxOcclusion = Lib.clamp(tonumber(e.maxOcclusion) or 0.7, 0.0, 1.0),
            modelHashKey = Hash.toInt32(math.tointeger(tonumber(e.modelHashKey) or 0) or 0),
            modelName = e.modelName and tostring(e.modelName) or tostring(e.modelHashKey),
            isDoor = e.isDoor == true,
            isGlass = e.isGlass == true,
            position = e.position,
        }
    end
    return portal
end

--- Accepts any save file version and returns a v3 interior.
function Model.migrate(data)
    assert(type(data) == 'table', 'interior data must be a table')
    assert(data.nameHash ~= nil and data.location ~= nil, 'interior data is missing nameHash / location')

    local fromVersion = math.tointeger(tonumber(data.version) or 1) or 1

    local interior = {
        version = Model.SCHEMA_VERSION,
        toolVersion = Lib.version,
        createdAt = data.createdAt or now(),
        updatedAt = data.updatedAt or now(),
        nameHash = Hash.toInt32(math.tointeger(tonumber(data.nameHash)) or 0),
        location = { x = tonumber(data.location.x) or 0.0, y = tonumber(data.location.y) or 0.0, z = tonumber(data.location.z) or 0.0 },
        rotation = data.rotation,
        saveName = data.saveName,
        archetypeName = data.archetypeName or '',
        notes = data.notes or '',
        settings = data.settings or {},
        rooms = {},
        portals = {},
        migratedFrom = fromVersion < Model.SCHEMA_VERSION and fromVersion or nil,
    }

    local d = cfg('Defaults.interior', {})
    interior.settings.flags = interior.settings.flags or d.flags or '0xAAAAA044'
    interior.settings.wallaSoundSet = interior.settings.wallaSoundSet or d.wallaSoundSet or '0xD4855127'
    interior.settings.reflections = interior.settings.reflections or d.reflections or '0x00000000'

    -- v2 kept the edited proxy hash next to the original one
    if data.proxyHashOverride then
        interior.proxyHashOverride = Hash.toInt32(math.tointeger(tonumber(data.proxyHashOverride)) or 0)
    elseif data.originalProxyHash and data.proxyHash and tonumber(data.originalProxyHash) ~= tonumber(data.proxyHash) then
        interior.proxyHashOverride = Hash.toInt32(math.tointeger(tonumber(data.proxyHash)) or 0)
    end

    -- v1 / v2 used 'hash_<HEX>' when the real name was unknown
    if interior.archetypeName == '' and type(data.name) == 'string' and data.name ~= '' and not data.name:match('^hash_') then
        interior.archetypeName = data.name
    end

    for i, r in ipairs(data.rooms or {}) do interior.rooms[i] = migrateRoom(r, i) end
    for i, p in ipairs(data.portals or {}) do interior.portals[i] = migratePortal(p, i) end

    if not interior.saveName or interior.saveName == '' then interior.saveName = Hash.hex(interior.nameHash) end
    interior.group = Lib.sanitizeFilename(data.group) or interior.saveName
    interior.output = defaultOutput()
    if type(data.output) == 'table' then
        for k in pairs(interior.output) do
            if data.output[k] ~= nil then interior.output[k] = data.output[k] ~= false end
        end
    end
    interior.doors = Model.sanitizeDoors(data.doors)
    interior.placements = Model.sanitizePlacements(data.placements, interior.location)

    Model.computeHashes(interior)
    Model.computeTopology(interior)

    return interior
end

-- ##### Editing ##### --

--[[
    Applies the user-editable subset sent by the UI. Anything else in `edits` is ignored,
    so the UI can never corrupt hashes / topology.

    edits = {
        saveName?, archetypeName?, notes?, proxyHashOverride? (string|number|false),
        settings? = { flags, wallaSoundSet, reflections },
        rooms? = { [i] = { preset?, dat151 = {...} } },
        portals? = { [i] = { isEnabled = {a,b}, entities = { [i] = { maxOcclusion, isDoor, isGlass, linkType } } } }
    }
]]
function Model.applyEdits(interior, edits)
    if type(edits) ~= 'table' then return interior end

    if edits.saveName ~= nil then
        interior.saveName = Lib.sanitizeFilename(edits.saveName) or interior.saveName
    end
    if edits.archetypeName ~= nil then
        interior.archetypeName = tostring(edits.archetypeName):gsub('%s', ''):sub(1, 64)
    end
    if edits.notes ~= nil then interior.notes = tostring(edits.notes):sub(1, 4000) end
    if type(edits.placements) == 'table' then interior.placements = Model.sanitizePlacements(edits.placements, interior.location) end
    if edits.group ~= nil then interior.group = Lib.sanitizeFilename(edits.group) or interior.group end
    if type(edits.output) == 'table' then
        for k in pairs(interior.output) do
            if edits.output[k] ~= nil then interior.output[k] = edits.output[k] ~= false end
        end
    end
    if type(edits.doors) == 'table' then interior.doors = Model.sanitizeDoors(edits.doors) end

    if edits.proxyHashOverride ~= nil then
        if edits.proxyHashOverride == false or edits.proxyHashOverride == '' then
            interior.proxyHashOverride = nil
        else
            interior.proxyHashOverride = Hash.parse(edits.proxyHashOverride)
        end
    end

    if type(edits.settings) == 'table' then
        for _, key in ipairs({ 'flags', 'wallaSoundSet', 'reflections' }) do
            if edits.settings[key] ~= nil then interior.settings[key] = tostring(edits.settings[key]):sub(1, 64) end
        end
    end

    if type(edits.rooms) == 'table' then
        for i, r in pairs(edits.rooms) do
            local room = interior.rooms[tonumber(i)]
            if room and type(r) == 'table' then
                if r.preset ~= nil then room.preset = r.preset ~= '' and r.preset or nil end
                if type(r.dat151) == 'table' then room.dat151 = Model.sanitizeDat151(r.dat151, room.dat151) end
            end
        end
    end

    if type(edits.portals) == 'table' then
        for i, p in pairs(edits.portals) do
            local portal = interior.portals[tonumber(i)]
            if portal and type(p) == 'table' then
                if type(p.isEnabled) == 'table' then
                    portal.isEnabled = { p.isEnabled[1] ~= false, p.isEnabled[2] ~= false }
                end
                if type(p.entities) == 'table' then
                    for ei, e in pairs(p.entities) do
                        local entity = portal.entities[tonumber(ei)]
                        if entity and type(e) == 'table' then
                            if e.maxOcclusion ~= nil then entity.maxOcclusion = Lib.clamp(tonumber(e.maxOcclusion) or entity.maxOcclusion, 0.0, 1.0) end
                            if e.isDoor ~= nil then entity.isDoor = e.isDoor == true end
                            if e.isGlass ~= nil then entity.isGlass = e.isGlass == true end
                            if e.linkType ~= nil then entity.linkType = math.tointeger(Lib.clamp(tonumber(e.linkType) or 1, 0, 2)) or 1 end
                        end
                    end
                end
            end
        end
    end

    interior.updatedAt = now()
    Model.computeHashes(interior)
    Model.computeTopology(interior)

    return interior
end

--- Apply a preset to a set of room indices (0-based). Returns number of rooms changed.
function Model.applyPreset(interior, presetId, roomIndices)
    local preset = Model.getPreset(presetId)
    if not preset then return 0 end
    local n = 0
    for _, idx in ipairs(roomIndices) do
        local room = interior.rooms[idx + 1]
        if room and room.index ~= 0 then
            local dat = Lib.deepcopy(room.dat151)
            Lib.merge(dat, preset.values)
            room.dat151 = Model.sanitizeDat151(dat, room.dat151)
            room.preset = preset.id
            n = n + 1
        end
    end
    return n
end

--- Copy acoustic settings from one room to others (occlusion names are kept).
function Model.copyRoomSettings(interior, fromIndex, toIndices)
    local src = interior.rooms[fromIndex + 1]
    if not src then return 0 end
    local n = 0
    for _, idx in ipairs(toIndices) do
        local room = interior.rooms[idx + 1]
        if room and room ~= src and room.index ~= 0 then
            local keepName = room.dat151.occlRoomName
            room.dat151 = Lib.deepcopy(src.dat151)
            room.dat151.occlRoomName = keepName
            room.preset = src.preset
            n = n + 1
        end
    end
    return n
end

--- Strip runtime-only data for saving to disk.
function Model.toSaveData(interior)
    local data = Lib.deepcopy(interior)
    data.interiorId = nil
    data.migratedFrom = nil
    data.fromSave = nil
    for _, p in ipairs(data.portals or {}) do p.needsGeometry = nil end
    return data
end

return Model
