--[[
    Custom sounds: your own audio files, packed into the game's formats on export (.awc + .dat54.rel).

    Sources live in sounds/<group>/<key>.wav. Settings per sound are kept in data/sounds.json.
    The panel converts any audio file (mp3, ogg, flac, wav...) to 16-bit mono WAV in the browser and uploads it;
    .wav files dropped into the folder by hand are picked up by Rescan.
]]

local Lib, AudioBuild, Storage = JDT.Lib, JDT.AudioBuild, JDT.Storage

local Sounds = {}
JDT.Sounds = Sounds

local META_FILE = 'data/sounds.json'
local meta = { groups = {} }      -- groups[group][key] = { label, loop, volume, category, codec, rate, normalize, seconds, bytes, at }
local uploads = {}                -- [src .. ':' .. uploadId] = { parts = {}, count, meta, at }
local inGame = {}                 -- dat54 name -> true when the export containing it was loaded at startup

local function dir() return (Config.Sounds and Config.Sounds.dir) or 'sounds' end

-- ##### base64 ##### --

local B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
local DEC = {}
for i = 1, 64 do DEC[B64:byte(i)] = i - 1 end

function Sounds.b64decode(s)
    s = s:gsub('[^%w%+/=]', '')
    local out, n = {}, 0
    local chunk = {}
    local cn = 0
    for i = 1, #s - 3, 4 do
        local a, b, c, d = s:byte(i, i + 3)
        local va, vb, vc, vd = DEC[a] or 0, DEC[b] or 0, DEC[c], DEC[d]
        local v = (va << 18) | (vb << 12) | ((vc or 0) << 6) | (vd or 0)
        cn = cn + 1
        if c == 61 then
            chunk[cn] = string.char((v >> 16) & 0xFF)
        elseif d == 61 then
            chunk[cn] = string.char((v >> 16) & 0xFF, (v >> 8) & 0xFF)
        else
            chunk[cn] = string.char((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF)
        end
        if cn >= 8192 then n = n + 1; out[n] = table.concat(chunk, '', 1, cn); cn = 0 end
    end
    if cn > 0 then n = n + 1; out[n] = table.concat(chunk, '', 1, cn) end
    return table.concat(out)
end

function Sounds.b64encode(data)
    local out, n = {}, 0
    for i = 1, #data, 3 do
        local a, b, c = data:byte(i, i + 2)
        local v = (a << 16) | ((b or 0) << 8) | (c or 0)
        local s1, s2, s3, s4 = (v >> 18) & 63, (v >> 12) & 63, (v >> 6) & 63, v & 63
        n = n + 1
        out[n] = B64:sub(s1 + 1, s1 + 1) .. B64:sub(s2 + 1, s2 + 1)
            .. (b and B64:sub(s3 + 1, s3 + 1) or '=') .. (c and B64:sub(s4 + 1, s4 + 1) or '=')
    end
    return table.concat(out)
end

-- ##### Metadata ##### --

local function persist()
    SaveResourceFile(Lib.resourceName, META_FILE, json.encode(meta, { indent = true }), -1)
end

local function num(v, def, lo, hi)
    v = tonumber(v)
    if not v or v ~= v then return def end
    if lo and v < lo then v = lo end
    if hi and v > hi then v = hi end
    return v
end

local function cleanMeta(m, old)
    m = type(m) == 'table' and m or {}
    old = old or {}
    local function pick(k, def) if m[k] == nil then return old[k] == nil and def or old[k] end return m[k] end
    local cat = pick('category', Config.Sounds.category or 'scripted')
    return {
        label = type(pick('label', nil)) == 'string' and pick('label', nil):sub(1, 48) or nil,
        loop = pick('loop', false) == true,
        volume = num(pick('volume', 0), 0, -40, 24),
        category = type(cat) == 'string' and cat:sub(1, 64) or 'scripted',
        codec = pick('codec', Config.Sounds.codec or 'adpcm') == 'pcm' and 'pcm' or 'adpcm',
        rate = math.floor(num(pick('rate', 0), 0, 0, 48000)),       -- 0 = keep the file's rate
        normalize = pick('normalize', Config.Sounds.normalize ~= false) == true,
        seconds = num(pick('seconds', 0), 0, 0, 36000),
        bytes = math.floor(num(pick('bytes', 0), 0, 0)),
        at = pick('at', os.date('%Y-%m-%d %H:%M')),
    }
end

local function wavPath(group, key) return ('%s/%s/%s.wav'):format(dir(), group, key) end

local function readWav(group, key)
    return Storage.read(Storage.path(wavPath(group, key)))
end

--- Everything the panel needs: { [group] = { { key, label, name, bank, set, ...meta, inGame } } }
function Sounds.list()
    local out = {}
    for g, list in pairs(meta.groups) do
        local arr = {}
        for key, m in pairs(list) do
            local c = Lib.deepcopy(m)
            c.key = key
            c.group = g
            c.name = AudioBuild.soundName(g, key)
            c.bank = AudioBuild.soundBank(g)
            c.set = AudioBuild.soundSet(g)
            c.inGame = inGame[c.name] == true
            arr[#arr + 1] = c
        end
        table.sort(arr, function(a, b) return a.key < b.key end)
        out[g] = arr
    end
    return out
end

function Sounds.broadcast(target)
    TriggerLatentClientEvent('jdt:sounds', target or -1, Config.Network.serverToClientBPS, Sounds.list())
end

--- dat54 name (lowercase) -> bank, for every custom sound (bank keepers in exports).
function Sounds.index()
    local idx = {}
    for g, list in pairs(meta.groups) do
        for key in pairs(list) do idx[AudioBuild.soundName(g, key)] = AudioBuild.soundBank(g) end
    end
    return idx
end

function Sounds.markInGame(names)
    for _, n in ipairs(names or {}) do inGame[n] = true end
end

-- ##### Upload / edit / delete ##### --

local function uniqueKey(group, wanted)
    local base = AudioBuild.soundKey(wanted)
    local key, i = base, 2
    local list = meta.groups[group] or {}
    while list[key] do key = ('%s_%d'):format(base:sub(1, 36), i); i = i + 1 end
    return key
end

--[[
    One chunk of an upload. info (first chunk) = { group, name, loop, volume, category, codec, rate, normalize, replace }
    returns { done = bool, key } or nil, err
]]
function Sounds.chunk(src, uploadId, index, count, data, info)
    uploadId = tostring(uploadId):sub(1, 32)
    local id = tostring(src) .. ':' .. uploadId
    index, count = math.floor(num(index, 0, 1, 10000)), math.floor(num(count, 0, 1, 10000))
    if index < 1 or count < 1 or type(data) ~= 'string' then return nil, 'bad chunk' end
    local u = uploads[id]
    if not u then
        if type(info) ~= 'table' then return nil, 'missing upload info' end
        u = { parts = {}, count = count, info = info, size = 0, at = os.time() }
        uploads[id] = u
    end
    u.parts[index] = data
    u.size = u.size + #data
    if u.size * 3 / 4 > (Config.Sounds.maxUploadMB or 25) * 1048576 then
        uploads[id] = nil
        return nil, ('file is larger than %d MB'):format(Config.Sounds.maxUploadMB or 25)
    end
    for i = 1, u.count do if not u.parts[i] then return { done = false } end end
    uploads[id] = nil

    local bytes = Sounds.b64decode(table.concat(u.parts))
    local w, err = JDT.Wav.read(bytes)
    if not w then return nil, err end
    local group = Lib.sanitizeFilename(u.info.group) or Config.Place.defaultGroup
    local key = u.info.replace and AudioBuild.soundKey(u.info.replace) or uniqueKey(group, u.info.name or 'sound')
    if not Storage.ensureDir(Storage.path(dir(), group)) then return nil, 'cannot create ' .. dir() .. '/' .. group end
    local ok, werr = Storage.write(Storage.path(wavPath(group, key)), bytes)
    if not ok then return nil, tostring(werr) end
    meta.groups[group] = meta.groups[group] or {}
    local m = cleanMeta(u.info, meta.groups[group][key])
    m.seconds = w.frames / w.rate
    m.bytes = #bytes
    m.label = m.label or (type(u.info.name) == 'string' and u.info.name:gsub('%.[%w]+$', ''):sub(1, 48)) or key
    meta.groups[group][key] = m
    persist()
    Sounds.broadcast()
    return { done = true, key = key, group = group }
end

function Sounds.update(group, key, fields)
    local list = meta.groups[group]
    if not list or not list[key] then return nil, 'not found' end
    list[key] = cleanMeta(fields, list[key])
    persist()
    Sounds.broadcast()
    return list[key]
end

function Sounds.remove(group, key)
    local list = meta.groups[group]
    if not list or not list[key] then return nil, 'not found' end
    list[key] = nil
    os.remove(Storage.path(wavPath(group, key)))
    if next(list) == nil then meta.groups[group] = nil end
    persist()
    Sounds.broadcast()
    return true
end

--- Picks up .wav files dropped into sounds/<group>/ by hand.
function Sounds.rescan(groups)
    local added = 0
    local names = {}
    for g in pairs(meta.groups) do names[g] = true end
    for _, g in ipairs(groups or {}) do if Lib.sanitizeFilename(g) then names[Lib.sanitizeFilename(g)] = true end end
    -- top-level folders (shell listing when available)
    local win = package and package.config and package.config:sub(1, 1) == '\\'
    local ok, handle = pcall(io.popen, win and ('dir /b /ad "%s" 2>nul'):format(Storage.path(dir()):gsub('/', '\\')) or ('ls -1 "%s" 2>/dev/null'):format(Storage.path(dir())))
    if ok and handle then
        for line in handle:lines() do
            local g = Lib.sanitizeFilename((line:gsub('[\r\n]', '')))
            if g then names[g] = true end
        end
        handle:close()
    end
    for g in pairs(names) do
        for _, file in ipairs(Storage.list(Storage.path(dir(), g), 'wav')) do
            local key = AudioBuild.soundKey(file)
            meta.groups[g] = meta.groups[g] or {}
            if not meta.groups[g][key] then
                if key ~= file then
                    -- keep file names game-safe
                    local data = Storage.read(Storage.path(dir(), g, file .. '.wav'))
                    if data then Storage.write(Storage.path(wavPath(g, key)), data); os.remove(Storage.path(dir(), g, file .. '.wav')) end
                end
                local data = readWav(g, key)
                local w = data and JDT.Wav.read(data)
                if w then
                    local m = cleanMeta({ label = file })
                    m.seconds, m.bytes = w.frames / w.rate, #data
                    meta.groups[g][key] = m
                    added = added + 1
                else
                    Lib.print.warn('skipped %s/%s.wav: not a readable WAV', g, file)
                end
            end
        end
        if meta.groups[g] and next(meta.groups[g]) == nil then meta.groups[g] = nil end
    end
    -- forget sounds whose file was deleted by hand
    for g, list in pairs(meta.groups) do
        for key in pairs(list) do
            if not readWav(g, key) then list[key] = nil end
        end
        if next(list) == nil then meta.groups[g] = nil end
    end
    persist()
    Sounds.broadcast()
    return added
end

--- Sends a sound's WAV to a client (panel preview), in chunks.
function Sounds.send(src, group, key, requestId)
    local data = readWav(group, key)
    if not data then return nil, 'not found' end
    local b64 = Sounds.b64encode(data)
    local size = 240000
    local count = math.max(1, math.ceil(#b64 / size))
    for i = 1, count do
        TriggerLatentClientEvent('jdt:soundData', src, Config.Network.uploadBPS or 1000000, requestId, i, count, b64:sub((i - 1) * size + 1, i * size))
    end
    return { count = count }
end

--- Converted sounds of a group for AudioBuild.package (opts.sounds).
function Sounds.forExport(group)
    local out, problems = {}, {}
    for key, m in pairs(meta.groups[group] or {}) do
        local data = readWav(group, key)
        local conv, err
        if data then conv, err = JDT.Wav.convert(data, { rate = (m.rate and m.rate > 0) and m.rate or nil, normalize = m.normalize }) end
        if conv then
            out[#out + 1] = { key = key, pcm = conv.pcm, rate = conv.rate, loop = m.loop, volume = m.volume, category = m.category, codec = m.codec }
        else
            problems[#problems + 1] = ('%s (%s)'):format(key, tostring(err or 'file missing'))
        end
    end
    table.sort(out, function(a, b) return a.key < b.key end)
    return out, problems
end

--- Door preset recordings in samples/doors/ (played by the panel next to each preset).
function Sounds.doorSamples()
    local out = {}
    local dir = Storage.path('samples', 'doors')
    for _, ext in ipairs({ 'ogg', 'mp3', 'wav' }) do
        for _, name in ipairs(Storage.list(dir, ext)) do
            if not out[name:lower()] then out[name:lower()] = name .. '.' .. ext end
        end
    end
    return out
end

function Sounds.init()
    local raw = LoadResourceFile(Lib.resourceName, META_FILE)
    if raw and raw ~= '' then
        local ok, data = pcall(json.decode, raw)
        if ok and type(data) == 'table' and type(data.groups) == 'table' then meta = data end
    end
    Storage.ensureDir(Storage.path(dir()))
    Sounds.rescan()
    -- drop stale half uploads
    CreateThread(function()
        while true do
            Wait(60000)
            local now = os.time()
            for id, u in pairs(uploads) do if now - u.at > 600 then uploads[id] = nil end end
        end
    end)
end

return Sounds
