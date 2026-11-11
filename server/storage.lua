--[[
    File storage for project files and generated output (server only).
    Uses plain Lua io/os - works on Windows and Linux FXServer builds.
]]

local Lib, Model = JDT.Lib, JDT.Model

local Storage = {}
JDT.Storage = Storage

local IS_WINDOWS = (package and package.config and package.config:sub(1, 1) == '\\')
    or ((os.getenv('OS') or ''):lower():find('windows') ~= nil)

local resourcePath = (GetResourcePath(Lib.resourceName) or '.'):gsub('//', '/'):gsub('[/\\]+$', '')

---@type table<string, string> uintNameHash string -> filename (without .json)
local index = {}

local function native(path)
    if IS_WINDOWS then return (path:gsub('/', '\\')) end
    return path
end

function Storage.path(...)
    return table.concat({ resourcePath, ... }, '/')
end

function Storage.relative(path)
    return (path:gsub('^' .. resourcePath:gsub('%p', '%%%0') .. '/?', ''))
end

local function exists(path)
    local f = io.open(native(path), 'r')
    if f then f:close() return true end
    return false
end

local function isWritableDir(path)
    local probe = native(path .. '/.mlotool_probe')
    local f = io.open(probe, 'w')
    if not f then return false end
    f:close()
    os.remove(probe)
    return true
end

--- Creates every missing directory level of `path`.
function Storage.ensureDir(path)
    if isWritableDir(path) then return true end

    local rel = Storage.relative(path)
    local current = resourcePath
    for part in rel:gmatch('[^/]+') do
        current = current .. '/' .. part
        if not isWritableDir(current) then
            if os.createdir then
                pcall(os.createdir, native(current))
            else
                os.execute(('mkdir "%s"'):format(native(current)))
            end
        end
    end

    local ok = isWritableDir(path)
    if not ok then Lib.print.error(locale('fail_create_directory', path, '-', 'not writable')) end
    return ok
end

function Storage.read(path)
    local f, err = io.open(native(path), 'rb')
    if not f then return nil, err end
    local data = f:read('a')
    f:close()
    return data
end

function Storage.write(path, data)
    local f, err = io.open(native(path), 'wb')
    if not f then
        Lib.print.error('%s: %s', locale('open_output_file_fail'), tostring(err))
        return false, err
    end
    local ok, werr = f:write(data)
    f:close()
    if not ok then
        Lib.print.error('%s: %s', locale('write_output_fail'), tostring(werr))
        return false, werr
    end
    return true
end

