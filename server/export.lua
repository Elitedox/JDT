--[[
    Export of a group (one MLO usually):
      always   -> output/<group>/   a complete, standalone audio resource (copy it into resources/)
      'self'   -> also installed into this resource (works after restart + reconnect, nothing to copy)
      'resource' -> also installed into the MLO's own resource, whose fxmanifest.lua is patched
]]

local Lib, AudioBuild, Rel = JDT.Lib, JDT.AudioBuild, JDT.Rel

local Export = {}
JDT.Export = Export

local RES = Lib.resourceName
local STATE_FILE = 'data/export_state.json'
local BEGIN = '-- >>> jdt (auto-generated, do not edit) >>>'
local FINISH = '-- <<< jdt <<<'
local OLD_BLOCKS = {
    { '-- >>> mlo_audio_studio (auto-generated, do not edit) >>>', '-- <<< mlo_audio_studio <<<' },
    { '-- >>> molo_soundemitters (auto-generated, do not edit) >>>', '-- <<< molo_soundemitters <<<' },   -- older manifests: replaced on export
}

local state = { groups = {} }
local loadedNative = {}   -- element id -> true when its native emitter was loaded by the game at startup

local IS_WINDOWS = (package and package.config and package.config:sub(1, 1) == '\\') or false

-- ##### Files (binary-safe, any resource) ##### --

local function resPath(res) return (GetResourcePath(res) or ''):gsub('//', '/') end

local function native(p) return IS_WINDOWS and p:gsub('/', '\\') or p end

local function mkdirs(res, path)
    local dir = path:match('(.+)/[^/]+$')
    if not dir then return end
    local acc = resPath(res)
    for part in dir:gmatch('[^/]+') do
        acc = acc .. '/' .. part
        if os.createdir then pcall(os.createdir, native(acc)) else os.execute(('mkdir "%s"'):format(native(acc))) end
    end
end

local writeErrors = {}

