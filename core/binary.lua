--[[
    Native GTA V audio files, written directly (no CodeWalker needed). Pure Lua 5.4.

    Rel  - game.dat151.rel (InteriorSettings, InteriorRoom, InteriorWeaponMetrics, DoorAudioSettingsLink,
           StaticEmitter, StaticEmitterList, AmbientZone, AmbientRule, AmbientZoneList)
           and sounds.dat54.rel (SimpleSound, SoundSet) for custom sounds.
           Layout mirrors CodeWalker's RelFile.Save() (dexyfex/CodeWalker, RelFile.cs).
    Pso  - <proxy hash>.ymt (naOcclusionInteriorMetadata, PSO), layout reproduced from CodeWalker's PsoBuilder.

]]

JDT = JDT or {}

local Hash = JDT.Hash
local pack, unpack = string.pack, string.unpack

local U32 <const> = 0xFFFFFFFF
local function u32(v) return math.tointeger(math.floor(tonumber(v) or 0)) & U32 end

-- ##### Hash helper ##### --

--- nil / '' / 0 -> 0, numbers as-is, 'hash_XXXXXXXX' / '0xXXXXXXXX' as hex, anything else joaat'd.
local function H(v)
    if v == nil or v == '' or v == 0 or v == false then return 0 end
    if type(v) == 'number' then return u32(v) end
    local s = tostring(v)
    local hex = s:match('^hash_(%x+)$') or s:match('^0[xX](%x+)$')
    if hex and #hex <= 8 then return tonumber(hex, 16) & U32 end
    return Hash.joaatU(s)
end

-- ##### dat151 .rel ##### --

local Rel = {}
JDT.Rel = Rel
Rel.hash = H

Rel.TYPE = {
    StaticEmitter = 6,
    StaticEmitterList = 32,
    AmbientZone = 37,
    AmbientRule = 38,
    AmbientZoneList = 39,
    InteriorSettings = 44,
    InteriorWeaponMetrics = 45,
    InteriorRoom = 46,
    DoorAudioSettings = 47,
    DoorAudioSettingsLink = 117,
}

Rel.SHAPE = { box = 0, sphere = 1, line = 2 }

--- RAGE tri-state flag words: 2 bits per flag, 00 = no, 01 = yes, 10 = not set.
function Rel.triFlags(list)
    local v = 0xAAAAAAAA
    for i, state in pairs(list) do
        if state ~= nil then
            local shift = (i - 1) * 2
            v = (v & ~(3 << shift)) | ((state and 1 or 0) << shift)
        end
    end
    return v & U32
end

--- AmbientRule flag order: index -> name
Rel.RULE_FLAGS = {
    'ignoreInitialMinRepeat', 'stopWhenRaining', 'stopOnLoudSound', 'followListener', 'useOcclusion', 'streaming',
    'stopOnZoneDeactivation', 'triggerOnLoudSound', 'canTriggerOverWater', 'checkConditionsEachFrame', 'usePlayerPosition', 'disableInMultiplayer',
}

function Rel.ruleFlags(r)
    local t = {}
    for i, name in ipairs(Rel.RULE_FLAGS) do
        local v = r[name]
        if v ~= nil then t[i] = v and true or false end
    end
    -- vanilla defaults (ar_vehicles_truck_horns_24hr): 0xAA0011A8
    if t[1] == nil then t[1] = false end
    if t[5] == nil then t[5] = true end
    if t[6] == nil then t[6] = false end
    if t[7] == nil then t[7] = true end
    for i = 8, 12 do if t[i] == nil then t[i] = false end end
    local v = Rel.triFlags(t)
    -- flags 13..16 stay "not set" like vanilla
    return v
end
local TYPE = Rel.TYPE

local function header(typeId) return pack('<I4', typeId & 0xFF) end -- name-table offset 0, type in the low byte

local encoders = {}

local function i16(v, def) return math.tointeger(math.floor(tonumber(v) or def)) or def end

function encoders.StaticEmitter(it)
    return header(TYPE.StaticEmitter) .. pack('<I4I4I4fffffi4I2I2I2I2I4I4I4fI2I2I4I4BBBBI2I2ff',
        u32(it.flags or 0xAA041501),
        H(it.childSound or 'null_sound'),
        H(it.radioStation),
        it.x, it.y, it.z,
        it.minDistance or 0.0,
        it.maxDistance or 20.0,
        math.tointeger(math.floor(it.volume or 0)) or 0,
        i16(it.lpf, 23900), i16(it.hpf, 0),
        i16(it.rolloff, 100), 0,
        H(it.interior), H(it.room),
        0,                              -- RadioStationForScore
        it.maxLeakage or 0.8,
        i16(it.minLeakDist, 6), i16(it.maxLeakDist, 15),
        H(it.alarm),
        H('null_sound'),                -- OnBreakOneShot
        i16(it.maxPathDepth, 3), i16(it.smallReverb, 0), i16(it.mediumReverb, 0), i16(it.largeReverb, 0),
        i16(it.minTime, 0), i16(it.maxTime, 1440),
        0.94, 0.99), nil                -- BrokenHealth / UndamagedHealth (vanilla values)
end

