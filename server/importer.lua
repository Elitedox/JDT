--[[
    Reads the audio an MLO resource already ships (.dat151.rel and stream/<proxy>.ymt) so a project
    can start from what is really in game. Returns a patch the client applies to the open interior.
]]

local Lib, Hash, Rel, Pso, Doors = JDT.Lib, JDT.Hash, JDT.Rel, JDT.Pso, JDT.Doors

local Importer = {}
JDT.Importer = Importer

local IS_WINDOWS = (package and package.config and package.config:sub(1, 1) == '\\') or false

-- hash -> readable name, built lazily from the catalogs
local names = nil
local function nameOf(h)
    if h == 0 then return '' end
    if not names then
        names = {}
        local function add(n) names[Hash.joaatU(n)] = n end
        local function each(file, fn)
            local raw = LoadResourceFile(Lib.resourceName, file)
            local ok, list = pcall(json.decode, raw or '[]')
            if ok and type(list) == 'table' then for _, v in ipairs(list) do fn(v) end end
        end
        each('catalog/sounds.json', function(s) add(s.n) end)
        each('catalog/door_presets.json', function(d) add(d.n) end)
        for _, d in ipairs(Doors.CUSTOM_SOUNDS) do add(d.id) end
        for _, n in ipairs(Doors.TUNINGS) do add(n) end
        local raw = LoadResourceFile(Lib.resourceName, 'catalog/ambience.json')
        local ok, amb = pcall(json.decode, raw or '{}')
        if ok and type(amb) == 'table' then
            for _, list in pairs(amb) do
                if type(list) == 'table' then for _, n in ipairs(list) do add(n) end end
            end
        end
        add('null_sound')
    end
    if JDT.Sounds and not names[h] then
        for n in pairs(JDT.Sounds.index()) do if Hash.joaatU(n) == h then return n end end
    end
    return names[h] or ('hash_%08X'):format(h)
end

local function hexFlags(v) return ('0x%08X'):format(v & 0xFFFFFFFF) end

