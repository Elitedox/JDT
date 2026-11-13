--[[
    Turns interior projects + placed elements + custom sounds into game files (pure Lua 5.4).

    - dat151 items: InteriorSettings / InteriorRoom (+ InteriorWeaponMetrics) per interior,
      DoorAudioSettingsLink per door, StaticEmitter per placed sound / radio the game can play natively
      (+ ambient_emitter_list_NN), AmbientZone + AmbientRule per placed ambient zone (+ ambient_zone_list)
    - dat54 + .awc: the group's custom sounds (one wave container, one sound per file, plus a sound set)
    - occlusion: one <proxy>.ymt per interior
    - package(): a complete, standalone FiveM resource (binary files, XML copies, fxmanifest, player script)
]]

JDT = JDT or {}

local Hash, Model, Encoders, Rel, Pso = JDT.Hash, JDT.Model, JDT.Encoders, JDT.Rel, JDT.Pso

local AudioBuild = {}
JDT.AudioBuild = AudioBuild

AudioBuild.VERSION = 45897013
AudioBuild.ZONE_LIST = 'ambient_zone_list'
AudioBuild.MAX_RULES = 16

local function u32(v) return math.tointeger(math.floor(tonumber(v) or 0)) & 0xFFFFFFFF end

local function cfg(path, default)
    local node = Config
    for part in path:gmatch('[^%.]+') do
        if type(node) ~= 'table' then return default end
        node = node[part]
    end
    if node == nil then return default end
    return node
end

function AudioBuild.safeName(group)
    return (tostring(group or 'default'):gsub('[^%w_%-]', '_'):lower())
end

-- ##### Custom sound naming ##### --

--- Short, game-safe identifier for a custom sound file name.
function AudioBuild.soundKey(name)
    local k = tostring(name or ''):lower():gsub('%.[%w]+$', ''):gsub('[^%w_]', '_'):gsub('_+', '_'):gsub('^_', ''):gsub('_$', '')
    if k == '' then k = 'sound' end
    return k:sub(1, 40)
end

--- dat54 sound name of a custom sound (usable anywhere a game sound name is: room tone, rules, emitters, scripts).
function AudioBuild.soundName(group, key)
    return ('mas_%s_%s'):format(AudioBuild.safeName(group), AudioBuild.soundKey(key))
end

function AudioBuild.soundSet(group) return ('mas_%s'):format(AudioBuild.safeName(group)) end
function AudioBuild.waveDir(group) return ('mas_%s'):format(AudioBuild.safeName(group)) end
function AudioBuild.soundBank(group)
    local g = AudioBuild.safeName(group)
    return ('mas_%s/%s_sounds'):format(g, g)
end

-- ##### Catalog lookups ##### --

local stationByEmitter = {}

--- radios: { { n = id, l = label } }, staticEmitters: { { n = name, rs = station label } }
function AudioBuild.setCatalog(radios, staticEmitters)
    local byLabel = {}
    for _, r in ipairs(radios or {}) do byLabel[r.l] = r.n end
    stationByEmitter = {}
    for _, e in ipairs(staticEmitters or {}) do
        if e.rs and e.rs ~= '' then stationByEmitter[tostring(e.n):lower()] = (byLabel[e.rs] or e.rs):upper() end
    end
end

function AudioBuild.stationOf(emitter)
    return emitter and stationByEmitter[tostring(emitter):lower()]
end

-- ##### Native eligibility ##### --