function encoders.StaticEmitterList(it)
    local b = { header(TYPE.StaticEmitterList), pack('<I4', #it.emitters) }
    for _, h in ipairs(it.emitters) do b[#b + 1] = pack('<I4', H(h)) end
    return table.concat(b), nil
end

function encoders.InteriorSettings(it)
    local b = { header(TYPE.InteriorSettings), pack('<I4I4I4I4', u32(H(it.flags or 0xAAAAA044)), H(it.walla or 'hash_D4855127'), H(it.reflections), #it.rooms) }
    local ht = {}
    for i, h in ipairs(it.rooms) do
        b[#b + 1] = pack('<I4', H(h))
        ht[#ht + 1] = 16 + (i - 1) * 4
    end
    return table.concat(b), ht
end

function encoders.InteriorRoom(it)
    return header(TYPE.InteriorRoom) .. pack('<I4I4I4BBi2fffI4BBi2fffffI4I4',
        u32(H(it.flags or 0xAAAAAAAA)),
        H(it.roomName),
        H(it.ambientZone),
        it.interiorType or 0, 0, 0,
        it.reverbSmall or 0.35, it.reverbMedium or 0.0, it.reverbLarge or 0.0,
        H(it.roomTone or 'null_sound'),
        it.rainType or 0, 0, 0,
        it.exteriorAudibility or 0.0,
        it.occlusionDamping or 0.0,
        it.nonMarkedPortalOcclusion or 0.7,
        it.portalOcclusionDistance or 0.0,
        it.portalFadeDistance or 50.0,
        H(it.weaponMetrics),
        H(it.walla or 'hash_D4855127')), { 8 }
end

function encoders.InteriorWeaponMetrics(it)
    return header(TYPE.InteriorWeaponMetrics) .. pack('<ffI4I4f',
        it.wetness or 0.5, it.visibility or 0.5,
        u32(it.lpf or 23900), u32(it.preDelay or 0), it.hold or 0.0), nil
end

--- Pads to 16 bytes counted from the start of the data block (CodeWalker writes it that way).
local function pad16(len, pos) return ('\0'):rep((16 - (pos + len) % 16) % 16) end

local function vec(v, d) v = v or d; return v[1] or v.x or 0.0, v[2] or v.y or 0.0, v[3] or v.z or 0.0 end

--[[
    AmbientZone: activation volume (zone switches on while the listener is inside) and positioning
    volume (where the rule sounds spawn). Defaults from az_dlc_xm_int_facility_server_group_west_02.
]]
function encoders.AmbientZone(it, pos)
    local ax, ay, az = vec(it.activationCentre, { 0, 0, 0 })
    local asx, asy, asz = vec(it.activationSize, { 10, 10, 10 })
    local px, py, pz = vec(it.positioningCentre or it.activationCentre, { 0, 0, 0 })
    local psx, psy, psz = vec(it.positioningSize or it.activationSize, { 10, 10, 10 })
    local b = {
        header(TYPE.AmbientZone),
        pack('<I4I4I4', u32(it.flags or 0xAA800424), Rel.SHAPE[it.shape or 'box'] or 0, 0),
        pack('<ffff ffff fffI4 fffI4 I2I2I4I4I4',
            ax, ay, az, 0.0, asx, asy, asz, 0.0,
            0.0, 0.0, 0.0, 0, 1.0, 1.0, 1.0, 0,
            (i16(it.activationAngle, 0) % 360), 0, 0, 0, 0),
        pack('<ffff ffff fffI4 fffI4 I2I2I4I4I4',
            px, py, pz, 0.0, psx, psy, psz, 0.0,
            0.0, 0.0, 0.0, 0, 1.0, 1.0, 1.0, 0,
            (i16(it.positioningAngle or it.activationAngle, 0) % 360), 0, 0, 0, 0),
        pack('<fffI4fffI4I4I4fI4I4',
            it.builtUpFactor or 0.0, it.minPedDensity or 0.0, it.maxPedDensity or 1.0, H(it.pedDensityTOD),
            it.pedDensityScalar or 1.0, it.maxWindInfluence or -1.0, it.minWindInfluence or -1.0,
            H(it.windElevationSounds), H(it.environmentRule), H(it.scene),
            it.underwaterCreakFactor or -1.0, H(it.pedWalla), H(it.randomRadio)),
    }
    local rules, dirs = it.rules or {}, it.dirAmbiences or {}
    b[#b + 1] = pack('<BBBB', math.min(255, i16(it.rulesToPlay, 4)), i16(it.waterCalculation, 1), #rules, 0)
    for _, r in ipairs(rules) do b[#b + 1] = pack('<I4', H(r)) end
    b[#b + 1] = pack('<BBBB', #dirs, 0, 0, 0)
    for _, d in ipairs(dirs) do b[#b + 1] = pack('<I4f', H(d.name), d.volume or 1.0) end
    local s = table.concat(b)
    return s .. pad16(#s, pos), nil
end

--[[
    AmbientRule: a sound the zone triggers. Times are minutes of the day, repeat times seconds.
    Defaults from ar_vehicles_truck_horns_24hr.
]]
function encoders.AmbientRule(it, pos)
    local conds = it.conditions or {}
    local b = {
        header(TYPE.AmbientRule),
        pack('<I4I4I4fffI4', u32(it.flags or Rel.ruleFlags(it)), 0, 0, it.ox or 0.0, it.oy or 0.0, it.oz or 0.0, 0),
        pack('<I4I4I4i4I4fff', H(it.sound), H(it.category or 'ambience_general'), 0, -1, 0,
            it.weight or 1.0, it.minDist or 0.0, it.maxDist or 30.0),
        pack('<I2I2I2I2BBBBBBI2',
            i16(it.minTime, 0), i16(it.maxTime, 1440),
            math.min(65535, i16(it.repeatTime, 10)), math.min(65535, i16(it.repeatVariance, 5)),
            i16(it.spawnHeight, 0), i16(it.explicitSpawn, 0),
            math.min(255, i16(it.maxLocal, 255)), math.min(255, i16(it.maxGlobal, 255)),
            math.min(255, i16(it.blockability, 100)), math.min(255, i16(it.maxPathDepth, 3)),
            #conds),
    }
    for _, c in ipairs(conds) do
        b[#b + 1] = pack('<I4fBBI2', H(c.name), c.value or 0.0, i16(c.type, 0), i16(c.bankLoading, 0), 0)
    end
    local s = table.concat(b)
    if #conds > 0 then s = s .. pad16(#s, pos) end
    return s, nil
end

function encoders.AmbientZoneList(it)
    local b = { header(TYPE.AmbientZoneList), pack('<I4', #it.zones) }
    for _, h in ipairs(it.zones) do b[#b + 1] = pack('<I4', H(h)) end
    return table.concat(b), nil
end

function encoders.DoorAudioSettings(it)
    return header(TYPE.DoorAudioSettings) .. pack('<I4I4f', H(it.sounds), H(it.tuning), it.maxOcclusion or 0.7), { 4 }
end

function encoders.DoorAudioSettingsLink(it)
    return header(TYPE.DoorAudioSettingsLink) .. pack('<I4', H(it.door)), { 0 }
end

--- Item copied as-is from another .rel (see Rel.read).
function encoders.Raw(it)
    return string.char(it.typeId) .. '\0\0\0' .. it.bytes:sub(5), it.ht
end

local ALIGN = { [TYPE.StaticEmitterList] = 4, [TYPE.AmbientZone] = 16, [TYPE.AmbientRule] = 16 }

local function rot8(h) return ((h >> 8) | (h << 24)) & U32 end

--- items: { { kind = 'InteriorRoom', name = 'x', ... }, ... } written in order. Returns the file bytes.
function Rel.build(items, version)
    local data = { pack('<I4', version or 45897013) }
    local pos = 4
    local entries, htOffsets = {}, {}

    for _, it in ipairs(items) do
        local enc = encoders[it.kind]
        if not enc then error('unknown rel item kind: ' .. tostring(it.kind)) end
        local align = ALIGN[it.kind == 'Raw' and it.typeId or TYPE[it.kind]]
        if align then
            while pos % align ~= 0 do data[#data + 1] = '\0'; pos = pos + 1 end
        end
        local bytes, ht = enc(it, pos)
        entries[#entries + 1] = { hash = it.nameHash and u32(it.nameHash) or H(it.name), offset = pos, length = #bytes }
        if ht then
            for _, o in ipairs(ht) do htOffsets[#htOffsets + 1] = pos + 12 + o end
        end
        data[#data + 1] = bytes
        pos = pos + #bytes
    end

    local block = table.concat(data)
    table.sort(entries, function(a, b) return rot8(a.hash) < rot8(b.hash) end)

    local out = {
        pack('<I4I4', 151, #block), block,
        pack('<I4I4', 4, 0),            -- name table: length 4, count 0
        pack('<I4', #entries),
    }
    for _, e in ipairs(entries) do out[#out + 1] = pack('<I4I4I4', e.hash, e.offset, e.length) end
    out[#out + 1] = pack('<I4', #htOffsets)
    for _, o in ipairs(htOffsets) do out[#out + 1] = pack('<I4', o) end
    out[#out + 1] = pack('<I4', 0)      -- pack table
    return table.concat(out)
end

--- CodeWalker-importable XML with the same content as Rel.build.
function Rel.toXml(items, version)
    local function hs(v)
        local h = H(v)
        if h == 0 then return nil end
        if type(v) == 'string' and not v:match('^hash_') and not v:match('^0[xX]') then return v:lower() end
        return ('hash_%08X'):format(h)
    end
    local function f(v) return (('%.6g'):format(v)) end
    local L = { '<?xml version="1.0" encoding="UTF-8"?>', '<Dat151>', (' <Version value="%d" />'):format(version or 45897013), ' <Items>' }
    local function add(s) L[#L + 1] = s end
    local function tag(name, v)
        local s = hs(v)
        if s then add(('   <%s>%s</%s>'):format(name, s, name)) else add(('   <%s />'):format(name)) end
    end
    local function val(name, v) add(('   <%s value="%s" />'):format(name, v)) end

    for _, it in ipairs(items) do
        if it.kind ~= 'Raw' then
            add(('  <Item type="%s" ntOffset="0">'):format(it.kind))
            add(('   <Name>%s</Name>'):format(it.name and (hs(it.name) or '') or ('hash_%08X'):format(u32(it.nameHash))))
            if it.kind == 'StaticEmitter' then
                val('Flags', ('0x%08X'):format(u32(it.flags or 0xAA041501)))
                tag('ChildSound', it.childSound or 'null_sound')
                tag('RadioStation', it.radioStation)
                add(('   <Position x="%s" y="%s" z="%s" />'):format(f(it.x), f(it.y), f(it.z)))
                val('MinDistance', f(it.minDistance or 0))
                val('MaxDistance', f(it.maxDistance or 20))
                val('EmittedVolume', math.tointeger(math.floor(it.volume or 0)) or 0)
                val('LPFCutoff', it.lpf or 23900)
                val('HPFCutoff', it.hpf or 0)
                val('RolloffFactor', it.rolloff or 100)
                tag('Interior', it.interior)
                tag('Room', it.room)
                add('   <RadioStationForScore />')
                val('MaxLeakage', f(it.maxLeakage or 0.8))
                val('MinLeakageDistance', it.minLeakDist or 6)
                val('MaxLeakageDistance', it.maxLeakDist or 15)
                tag('Alarm', it.alarm)
                add('   <OnBreakOneShot>null_sound</OnBreakOneShot>')
                val('MaxPathDepth', it.maxPathDepth or 3)
                val('SmallReverbSend', it.smallReverb or 0)
                val('MediumReverbSend', it.mediumReverb or 0)
                val('LargeReverbSend', it.largeReverb or 0)
                val('MinTimeMinutes', it.minTime or 0)
                val('MaxTimeMinutes', it.maxTime or 1440)
                val('BrokenHealth', '0.94')
                val('UndamagedHealth', '0.99')
            elseif it.kind == 'StaticEmitterList' then
                add('   <Emitters>')
                for _, e in ipairs(it.emitters) do add(('    <Item>%s</Item>'):format(hs(e))) end
                add('   </Emitters>')
            elseif it.kind == 'InteriorSettings' then
                val('Flags', ('0x%08X'):format(u32(H(it.flags or 0xAAAAA044))))
                tag('InteriorWallaSoundSet', it.walla or 'hash_D4855127')
                tag('InteriorReflections', it.reflections)
                add('   <Rooms>')
                for _, r in ipairs(it.rooms) do add(('    <Item>%s</Item>'):format(hs(r))) end
                add('   </Rooms>')
            elseif it.kind == 'InteriorRoom' then
                val('Flags', ('0x%08X'):format(u32(H(it.flags or 0xAAAAAAAA))))
                tag('RoomName', it.roomName)
                tag('AmbientZone', it.ambientZone)
                val('InteriorType', it.interiorType or 0)
                val('ReverbSmall', f(it.reverbSmall or 0.35))
                val('ReverbMedium', f(it.reverbMedium or 0))
                val('ReverbLarge', f(it.reverbLarge or 0))
                tag('RoomToneSound', it.roomTone or 'null_sound')
                val('RainType', it.rainType or 0)
                val('ExteriorAudibility', f(it.exteriorAudibility or 0))
                val('RoomOcclusionDamping', f(it.occlusionDamping or 0))
                val('NonMarkedPortalOcclusion', f(it.nonMarkedPortalOcclusion or 0.7))
                val('DistanceFromPortalForOcclusion', f(it.portalOcclusionDistance or 0))
                val('DistanceFromPortalFadeDistance', f(it.portalFadeDistance or 50))
                tag('WeaponMetrics', it.weaponMetrics)
                tag('InteriorWallaSoundSet', it.walla or 'hash_D4855127')
            elseif it.kind == 'DoorAudioSettingsLink' then
                tag('Door', it.door)
            elseif it.kind == 'DoorAudioSettings' then
                tag('Sounds', it.sounds)
                tag('TuningParams', it.tuning)
                val('MaxOcclusion', f(it.maxOcclusion or 0.7))
            elseif it.kind == 'InteriorWeaponMetrics' then
                val('Wetness', f(it.wetness or 0.5))
                val('Visability', f(it.visibility or 0.5))
                val('LPFCutoff', math.tointeger(math.floor(it.lpf or 23900)))
                val('PreDelay', math.tointeger(math.floor(it.preDelay or 0)))
                val('Hold', f(it.hold or 0))
            elseif it.kind == 'AmbientZone' then
                local function v3(name, v, d)
                    local x, y, z = vec(v, d)
                    add(('   <%s x="%s" y="%s" z="%s" />'):format(name, f(x), f(y), f(z)))
                end
                val('Flags', ('0x%08X'):format(u32(it.flags or 0xAA800424)))
                add(('   <Shape>%s</Shape>'):format(({ box = 'Box', sphere = 'Sphere', line = 'Line' })[it.shape or 'box'] or 'Box'))
                v3('ActivationZoneCentre', it.activationCentre, { 0, 0, 0 })
                v3('ActivationZoneSize', it.activationSize, { 10, 10, 10 })
                v3('ActivationZonePostRotationOffset', nil, { 0, 0, 0 })
                v3('ActivationZoneSizeScale', nil, { 1, 1, 1 })
                val('ActivationZoneRotationAngle', (math.tointeger(math.floor(it.activationAngle or 0)) or 0) % 360)
                v3('PositioningZoneCentre', it.positioningCentre or it.activationCentre, { 0, 0, 0 })
                v3('PositioningZoneSize', it.positioningSize or it.activationSize, { 10, 10, 10 })
                v3('PositioningZonePostRotationOffset', nil, { 0, 0, 0 })
                v3('PositioningZoneSizeScale', nil, { 1, 1, 1 })
                val('PositioningZoneRotationAngle', (math.tointeger(math.floor(it.positioningAngle or it.activationAngle or 0)) or 0) % 360)
                val('BuiltUpFactor', f(it.builtUpFactor or 0))
                val('MinPedDensity', f(it.minPedDensity or 0))
                val('MaxPedDensity', f(it.maxPedDensity or 1))
                tag('PedDensityTOD', it.pedDensityTOD)
                val('PedDensityScalar', f(it.pedDensityScalar or 1))
                val('MaxWindInfluence', f(it.maxWindInfluence or -1))
                val('MinWindInfluence', f(it.minWindInfluence or -1))
                tag('WindElevationSounds', it.windElevationSounds)
                tag('EnvironmentRule', it.environmentRule)
                tag('AudioScene', it.scene)
                val('UnderwaterCreakFactor', f(it.underwaterCreakFactor or -1))
                tag('PedWallaSettings', it.pedWalla)
                tag('RandomisedRadioSettings', it.randomRadio)
                val('NumRulesToPlay', it.rulesToPlay or 4)
                val('ZoneWaterCalculation', it.waterCalculation or 1)
                add('   <Rules>')
                for _, r in ipairs(it.rules or {}) do add(('    <Item>%s</Item>'):format(hs(r))) end
                add('   </Rules>')
                add('   <DirAmbiences>')
                for _, d in ipairs(it.dirAmbiences or {}) do
                    add('    <Item>')
                    add(('     <Name>%s</Name>'):format(hs(d.name)))
                    add(('     <Volume value="%s" />'):format(f(d.volume or 1)))
                    add('    </Item>')
                end
                add('   </DirAmbiences>')
            elseif it.kind == 'AmbientRule' then
                val('Flags', ('0x%08X'):format(u32(it.flags or Rel.ruleFlags(it))))
                add(('   <ExplicitPosition x="%s" y="%s" z="%s" />'):format(f(it.ox or 0), f(it.oy or 0), f(it.oz or 0)))
                tag('ChildSound', it.sound)
                tag('Category', it.category or 'ambience_general')
                val('LastPlayTime', 0)
                val('DynamicBankID', -1)
                val('DynamicSlotType', 0)
                val('Weight', f(it.weight or 1))
                val('MinDist', f(it.minDist or 0))
                val('MaxDist', f(it.maxDist or 30))
                val('MinTimeMinutes', it.minTime or 0)
                val('MaxTimeMinutes', it.maxTime or 1440)
                val('MinRepeatTime', it.repeatTime or 10)
                val('MinRepeatTimeVariance', it.repeatVariance or 5)
                val('SpawnHeight', it.spawnHeight or 0)
                add(('   <ExplicitSpawn>%s</ExplicitSpawn>'):format(({ [0] = 'Disabled', 'WorldRelative', 'InteriorRelative' })[it.explicitSpawn or 0] or 'Disabled'))
                val('MaxLocalInstances', it.maxLocal or 255)
                val('MaxGlobalInstances', it.maxGlobal or 255)
                val('BlockabilityFactor', it.blockability or 100)
                val('MaxPathDepth', it.maxPathDepth or 3)
                add('   <Conditions />')
            elseif it.kind == 'AmbientZoneList' then
                add('   <Zones>')
                for _, z in ipairs(it.zones) do add(('    <Item>%s</Item>'):format(hs(z))) end
                add('   </Zones>')
            end
            add('  </Item>')
        end
    end
    add(' </Items>')
    add('</Dat151>')
    return table.concat(L, '\n') .. '\n'
end

-- Reader (used to merge an MLO's existing audio file and for tests)

local function rawHashTable(typeId, bytes)
    if typeId == TYPE.InteriorSettings then
        local count = unpack('<I4', bytes, 17)
        local t = {}
        for i = 0, count - 1 do t[#t + 1] = 16 + i * 4 end
        return t
    elseif typeId == TYPE.InteriorRoom then return { 8 }
    elseif typeId == TYPE.DoorAudioSettings then return { 4 }
    elseif typeId == TYPE.DoorAudioSettingsLink then return { 0 }
    elseif typeId == TYPE.StaticEmitter or typeId == TYPE.StaticEmitterList or typeId == TYPE.AmbientZone
        or typeId == TYPE.AmbientRule or typeId == TYPE.AmbientZoneList or typeId == TYPE.InteriorWeaponMetrics
        or typeId == 48 --[[DoorTuningParams]] then return nil
    end
    return false -- unknown layout
end

--- Returns { version, items = { { nameHash, typeId, bytes, ht, known } } } in data order, or nil, err.
function Rel.read(data)
    if type(data) ~= 'string' or #data < 8 then return nil, 'file too small' end
    local relType, dataLen = unpack('<I4I4', data, 1)
    if relType ~= 151 then return nil, 'not a dat151 file' end
    local block = data:sub(9, 8 + dataLen)
    local pos = 9 + dataLen
    local _, ntCount = unpack('<I4I4', data, pos)
    pos = pos + 8 + 4 * ntCount
    for _ = 1, ntCount do pos = (data:find('\0', pos, true) or #data) + 1 end
    local count = unpack('<I4', data, pos)
    pos = pos + 4
    local items = {}
    for _ = 1, count do
        local h, off, len = unpack('<I4I4I4', data, pos)
        pos = pos + 12
        local bytes = block:sub(off + 1, off + len)
        local typeId = bytes:byte(1)
        local ht = rawHashTable(typeId, bytes)
        items[#items + 1] = { nameHash = h, offset = off, typeId = typeId, bytes = bytes, ht = ht or nil, known = ht ~= false }
    end
    table.sort(items, function(a, b) return a.offset < b.offset end)
    return { version = unpack('<I4', block, 1), items = items }
end

--- Room name hashes listed by an InteriorSettings item.
function Rel.roomsOf(item)
    local out = {}
    if item.typeId ~= TYPE.InteriorSettings then return out end
    local count = unpack('<I4', item.bytes, 17)
    for i = 0, count - 1 do out[#out + 1] = unpack('<I4', item.bytes, 21 + i * 4) end
    return out
end

--- Decodes the fields of an InteriorRoom item (tests / inspection).
function Rel.decodeRoom(bytes)
    local f = { unpack('<I4I4I4I4BBi2fffI4BBi2fffffI4I4', bytes) }
    return {
        flags = f[2], roomName = f[3], ambientZone = f[4], interiorType = f[5],
        reverbSmall = f[8], reverbMedium = f[9], reverbLarge = f[10], roomTone = f[11], rainType = f[12],
        exteriorAudibility = f[15], occlusionDamping = f[16], nonMarkedPortalOcclusion = f[17],
        portalOcclusionDistance = f[18], portalFadeDistance = f[19], weaponMetrics = f[20], walla = f[21],
    }
end

function Rel.decodeDoorSettings(bytes)
    local sounds, tuning, occ = unpack('<I4I4f', bytes, 5)
    return { sounds = sounds, tuning = tuning, maxOcclusion = occ }
end

function Rel.decodeWeaponMetrics(bytes)
    local w, v, lpf, pre, hold = unpack('<ffI4I4f', bytes, 5)
    return { wetness = w, visibility = v, lpf = lpf, preDelay = pre, hold = hold }
end

function Rel.decodeZone(bytes)
    local o = 5
    local flags, shape = unpack('<I4I4', bytes, o); o = o + 12
    local ax, ay, az, _, asx, asy, asz = unpack('<fffffff', bytes, o); o = o + 32 + 32
    local aAng = unpack('<I2', bytes, o); o = o + 16
    local px, py, pz, _, psx, psy, psz = unpack('<fffffff', bytes, o); o = o + 64
    local pAng = unpack('<I2', bytes, o); o = o + 16
    local bu, minPed, maxPed, tod, scalar, maxW, minW, windEl, env, scene, creak, walla, radio = unpack('<fffI4fffI4I4I4fI4I4', bytes, o); o = o + 52
    local toPlay, water, nRules = unpack('<BBB', bytes, o); o = o + 4
    local rules = {}
    for i = 1, nRules do rules[i] = unpack('<I4', bytes, o); o = o + 4 end
    local nDirs = unpack('<B', bytes, o); o = o + 4
    local dirs = {}
    for i = 1, nDirs do local h, vol = unpack('<I4f', bytes, o); dirs[i] = { name = h, volume = vol }; o = o + 8 end
    local shapes = { [0] = 'box', 'sphere', 'line' }
    return {
        flags = flags, shape = shapes[shape & 0xFF] or 'box',
        activationCentre = { ax, ay, az }, activationSize = { asx, asy, asz }, activationAngle = aAng,
        positioningCentre = { px, py, pz }, positioningSize = { psx, psy, psz }, positioningAngle = pAng,
        builtUpFactor = bu, minPedDensity = minPed, maxPedDensity = maxPed, pedDensityTOD = tod, pedDensityScalar = scalar,
        maxWindInfluence = maxW, minWindInfluence = minW, windElevationSounds = windEl, environmentRule = env, scene = scene,
        underwaterCreakFactor = creak, pedWalla = walla, randomRadio = radio,
        rulesToPlay = toPlay, waterCalculation = water, rules = rules, dirAmbiences = dirs,
    }
end

function Rel.decodeRule(bytes)
    local flags, _, _, ox, oy, oz, _, sound, cat, _, _, _, weight, minD, maxD, minT, maxT, rep, repVar, height, explicit, maxLocal, maxGlobal, block, depth, nCond
        = unpack('<I4I4I4fffI4I4I4I4i4I4fffI2I2I2I2BBBBBBI2', bytes, 5)
    local r = {
        flags = flags, ox = ox, oy = oy, oz = oz, sound = sound, category = cat, weight = weight, minDist = minD, maxDist = maxD,
        minTime = minT, maxTime = maxT, repeatTime = rep, repeatVariance = repVar, spawnHeight = height, explicitSpawn = explicit,
        maxLocal = maxLocal, maxGlobal = maxGlobal, blockability = block, maxPathDepth = depth, conditions = {},
    }
    for i, name in ipairs(Rel.RULE_FLAGS) do
        local bits = (flags >> ((i - 1) * 2)) & 3
        if bits == 1 then r[name] = true elseif bits == 0 then r[name] = false end
    end
    local o = 5 + 76
    for i = 1, nCond do
        local h, v, t, bl = unpack('<I4fBB', bytes, o)
        r.conditions[i] = { name = h, value = v, type = t, bankLoading = bl }
        o = o + 12
    end
    return r
end

-- ##### sounds.dat54.rel (custom sounds) ##### --

local Snd = {}
JDT.Snd54 = Snd
Snd.VERSION = 7314721
Snd.TYPE = { LoopingSound = 1, SimpleSound = 12, SoundSet = 32 }

-- header field order: bit -> { pack code, key }
local HDR = {
    [0] = { 'I4', 'flags2' }, { 'I2', 'maxHeaderSize' }, { 'i2', 'volume' }, { 'I2', 'volumeVariance' },
    { 'i2', 'pitch' }, { 'I2', 'pitchVariance' }, { 'I2', 'pan' }, { 'I2', 'panVariance' },
    { 'i2', 'preDelay' }, { 'I2', 'preDelayVariance' }, { 'i4', 'startOffset' }, { 'i4', 'startOffsetVariance' },
    { 'I2', 'attackTime' }, { 'I2', 'releaseTime' }, { 'I2', 'dopplerFactor' }, { 'I4', 'category' },
    { 'I2', 'lpf' }, { 'I2', 'lpfVariance' }, { 'I2', 'hpf' }, { 'I2', 'hpfVariance' },
    { 'I4', 'volumeCurve' }, { 'i2', 'volumeCurveScale' }, { 'B', 'volumeCurvePlateau' }, { 'B', 'speakerMask' },
    { 'B', 'effectRoute' }, { 'I4', 'preDelayVariable' }, { 'I4', 'startOffsetVariable' }, { 'I2', 'smallReverb' },
    { 'I2', 'mediumReverb' }, { 'I2', 'largeReverb' }, { 'I2', 'unk25' }, { 'I2', 'unk26' },
}

--- Sound header: flags word (one bit per present field, 0xAAAAAAAA = none) + the present fields.
function Snd.header(h)
    h = h or {}
    local flags, parts = 0, {}
    for bit = 0, 31 do
        local spec = HDR[bit]
        local v = h[spec[2]]
        if v ~= nil then
            flags = flags | (1 << bit)
            if spec[2] == 'category' or spec[2] == 'volumeCurve' or spec[2]:match('Variable$') then v = H(v) end
            parts[#parts + 1] = pack('<' .. spec[1], math.tointeger(v) or math.floor(v))
        end
    end
    if flags == 0 then return pack('<I4', 0xAAAAAAAA) end
    return pack('<I4', flags) .. table.concat(parts)
end

--[[
    items: { kind = 'SimpleSound', name, header = { volume = mB, category = 'scripted' }, container = 'dir/awc', wave = 'name' }
           { kind = 'SoundSet', name, header?, sounds = { { script = 'name', sound = 'child' } } }
           { kind = 'LoopingSound', name, header?, child = 'sound', count = -1 }
    containers: { 'dir\awc' } (name table, backslashes as CodeWalker writes them)
]]
function Snd.build(items, containers, version)
    local data = { pack('<I4', version or Snd.VERSION) }
    local pos = 4
    local entries, ht, pt = {}, {}, {}
    for _, it in ipairs(items) do
        local hdr = Snd.header(it.header)
        local base = 8 + pos + 1 + #hdr -- file offset of the first byte after the header
        local body
        if it.kind == 'SimpleSound' then
            body = pack('<I4I4B', H(it.container), H(it.wave), it.slot or 0)
            pt[#pt + 1] = base
        elseif it.kind == 'SoundSet' then
            local list = {}
            for _, s in ipairs(it.sounds) do list[#list + 1] = { H(s.script), H(s.sound) } end
            table.sort(list, function(a, b) return a[1] < b[1] end)
            local b = { pack('<i4', #list) }
            for i, s in ipairs(list) do
                b[#b + 1] = pack('<I4I4', s[1], s[2])
                ht[#ht + 1] = base + 8 + (i - 1) * 8
            end
            body = table.concat(b)
        elseif it.kind == 'LoopingSound' then
            body = pack('<i2i2i2I4I4', it.count or -1, it.countVariance or 0, it.loopPoint or 0, H(it.child), H(it.countVariable))
            ht[#ht + 1] = base + 6
        else
            error('unknown dat54 item kind: ' .. tostring(it.kind))
        end
        local bytes = string.char(Snd.TYPE[it.kind]) .. hdr .. body
        entries[#entries + 1] = { hash = H(it.name), offset = pos, length = #bytes }
        data[#data + 1] = bytes
        pos = pos + #bytes
    end
    local block = table.concat(data)
    table.sort(entries, function(a, b) return rot8(a.hash) < rot8(b.hash) end)

    local ntLen = 4 + 4 * #containers
    for _, c in ipairs(containers) do ntLen = ntLen + #c + 1 end
    local out = { pack('<I4I4', 54, #block), block, pack('<I4I4', ntLen, #containers) }
    local off = 0
    for _, c in ipairs(containers) do out[#out + 1] = pack('<I4', off); off = off + #c + 1 end
    for _, c in ipairs(containers) do out[#out + 1] = c .. '\0' end
    out[#out + 1] = pack('<I4', #entries)
    for _, e in ipairs(entries) do out[#out + 1] = pack('<I4I4I4', e.hash, e.offset, e.length) end
    out[#out + 1] = pack('<I4', #ht)
    for _, o in ipairs(ht) do out[#out + 1] = pack('<I4', o) end
    out[#out + 1] = pack('<I4', #pt)
    for _, o in ipairs(pt) do out[#out + 1] = pack('<I4', o) end
    return table.concat(out)
end

function Snd.toXml(items, containers, version)
    local function hs(v)
        if type(v) == 'string' and not v:match('^hash_') then return v end
        return ('hash_%08X'):format(H(v))
    end
    local L = { '<?xml version="1.0" encoding="UTF-8"?>', '<Dat54>', (' <Version value="%d" />'):format(version or Snd.VERSION), ' <ContainerPaths>' }
    for _, c in ipairs(containers) do L[#L + 1] = ('  <Item>%s</Item>'):format(c) end
    L[#L + 1] = ' </ContainerPaths>'
    L[#L + 1] = ' <Items>'
    for _, it in ipairs(items) do
        L[#L + 1] = ('  <Item type="%s">'):format(it.kind)
        L[#L + 1] = ('   <Name>%s</Name>'):format(hs(it.name))
        L[#L + 1] = '   <Header>'
        local h = it.header or {}
        local flags = 0
        for bit = 0, 31 do if h[HDR[bit][2]] ~= nil then flags = flags | (1 << bit) end end
        L[#L + 1] = ('    <Flags value="0x%08X" />'):format(flags == 0 and 0xAAAAAAAA or flags)
        if h.volume then L[#L + 1] = ('    <Volume value="%d" />'):format(h.volume) end
        if h.category then L[#L + 1] = ('    <Category>%s</Category>'):format(hs(h.category)) end
        L[#L + 1] = '   </Header>'
        if it.kind == 'SimpleSound' then
            L[#L + 1] = ('   <ContainerName>%s</ContainerName>'):format(it.container)
            L[#L + 1] = ('   <FileName>%s</FileName>'):format(hs(it.wave))
            L[#L + 1] = ('   <WaveSlotNum value="%d" />'):format(it.slot or 0)
        elseif it.kind == 'SoundSet' then
            L[#L + 1] = '   <SoundSets>'
            for _, s in ipairs(it.sounds) do
                L[#L + 1] = ('    <Item><ScriptName>%s</ScriptName><ChildSound>%s</ChildSound></Item>'):format(hs(s.script), hs(s.sound))
            end
            L[#L + 1] = '   </SoundSets>'
        elseif it.kind == 'LoopingSound' then
            L[#L + 1] = ('   <LoopCount value="%d" />'):format(it.count or -1)
            L[#L + 1] = ('   <LoopCountVariance value="%d" />'):format(it.countVariance or 0)
            L[#L + 1] = ('   <LoopPoint value="%d" />'):format(it.loopPoint or 0)
            L[#L + 1] = ('   <ChildSound>%s</ChildSound>'):format(hs(it.child))
            L[#L + 1] = '   <LoopCountVariable />'
        end
        L[#L + 1] = '  </Item>'
    end
    L[#L + 1] = ' </Items>'
    L[#L + 1] = '</Dat54>'
    return table.concat(L, '\n') .. '\n'
end

-- ##### Occlusion .ymt (PSO) ##### --

local Pso = {}
JDT.Pso = Pso

local H_ROOT, H_PORTAL, H_ENTITY, H_NODE, H_CHILD = 0xDE5DB4C2, 0x811C03CF, 0xF6624EF9, 0x771E3577, 0x892CF74F
local SCHEMA = {
    [H_ENTITY] = '0000000500000010000000006c0eb7bf0600000000000000b4e6530e0700000400000000e367400506000008000000001c4929eb0000000c000000003f33caad0000000d00000000',
    [H_PORTAL] = '000000070000002800000000df6b30ef06000000000000003f4807570500000400000000baf48c550500000800000000036d70200600000c000000003d535eda0500001000000000000001000c000000f6624ef9bef8bc2c0d00001800000005',
    [H_CHILD]  = '000000020000000800000000a23cde7b060000000000000040a50f770500000400000000',
    [H_NODE]   = '0000000300000018000000006098a50e0600000000000000000001000c000000892cf74fd27114dc0d00000800000001',
    [H_ROOT]   = '000000040000002000000000000001000c000000811c03cfb7e5d57c0d00000000000000000001000c000000771e3577441599890d00001000000002',
}
local function unhex(h) return (h:gsub('..', function(c) return string.char(tonumber(c, 16)) end)) end
for k, v in pairs(SCHEMA) do SCHEMA[k] = unhex(v) end

--[[
    data = {
        portals = { { proxy, portalIdx, roomIdx, destProxy, destRoomIdx, entities = { { linkType, maxOcclusion, model, isDoor, isGlass } } } },
        nodes   = { { key, children = { { key, portalInfoIdx } } } },
    }
]]
function Pso.build(data)
    local order = { H_ENTITY, H_PORTAL, H_CHILD, H_NODE, H_ROOT }
    local blocks = {}
    for _, h in ipairs(order) do blocks[h] = { parts = {}, size = 0 } end
    local schemaOrder, seen = {}, {}
    local function touched(h) if not seen[h] then seen[h] = true; schemaOrder[#schemaOrder + 1] = h end end
    local function add(h, bytes)
        local b = blocks[h]
        local off = b.size
        b.parts[#b.parts + 1] = bytes
        b.size = b.size + #bytes
        return off
    end
    local function arr(h, off, count) return { h = h, off = off, count = count } end

    local portalItems = {}
    for _, p in ipairs(data.portals) do
        local entArr
        if #p.entities > 0 then
            local chunk = {}
            for _, e in ipairs(p.entities) do
                chunk[#chunk + 1] = pack('>I4fI4BBI2', e.linkType or 1, e.maxOcclusion or 0.7, u32(e.model), e.isDoor and 1 or 0, e.isGlass and 1 or 0, 0)
                touched(H_ENTITY)
            end
            entArr = arr(H_ENTITY, add(H_ENTITY, table.concat(chunk)), #p.entities)
        end
        portalItems[#portalItems + 1] = { head = pack('>I4i4i4I4i4I4', u32(p.proxy), p.portalIdx, p.roomIdx, u32(p.destProxy), p.destRoomIdx, 0), arr = entArr }
        touched(H_PORTAL)
    end
    local portalArr
    if #portalItems > 0 then portalArr = arr(H_PORTAL, blocks[H_PORTAL].size, #portalItems) end

    local nodeItems = {}
    for _, n in ipairs(data.nodes) do
        local chArr
        if #n.children > 0 then
            local chunk = {}
            for _, c in ipairs(n.children) do
                chunk[#chunk + 1] = pack('>I4i4', u32(c.key), c.portalInfoIdx)
                touched(H_CHILD)
            end
            chArr = arr(H_CHILD, add(H_CHILD, table.concat(chunk)), #n.children)
        end
        nodeItems[#nodeItems + 1] = { head = pack('>I4I4', u32(n.key), 0), arr = chArr }
        touched(H_NODE)
    end
    local nodeArr
    if #nodeItems > 0 then nodeArr = arr(H_NODE, blocks[H_NODE].size, #nodeItems) end
    touched(H_ROOT)

    local ids, present = {}, {}
    for _, h in ipairs(order) do
        local needed = (h == H_ROOT) or (h == H_PORTAL and portalArr) or (h == H_NODE and nodeArr) or blocks[h].size > 0
        if needed then present[#present + 1] = h; ids[h] = #present end
    end
    local function arrBytes(a)
        if not a then return string.rep('\0', 16) end
        return pack('>I4I4I2I2I4', (ids[a.h] & 0xFFF) + ((a.off & 0xFFFFF) << 12), 0, a.count, a.count, 0)
    end
    for _, it in ipairs(portalItems) do add(H_PORTAL, it.head .. arrBytes(it.arr)) end
    for _, it in ipairs(nodeItems) do add(H_NODE, it.head .. arrBytes(it.arr)) end
    add(H_ROOT, arrBytes(portalArr) .. arrBytes(nodeArr))

    local body, offsets, off = {}, {}, 16
    for _, h in ipairs(present) do
        offsets[h] = off
        body[#body + 1] = table.concat(blocks[h].parts)
        off = off + blocks[h].size
    end
    local psinData = table.concat(body)
    local psin = pack('>c4I4I4I4', 'PSIN', 16 + #psinData, 0, 0) .. psinData

    local pm = { pack('>c4I4I4I2I2', 'PMAP', 16 + 16 * #present, ids[H_ROOT], #present, 0x7070) }
    for _, h in ipairs(present) do pm[#pm + 1] = pack('>I4I4I4I4', h, offsets[h], 0, blocks[h].size) end
    local pmap = table.concat(pm)

    local idx, blobs, pos = {}, {}, 12 + 8 * #schemaOrder
    for _, h in ipairs(schemaOrder) do
        idx[#idx + 1] = pack('>I4I4', h, pos)
        blobs[#blobs + 1] = SCHEMA[h]
        pos = pos + #SCHEMA[h]
    end
    local psch = pack('>c4I4I4', 'PSCH', pos, #schemaOrder) .. table.concat(idx) .. table.concat(blobs)

    return psin .. pmap .. psch
end

--- Reads a PSO written by Pso.build back into the same data shape (tests / inspection).
function Pso.read(bin)
    local tag, psinLen = unpack('>c4I4', bin, 1)
    assert(tag == 'PSIN', 'not a PSO file')
    local pmPos = psinLen + 1
    local ptag, _, rootId, count = unpack('>c4I4I4I2', bin, pmPos)
    assert(ptag == 'PMAP', 'missing PMAP')
    local blocks = {}
    for i = 1, count do
        local h, offset, _, size = unpack('>I4I4I4I4', bin, pmPos + 16 + (i - 1) * 16)
        blocks[i] = { hash = h, offset = offset, size = size }
    end
    local function ptr(raw)
        local id = raw & 0xFFF
        local off = raw >> 12
        return blocks[id], off
    end
    local function arrAt(pos)
        local raw, _, c = unpack('>I4I4I2', bin, pos)
        if c == 0 then return nil, 0 end
        local b, off = ptr(raw)
        return 1 + b.offset + off, c
    end
    local root = blocks[rootId]
    local rootPos = 1 + root.offset + root.size - 32
    local data = { portals = {}, nodes = {} }

    local pPos, pCount = arrAt(rootPos)
    for i = 0, (pCount or 0) - 1 do
        local base = pPos + i * 40
        local proxy, portalIdx, roomIdx, destProxy, destRoomIdx = unpack('>I4i4i4I4i4', bin, base)
        local p = { proxy = proxy, portalIdx = portalIdx, roomIdx = roomIdx, destProxy = destProxy, destRoomIdx = destRoomIdx, entities = {} }
        local ePos, eCount = arrAt(base + 24)
        for j = 0, (eCount or 0) - 1 do
            local lt, mo, model, door, glass = unpack('>I4fI4BB', bin, ePos + j * 16)
            p.entities[#p.entities + 1] = { linkType = lt, maxOcclusion = mo, model = model, isDoor = door == 1, isGlass = glass == 1 }
        end
        data.portals[#data.portals + 1] = p
    end

    local nPos, nCount = arrAt(rootPos + 16)
    for i = 0, (nCount or 0) - 1 do
        local base = nPos + i * 24
        local key = unpack('>I4', bin, base)
        local n = { key = key, children = {} }
        local cPos, cCount = arrAt(base + 8)
        for j = 0, (cCount or 0) - 1 do
            local ck, pi = unpack('>I4i4', bin, cPos + j * 8)
            n.children[#n.children + 1] = { key = ck, portalInfoIdx = pi }
        end
        data.nodes[#data.nodes + 1] = n
    end
    return data
end

return { Rel = Rel, Pso = Pso }