--- AmbientZone item (+ its AmbientRule items from the same file) -> placed zone element data.
local function zoneElement(zoneItem, byHash)
    local z = Rel.decodeZone(zoneItem.bytes)
    local pc, ps, as = z.positioningCentre, z.positioningSize, z.activationSize
    local zone = {
        shape = z.shape == 'sphere' and 'sphere' or 'box',
        rotation = z.positioningAngle or 0,
        rulesToPlay = z.rulesToPlay,
        scene = z.scene ~= 0 and nameOf(z.scene) or nil,
        environmentRule = z.environmentRule ~= 0 and nameOf(z.environmentRule) or nil,
        rules = {}, vanillaRules = {}, dirAmbiences = {},
    }
    if zone.shape == 'sphere' then
        zone.radius = ps[1]
        zone.fade = math.max(0.0, as[1] - ps[1])
    else
        zone.width, zone.length, zone.height = ps[1], ps[2], ps[3]
        zone.fade = math.max(0.0, math.min((as[1] - ps[1]) / 2, (as[2] - ps[2]) / 2))
    end
    for _, rh in ipairs(z.rules) do
        local it = byHash[rh]
        if it and it.typeId == Rel.TYPE.AmbientRule then
            local r = Rel.decodeRule(it.bytes)
            zone.rules[#zone.rules + 1] = {
                sound = nameOf(r.sound), category = nameOf(r.category), weight = r.weight,
                minDist = r.minDist, maxDist = r.maxDist,
                from = math.floor(r.minTime / 60), to = math.min(24, math.ceil(r.maxTime / 60)),
                every = r.repeatTime, variance = r.repeatVariance,
                fixed = r.explicitSpawn ~= 0, x = r.ox, y = r.oy, z = r.oz,
                occlusion = r.useOcclusion ~= false, stopRain = r.stopWhenRaining == true,
                followListener = r.followListener == true, streaming = r.streaming == true,
                overWater = r.canTriggerOverWater == true, stopOnLeave = r.stopOnZoneDeactivation ~= false,
                startNow = r.ignoreInitialMinRepeat == true, maxLocal = r.maxLocal, spawnHeight = r.spawnHeight,
            }
        else
            zone.vanillaRules[#zone.vanillaRules + 1] = nameOf(rh)
        end
    end
    for _, d in ipairs(z.dirAmbiences) do zone.dirAmbiences[#zone.dirAmbiences + 1] = { name = nameOf(d.name), volume = d.volume } end
    return { type = 'zone', label = nameOf(zoneItem.nameHash), x = pc[1], y = pc[2], z = pc[3], zone = zone }
end

--- Every file in a resource matching an extension (recursive, shell listing with a manifest fallback).
local function listFiles(res, suffix)
    local root = (GetResourcePath(res) or ''):gsub('//', '/')
    local out = {}
    local cmd = IS_WINDOWS and ('dir /b /s "%s" 2>nul'):format(root:gsub('/', '\\')) or ('find "%s" -type f 2>/dev/null'):format(root)
    local ok, h = pcall(io.popen, cmd)
    if ok and h then
        for line in h:lines() do
            line = line:gsub('\\', '/'):gsub('[\r\n]', '')
            if line:lower():sub(-#suffix) == suffix then
                local rel = line:sub(#root + 2)
                if rel ~= '' and not rel:find('_mas_backup', 1, true) then out[#out + 1] = rel end
            end
        end
        h:close()
    end
    return out
end

--[[
    interior = the project as the client has it (rooms, portals, doors)
    returns patch = {
        files = { ... }, settings = {...}?, rooms = { [roomIndex] = dat151 }, doors = { [u32] = { preset, model } },
        entities = { [portalIndex] = { [entityIndex] = { maxOcclusion, isDoor, isGlass } } }, counts = { ... }
    }
]]
function Importer.fromResource(res, interior)
    if GetResourceState(res) == 'missing' or not GetResourcePath(res) then return nil, ('resource "%s" not found'):format(res) end
    local read = JDT.Export.readFile
    local patch = { files = {}, rooms = {}, doors = {}, entities = {}, zones = {}, counts = { rooms = 0, doors = 0, entities = 0, zones = 0 } }
    local zoneIndex = {}  -- zone item hash -> index in patch.zones
    local nameHash = interior.uintNameHash or (interior.nameHash & 0xFFFFFFFF)

    -- Candidate .rel files: declared AUDIO_GAMEDATA first, then anything named *.dat151.rel
    local relFiles, seen = {}, {}
    for _, f in ipairs(JDT.Export.ownAudioFiles(res)) do if not seen[f] then seen[f] = true; relFiles[#relFiles + 1] = f end end
    for _, f in ipairs(listFiles(res, '.dat151.rel')) do if not seen[f] then seen[f] = true; relFiles[#relFiles + 1] = f end end

    local roomByHash = {}
    for i, room in ipairs(interior.rooms or {}) do
        if room.index ~= 0 then roomByHash[Hash.joaatU(room.name)] = i - 1 end
    end
    local doorByLink = {}
    local function addDoorCandidate(hash, model)
        local u = (math.tointeger(hash) or 0) & 0xFFFFFFFF
        if u ~= 0 then doorByLink[Hash.joaatU(Doors.linkName(u))] = { key = tostring(u), model = model } end
    end
    for k, d in pairs(interior.doors or {}) do addDoorCandidate(tonumber(k), d.model) end
    for _, p in ipairs(interior.portals or {}) do
        for _, e in ipairs(p.entities or {}) do addDoorCandidate(e.modelHashKey, e.modelName) end
    end

    for _, path in ipairs(relFiles) do
        local data = read(res, path)
        local parsed = data and Rel.read(data)
        if parsed then
            local used = false
            local byHash = {}
            for _, it in ipairs(parsed.items) do byHash[it.nameHash] = it end
            local settings = byHash[nameHash]
            if settings and settings.typeId == Rel.TYPE.InteriorSettings then
                used = true
                local flags, walla, refl = string.unpack('<I4I4I4', settings.bytes, 5)
                patch.settings = { flags = hexFlags(flags), wallaSoundSet = ('0x%08X'):format(walla), reflections = ('0x%08X'):format(refl) }
                for _, rh in ipairs(Rel.roomsOf(settings)) do
                    local item = byHash[rh]
                    if item and item.typeId == Rel.TYPE.InteriorRoom then
                        local r = Rel.decodeRoom(item.bytes)
                        local idx = roomByHash[r.roomName]
                        if idx then
                            local wm = r.weaponMetrics ~= 0 and nameOf(r.weaponMetrics) or ''
                            local wmItem = r.weaponMetrics ~= 0 and byHash[r.weaponMetrics]
                            local custom = wmItem and wmItem.typeId == Rel.TYPE.InteriorWeaponMetrics and Rel.decodeWeaponMetrics(wmItem.bytes)
                            local zoneRef = ''
                            local zItem = r.ambientZone ~= 0 and byHash[r.ambientZone]
                            if zItem and zItem.typeId == Rel.TYPE.AmbientZone then
                                if not zoneIndex[r.ambientZone] then
                                    patch.zones[#patch.zones + 1] = { element = zoneElement(zItem, byHash), rooms = {} }
                                    zoneIndex[r.ambientZone] = #patch.zones
                                end
                                local zr = patch.zones[zoneIndex[r.ambientZone]].rooms
                                zr[#zr + 1] = idx
                            elseif r.ambientZone ~= 0 then
                                zoneRef = nameOf(r.ambientZone)
                            end
                            patch.rooms[idx] = {
                                occlRoomName = ('hash_%08X'):format(rh),
                                flags = hexFlags(r.flags),
                                ambientZone = zoneRef,
                                interiorType = r.interiorType,
                                reverbSmall = r.reverbSmall, reverbMedium = r.reverbMedium, reverbLarge = r.reverbLarge,
                                roomToneSound = nameOf(r.roomTone),
                                rainType = r.rainType,
                                exteriorAudibility = r.exteriorAudibility,
                                roomOcclusionDamping = r.occlusionDamping,
                                nonMarkedPortalOcclusion = r.nonMarkedPortalOcclusion,
                                distanceFromPortalForOcclusion = r.portalOcclusionDistance,
                                distanceFromPortalFadeDistance = r.portalFadeDistance,
                                weaponMetrics = custom and 'custom' or wm,
                                weaponWetness = custom and custom.wetness or nil,
                                weaponVisibility = custom and custom.visibility or nil,
                                weaponLpf = custom and custom.lpf or nil,
                                weaponPreDelay = custom and custom.preDelay or nil,
                                weaponHold = custom and custom.hold or nil,
                                interiorWallaSoundSet = nameOf(r.walla),
                            }
                            patch.counts.rooms = patch.counts.rooms + 1
                        end
                    end
                end
            end
            for h, it in pairs(byHash) do
                local door = doorByLink[h]
                if door and it.typeId == Rel.TYPE.DoorAudioSettingsLink then
                    used = true
                    local preset = string.unpack('<I4', it.bytes, 5)
                    local das = byHash[preset]
                    if das and das.typeId == Rel.TYPE.DoorAudioSettings then
                        local c = Rel.decodeDoorSettings(das.bytes)
                        patch.doors[door.key] = { model = door.model, preset = 'custom', how = 'imported',
                            custom = { sounds = nameOf(c.sounds), tuning = nameOf(c.tuning), maxOcclusion = c.maxOcclusion } }
                    else
                        patch.doors[door.key] = { model = door.model, preset = nameOf(preset), how = 'imported' }
                    end
                    patch.counts.doors = patch.counts.doors + 1
                end
            end
            -- zones listed in this file's zone list that no room points at
            for _, it in ipairs(parsed.items) do
                if it.typeId == Rel.TYPE.AmbientZoneList then
                    local n = string.unpack('<I4', it.bytes, 5)
                    for i = 0, n - 1 do
                        local zh = string.unpack('<I4', it.bytes, 9 + i * 4)
                        local zItem = byHash[zh]
                        if zItem and zItem.typeId == Rel.TYPE.AmbientZone and not zoneIndex[zh] then
                            patch.zones[#patch.zones + 1] = { element = zoneElement(zItem, byHash), rooms = {} }
                            zoneIndex[zh] = #patch.zones
                            used = true
                        end
                    end
                end
            end
            if used then patch.files[#patch.files + 1] = path end
        end
    end

    -- Occlusion: stream/<proxy>.ymt anywhere in the resource
    local proxy = tostring(interior.uintProxyHash or 0)
    local ymtPath
    for _, f in ipairs(listFiles(res, '.ymt')) do
        if f:match('([^/]+)%.ymt$') == proxy then ymtPath = f break end
    end
    ymtPath = ymtPath or ('stream/%s.ymt'):format(proxy)
    local ybin = read(res, ymtPath)
    if ybin and ybin:sub(1, 4) == 'PSIN' then
        local ok, data = pcall(Pso.read, ybin)
        local mine = JDT.Encoders.ymtData(interior)
        if ok and #data.portals == #mine.portals then
            for j, fp in ipairs(data.portals) do
                local src = mine.portals[j].source
                local portal = src and interior.portals[src + 1]
                if portal and #fp.entities == #portal.entities then
                    for k, fe in ipairs(fp.entities) do
                        if (portal.entities[k].modelHashKey & 0xFFFFFFFF) == fe.model then
                            patch.entities[src] = patch.entities[src] or {}
                            patch.entities[src][k - 1] = { maxOcclusion = fe.maxOcclusion, isDoor = fe.isDoor, isGlass = fe.isGlass }
                            patch.counts.entities = patch.counts.entities + 1
                        end
                    end
                end
            end
            patch.files[#patch.files + 1] = ymtPath
        elseif ok then
            patch.notes = { ('%s has a different portal layout (%d vs %d portal infos): occlusion not imported'):format(ymtPath, #data.portals, #mine.portals) }
        end
    end

    patch.counts.zones = #patch.zones
    return patch
end

return Importer