--- Can the game play this element on its own from the .rel (no script)?
function AudioBuild.isNativeEligible(e)
    if e.enabled == false then return false end
    if e.type == 'zone' then
        return cfg('Output.nativeZones', true) ~= false and e.zone ~= nil
            and (#(e.zone.rules or {}) + #(e.zone.vanillaRules or {}) + #(e.zone.dirAmbiences or {})) > 0
    end
    if cfg('Output.nativeEmitters', true) == false then return false end
    if e.type == 'radio' then return e.radio ~= nil and e.radio.station ~= nil end
    if e.type == 'ambient' and e.ambient then
        return (e.ambient.station or AudioBuild.stationOf(e.ambient.emitter)) ~= nil
    end
    if e.type == 'sound' and e.sound then
        local s = e.sound
        return (not s.set or s.set == '') and not s.bank and s['repeat'] ~= false and (s.delayMax or 0) == 0
    end
    return false
end

function AudioBuild.listName(group)
    local n = tonumber(cfg('Output.emitterListNumber', {})[group]) or (10 + Hash.joaatU(AudioBuild.safeName(group)) % 90)
    return ('ambient_emitter_list_%02d'):format(math.tointeger(n) or 10)
end

-- ##### Zones ##### --

function AudioBuild.zoneName(e) return ('az_mas_%s'):format(tostring(e.id):gsub('^se_', '')) end
function AudioBuild.ruleName(e, i) return ('ar_mas_%s_%02d'):format(tostring(e.id):gsub('^se_', ''), i) end

--- Positioning (inner) and activation (outer) volumes of a zone element.
function AudioBuild.zoneVolumes(e)
    local z = e.zone
    local fade = z.fade or 5.0
    if z.shape == 'sphere' then
        local r = z.radius or 10.0
        return { size = { r, r, r } }, { size = { r + fade, r + fade, r + fade } }, r + fade
    end
    local w, l, h = z.width or 10.0, z.length or 10.0, z.height or 5.0
    local outer = { w + fade * 2, l + fade * 2, h + fade * 2 }
    return { size = { w, l, h } }, { size = outer }, math.sqrt(outer[1] ^ 2 + outer[2] ^ 2 + outer[3] ^ 2) / 2
end

local function zoneItems(e)
    local z = e.zone
    local inner, outer = AudioBuild.zoneVolumes(e)
    local rules, items = {}, {}
    for i, r in ipairs(z.rules or {}) do
        if i > AudioBuild.MAX_RULES then break end
        local name = AudioBuild.ruleName(e, i)
        local fixed = r.fixed == true
        items[#items + 1] = {
            kind = 'AmbientRule', name = name,
            sound = r.sound, category = r.category or 'ambience_general',
            weight = r.weight or 1.0, minDist = r.minDist or 0.0, maxDist = r.maxDist or 25.0,
            minTime = (r.from or 0) * 60, maxTime = (r.to or 24) * 60,
            repeatTime = r.every or 10, repeatVariance = r.variance or 5,
            explicitSpawn = fixed and 1 or 0,
            ox = fixed and (r.x or e.x) or 0.0, oy = fixed and (r.y or e.y) or 0.0, oz = fixed and (r.z or e.z) or 0.0,
            spawnHeight = r.spawnHeight or 0, maxLocal = r.maxLocal or 255, maxGlobal = r.maxGlobal or 255,
            blockability = r.blockability or 100, maxPathDepth = r.maxPathDepth or 3,
            useOcclusion = r.occlusion ~= false, stopWhenRaining = r.stopRain == true,
            followListener = r.followListener == true, streaming = r.streaming == true,
            stopOnZoneDeactivation = r.stopOnLeave ~= false, canTriggerOverWater = r.overWater == true,
            ignoreInitialMinRepeat = r.startNow == true,
        }
        rules[#rules + 1] = name
    end
    for _, v in ipairs(z.vanillaRules or {}) do
        if #rules >= AudioBuild.MAX_RULES + 16 then break end
        rules[#rules + 1] = v
    end
    local zone = {
        kind = 'AmbientZone', name = AudioBuild.zoneName(e),
        shape = z.shape == 'sphere' and 'sphere' or 'box',
        activationCentre = { e.x, e.y, e.z }, activationSize = outer.size, activationAngle = z.rotation or 0,
        positioningCentre = { e.x, e.y, e.z }, positioningSize = inner.size, positioningAngle = z.rotation or 0,
        rulesToPlay = z.rulesToPlay or 4,
        rules = rules,
        dirAmbiences = z.dirAmbiences or {},
        scene = (z.scene and z.scene ~= '') and z.scene or nil,
        environmentRule = (z.environmentRule and z.environmentRule ~= '') and z.environmentRule or nil,
        builtUpFactor = z.builtUp, maxPedDensity = z.maxPedDensity,
    }
    table.insert(items, 1, zone)
    return items
end

-- ##### dat151 items ##### --

local function roomItem(interior, room, zoneRefs)
    local d = room.dat151
    local zone = d.ambientZone
    if zone and zone ~= '' then
        local id = zone:match('^zone:(.+)$')
        if id then zone = zoneRefs[id] end
    end
    local wm = d.weaponMetrics
    local wmItem
    if wm == 'custom' then
        wm = ('iwm_%s'):format(Model.occlRoomName(interior, room))
        wmItem = {
            kind = 'InteriorWeaponMetrics', name = wm,
            wetness = d.weaponWetness, visibility = d.weaponVisibility, lpf = d.weaponLpf,
            preDelay = d.weaponPreDelay, hold = d.weaponHold,
        }
    end
    return {
        kind = 'InteriorRoom',
        name = Model.occlRoomName(interior, room),
        flags = d.flags,
        roomName = room.name:lower(),
        ambientZone = (zone and zone ~= '') and zone or nil,
        interiorType = d.interiorType,
        reverbSmall = d.reverbSmall, reverbMedium = d.reverbMedium, reverbLarge = d.reverbLarge,
        roomTone = (d.roomToneSound and d.roomToneSound ~= '') and d.roomToneSound or 'null_sound',
        rainType = d.rainType,
        exteriorAudibility = d.exteriorAudibility,
        occlusionDamping = d.roomOcclusionDamping,
        nonMarkedPortalOcclusion = d.nonMarkedPortalOcclusion,
        portalOcclusionDistance = d.distanceFromPortalForOcclusion,
        portalFadeDistance = d.distanceFromPortalFadeDistance,
        weaponMetrics = (wm and wm ~= '') and wm or nil,
        walla = (d.interiorWallaSoundSet and d.interiorWallaSoundSet ~= '') and d.interiorWallaSoundSet or 'hash_D4855127',
    }, wmItem
end

--- Finds the room item a placed element belongs to (for native emitters).
local function roomFor(interiors, e)
    if not e.interiorHash or e.interiorHash == 0 or not e.roomName or e.roomName == '' or e.roomName == 'limbo' then return nil end
    for _, interior in ipairs(interiors) do
        if u32(interior.nameHash) == u32(e.interiorHash) and interior.output.rooms ~= false then
            for _, room in ipairs(interior.rooms) do
                if room.index ~= 0 and room.name:lower() == tostring(e.roomName):lower() then
                    return interior, room
                end
            end
        end
    end
end

local function sortedElements(elements)
    local sorted = {}
    for _, e in ipairs(elements or {}) do sorted[#sorted + 1] = e end
    table.sort(sorted, function(a, b) return tostring(a.id) < tostring(b.id) end)
    return sorted
end

--- Builds the .rel item list.
---@return table items, table info { nativeIds, noRoom, rooms, doors, emitters, zones, listName, missingZones }
function AudioBuild.relItems(group, interiors, elements)
    local items = {}
    local info = { nativeIds = {}, noRoom = {}, rooms = 0, doors = 0, emitters = 0, zones = 0, rules = 0, interiors = 0, weapon = 0, missingZones = {} }
    local sorted = sortedElements(elements)

    -- zones first: rooms can point at them
    local zoneRefs, zoneItemsList, zoneNames = {}, {}, {}
    for _, e in ipairs(sorted) do
        if e.type == 'zone' and AudioBuild.isNativeEligible(e) then
            local zi = zoneItems(e)
            zoneRefs[tostring(e.id)] = zi[1].name
            for _, it in ipairs(zi) do zoneItemsList[#zoneItemsList + 1] = it end
            zoneNames[#zoneNames + 1] = zi[1].name
            info.nativeIds[#info.nativeIds + 1] = e.id
            info.zones = info.zones + 1
            info.rules = info.rules + #zi - 1
        end
    end

    local roomsOn, doorsOn = cfg('Output.dat151', true) ~= false, cfg('Output.doors', true) ~= false
    for _, interior in ipairs(interiors) do
        if roomsOn and interior.output.rooms ~= false then
            local refs, rooms, metrics = {}, {}, {}
            for _, room in ipairs(interior.rooms) do
                if room.index ~= 0 then
                    local zone = room.dat151.ambientZone
                    local zid = zone and zone:match('^zone:(.+)$')
                    if zid and not zoneRefs[zid] then info.missingZones[#info.missingZones + 1] = room.name end
                    local it, wm = roomItem(interior, room, zoneRefs)
                    refs[#refs + 1] = it.name
                    rooms[#rooms + 1] = it
                    if wm then metrics[#metrics + 1] = wm end
                end
            end
            local s = interior.settings or {}
            items[#items + 1] = {
                kind = 'InteriorSettings', name = interior.name, nameHash = u32(interior.nameHash),
                flags = s.flags, walla = s.wallaSoundSet, reflections = s.reflections, rooms = refs,
            }
            for _, it in ipairs(rooms) do items[#items + 1] = it end
            for _, it in ipairs(metrics) do items[#items + 1] = it end
            info.rooms = info.rooms + #rooms
            info.weapon = info.weapon + #metrics
            info.interiors = info.interiors + 1
        end
    end

    local doneDoors = {}
    for _, interior in ipairs(interiors) do
        if doorsOn and interior.output.doors ~= false then
            local keys = {}
            for k in pairs(interior.doors or {}) do keys[#keys + 1] = k end
            table.sort(keys)
            for _, k in ipairs(keys) do
                local d = interior.doors[k]
                local h = u32(tonumber(k))
                if h ~= 0 and d.preset and d.preset ~= '' and not doneDoors[h] then
                    doneDoors[h] = true
                    local target = d.preset
                    if d.preset == 'custom' and d.custom then
                        target = JDT.Doors.settingsName(h)
                        items[#items + 1] = {
                            kind = 'DoorAudioSettings', name = target,
                            sounds = d.custom.sounds, tuning = d.custom.tuning, maxOcclusion = d.custom.maxOcclusion,
                        }
                        info.customDoors = (info.customDoors or 0) + 1
                    end
                    if target ~= 'custom' then
                        items[#items + 1] = { kind = 'DoorAudioSettingsLink', name = JDT.Doors.linkName(h), door = target }
                        info.doors = info.doors + 1
                    end
                end
            end
        end
    end

    local names = {}
    for _, e in ipairs(sorted) do
        if e.type ~= 'zone' and AudioBuild.isNativeEligible(e) then
            local name = ('mas_%s'):format(tostring(e.id):gsub('^se_', ''))
            local music = e.type == 'radio' or e.type == 'ambient'
            local db = tonumber(e.volume) or (music and cfg('Output.nativeMusicVolume', 12.0) or cfg('Output.nativeSoundVolume', 0.0))
            local x = e.emitter or {}
            local it = {
                kind = 'StaticEmitter', name = name, x = e.x, y = e.y, z = e.z, maxDistance = e.range,
                minDistance = x.minDistance,
                minTime = e.hours and e.hours.from * 60 or 0, maxTime = e.hours and e.hours.to * 60 or 1440,
                volume = math.floor(db * 100 + 0.5),      -- EmittedVolume is in mB (1/100 dB)
                rolloff = x.rolloff or (music and 250 or 100), -- vanilla radio emitters roll off 2.5x slower
                lpf = x.lpf, hpf = x.hpf,
                maxLeakage = x.maxLeakage, minLeakDist = x.minLeakDist, maxLeakDist = x.maxLeakDist,
                maxPathDepth = x.maxPathDepth,
                smallReverb = x.smallReverb or (music and 50 or nil),
                mediumReverb = x.mediumReverb or (music and 50 or nil),
                largeReverb = x.largeReverb,
            }
            if e.type == 'radio' then
                it.radioStation, it.childSound = e.radio.station, 'null_sound'
            elseif e.type == 'ambient' then
                it.radioStation, it.childSound = e.ambient.station or AudioBuild.stationOf(e.ambient.emitter), 'null_sound'
            else
                it.childSound = e.sound.name
            end
            local interior, room = roomFor(interiors, e)
            if interior then
                it.interior, it.room = u32(interior.nameHash), Model.occlRoomName(interior, room)
            else
                info.noRoom[#info.noRoom + 1] = e.label or e.id
            end
            items[#items + 1] = it
            names[#names + 1] = name
            info.nativeIds[#info.nativeIds + 1] = e.id
        end
    end

    if #names > 0 then
        info.listName = AudioBuild.listName(group)
        items[#items + 1] = { kind = 'StaticEmitterList', name = info.listName, emitters = names }
        info.emitters = #names
    end

    if #zoneNames > 0 then
        for _, it in ipairs(zoneItemsList) do items[#items + 1] = it end
        items[#items + 1] = { kind = 'AmbientZoneList', name = AudioBuild.ZONE_LIST, zones = zoneNames }
    end

    return items, info
end

-- ##### Custom sounds ##### --

--[[
    sounds = { { key, pcm, rate, loop, volume (dB), category, codec ('adpcm'|'pcm'), headroom } }
    returns dat54 items, container names, awc streams
]]
function AudioBuild.soundItems(group, sounds)
    local bank = AudioBuild.soundBank(group)
    local items, set, streams = {}, { kind = 'SoundSet', name = AudioBuild.soundSet(group), sounds = {} }, {}
    local seen = {}
    for _, s in ipairs(sounds or {}) do
        local key = AudioBuild.soundKey(s.key)
        if not seen[key] and (s.pcm == true or (type(s.pcm) == 'string' and #s.pcm >= 2)) then
            seen[key] = true
            local name = AudioBuild.soundName(group, key)
            items[#items + 1] = {
                kind = 'SimpleSound', name = name,
                header = { volume = math.floor((tonumber(s.volume) or 0) * 100 + 0.5), category = s.category or 'scripted' },
                container = bank, wave = key,
            }
            set.sounds[#set.sounds + 1] = { script = key, sound = name }
            streams[#streams + 1] = { name = key, pcm = s.pcm, rate = s.rate, codec = s.codec or 'adpcm', headroom = s.headroom or -100, loop = s.loop == true }
        end
    end
    if #items > 0 then items[#items + 1] = set end
    return items, { (bank:gsub('/', '\\')) }, streams
end

--- Areas where a custom sound bank must stay loaded (room tones / zone rules using custom sounds).
---@param custom table set of dat54 names that are custom sounds -> bank
function AudioBuild.bankKeepers(interiors, elements, custom)
    local keepers = {}
    if not custom or next(custom) == nil then return keepers end
    for _, interior in ipairs(interiors) do
        local bank
        for _, room in ipairs(interior.rooms) do
            local tone = room.dat151 and room.dat151.roomToneSound
            if tone and custom[tone:lower()] then bank = custom[tone:lower()] end
        end
        if bank and interior.location then
            local r = 30.0
            for _, p in ipairs(interior.portals or {}) do
                for _, c in ipairs(p.corners or {}) do
                    local dx, dy, dz = c.x - interior.location.x, c.y - interior.location.y, c.z - interior.location.z
                    r = math.max(r, math.sqrt(dx * dx + dy * dy + dz * dz) + 15.0)
                end
            end
            keepers[#keepers + 1] = { id = ('bank_i%d'):format(u32(interior.nameHash)), type = 'bank', bank = bank,
                x = interior.location.x, y = interior.location.y, z = interior.location.z, range = math.min(r, 250.0) }
        end
    end
    for _, e in ipairs(sortedElements(elements)) do
        if e.type == 'zone' and e.zone and e.enabled ~= false then
            local bank
            for _, r in ipairs(e.zone.rules or {}) do
                if r.sound and custom[tostring(r.sound):lower()] then bank = custom[tostring(r.sound):lower()] end
            end
            if bank then
                local _, _, radius = AudioBuild.zoneVolumes(e)
                keepers[#keepers + 1] = { id = 'bank_' .. tostring(e.id), type = 'bank', bank = bank, x = e.x, y = e.y, z = e.z, range = radius + 10.0 }
            end
        end
    end
    return keepers
end

-- ##### Standalone resource ##### --

function AudioBuild.paths(group)
    local g = AudioBuild.safeName(group)
    return {
        rel = ('audio/%s_game.dat151.rel'):format(g),
        dat = ('audio/%s_game.dat'):format(g),
        relXml = ('xml/%s_game.dat151.rel.xml'):format(g),
        sounds = ('audio/%s_sounds.dat54.rel'):format(g),
        soundsDat = ('audio/%s_sounds.dat'):format(g),
        soundsXml = ('xml/%s_sounds.dat54.rel.xml'):format(g),
        waveDir = AudioBuild.waveDir(g),
        awc = ('%s/%s_sounds.awc'):format(AudioBuild.waveDir(g), g),
        player = 'client/player.lua',
    }
end

--[[
    opts = {
        xml = true,                 -- also write CodeWalker XML copies in xml/
        comments = false,
        maxPathDistance = 5,
        encodeJson = json.encode,   -- needed when a player script is generated
        playerTemplate = '<lua>',   -- runtime/player_core.lua
        toolVersion = '3.0.0',
        sounds = { ... },           -- this group's custom sounds (see soundItems)
        customIndex = { [dat54 name] = bank },  -- every known custom sound (bank keepers)
    }
    returns { files = { { path, content, binary } }, stats, notes, nativeIds, hasRel, hasSounds, ymts, playerCount, soundNames }
]]
function AudioBuild.package(group, interiors, elements, opts)
    opts = opts or {}
    local p = AudioBuild.paths(group)
    local files, notes = {}, {}
    local result = { files = files, notes = notes, ymts = {}, playerCount = 0, soundNames = {} }

    local items, info = AudioBuild.relItems(group, interiors, elements)
    result.nativeIds = info.nativeIds
    result.stats = {
        rooms = info.rooms, doors = info.doors, emitters = info.emitters, interiors = info.interiors, portals = 0, paths = 0,
        zones = info.zones, rules = info.rules, weapon = info.weapon, sounds = 0,
    }

    if #items > 0 then
        files[#files + 1] = { path = p.rel, content = Rel.build(items, AudioBuild.VERSION), binary = true }
        if opts.xml ~= false then files[#files + 1] = { path = p.relXml, content = Rel.toXml(items, AudioBuild.VERSION) } end
        result.hasRel = true
    end

    -- custom sounds
    local sItems, containers, streams = AudioBuild.soundItems(group, opts.sounds)
    if #streams > 0 and opts.noBinary then
        result.hasSounds = true
        result.stats.sounds = #streams
    elseif #streams > 0 then
        files[#files + 1] = { path = p.sounds, content = JDT.Snd54.build(sItems, containers), binary = true }
        files[#files + 1] = { path = p.awc, content = JDT.Awc.build(streams), binary = true }
        if opts.xml ~= false then files[#files + 1] = { path = p.soundsXml, content = JDT.Snd54.toXml(sItems, containers) } end
        result.hasSounds = true
        result.stats.sounds = #streams
        for _, it in ipairs(sItems) do
            if it.kind == 'SimpleSound' then result.soundNames[#result.soundNames + 1] = it.name end
        end
    end

    for _, interior in ipairs(interiors) do
        if cfg('Output.ymt', true) ~= false and interior.output.occlusion ~= false and #interior.portals > 0 then
            -- one occlusion file per placement of the MLO: the game finds it by the placement's position
            for n, inst in ipairs(Model.instances(interior)) do
                local data, st = Encoders.ymtData(inst, { maxPathDistance = opts.maxPathDistance })
                local name = Encoders.ymtName(inst)
                files[#files + 1] = { path = ('stream/%s.ymt'):format(name), content = Pso.build(data), binary = true }
                if opts.xml ~= false then
                    files[#files + 1] = { path = ('xml/%s.ymt.pso.xml'):format(name), content = (Encoders.ymt(inst, { data = data, comments = opts.comments })) }
                end
                result.ymts[#result.ymts + 1] = name
                if n == 1 then
                    result.stats.portals = result.stats.portals + st.portalInfos
                    result.stats.paths = result.stats.paths + st.paths
                end
            end
            result.stats.placements = (result.stats.placements or 0) + #(interior.placements or {}) + 1
        end
    end

    -- Everything the game can't play natively goes into a small client script
    local native = {}
    for _, id in ipairs(info.nativeIds) do native[id] = true end
    local list = {}
    for _, e in ipairs(elements or {}) do
        if not native[e.id] and e.enabled ~= false then
            local c = JDT.Lib.deepcopy(e)
            c.pack, c.native, c.group = nil, nil, nil
            list[#list + 1] = c
        end
    end
    local custom = opts.customIndex or {}
    for _, k in ipairs(AudioBuild.bankKeepers(interiors, elements, custom)) do list[#list + 1] = k end
    table.sort(list, function(a, b) return tostring(a.id) < tostring(b.id) end)
    if #list > 0 and opts.encodeJson and opts.playerTemplate then
        local data = opts.encodeJson(list)
        local eq = '=='
        while data:find(']' .. eq .. ']', 1, true) do eq = eq .. '=' end
        files[#files + 1] = {
            path = p.player,
            content = ('-- Generated by jdt for "%s". Plays the placed sounds the game cannot play on its own.\nlocal DATA_JSON = [%s[%s]%s]\n'):format(group, eq, data, eq) .. opts.playerTemplate,
        }
        result.playerCount = #list
    end

    if #info.noRoom > 0 then
        notes[#notes + 1] = { key = 'export_no_room', args = { #info.noRoom, table.concat(info.noRoom, ', ') } }
    end
    if #info.missingZones > 0 then
        notes[#notes + 1] = { key = 'export_missing_zone', args = { table.concat(info.missingZones, ', ') } }
    end

    files[#files + 1] = { path = 'fxmanifest.lua', content = AudioBuild.manifest(group, result, opts) }
    files[#files + 1] = { path = 'README.md', content = AudioBuild.readme(group, interiors, result, opts) }
    return result
end

--- fxmanifest lines for the audio data files (shared by the standalone manifest and installs).
---@param rel string|nil  path of the .dat151.rel
---@param sounds string|nil path of the .dat54.rel
---@param waveDir string|nil wave pack folder
---@param awc string|nil path of the .awc
function AudioBuild.dataLines(rel, sounds, waveDir, awc)
    local L, files = {}, {}
    if sounds and awc then
        files[#files + 1] = ("'%s'"):format(sounds)
        files[#files + 1] = ("'%s'"):format(awc)
    end
    if rel then files[#files + 1] = ("'%s'"):format(rel) end
    if #files > 0 then L[#L + 1] = 'files { ' .. table.concat(files, ', ') .. ' }' end
    if sounds and awc then
        L[#L + 1] = ("data_file 'AUDIO_WAVEPACK' '%s'"):format(waveDir)
        L[#L + 1] = ("data_file 'AUDIO_SOUNDDATA' '%s'"):format((sounds:gsub('54%.rel$', '')))
    end
    if rel then L[#L + 1] = ("data_file 'AUDIO_GAMEDATA' '%s'"):format((rel:gsub('151%.rel$', ''))) end
    return L
end

function AudioBuild.manifest(group, result, opts)
    local p = AudioBuild.paths(group)
    local L = {
        ('-- Audio for "%s", generated by jdt %s. Works on its own: the tool does not need to run.'):format(group, opts.toolVersion or ''),
        '-- Ensure this resource AFTER the MLO, then restart the server and reconnect (audio is only read when you join).',
        '',
        "fx_version 'cerulean'",
        "game 'gta5'",
        "lua54 'yes'",
        "this_is_a_map 'yes'",
        '',
    }
    for _, l in ipairs(AudioBuild.dataLines(result.hasRel and p.rel or nil, result.hasSounds and p.sounds or nil, p.waveDir, result.hasSounds and p.awc or nil)) do
        L[#L + 1] = l
    end
    if result.playerCount > 0 then L[#L + 1] = ("client_script '%s'"):format(p.player) end
    if #result.ymts > 0 then L[#L + 1] = ('-- stream/*.ymt (audio occlusion) is streamed automatically') end
    return table.concat(L, '\n') .. '\n'
end

function AudioBuild.readme(group, interiors, result, opts)
    local L = {
        ('# Audio for %s'):format(group), '',
        'Generated by jdt. Native game files, no CodeWalker step needed.', '',
        '## Install', '',
        '1. Copy this folder into your server `resources` (rename it if you like).',
        '2. Add `ensure <folder name>` to `server.cfg`, after the MLO.',
        '3. Restart the server and reconnect.', '',
        '## Contents', '',
    }
    for _, f in ipairs(result.files) do
        if f.path ~= 'README.md' then L[#L + 1] = ('- `%s`'):format(f.path) end
    end
    L[#L + 1] = ''
    if #interiors > 0 then
        L[#L + 1] = '## Interiors'
        L[#L + 1] = ''
        for _, i in ipairs(interiors) do
            L[#L + 1] = ('- %s (hash %d, proxy %d, %d rooms, %d portals)'):format(i.name, i.uintNameHash, i.uintProxyHash, #i.rooms, #i.portals)
            for n, inst in ipairs(Model.instances(i)) do
                if n > 1 then L[#L + 1] = ('  - also placed at %.2f, %.2f, %.2f (proxy %d)'):format(inst.location.x, inst.location.y, inst.location.z, inst.uintProxyHash) end
            end
        end
        L[#L + 1] = ''
    end
    if #result.soundNames > 0 then
        L[#L + 1] = '## Custom sounds'
        L[#L + 1] = ''
        L[#L + 1] = ('Sound set `%s`, bank `%s`. From a script:'):format(AudioBuild.soundSet(group), AudioBuild.soundBank(group))
        L[#L + 1] = ''
        L[#L + 1] = '```lua'
        L[#L + 1] = ("RequestScriptAudioBank('%s', false)"):format(AudioBuild.soundBank(group))
        L[#L + 1] = ("PlaySoundFromCoord(-1, '<sound>', x, y, z, '%s', false, 20, false)"):format(AudioBuild.soundSet(group))
        L[#L + 1] = '```'
        L[#L + 1] = ''
        for _, n in ipairs(result.soundNames) do L[#L + 1] = ('- `%s`'):format(n) end
        L[#L + 1] = ''
    end
    L[#L + 1] = 'The `xml/` folder holds the same data as CodeWalker XML, for inspection or manual edits.'
    return table.concat(L, '\n') .. '\n'
end

return AudioBuild
