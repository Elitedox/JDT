--[[
    Client entry point: one key opens the panel (anywhere), NUI bridge, exports.
]]

local Lib, Hash, Model, Encoders, Validate, Scanner, Rpc, Draw, Player, Preview, Editor, AudioBuild =
    JDT.Lib, JDT.Hash, JDT.Model, JDT.Encoders, JDT.Validate, JDT.Scanner, JDT.Rpc, JDT.DebugDraw,
    JDT.Player, JDT.Preview, JDT.Editor, JDT.AudioBuild

Lib.loadLocales()

---@type table<string, table> uintNameHash -> interior
local cache = {}
local doorSpots = {}         -- uintNameHash -> { [u32 model] = pos } (where to test each door)
local current = nil          -- interior open in the panel (nil outside an interior)
local panelOpen = false
local freeMove = false
local autoSaveAt = 0
local soundCheck = nil       -- last shared sound check result

-- ##### Helpers ##### --

local function nui(action, data)
    SendNUIMessage({ action = action, data = data })
end

local function notify(kind, title, text)
    if type(Config.Notify) == 'function' then
        local ok, handled = pcall(Config.Notify, kind, title, text)
        if ok and handled then return end
    end
    nui('toast', { kind = kind, title = title, text = text })
end
JDT.notify = notify

RegisterNetEvent('jdt:notify', function(kind, title, text) notify(kind, title, text) end)

local function cacheKey(nameHash)
    return tostring(Hash.toUInt32(math.tointeger(nameHash) or 0))
end

