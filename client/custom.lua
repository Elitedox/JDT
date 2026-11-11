--[[
    Custom sounds on the client.

    - keeps the server's list of custom sounds (JDT.CustomSounds)
    - until an export containing a sound has been loaded by the game (restart + reconnect), every placed sound,
      zone rule or preview that uses it is played by the panel instead, in 3D: the panel gets the camera
      position every frame and pans / fades the sound like the game would
    - relays uploads, edits and previews between the panel and the server
]]

local Lib, Rpc, Player, AudioBuild = JDT.Lib, JDT.Rpc, JDT.Player, JDT.AudioBuild

local Custom = {}
JDT.Custom = Custom
JDT.CustomSounds = {}          -- group -> list (as the server sends it)

local byName = {}              -- dat54 name (lower) -> sound
local bySetKey = {}            -- 'mas_<group>' .. ':' .. key -> sound
local banks = {}               -- bank -> true when the game has it loaded (exported + reconnected)
local voices = {}              -- id -> { stop time, loop }
local nextVoice = 0

local function nui(action, data) SendNUIMessage({ action = action, data = data }) end

local function index()
    byName, bySetKey, banks = {}, {}, {}
    for _, list in pairs(JDT.CustomSounds) do
        for _, s in ipairs(list) do
            byName[s.name:lower()] = s
            bySetKey[s.set:lower() .. ':' .. s.key:lower()] = s
            if s.inGame then banks[s.bank] = true end
        end
    end
end

RegisterNetEvent('jdt:sounds', function(list)
    JDT.CustomSounds = list or {}
    index()
    nui('customSounds', JDT.CustomSounds)
end)

local function lookup(name, set)
    if not name then return nil end
    local s = byName[tostring(name):lower()]
    if not s and set and set ~= '' then s = bySetKey[tostring(set):lower() .. ':' .. tostring(name):lower()] end
    return s
end
Custom.lookup = lookup

--- True when the sound is custom and the game does not have it yet (the panel plays it).
function Player.isVirtual(name, set)
    local s = lookup(name, set)
    return s ~= nil and not s.inGame
end

function Player.isVirtualBank(bank)
    for _, list in pairs(JDT.CustomSounds) do
        for _, s in ipairs(list) do
            if s.bank == bank then return not s.inGame end
        end
    end
    return false
end

-- ##### 3D playback in the panel ##### --

local listenerRunning = false

local function listenerLoop()
    if listenerRunning then return end
    listenerRunning = true
    CreateThread(function()
        local lx, ly, lz, lrx, lrz = nil, 0, 0, 0, 0
        while next(voices) do
            local cam = GetFinalRenderedCamCoord()
            local rot = GetFinalRenderedCamRot(2)
            -- only message the panel when the listener really moved (saves ~30 NUI messages / s standing still)
            if not lx or math.abs(cam.x - lx) + math.abs(cam.y - ly) + math.abs(cam.z - lz) > 0.02
                or math.abs(rot.x - lrx) + math.abs(((rot.z - lrz + 180.0) % 360.0) - 180.0) > 0.4 then
                lx, ly, lz, lrx, lrz = cam.x, cam.y, cam.z, rot.x, rot.z
                local rz, rx = math.rad(rot.z), math.rad(rot.x)
                local fx, fy, fz = -math.sin(rz) * math.cos(rx), math.cos(rz) * math.cos(rx), math.sin(rx)
                local ux, uy, uz = math.sin(rz) * math.sin(rx), -math.cos(rz) * math.sin(rx), math.cos(rx)
                nui('listener', { x = cam.x, y = cam.y, z = cam.z, fx = fx, fy = fy, fz = fz, ux = ux, uy = uy, uz = uz })
            end
            local now = GetGameTimer()
            for id, v in pairs(voices) do
                if v.endsAt and now > v.endsAt + 500 then voices[id] = nil end
            end
            Wait(33)
        end
        listenerRunning = false
    end)
end

Player.router = function(name, set, x, y, z, range)
    local s = lookup(name, set)
    if not s or s.inGame then return nil end
    nextVoice = nextVoice + 1
    local id = nextVoice
    local started = GetGameTimer()
    local endsAt = (not s.loop) and (started + math.floor((s.seconds or 1) * 1000) + 150) or nil
    voices[id] = { endsAt = endsAt }
    nui('voice', { op = 'play', id = id, group = s.group, key = s.key, x = x, y = y, z = z, range = range or 20, loop = s.loop, volume = s.volume or 0 })
    listenerLoop()
    local handle = {}
    function handle.stop()
        if voices[id] then
            voices[id] = nil
            nui('voice', { op = 'stop', id = id })
        end
    end
    function handle.finished()
        return voices[id] == nil or (endsAt ~= nil and GetGameTimer() > endsAt)
    end
    return handle
end

-- ##### NUI <-> server relay ##### --

local function cb(name, fn)
    RegisterNUICallback('jdt:' .. name, function(data, respond)
        local ok, result = pcall(fn, data or {})
        if not ok then
            Lib.print.error('NUI %s failed: %s', name, tostring(result))
            return respond({ ok = false, error = tostring(result) })
        end
        respond(result == nil and { ok = true } or result)
    end)
end

cb('sound:chunk', function(d)
    local r = Rpc.callBulk('soundChunk', d.uploadId, d.index, d.count, d.data, d.info)
    return r or { ok = false, error = 'no answer' }
end)

cb('sound:update', function(d) return Rpc.call('soundUpdate', d.group, d.key, d.fields) or { ok = false } end)
cb('sound:delete', function(d) return Rpc.call('soundDelete', d.group, d.key) or { ok = false } end)
cb('sound:rescan', function(d) return Rpc.call('soundRescan', d.groups) or { ok = false } end)

local fetches = 0
cb('sound:fetch', function(d)
    fetches = fetches + 1
    local rid = ('f%d'):format(fetches)
    local r = Rpc.call('soundFetch', d.group, d.key, rid)
    if not r or not r.ok then return { ok = false, error = r and r.error } end
    return { ok = true, requestId = rid, count = r.count }
end)

RegisterNetEvent('jdt:soundData', function(requestId, index, count, data)
    nui('soundData', { requestId = requestId, index = index, count = count, data = data })
end)

cb('voice:ended', function(d)
    local id = tonumber(d.id)
    if id then voices[id] = nil end
end)

AddEventHandler('onResourceStop', function(res)
    if res == Lib.resourceName then
        for id in pairs(voices) do nui('voice', { op = 'stop', id = id }) end
        voices = {}
    end
end)

return Custom