local function writeFile(res, path, data)
    mkdirs(res, path)
    local full = resPath(res) .. '/' .. path
    local f, err = io.open(native(full), 'wb')
    if f then
        f:write(data)
        f:close()
        local chk = io.open(native(full), 'rb')
        if chk then
            local back = chk:read('a')
            chk:close()
            if back == data then return true end
        end
        err = 'written but read back differs'
    end
    if res == RES and SaveResourceFile(res, path, data, #data) then return true end
    Lib.print.error('cannot write %s/%s: %s', res, path, tostring(err))
    writeErrors[#writeErrors + 1] = path
    return false, err
end

local function readFile(res, path)
    local f = io.open(native(resPath(res) .. '/' .. path), 'rb')
    if not f then return nil end
    local d = f:read('a')
    f:close()
    return d
end
Export.readFile = readFile

local function removeFile(res, path)
    os.remove(native(resPath(res) .. '/' .. path))
end

local function permLine(res) return ('add_filesystem_permission %s write %s'):format(RES, res) end

local function saveState()
    SaveResourceFile(RES, STATE_FILE, json.encode(state, { indent = true }), -1)
end

-- ##### fxmanifest.lua managed block ##### --

local function stripBlock(raw, b, f)
    local a = raw:find(b, 1, true)
    local z = a and raw:find(f, a, true)
    if a and z then raw = raw:sub(1, a - 1):gsub('%s+$', '') .. raw:sub(z + #f):gsub('^%s*', '\n') end
    return raw
end

local function stripAll(raw)
    raw = stripBlock(raw, BEGIN, FINISH)
    for _, b in ipairs(OLD_BLOCKS) do raw = stripBlock(raw, b[1], b[2]) end
    return raw
end

local function manifestRaw(res)
    return readFile(res, 'fxmanifest.lua') or LoadResourceFile(res, 'fxmanifest.lua')
end

--- Lines this resource's block should contain (every group installed there).
local function blockLines(res)
    local names = {}
    for g, st in pairs(state.groups) do
        if st.installTarget == res then names[#names + 1] = g end
    end
    table.sort(names)
    local lines, map = {}, false
    for _, g in ipairs(names) do
        local st = state.groups[g]
        local i = st.installed
        if i and (i.rel or i.sounds) then
            for _, l in ipairs(AudioBuild.dataLines(i.rel, i.sounds, i.waveDir, i.awc)) do lines[#lines + 1] = l end
        end
        if i and i.ymts and #i.ymts > 0 then map = true end
    end
    if res ~= RES then
        for _, g in ipairs(names) do
            local st = state.groups[g]
            if st.installed and st.installed.player then lines[#lines + 1] = ("client_script '%s'"):format(st.installed.player) end
        end
    end
    if map then
        local raw = stripAll(manifestRaw(res) or '')
        if not raw:find('this_is_a_map', 1, true) then table.insert(lines, 1, "this_is_a_map 'yes'") end
    end
    return lines
end

local function writeManifest(res)
    local raw = manifestRaw(res)
    if not raw then return false, 'fxmanifest.lua not found' end
    raw = stripAll(raw):gsub('%s+$', '')
    local lines = blockLines(res)
    if #lines > 0 then
        raw = raw .. '\n\n' .. BEGIN .. '\n' .. table.concat(lines, '\n') .. '\n' .. FINISH .. '\n'
    else
        raw = raw .. '\n'
    end
    local ok, err = load(raw, 'fxmanifest', 't', setmetatable({}, { __index = function() return function() end end }))
    if not ok then return false, 'manifest would break: ' .. tostring(err) end
    return writeFile(res, 'fxmanifest.lua', raw)
end

local function manifestHasGroup(res, st)
    local raw = manifestRaw(res) or ''
    if not st.installed or not (st.installed.rel or st.installed.sounds) then return raw:find(BEGIN, 1, true) ~= nil end
    return raw:find(st.installed.rel or st.installed.sounds, 1, true) ~= nil
end

-- ##### Taking over the target's own audio files (resource install) ##### --

local function escPat(s) return (s:gsub('[%^%$%(%)%%%.%[%]%*%+%-%?]', '%%%0')) end

local function ownAudioFiles(res)
    local raw = stripAll(manifestRaw(res) or '')
    local out = {}
    for line in raw:gmatch('[^\n]+') do
        if not line:match('^%s*%-%-') then
            local dat = line:match("data_file%s*%(?%s*['\"]AUDIO_GAMEDATA['\"]%s*,?%s*['\"]([^'\"]+)['\"]")
            if dat then out[#out + 1] = (dat:gsub('%.dat$', '.dat151.rel')) end
        end
    end
    return out
end
Export.ownAudioFiles = ownAudioFiles

local function unlistFromManifest(res, relFile)
    local raw = manifestRaw(res)
    if not raw then return false, 'no fxmanifest.lua' end
    if not readFile(res, 'fxmanifest.lua.mas_backup') then writeFile(res, 'fxmanifest.lua.mas_backup', raw) end
    local dat = relFile:gsub('%.dat151%.rel$', '.dat')
    local new = raw:gsub("(\n?)([ \t]*)(data_file%s*%(?%s*['\"]AUDIO_GAMEDATA['\"]%s*,?%s*['\"]" .. escPat(dat) .. "['\"]%s*%)?)",
        '%1%2-- [moved into jdt export] %3')
    new = new:gsub("['\"]" .. escPat(relFile) .. "['\"]%s*,?", '')
    new = new:gsub(',(%s*)}', '%1}'):gsub('{(%s*),', '{%1')
    local ok, err = load(new, 'fxmanifest', 't', setmetatable({}, { __index = function() return function() end end }))
    if not ok then return false, 'manifest would break: ' .. tostring(err) end
    return writeFile(res, 'fxmanifest.lua', new)
end

local function absorbTargetAudio(group, target, ownRel, generated)
    local st = state.groups[group] or {}
    local absorbed = st.absorbed or {}
    local sources, notes = {}, {}
    for _, b in ipairs(absorbed) do sources[#sources + 1] = { path = b, backup = true } end
    for _, f in ipairs(ownAudioFiles(target)) do
        if f ~= ownRel then sources[#sources + 1] = { path = f, backup = false } end
    end

    local candidates = {}
    for _, src in ipairs(sources) do
        local data = readFile(target, src.path)
        local parsed = data and Rel.read(data)
        if parsed then
            local allKnown, overlaps = true, false
            for _, it in ipairs(parsed.items) do
                if not it.known then allKnown = false end
                if generated[it.nameHash] then overlaps = true end
            end
            if src.backup or (allKnown and overlaps) then
                local before = #candidates
                for _, it in ipairs(parsed.items) do candidates[#candidates + 1] = it end
                if not src.backup then
                    local backup = 'audio/_mas_backup/' .. src.path:match('([^/]+)$')
                    writeFile(target, backup, data)
                    removeFile(target, src.path)
                    local ok, err = unlistFromManifest(target, src.path)
                    if not ok then
                        writeFile(target, src.path, data)
                        notes[#notes + 1] = ('kept %s (%s)'):format(src.path, tostring(err))
                        for _ = before + 1, #candidates do table.remove(candidates) end
                    else
                        absorbed[#absorbed + 1] = backup
                        notes[#notes + 1] = ('merged %s (original kept in %s)'):format(src.path, backup)
                    end
                end
            elseif overlaps then
                notes[#notes + 1] = ('WARNING %s also defines this interior or its doors and could not be merged'):format(src.path)
            end
        end
    end

    local drop = {}
    for h in pairs(generated) do drop[h] = true end
    for _, it in ipairs(candidates) do
        if it.typeId == Rel.TYPE.InteriorSettings and generated[it.nameHash] then
            for _, r in ipairs(Rel.roomsOf(it)) do drop[r] = true end
        end
    end
    local raw, seen = {}, {}
    for _, it in ipairs(candidates) do
        if not drop[it.nameHash] and not seen[it.nameHash] then
            seen[it.nameHash] = true
            raw[#raw + 1] = { kind = 'Raw', typeId = it.typeId, bytes = it.bytes, ht = it.ht, nameHash = it.nameHash }
        end
    end
    return raw, notes, absorbed
end

-- ##### Cleaning previous installs ##### --

local function removeInstalled(st)
    if not st or not st.installed or not st.installTarget then return end
    local res = st.installTarget
    if GetResourceState(res) == 'missing' then return end
    if st.installed.rel then removeFile(res, st.installed.rel) end
    if st.installed.sounds then removeFile(res, st.installed.sounds) end
    if st.installed.awc then removeFile(res, st.installed.awc) end
    if st.installed.player then removeFile(res, st.installed.player) end
    for _, y in ipairs(st.installed.ymts or {}) do removeFile(res, 'stream/' .. y .. '.ymt') end
end

local function removeOutput(st)
    for _, path in ipairs(st and st.outputFiles or {}) do removeFile(RES, path) end
end

-- ##### Export ##### --

local function playerTemplate()
    return LoadResourceFile(RES, 'runtime/player_core.lua') or ''
end

--[[
    opts = { install = 'self'|'resource'|'none', target = '<resource>', xml = bool, comments = bool }
    returns result table or nil, message
]]
function Export.run(group, interiors, elements, opts)
    opts = opts or {}
    group = Lib.sanitizeFilename(group)
    if not group then return nil, 'invalid group name' end

    local install = opts.install or Config.Output.install or 'self'
    local target = install == 'self' and RES or (install == 'resource' and opts.target or nil)
    if install == 'resource' then
        if not target or target == '' or target == RES then return nil, 'pick the MLO resource to install into' end
        if GetResourceState(target) == 'missing' or not GetResourcePath(target) then return nil, ('resource "%s" not found'):format(target) end
    end

    local mine = {}
    for _, e in ipairs(elements) do if not e.pack then mine[#mine + 1] = e end end

    local sounds, soundProblems = {}, {}
    if JDT.Sounds then sounds, soundProblems = JDT.Sounds.forExport(group) end

    local pkg = AudioBuild.package(group, interiors, mine, {
        xml = opts.xml ~= false and Config.Output.xml ~= false,
        comments = opts.comments == true or Config.Output.debugComments == true,
        maxPathDistance = Config.Output.maxPathDistance,
        encodeJson = function(v) return json.encode(v) end,
        playerTemplate = playerTemplate(),
        toolVersion = Lib.version,
        sounds = sounds,
        customIndex = JDT.Sounds and JDT.Sounds.index() or {},
    })

    if #pkg.files <= 2 then return nil, 'nothing to export in this group' end

    writeErrors = {}
    local prev = state.groups[group]
    local prevTarget = prev and prev.installTarget
    removeOutput(prev)
    removeInstalled(prev)

    -- 1. standalone folder
    local base = ('%s/%s'):format(Config.Storage.outputDir, group)
    local outputFiles = {}
    for _, f in ipairs(pkg.files) do
        local path = base .. '/' .. f.path
        if writeFile(RES, path, f.content) then outputFiles[#outputFiles + 1] = path end
    end

    -- 2. install
    local installed, notes = nil, {}
    for _, n in ipairs(pkg.notes) do notes[#notes + 1] = locale(n.key, table.unpack(n.args)) end
    if #soundProblems > 0 then notes[#notes + 1] = locale('export_sound_problems', table.concat(soundProblems, ', ')) end

    if target then
        installed = { ymts = {} }
        local byPath = {}
        for _, f in ipairs(pkg.files) do byPath[f.path] = f end
        local p = AudioBuild.paths(group)
        local relName = install == 'self' and p.rel or ('audio/mas_%s_game.dat151.rel'):format(AudioBuild.safeName(group))

        local relBytes = byPath[p.rel] and byPath[p.rel].content
        if install == 'resource' then
            -- merge the MLO's own audio file for the same interior / doors, if any
            local items = AudioBuild.relItems(group, interiors, mine)
            local generated = {}
            for _, it in ipairs(items) do generated[it.nameHash or Rel.hash(it.name)] = true end
            local raw, absorbNotes, absorbed = absorbTargetAudio(group, target, relName, generated)
            for _, n in ipairs(absorbNotes) do notes[#notes + 1] = n end
            if #raw > 0 then
                for _, it in ipairs(raw) do items[#items + 1] = it end
                relBytes = Rel.build(items, AudioBuild.VERSION)
            end
            state.groups[group] = state.groups[group] or {}
            state.groups[group].absorbed = absorbed
        end

        if relBytes and writeFile(target, relName, relBytes) then installed.rel = relName end
        if pkg.hasSounds then
            local soundsName = install == 'self' and p.sounds or ('audio/mas_%s_sounds.dat54.rel'):format(AudioBuild.safeName(group))
            if writeFile(target, soundsName, byPath[p.sounds].content) and writeFile(target, p.awc, byPath[p.awc].content) then
                installed.sounds, installed.awc, installed.waveDir = soundsName, p.awc, p.waveDir
            end
        end
        for _, y in ipairs(pkg.ymts) do
            local stream = 'stream/' .. y .. '.ymt'
            local existing = install == 'resource' and readFile(target, stream)
            if existing and not readFile(target, 'audio/_mas_backup/' .. y .. '.ymt') then
                writeFile(target, 'audio/_mas_backup/' .. y .. '.ymt', existing)
                notes[#notes + 1] = ('replaced %s (original kept in audio/_mas_backup)'):format(stream)
            end
            if writeFile(target, stream, byPath[stream].content) then installed.ymts[#installed.ymts + 1] = y end
        end
        if install == 'resource' and byPath[p.player] then
            local playerPath = ('audio/mas_%s_player.lua'):format(AudioBuild.safeName(group))
            if writeFile(target, playerPath, byPath[p.player].content) then installed.player = playerPath end
        end
    end

    local st = state.groups[group] or {}
    st.at = os.date('%Y-%m-%d %H:%M')
    st.install = install
    st.installTarget = target
    st.installed = installed
    st.outputFiles = outputFiles
    st.nativeIds = pkg.nativeIds
    st.soundNames = pkg.soundNames
    st.playerCount = pkg.playerCount
    st.stats = pkg.stats
    st.pending = target ~= nil
    state.groups[group] = st
    saveState()

    if prevTarget and prevTarget ~= target and GetResourceState(prevTarget) ~= 'missing' then
        writeManifest(prevTarget)
    end
    if target then
        local ok, err = writeManifest(target)
        if not ok then notes[#notes + 1] = 'fxmanifest.lua: ' .. tostring(err) end
    end

    if #writeErrors > 0 then
        local msg = target and target ~= RES
            and locale('export_blocked', target, table.concat(writeErrors, ', '), permLine(target))
            or locale('export_write_failed', table.concat(writeErrors, ', '))
        return nil, msg, { permission = target and target ~= RES and permLine(target) or nil }
    end

    return {
        group = group, dir = base, files = outputFiles, install = install, target = target,
        installed = installed, notes = notes, stats = pkg.stats, playerCount = pkg.playerCount,
        nativeCount = #pkg.nativeIds,
    }
end

--- Removes a group's installed files and output folder.
function Export.uninstall(group)
    local st = state.groups[group]
    if not st then return false end
    removeInstalled(st)
    removeOutput(st)
    state.groups[group] = nil
    saveState()
    if st.installTarget then writeManifest(st.installTarget) end
    return true
end

-- ##### Status ##### --

function Export.isNativeLoaded(e)
    return loadedNative[e.id] == true and AudioBuild.isNativeEligible(e)
end

function Export.status()
    local out = {}
    for g, st in pairs(state.groups) do
        local target = st.installTarget
        out[g] = {
            at = st.at, install = st.install, target = target, pending = st.pending,
            manifest = target and manifestHasGroup(target, st) or nil,
            playerCount = st.playerCount or 0, stats = st.stats,
            external = target and target ~= RES and st.installed and st.installed.player ~= nil or false,
            perm = target and target ~= RES and permLine(target) or nil,
            dir = ('%s/%s'):format(Config.Storage.outputDir, g),
            ymts = st.installed and st.installed.ymts or {},
            sounds = st.installed and st.installed.sounds ~= nil or false,
        }
    end
    return out
end

function Export.resources()
    local out = {}
    for i = 0, GetNumResources() - 1 do
        local r = GetResourceByFindIndex(i)
        if r and r ~= RES and GetResourceState(r) ~= 'missing' and LoadResourceFile(r, 'fxmanifest.lua') then out[#out + 1] = r end
    end
    table.sort(out)
    return out
end

-- ##### Startup ##### --

function Export.init()
    local raw = LoadResourceFile(RES, STATE_FILE)
    if raw and raw ~= '' then
        local ok, data = pcall(json.decode, raw)
        if ok and type(data) == 'table' and type(data.groups) == 'table' then state = data end
    end

    for g, st in pairs(state.groups) do
        local res = st.installTarget
        if res and GetResourceState(res) ~= 'missing' then
            if manifestHasGroup(res, st) then
                st.pending = false
                for _, id in ipairs(st.nativeIds or {}) do loadedNative[id] = true end
                if JDT.Sounds then JDT.Sounds.markInGame(st.soundNames) end
            else
                local ok, err = writeManifest(res)
                if ok then
                    Lib.print.info(locale('manifest_repatched', res))
                else
                    Lib.print.error('%s: %s', res, tostring(err))
                    if res ~= RES then Lib.print.error(permLine(res)) end
                end
            end
        end
    end
    saveState()
end

return Export