local function elementList()
    local out = {}
    for _, e in pairs(JDT.Elements) do out[#out + 1] = e end
    table.sort(out, function(a, b) return a.id < b.id end)
    return out
end

local function customIndex()
    local idx = {}
    for _, list in pairs(JDT.CustomSounds or {}) do
        for _, s in ipairs(list) do idx[s.name:lower()] = s.bank end
    end
    return idx
end

local function analysis(interior)
    local opts = { maxPathDistance = Config.Output.maxPathDistance, elements = elementList(), custom = customIndex() }
    return {
        issues = Validate.run(interior, opts),
        summary = Validate.summary(interior, opts),
        archetypeMatch = Model.archetypeNameMatches(interior),
        ymtName = Encoders.ymtName(interior),
        relName = AudioBuild.paths(interior.group).rel,
        listName = AudioBuild.listName(interior.group),
    }
end

local function spotsFor(interior)
    local key = cacheKey(interior.nameHash)
    local spots = {}
    for k, pos in pairs(doorSpots[key] or {}) do spots[k] = pos end
    for _, p in ipairs(interior.portals) do
        for _, e in ipairs(p.entities) do
            local k = tostring(Hash.toUInt32(e.modelHashKey))
            if e.position and not spots[k] then spots[k] = e.position end
        end
    end
    return spots
end

local function payload(interior)
    if not interior then return { interior = false } end
    return {
        interior = Model.toSaveData(interior), analysis = analysis(interior),
        interiorId = interior.interiorId, doorSpots = spotsFor(interior),
    }
end

local function currentInteriorId()
    local id = GetInteriorFromEntity(PlayerPedId())
    if id ~= 0 and IsValidInterior(id) then return id end
    return 0
end

local function rememberDoors(interiorId, detected)
    local _, nameHash = GetInteriorLocationAndNamehash(interiorId)
    local spots = {}
    for _, d in ipairs(detected or {}) do spots[tostring(d.hash)] = d.pos end
    doorSpots[cacheKey(nameHash)] = spots
end

local function save(interior, silent)
    local res = Rpc.call('save', Model.toSaveData(interior), silent)
    if res and res.saveName then interior.saveName = res.saveName end
    return res
end

local function adoptLoaded(data, interiorId)
    local ok, interior = pcall(Model.migrate, data)
    if not ok then
        notify('error', locale('data_generation_fail'), tostring(interior))
        return nil
    end
    interior.interiorId = interiorId

    local _, nameHash = GetInteriorLocationAndNamehash(interiorId)
    if Hash.toInt32(nameHash) ~= interior.nameHash then
        notify('error', locale('load_wrong_interior'), interior.saveName)
        return nil
    end

    if not Scanner.refreshGeometry(interior, interiorId) then
        notify('warning', locale('warning'), locale('layout_changed'))
    end
    local detected = Scanner.detectDoors(interiorId)
    rememberDoors(interiorId, detected)
    if (next(interior.doors) == nil) then Model.syncDoors(interior, detected) end

    if interior.migratedFrom then
        notify('info', locale('migrated_title'), locale('migrated_text', interior.migratedFrom))
    end
    return interior
end

local function build(interiorId)
    local interior = Scanner.build(interiorId)
    rememberDoors(interiorId, Scanner.detectDoors(interiorId))
    return interior
end

--- Cached, saved or freshly scanned data for the interior the player stands in.
local function resolveInterior(interiorId, mode)
    local _, nameHash = GetInteriorLocationAndNamehash(interiorId)
    local key = cacheKey(nameHash)

    if mode == 'rebuild' then
        cache[key] = build(interiorId)
        return cache[key]
    end

    if mode ~= 'reload' and cache[key] then
        cache[key].interiorId = interiorId
        return cache[key]
    end

    if mode == 'reload' or Config.Open.autoLoadSaved then
        local data = Rpc.call('load', nameHash)
        if data then
            local interior = adoptLoaded(data, interiorId)
            if interior then
                cache[key] = interior
                return interior
            end
        elseif mode == 'reload' then
            notify('warning', locale('warning'), locale('no_filename_name_hash', Hash.hex(nameHash)))
        end
    end

    if cache[key] then return cache[key] end
    cache[key] = build(interiorId)
    return cache[key]
end

-- ##### Open / close ##### --

local function setFreeMove(on)
    freeMove = on and true or false
    SetNuiFocusKeepInput(freeMove)
end

local function hidePanel()
    panelOpen = false
    setFreeMove(false)
    SetNuiFocus(false, false)
    nui('panel', { visible = false })
end

local function closeAll(edits)
    if Editor.isAiming() then Editor.stopAiming(true) end
    if panelOpen then hidePanel() end
    nui('close')
    JDT.focusElement = nil
    Editor.setMarkers(false)
    Preview.stopAll()
    for id in pairs(Player.edit) do Player.endEdit(id) end

    if current and edits then Model.applyEdits(current, edits) end
    if current and Config.Storage.autoSaveOnClose then
        local interior = current
        CreateThread(function() save(interior, true) end)
    end
end

local function showPanel(extra)
    panelOpen = true
    SetNuiFocus(true, true)
    Editor.setMarkers(true)
    local data = payload(current)
    data.visible = true
    data.elements = elementList()
    data.group = Editor.getGroup()
    data.range = Editor.getRange()
    data.previews = Preview.list()
    data.exportStatus = JDT.ExportStatus
    data.customSounds = JDT.CustomSounds
    data.doorSamples = JDT.DoorSamples
    data.debug = Draw.getState()
    for k, v in pairs(extra or {}) do data[k] = v end
    nui('panel', data)
    if soundCheck then nui('soundCheck', soundCheck) end
end

local function open(mode)
    if panelOpen then return nui('requestClose') end -- the UI answers with its edits
    if Editor.isAiming() then
        Editor.stopAiming(true)
        return showPanel()
    end
    if IsNuiFocused() then return notify('error', locale('nui_already_focused')) end

    local interiorId = currentInteriorId()
    local roomIndex = -1
    if interiorId ~= 0 then
        local interior = resolveInterior(interiorId, mode)
        if interior then
            current = interior
            Draw.setInterior(current)
            Editor.defaultGroupFor(current.group)
            roomIndex = Config.Open.focusCurrentRoom and Scanner.currentRoomIndex(interiorId) or -1
        end
    else
        current = nil
        Draw.setInterior(nil)
        Editor.defaultGroupFor(nil)
    end

    autoSaveAt = GetGameTimer() + (Config.Storage.autoSaveIntervalMinutes or 0) * 60000
    showPanel({ roomIndex = roomIndex, opened = true })
end

JDT.openPanel = function() showPanel() end
JDT.openEdit = function(id) showPanel({ editId = id }) end
JDT.onAimEnd = function() showPanel() end

-- live pushes
local elementsDirty = false
JDT.onElementsChanged = function()
    if elementsDirty then return end
    elementsDirty = true
    SetTimeout(150, function()
        elementsDirty = false
        if panelOpen then nui('elements', elementList()) end
    end)
end
JDT.onPreviewChanged = function(list) nui('previews', list) end
JDT.onExportStatus = function(status) nui('exportStatus', status) end
JDT.onSoundFailed = function(name, set) nui('soundFailed', { name = name, set = set }) end

RegisterNetEvent('jdt:soundCheck', function(c)
    soundCheck = c
    nui('soundCheck', c)
end)

-- ##### Open / close: bound in client/keybinds.lua (players change the key in Settings > Keybinds) ##### --

JDT.togglePanel = function() CreateThread(function() open() end) end

-- the panel's accent colour (Settings > Accent): in-world drawings follow it
-- in-world accent until the panel sends the player's own: Config.UI.accent ('#rrggbb')
JDT.accent = { 88, 201, 139 }
do
    local hex = tostring(Config.UI and Config.UI.accent or ''):match('^#?(%x%x%x%x%x%x)$')
    if hex then JDT.accent = { tonumber(hex:sub(1, 2), 16), tonumber(hex:sub(3, 4), 16), tonumber(hex:sub(5, 6), 16) } end
end
RegisterNUICallback('jdt:ui:accent', function(d, respond)
    local c = type(d) == 'table' and d.rgb
    if type(c) == 'table' then
        for i = 1, 3 do JDT.accent[i] = math.floor(Lib.clamp(tonumber(c[i]) or JDT.accent[i], 0, 255)) end
    end
    respond({ ok = true })
end)

if Config.Commands and Config.Commands.enabled then
    RegisterCommand(Config.Commands.open, function(_, args)
        local mode = args[1]
        if mode == '1' then mode = 'reload' elseif mode == '2' then mode = 'rebuild' end
        CreateThread(function() open(mode) end)
    end, false)

    RegisterCommand(Config.Commands.save, function(_, args)
        CreateThread(function()
            local id = currentInteriorId()
            if id == 0 then return notify('error', locale('unrecognized_interior')) end
            local interior = resolveInterior(id)
            if args[1] then interior.saveName = Lib.sanitizeFilename(args[1]) or interior.saveName end
            save(interior)
        end)
    end, false)
end

-- ##### Background: auto-save, free-move input blocking ##### --

CreateThread(function()
    while true do
        local sleep = 1000

        if panelOpen then
            if freeMove and Config.UI.blockAttackWhileOpen then
                sleep = 0
                for _, control in ipairs({ 24, 25, 37, 44, 45, 140, 141, 142, 143, 257, 263, 264 }) do
                    DisableControlAction(0, control, true)
                end
                DisablePlayerFiring(PlayerId(), true)
            end

            local interval = Config.Storage.autoSaveIntervalMinutes or 0
            if interval > 0 and current and GetGameTimer() > autoSaveAt then
                autoSaveAt = GetGameTimer() + interval * 60000
                nui('requestSync')
            end
        end

        Wait(sleep)
    end
end)

-- ##### NUI callbacks ##### --

local function cb(name, fn)
    RegisterNUICallback('jdt:' .. name, function(data, respond)
        local ok, result = pcall(fn, data or {})
        if not ok then
            Lib.print.error('NUI %s failed: %s', name, tostring(result))
            notify('error', locale('error'), tostring(result))
            return respond({ ok = false, error = tostring(result) })
        end
        respond(result == nil and { ok = true } or result)
    end)
end

local function withEdits(data)
    if current and data.edits then Model.applyEdits(current, data.edits) end
end

cb('ready', function()
    return {
        locales = Lib.allLocales(),
        presets = Config.RoomPresets,
        ui = Config.UI,
        player = Config.Player and Config.Player.enabled ~= false or false,
        output = {
            xml = Config.Output.xml, comments = Config.Output.debugComments, install = Config.Output.install,
            maxPathDistance = Config.Output.maxPathDistance,
        },
        place = { defaultRange = Config.Place.defaultRange, defaultGroup = Config.Place.defaultGroup },
        openKey = Config.Open.key,
        keybinds = JDT.Keybinds and JDT.Keybinds.list() or nil,
        outsideTab = Config.Open.outsideTab,
        version = Lib.version,
        fields = Model.DAT151_FIELDS,
        doorSounds = JDT.Doors.SOUNDS,
        doorCustomSounds = JDT.Doors.CUSTOM_SOUNDS,
        doorTunings = JDT.Doors.TUNINGS,
        resource = Lib.resourceName,
        sounds = {
            maxUploadMB = Config.Sounds.maxUploadMB, sampleRate = Config.Sounds.sampleRate,
            codec = Config.Sounds.codec, category = Config.Sounds.category, normalize = Config.Sounds.normalize,
        },
        nativeZones = Config.Output.nativeZones ~= false,
        inspect = { pollMs = Config.Inspect and Config.Inspect.pollMs or 500 },
    }
end)

cb('close', function(data) closeAll(data.edits) end)

cb('freeMove', function(data) setFreeMove(data.enabled == true) end)

-- Interior project

cb('sync', function(data)
    if not current then return { interior = false } end
    withEdits(data)
    if data.autosave then CreateThread(function() save(current, true) end) end
    return payload(current)
end)

cb('save', function(data)
    if not current then return { ok = false } end
    withEdits(data)
    local res = save(current)
    return { ok = res ~= nil and res ~= false, result = res, data = payload(current) }
end)

cb('reload', function()
    local id = currentInteriorId()
    if id == 0 then return { ok = false } end
    local interior = resolveInterior(id, 'reload')
    if interior then current = interior Draw.setInterior(current) end
    return payload(current)
end)

cb('rebuild', function(data)
    local id = currentInteriorId()
    if id == 0 then return { ok = false } end
    if data.keepSettings and current then
        local old = current
        current = Scanner.rescanKeepSettings(old, id)
        current.doors = old.doors
        current.group, current.output = old.group, old.output
        rememberDoors(id, Scanner.detectDoors(id))
        cache[cacheKey(current.nameHash)] = current
    else
        current = resolveInterior(id, 'rebuild')
    end
    Draw.setInterior(current)
    notify('success', locale('rebuilt'))
    return payload(current)
end)

cb('listSaves', function()
    return { ok = true, list = Rpc.call('list') or {} }
end)

cb('loadSave', function(data)
    local id = currentInteriorId()
    if id == 0 then return { ok = false } end
    local saved = Rpc.call('loadFile', data.file)
    if not saved then return { ok = false } end
    local interior = adoptLoaded(saved, id)
    if not interior then return { ok = false } end
    current = interior
    cache[cacheKey(interior.nameHash)] = interior
    Draw.setInterior(current)
    notify('success', locale('loaded_save'), data.file)
    return payload(current)
end)

cb('importJson', function(data)
    local id = currentInteriorId()
    if id == 0 then return { ok = false } end
    local ok, decoded = pcall(json.decode, data.text or '')
    if not ok or type(decoded) ~= 'table' then
        notify('error', locale('import_invalid'))
        return { ok = false }
    end
    local interior = adoptLoaded(decoded, id)
    if not interior then return { ok = false } end
    current = interior
    cache[cacheKey(interior.nameHash)] = interior
    Draw.setInterior(current)
    notify('success', locale('imported'))
    return payload(current)
end)

cb('exportJson', function(data)
    if not current then return { ok = false } end
    withEdits(data)
    return { ok = true, text = json.encode(Model.toSaveData(current), { indent = true, sort_keys = true }) }
end)

--- Reads the audio an MLO resource already ships and applies it to the open project.
cb('importFrom', function(data)
    if not current then return { ok = false } end
    withEdits(data)
    local res = Rpc.call('importFrom', data.resource, Model.toSaveData(current))
    if not res or not res.ok then
        notify('error', locale('import_failed'), res and res.error or '')
        return { ok = false }
    end
    local p = res.patch
    if p.settings then
        for k, v in pairs(p.settings) do current.settings[k] = v end
    end
    for idx, dat in pairs(p.rooms or {}) do
        local room = current.rooms[(tonumber(idx) or -1) + 1]
        if room then
            room.dat151 = Model.sanitizeDat151(dat, room.dat151)
            room.preset = nil
        end
    end
    for k, d in pairs(p.doors or {}) do current.doors[tostring(k)] = d end
    for pi, ents in pairs(p.entities or {}) do
        local portal = current.portals[(tonumber(pi) or -1) + 1]
        for ei, v in pairs(portal and ents or {}) do
            local e = portal.entities[(tonumber(ei) or -1) + 1]
            if e then
                e.maxOcclusion = Lib.clamp(tonumber(v.maxOcclusion) or e.maxOcclusion, 0.0, 1.0)
                e.isDoor, e.isGlass = v.isDoor == true, v.isGlass == true
            end
        end
    end
    Model.computeHashes(current)
    Model.computeTopology(current)
    -- ambient zones become placed zones (rooms that used them point at the new elements)
    local zonesMade = 0
    for _, z in ipairs(p.zones or {}) do
        local el = z.element
        el.group = current.group
        el.interiorHash = current.nameHash
        local saved = Rpc.call('elementSave', el)
        if saved and saved.id then
            zonesMade = zonesMade + 1
            for _, idx in ipairs(z.rooms or {}) do
                local room = current.rooms[(tonumber(idx) or -1) + 1]
                if room then room.dat151.ambientZone = 'zone:' .. saved.id end
            end
        end
    end
    local c = p.counts or {}
    if (c.rooms or 0) + (c.doors or 0) + (c.entities or 0) + zonesMade == 0 then
        notify('warning', locale('import_nothing', data.resource))
    else
        notify('success', locale('import_done', c.rooms or 0, c.doors or 0, c.entities or 0), table.concat(p.files or {}, ', '))
        if zonesMade > 0 then notify('success', locale('import_zones', zonesMade)) end
    end
    local out = payload(current)
    out.importNotes = p.notes
    return out
end)

cb('applyPreset', function(data)
    if not current then return { ok = false } end
    withEdits(data)
    local n = Model.applyPreset(current, data.preset, data.rooms or {})
    notify('success', locale('preset_applied', n))
    return payload(current)
end)

cb('copyRoom', function(data)
    if not current then return { ok = false } end
    withEdits(data)
    local n = Model.copyRoomSettings(current, data.from, data.to or {})
    notify('success', locale('room_copied', n))
    return payload(current)
end)

cb('resetRoom', function(data)
    if not current then return { ok = false } end
    withEdits(data)
    for _, idx in ipairs(data.rooms or {}) do
        local room = current.rooms[idx + 1]
        if room then
            local keep = room.dat151.occlRoomName
            room.dat151 = Model.defaultDat151()
            room.dat151.occlRoomName = keep
            room.preset = nil
        end
    end
    return payload(current)
end)

cb('autoDetect', function(data)
    if not current then return { ok = false } end
    withEdits(data)
    local n = Model.autoDetectEntities(current, data.portal)
    Model.syncDoors(current)
    notify('success', locale('auto_detected', n))
    return payload(current)
end)

cb('bulkEntities', function(data)
    if not current then return { ok = false } end
    withEdits(data)
    local n = 0
    for _, portal in ipairs(current.portals) do
        for _, e in ipairs(portal.entities) do
            local match = data.filter == 'all'
                or (data.filter == 'doors' and e.isDoor)
                or (data.filter == 'glass' and e.isGlass)
                or (data.filter == 'other' and not e.isDoor and not e.isGlass)
            if match then
                e.maxOcclusion = Lib.clamp(tonumber(data.maxOcclusion) or e.maxOcclusion, 0.0, 1.0)
                n = n + 1
            end
        end
    end
    notify('success', locale('bulk_applied', n))
    return payload(current)
end)

cb('setAllPortals', function(data)
    if not current then return { ok = false } end
    withEdits(data)
    for _, portal in ipairs(current.portals) do
        portal.isEnabled = { data.enabled == true, data.enabled == true }
    end
    Model.computeTopology(current)
    return payload(current)
end)

cb('preview', function(data)
    if not current then return { ok = false } end
    withEdits(data)
    local opts = { comments = data.comments == true, maxPathDistance = Config.Output.maxPathDistance }
    local text
    if data.kind == 'dat151' then
        local mine = {}
        for _, e in ipairs(elementList()) do if e.group == current.group and not e.pack then mine[#mine + 1] = e end end
        text = JDT.Rel.toXml((AudioBuild.relItems(current.group, { current }, mine)))
    elseif data.kind == 'manifest' then
        local mine = {}
        for _, e in ipairs(elementList()) do if e.group == current.group and not e.pack then mine[#mine + 1] = e end end
        local sounds = {}
        for _, s in ipairs((JDT.CustomSounds or {})[current.group] or {}) do sounds[#sounds + 1] = { key = s.key, pcm = true } end
        local pkg = AudioBuild.package(current.group, { current }, mine, { xml = false, noBinary = true, sounds = sounds,
            encodeJson = json.encode, playerTemplate = '', customIndex = customIndex() })
        for _, f in ipairs(pkg.files) do if f.path == 'fxmanifest.lua' then text = f.content end end
    else
        text = Encoders.ymt(current, opts)
    end
    return { ok = true, text = text }
end)

-- Doors

cb('doorTest', function(data)
    if not current then return { ok = false } end
    local spots = spotsFor(current)
    local pos = spots[tostring(data.key)]
    if not pos then
        notify('warning', locale('door_not_found'))
        return { ok = false }
    end
    local door = current.doors[tostring(data.key)]
    Preview.start({ type = 'door', model = tonumber(data.key), pos = pos, label = door and door.model or tostring(data.key) })
    return { ok = true }
end)

cb('doorDetect', function(data)
    if not current then return { ok = false } end
    local spots = spotsFor(current)
    local pos = spots[tostring(data.key)]
    if not pos then return { ok = false } end
    local res = Scanner.cycleDoor(tonumber(data.key), pos)
    if res.kind then
        local door = current.doors[tostring(data.key)]
        if door then
            door.kind, door.how = res.kind, 'probed'
            door.preset = JDT.Doors.presetFor(res.kind, door.model)
        end
    end
    local out = payload(current)
    out.detected = res.kind
    return out
end)

cb('doorAimed', function(data)
    if not current then return { ok = false } end
    withEdits(data)
    local cam = GetGameplayCamCoord()
    local rot = GetGameplayCamRot(2)
    local rz, rx = math.rad(rot.z), math.rad(rot.x)
    local n = math.abs(math.cos(rx))
    local dir = vector3(-math.sin(rz) * n, math.cos(rz) * n, math.sin(rx))
    local dest = cam + dir * 15.0
    local h = StartExpensiveSynchronousShapeTestLosProbe(cam.x, cam.y, cam.z, dest.x, dest.y, dest.z, 16, PlayerPedId(), 7)
    local _, hit, _, _, ent = GetShapeTestResult(h)
    if not (hit == true or hit == 1) or not ent or ent == 0 or GetEntityType(ent) ~= 3 then
        notify('warning', locale('door_aim_first'))
        return { ok = false }
    end
    local u = Hash.toUInt32(GetEntityModel(ent))
    local name = Lib.archetypeName(ent)
    local c = GetEntityCoords(ent)
    local model = (name and name ~= '') and name or ('0x' .. Hash.hex(u))
    current.doors[tostring(u)] = current.doors[tostring(u)] or JDT.Doors.guess(model)
    local spots = doorSpots[cacheKey(current.nameHash)] or {}
    spots[tostring(u)] = { x = c.x, y = c.y, z = c.z }
    doorSpots[cacheKey(current.nameHash)] = spots
    notify('success', locale('door_added'), model)
    return payload(current)
end)

-- Previews ("Now playing")

local function playerPos()
    local c = GetEntityCoords(PlayerPedId())
    return { x = c.x, y = c.y, z = c.z + 0.5 }
end

cb('playerPos', function() return playerPos() end)

cb('preview:start', function(data)
    local pid = Preview.start(data, data.pos or playerPos())
    if data.loop and pid then Preview.loop(pid, true) end
    return { ok = pid ~= nil, id = pid }
end)
cb('preview:toggle', function(data) Preview.toggle(tonumber(data.id)) end)
cb('preview:stop', function(data) Preview.stop(tonumber(data.id)) end)
cb('preview:stopAll', function() Preview.stopAll() end)

-- Placed elements (live)

cb('element:save', function(data)
    local res = Rpc.call('elementSave', data.element)
    return { ok = res ~= nil and res ~= false, element = res }
end)
cb('element:delete', function(data)
    return { ok = Rpc.call('elementDelete', data.id) == true }
end)
cb('element:live', function(data)
    if data.element and data.element.id and JDT.Elements[data.element.id] then
        Player.setEdit(data.element.id, data.element)
        JDT.focusElement = data.element.id
    end
end)
cb('element:endLive', function(data)
    if data.id then Player.endEdit(data.id) end
    JDT.focusElement = nil
end)
cb('element:toggle', function(data)
    local state = data.state
    if state == 'default' then state = nil end
    Player.setOverride(data.id, state)
    return { active = Player.activeIds() }
end)
cb('element:solo', function(data)
    Player.solo = data.id
    for id in pairs(JDT.Elements) do Player.reset(id) end
    return { active = Player.activeIds() }
end)
cb('element:muteAll', function(data)
    Player.muted = data.on == true
    for id in pairs(JDT.Elements) do Player.reset(id) end
    return { active = Player.activeIds() }
end)
cb('element:focus', function(data) JDT.focusElement = data.id end)
cb('element:active', function()
    local zones = {}
    for id, e in pairs(JDT.Elements) do
        if e.type == 'zone' then zones[id] = Player.zoneState(id) end
    end
    return { active = Player.activeIds(), zones = zones }
end)
cb('element:teleport', function(data) Editor.teleport(data.id) end)
cb('element:move', function(data)
    if Editor.startMove(data.id) then hidePanel() end
end)
cb('place', function(data)
    hidePanel()
    Editor.startAiming(data.template)
end)
cb('setGroup', function(data)
    Editor.setGroup(data.group)
    return { group = Editor.getGroup() }
end)
cb('packJson', function(data) return Rpc.call('packJson', data.group) or {} end)

-- Sound check: plays every catalog sound for a split second and keeps the ones that really play

local scanning = false
cb('scan:start', function(data)
    if scanning or type(data.items) ~= 'table' then return { ok = false } end
    scanning = true
    Preview.stopAll()
    CreateThread(function()
        local items, bad, good, batch = data.items, {}, {}, 12
        for i = 1, #items, batch do
            if not scanning then break end
            local p = GetEntityCoords(PlayerPedId())
            local ids = {}
            for j = i, math.min(i + batch - 1, #items) do
                local it = items[j]
                ids[#ids + 1] = { id = Player.playSound(it.n, it.r, p.x, p.y, p.z + 0.5, 15.0), k = it.k }
            end
            Wait(0) Wait(0) Wait(0)
            for _, snd in ipairs(ids) do
                if HasSoundFinished(snd.id) then bad[#bad + 1] = snd.k else good[#good + 1] = snd.k end
                StopSound(snd.id)
                ReleaseSoundId(snd.id)
            end
            nui('scanProgress', { done = math.min(i + batch - 1, #items), total = #items, bad = #bad })
            Wait(60)
        end
        local completed = scanning
        scanning = false
        nui('scanProgress', { done = #items, total = #items, bad = #bad, finished = true, aborted = not completed })
        if completed then Rpc.call('scanResult', bad, good, #items, data.full == true) end
    end)
    return { ok = true }
end)
cb('scan:stop', function() scanning = false end)
cb('scan:hide', function(data) Rpc.call('hideSound', data.key, data.state) end)
cb('scan:reset', function() Rpc.call('resetCheck') end)

-- Export

cb('export', function(data)
    if current then
        withEdits(data)
        if current.group == data.group then save(current, true) end
    end
    local res = Rpc.call('export', data.group, data.options)
    return res or { ok = false }
end)
cb('exportStatus', function() return Rpc.call('exportStatus') or {} end)
cb('resources', function() return { list = Rpc.call('resources') or {} } end)
cb('uninstall', function(data) return { ok = Rpc.call('uninstall', data.group) == true } end)

-- World debug drawing

cb('debug', function(data)
    Draw.update(data)
    return Draw.getState()
end)

cb('debugEntity', function(data)
    Draw.toggleEntity(tonumber(data.portal) or 0, tonumber(data.entity) or 0, data.enabled == true)
    return Draw.getState()
end)

cb('currentRoom', function()
    local id = currentInteriorId()
    return { ok = true, index = Scanner.currentRoomIndex(id) }
end)

cb('teleportPortal', function(data)
    if not Config.UI.allowTeleport or not current then return { ok = false } end
    local portal = current.portals[(tonumber(data.portal) or -1) + 1]
    if not portal or not portal.centroid then return { ok = false } end
    local m = portal.centroid
    return { ok = JDT.Inspect.teleport(m.x, m.y, m.z) }
end)

-- ##### Exports ##### --

exports('open', function(mode) CreateThread(function() open(mode) end) end)
exports('close', function() closeAll() end)
exports('isOpen', function() return panelOpen or Editor.isAiming() end)
exports('getInterior', function() return current and Model.toSaveData(current) end)

AddEventHandler('onResourceStop', function(res)
    if res == Lib.resourceName and (panelOpen or Editor.isAiming()) then
        SetNuiFocus(false, false)
        SetNuiFocusKeepInput(false)
    end
end)