local function popenList(dir, ext)
    local cmd = IS_WINDOWS
        and ('dir /b "%s" 2>nul'):format(native(dir))
        or ('ls -1 "%s" 2>/dev/null'):format(dir)

    local ok, handle = pcall(io.popen, cmd)
    if not ok or not handle then return nil end

    local out = {}
    local pattern = '^(.+)%.' .. ext .. '$'
    for line in handle:lines() do
        line = line:gsub('[\r\n]', '')
        local name = line:match(pattern)
        if name then out[#out + 1] = name end
    end
    handle:close()
    return out
end

--- Lists file names (without extension) in a directory matching `ext` (e.g. 'json').
--- Uses the shell when available and an index.json kept by this resource as a fallback.
function Storage.list(dir, ext)
    local seen, out = {}, {}
    local function add(name)
        if name ~= 'index' and not seen[name] then seen[name] = true out[#out + 1] = name end
    end

    for _, name in ipairs(popenList(dir, ext) or {}) do add(name) end

    local raw = Storage.read(dir .. '/index.json')
    local ok, list = pcall(function() return raw and json.decode(raw) end)
    if ok and type(list) == 'table' then
        for _, name in ipairs(list) do
            if type(name) == 'string' and exists(('%s/%s.%s'):format(dir, name, ext)) then add(name) end
        end
    end

    table.sort(out)
    return out
end

local function addToIndex(dir, name)
    local raw = Storage.read(dir .. '/index.json')
    local ok, list = pcall(function() return raw and json.decode(raw) end)
    list = (ok and type(list) == 'table') and list or {}
    for _, n in ipairs(list) do if n == name then return end end
    list[#list + 1] = name
    table.sort(list)
    Storage.write(dir .. '/index.json', json.encode(list))
end

-- ##### Project files ##### --

local function savedDir() return Storage.path(Config.Storage.savedDir) end
local function outputDir() return Storage.path(Config.Storage.outputDir) end

local function decode(raw)
    local ok, data = pcall(json.decode, raw)
    if ok and type(data) == 'table' then return data end
    return nil
end

local function indexKey(nameHash)
    return tostring(JDT.Hash.toUInt32(math.tointeger(tonumber(nameHash) or 0) or 0))
end

local function rotateBackups(filename)
    local keep = tonumber(Config.Storage.backups) or 0
    if keep <= 0 then return end

    local current = Storage.read(savedDir() .. '/' .. filename .. '.json')
    if not current then return end

    local dir = savedDir() .. '/backups'
    if not Storage.ensureDir(dir) then return end

    local backupName = ('%s.%s'):format(filename, os.date('%Y%m%d-%H%M%S'))
    Storage.write(('%s/%s.json'):format(dir, backupName), current)
    addToIndex(dir, backupName)

    local existing = {}
    for _, name in ipairs(Storage.list(dir, 'json')) do
        if name:sub(1, #filename + 1) == filename .. '.' then existing[#existing + 1] = name end
    end
    table.sort(existing)
    for i = 1, #existing - keep do os.remove(native(dir .. '/' .. existing[i] .. '.json')) end
end

--- Read + migrate a project file.
function Storage.loadFile(filename)
    filename = Lib.sanitizeFilename(filename)
    if not filename then return nil, 'invalid filename' end
    local raw, err = Storage.read(savedDir() .. '/' .. filename .. '.json')
    if not raw then return nil, err end
    local data = decode(raw)
    if not data then return nil, 'invalid json' end
    local ok, interior = pcall(Model.migrate, data)
    if not ok then return nil, interior end
    interior.saveName = interior.saveName or filename
    index[indexKey(interior.nameHash)] = filename
    return interior
end

function Storage.filenameFor(nameHash)
    return index[indexKey(nameHash)]
end

function Storage.loadFor(nameHash)
    local filename = Storage.filenameFor(nameHash)
    if not filename then return nil end
    return Storage.loadFile(filename)
end

--- Saves a (validated) interior. Returns relative path.
function Storage.save(interior)
    local filename = Lib.sanitizeFilename(interior.saveName) or JDT.Hash.hex(interior.nameHash)
    if not Storage.ensureDir(savedDir()) then return nil, 'directory' end

    rotateBackups(filename)

    local data = Model.toSaveData(interior)
    local ok, err = Storage.write(savedDir() .. '/' .. filename .. '.json', json.encode(data, { indent = true, sort_keys = true }))
    if not ok then return nil, err end

    addToIndex(savedDir(), filename)
    -- the same interior may have been saved under a different name before
    index[indexKey(interior.nameHash)] = filename
    return Config.Storage.savedDir .. '/' .. filename .. '.json'
end

--- Summary of every project file for the "Saved projects" list.
function Storage.listProjects()
    local out = {}
    for _, name in ipairs(Storage.list(savedDir(), 'json')) do
        local raw = name ~= 'index' and Storage.read(savedDir() .. '/' .. name .. '.json')
        local data = raw and decode(raw)
        if data and data.nameHash then
            out[#out + 1] = {
                file = name,
                name = (data.archetypeName and data.archetypeName ~= '') and data.archetypeName or data.name,
                group = data.group or name,
                nameHash = indexKey(data.nameHash),
                rooms = data.rooms and #data.rooms or 0,
                portals = data.portals and #data.portals or 0,
                updatedAt = data.updatedAt,
                version = data.version or 1,
            }
        end
    end
    return out
end

--- Every saved interior whose export group is `group` (migrated, ready to build).
function Storage.loadGroup(group)
    local out = {}
    for _, name in ipairs(Storage.list(savedDir(), 'json')) do
        if name ~= 'index' then
            local interior = Storage.loadFile(name)
            if interior and interior.group == group then out[#out + 1] = interior end
        end
    end
    table.sort(out, function(a, b) return a.saveName < b.saveName end)
    return out
end

--- Builds the nameHash index and imports old save folders.
function Storage.init()
    Storage.ensureDir(savedDir())

    for _, legacy in ipairs(Config.Storage.legacyDirs or {}) do
        local dir = Storage.path(legacy)
        local names = Storage.list(dir, 'json')
        if #names > 0 then Lib.print.info(locale('found_mlo_json_files', #names, legacy)) end

        for _, name in ipairs(names) do
            if not exists(savedDir() .. '/' .. name .. '.json') then
                local raw = Storage.read(dir .. '/' .. name .. '.json')
                local data = raw and decode(raw)
                local ok, interior = pcall(Model.migrate, data or {})
                if ok then
                    interior.saveName = name
                    Storage.save(interior)
                    Lib.print.info(locale('migrated_save', name, legacy, Config.Storage.savedDir))
                else
                    Lib.print.warn('Could not import %s/%s.json: %s', legacy, name, tostring(interior))
                end
            end
        end
    end

    local count = 0
    for _, name in ipairs(Storage.list(savedDir(), 'json')) do
        local raw = Storage.read(savedDir() .. '/' .. name .. '.json')
        local data = raw and decode(raw)
        if data and data.nameHash then
            index[indexKey(data.nameHash)] = name
            count = count + 1
        end
    end
    Lib.print.info(locale('found_mlo_json_files', count, Config.Storage.savedDir))
end

return Storage
