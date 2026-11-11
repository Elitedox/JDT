--[[
    Server entry point: RPC handlers, exports. No permissions: everyone on the server can use the tool.
]]

local Lib, Model, Storage, Elements, Export, Importer, AudioBuild, Sounds =
    JDT.Lib, JDT.Model, JDT.Storage, JDT.Elements, JDT.Export, JDT.Importer, JDT.AudioBuild, JDT.Sounds

Lib.loadLocales()

local MAX_ROOMS, MAX_PORTALS, MAX_ENTITIES = 256, 1024, 64

local function notify(src, kind, title, text)
    if tonumber(src) and tonumber(src) > 0 then
        TriggerClientEvent('jdt:notify', src, kind, title, text)
    else
        Lib.print.info('%s %s', title, text or '')
    end
end

local function broadcastStatus()
    TriggerClientEvent('jdt:exportStatus', -1, Export.status())
end

-- ##### Validation of client data ##### --

local function validateInterior(data)
    if type(data) ~= 'table' then return nil, 'no data' end
    if type(data.rooms) ~= 'table' or #data.rooms > MAX_ROOMS then return nil, 'too many rooms' end
    if type(data.portals) ~= 'table' or #data.portals > MAX_PORTALS then return nil, 'too many portals' end
    for _, p in ipairs(data.portals) do
        if type(p) ~= 'table' or (p.entities and #p.entities > MAX_ENTITIES) then return nil, 'bad portal' end
    end
    -- migrate() re-derives every hash, index and value range from scratch, never trusting the client
    local ok, interior = pcall(Model.migrate, data)
    if not ok then return nil, tostring(interior) end
    return interior
end

-- ##### RPC ##### --

local handlers = {}

handlers.hello = function(src)
    Elements.broadcastAll(src)
    Elements.sendCheck(src)
    Sounds.broadcast(src)
    return { status = Export.status(), doorSamples = Sounds.doorSamples() }
end

-- Custom sounds

handlers.soundChunk = function(src, uploadId, index, count, data, info)
    local r, err = Sounds.chunk(src, uploadId, index, count, data, info)
    if not r then
        notify(src, 'error', locale('sound_upload_failed'), err)
        return { ok = false, error = err }
    end
    if r.done then notify(src, 'success', locale('sound_uploaded'), ('%s/%s'):format(r.group, r.key)) end
    return { ok = true, done = r.done, key = r.key, group = r.group }
end

handlers.soundUpdate = function(src, group, key, fields)
    local r, err = Sounds.update(tostring(group), tostring(key), fields)
    if not r then return { ok = false, error = err } end
    return { ok = true }
end

handlers.soundDelete = function(src, group, key)
    local ok, err = Sounds.remove(tostring(group), tostring(key))
    if not ok then return { ok = false, error = err } end
    notify(src, 'success', locale('sound_deleted'), ('%s/%s'):format(group, key))
    return { ok = true }
end

handlers.soundRescan = function(src, groups)
    local n = Sounds.rescan(type(groups) == 'table' and groups or {})
    notify(src, 'success', locale('sound_rescanned', n))
    return { ok = true, added = n }
end

handlers.soundFetch = function(src, group, key, requestId)
    local r, err = Sounds.send(src, tostring(group), tostring(key), requestId)
    if not r then return { ok = false, error = err } end
    return { ok = true, count = r.count }
end

-- Projects (interiors)

handlers.load = function(src, nameHash)
    local interior = Storage.loadFor(nameHash)
    return interior and Model.toSaveData(interior) or false
end

handlers.loadFile = function(src, filename)
    local interior, err = Storage.loadFile(filename)
    if not interior then
        notify(src, 'error', locale('open_file_fail'), tostring(err))
        return false
    end
    return Model.toSaveData(interior)
end

handlers.list = function()
    return Storage.listProjects()
end

handlers.save = function(src, data, silent)
    local interior, err = validateInterior(data)
    if not interior then
        notify(src, 'error', locale('save_mlo_fail'), err)
        return false
    end

    local previous = Storage.loadFor(interior.nameHash)
    local path, werr = Storage.save(interior)
    if not path then
        notify(src, 'error', locale('save_mlo_fail'), tostring(werr))
        return false
    end
    -- renaming a project's group carries its placed elements along
    if previous and previous.group ~= interior.group then Elements.renameGroup(previous.group, interior.group) end

    Lib.print.info('%s: %s (%s)', locale('save_mlo_success'), path, GetPlayerName(src) or 'console')
    if not silent then notify(src, 'success', locale('save_mlo_success'), path) end
    return { path = path, saveName = interior.saveName }
end

-- Placed elements (live for everyone)

handlers.elementSave = function(src, d)
    local e, how = Elements.upsert(src, d)
    if not e then
        notify(src, 'error', locale('element_rejected'), how)
        return false
    end
    notify(src, 'success', locale(how == 'updated' and 'element_updated' or 'element_placed'), e.label or e.id)
    return e
end

handlers.elementDelete = function(src, id)
    local e, err = Elements.remove(id)
    if not e then
        notify(src, 'error', locale('element_rejected'), err)
        return false
    end
    notify(src, 'success', locale('element_deleted'), e.label or e.id)
    return true
end

handlers.packJson = function(src, group)
    local text, count = Elements.packJson(group)
    return { text = text, count = count }
end

-- Sound check

handlers.scanResult = function(src, bad, good, total, full)
    local n = Elements.scanResult(bad, good, total, full)
    notify(src, 'success', locale('scan_done', n))
    return true
end

handlers.hideSound = function(src, key, state)
    Elements.hideSound(key, state)
    return true
end

handlers.resetCheck = function()
    Elements.resetCheck()
    return true
end

-- Export / import

handlers.export = function(src, group, opts)
    group = Lib.sanitizeFilename(group)
    if not group then return { ok = false, error = 'invalid group' } end
    local interiors = Storage.loadGroup(group)
    local elements = Elements.list(group)
    local result, err, extra = Export.run(group, interiors, elements, type(opts) == 'table' and opts or {})
    broadcastStatus()
    if not result then
        notify(src, 'error', locale('export_failed'), err)
        return { ok = false, error = err, permission = extra and extra.permission }
    end
    for _, path in ipairs(result.files) do Lib.print.verbose('written %s', path) end
    Lib.print.info(locale('export_done', group, #result.files, result.dir))
    notify(src, 'success', locale('export_done', group, #result.files, result.dir))
    return { ok = true, result = result }
end

handlers.uninstall = function(src, group)
    local ok = Export.uninstall(group)
    broadcastStatus()
    return ok
end

handlers.exportStatus = function()
    return Export.status()
end

handlers.resources = function()
    return Export.resources()
end

handlers.importFrom = function(src, res, data)
    local interior, err = validateInterior(data)
    if not interior then return { ok = false, error = err } end
    local patch, perr = Importer.fromResource(tostring(res or ''), interior)
    if not patch then return { ok = false, error = perr } end
    return { ok = true, patch = patch }
end

RegisterNetEvent('jdt:rpc', function(id, method, ...)
    local src = source
    local handler = handlers[method]
    local result

    if not handler then
        result = { ok = false, error = 'unknown method' }
    else
        local ok, value = pcall(handler, src, ...)
        if not ok then
            Lib.print.error('rpc %s failed: %s', method, tostring(value))
            result = { ok = false, error = tostring(value) }
        else
            result = { ok = true, value = value }
        end
    end

    TriggerLatentClientEvent('jdt:rpcResult', src, Config.Network.serverToClientBPS, id, result)
end)

-- ##### Exports (for other resources / server console) ##### --

--- exports.jdt:exportGroup('my_mlo', { install = 'none' })
exports('exportGroup', function(group, opts)
    return handlers.export(0, group, opts)
end)
exports('listProjects', function() return Storage.listProjects() end)
exports('loadProject', function(filename) local i = Storage.loadFile(filename) return i and Model.toSaveData(i) end)
--- Turn a placed element on / off for everyone (not saved), e.g. when a club opens.
exports('SetEmitterEnabled', function(id, state) return Elements.setEnabled(id, state) end)
exports('GetEmitters', function(group) return Elements.list(group) end)

--- Console: `jdt_export` lists groups, `jdt_export <group> [self|none]` exports one.
RegisterCommand('jdt_export', function(src, args)
    if src ~= 0 then return end
    if not args[1] then
        local groups = {}
        for _, p in ipairs(Storage.listProjects()) do groups[p.group] = (groups[p.group] or 0) + 1 end
        for _, e in ipairs(Elements.list()) do groups[e.group] = groups[e.group] or 0 end
        for g, n in pairs(groups) do print(('  %s  (%d interiors)'):format(g, n)) end
        return
    end
    handlers.export(0, args[1], { install = args[2] })
end, true)

-- ##### Startup ##### --

local function loadCatalog(path)
    local raw = LoadResourceFile(Lib.resourceName, path)
    local ok, data = pcall(json.decode, raw or '[]')
    return ok and data or {}
end

CreateThread(function()
    AudioBuild.setCatalog(loadCatalog('catalog/radios.json'), loadCatalog('catalog/static_emitters.json'))
    Storage.init()
    Sounds.init()
    Export.init()
    Elements.init()
    Elements.broadcastAll()
    Lib.print.info('jdt %s ready - open key: %s', Lib.version, tostring(Config.Open.key))
end)
