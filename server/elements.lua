--[[
    Placed elements (sounds, vanilla emitters, radios, mute zones, objects, ambient zones): storage, validation,
    live sync to every client, vanilla emitter allocation and the shared sound check.
]]

local Lib = JDT.Lib

local Elements = {}
JDT.Elements = Elements

local CHECK_FILE = 'data/sound_check.json'

local store = {}          -- id -> element
local soundCheck = { bad = {}, hidden = {}, checked = 0, at = nil }

local function save(path, data)
    SaveResourceFile(Lib.resourceName, path, json.encode(data, { indent = true }), -1)
end

local function load(path)
    local raw = LoadResourceFile(Lib.resourceName, path)
    if not raw or raw == '' then return nil end
    local ok, data = pcall(json.decode, raw)
    return ok and data or nil
end

-- ##### Validation ##### --

local function num(v, def, min, max)
    v = tonumber(v)
    if not v or v ~= v or v == math.huge or v == -math.huge then return def end
    if min and v < min then v = min end
    if max and v > max then v = max end
    return v
end

local function str(v, maxLen, def)
    if type(v) ~= 'string' then return def end
    v = v:gsub('[%c]', '')
    if #v == 0 then return def end
    return v:sub(1, maxLen or 64)
end

local function genId()
    local id
    repeat id = ('se_%d%03d'):format(os.time() % 1000000, math.random(0, 999)) until not store[id]
    return id
end

local TYPES = { sound = true, ambient = true, radio = true, static = true, prop = true, zone = true }

local function bool(v, def) if v == nil then return def end return v == true end

--- Native StaticEmitter fields (all optional; nil = game / tool default).
local function sanitizeEmitter(x)
    if type(x) ~= 'table' then return nil end
    local out = {
        minDistance = num(x.minDistance, nil, 0.0, 300.0),
        lpf = x.lpf and math.floor(num(x.lpf, 23900, 100, 23900)) or nil,
        hpf = x.hpf and math.floor(num(x.hpf, 0, 0, 20000)) or nil,
        rolloff = x.rolloff and math.floor(num(x.rolloff, 100, 1, 1000)) or nil,
        maxLeakage = num(x.maxLeakage, nil, 0.0, 1.0),
        minLeakDist = x.minLeakDist and math.floor(num(x.minLeakDist, 6, 0, 500)) or nil,
        maxLeakDist = x.maxLeakDist and math.floor(num(x.maxLeakDist, 15, 0, 500)) or nil,
        maxPathDepth = x.maxPathDepth and math.floor(num(x.maxPathDepth, 3, 1, 10)) or nil,
        smallReverb = x.smallReverb and math.floor(num(x.smallReverb, 0, 0, 100)) or nil,
        mediumReverb = x.mediumReverb and math.floor(num(x.mediumReverb, 0, 0, 100)) or nil,
        largeReverb = x.largeReverb and math.floor(num(x.largeReverb, 0, 0, 100)) or nil,
    }
    if next(out) == nil then return nil end
    return out
end

local function sanitizeRule(r)
    if type(r) ~= 'table' then return nil end
    local sound = str(r.sound, 128, nil)
    if not sound then return nil end
    local from, to = num(r.from, 0, 0, 23), num(r.to, 24, 1, 24)
    local out = {
        sound = sound,
        label = str(r.label, 48, nil),
        category = str(r.category, 64, 'ambience_general'),
        weight = num(r.weight, 1.0, 0.0, 100.0),
        minDist = num(r.minDist, 0.0, 0.0, 500.0),
        maxDist = num(r.maxDist, 25.0, 0.5, 1000.0),
        from = math.floor(from), to = math.floor(to),
        every = math.floor(num(r.every, 10, 0, 600)),
        variance = math.floor(num(r.variance, 5, 0, 600)),
        fixed = bool(r.fixed, false),
        occlusion = bool(r.occlusion, true),
        stopRain = bool(r.stopRain, false),
        stopOnLeave = bool(r.stopOnLeave, true),
        followListener = bool(r.followListener, false),
        streaming = bool(r.streaming, false),
        overWater = bool(r.overWater, false),
        startNow = bool(r.startNow, false),
        maxLocal = math.floor(num(r.maxLocal, 255, 1, 255)),
        spawnHeight = math.floor(num(r.spawnHeight, 0, 0, 2)),
    }
    if out.maxDist < out.minDist then out.maxDist = out.minDist end
    if out.fixed then out.x, out.y, out.z = num(r.x, nil), num(r.y, nil), num(r.z, nil) end
    return out
end

local function sanitizeZone(z)
    z = type(z) == 'table' and z or {}
    local out = {
        shape = z.shape == 'sphere' and 'sphere' or 'box',
        width = num(z.width, 10.0, 0.5, 500.0), length = num(z.length, 10.0, 0.5, 500.0), height = num(z.height, 5.0, 0.5, 200.0),
        radius = num(z.radius, 8.0, 0.5, 500.0),
        rotation = math.floor(num(z.rotation, 0, -360, 720)) % 360,
        fade = num(z.fade, 5.0, 0.0, 200.0),
        rulesToPlay = math.floor(num(z.rulesToPlay, 4, 1, 32)),
        scene = str(z.scene, 64, nil),
        environmentRule = str(z.environmentRule, 64, nil),
        rules = {}, vanillaRules = {}, dirAmbiences = {},
    }
    for _, r in ipairs(type(z.rules) == 'table' and z.rules or {}) do
        local c = sanitizeRule(r)
        if c and #out.rules < 16 then out.rules[#out.rules + 1] = c end
    end
    for _, v in ipairs(type(z.vanillaRules) == 'table' and z.vanillaRules or {}) do
        local n = str(v, 64, nil)
        if n and #out.vanillaRules < 16 then out.vanillaRules[#out.vanillaRules + 1] = n:lower() end
    end
    for _, d in ipairs(type(z.dirAmbiences) == 'table' and z.dirAmbiences or {}) do
        local n = type(d) == 'table' and str(d.name, 64, nil) or str(d, 64, nil)
        if n and #out.dirAmbiences < 8 then
            out.dirAmbiences[#out.dirAmbiences + 1] = { name = n:lower(), volume = num(type(d) == 'table' and d.volume or 1.0, 1.0, 0.0, 4.0) }
        end
    end
    return out
end

--- Bounding radius of a zone's activation volume (used for streaming).
local function zoneRange(z)
    if z.shape == 'sphere' then return z.radius + z.fade end
    local w, l, h = z.width + z.fade * 2, z.length + z.fade * 2, z.height + z.fade * 2
    return math.sqrt(w * w + l * l + h * h) / 2
end

local function usedEmitters(exceptId)
    local used = {}
    for id, e in pairs(store) do
        if id ~= exceptId then
            if e.type == 'radio' and e.radio and e.radio.emitter then used[e.radio.emitter:lower()] = e end
            if e.type == 'ambient' and e.ambient and e.ambient.emitter then used[e.ambient.emitter:lower()] = e end
            if e.type == 'static' and e.static and e.static.name then used[e.static.name:lower()] = e end
        end
    end
    return used
end

local function allocRadioEmitter(wanted, exceptId)
    local used = usedEmitters(exceptId)
    if wanted and not used[wanted:lower()] then return wanted end
    for _, name in ipairs(RadioEmitterPool) do
        if not used[name:lower()] then return name end
    end
end

function Elements.sanitize(d, existing)
    if type(d) ~= 'table' or not TYPES[d.type] then return nil, 'invalid type' end
    local e = {
        id = existing and existing.id or genId(),
        type = d.type,
        label = str(d.label, 48, nil),
        group = Lib.sanitizeFilename(d.group) or Config.Place.defaultGroup,
        x = num(d.x, nil), y = num(d.y, nil), z = num(d.z, nil),
        range = num(d.range, Config.Place.defaultRange, 1.0, 300.0),
        enabled = d.enabled ~= false,
        interiorOnly = d.interiorOnly == true,
        interiorHash = math.tointeger(math.floor(num(d.interiorHash, 0))) or 0,
        roomHash = math.tointeger(math.floor(num(d.roomHash, 0))) or 0,
        roomName = str(d.roomName, 64, nil),
        volume = num(d.volume, nil, -30.0, 24.0),
    }
    if not (e.x and e.y and e.z) then return nil, 'invalid coordinates' end
    if math.abs(e.x) > 20000 or math.abs(e.y) > 20000 or math.abs(e.z) > 5000 then return nil, 'outside the map' end

    if type(d.hours) == 'table' then
        local from, to = num(d.hours.from, nil, 0, 23), num(d.hours.to, nil, 0, 24)
        if from and to and not (from == 0 and to == 24) then e.hours = { from = math.floor(from), to = math.floor(to) } end
    end

    if type(d.prop) == 'table' and str(d.prop.model, 64, nil) then
        e.prop = {
            model = str(d.prop.model, 64, nil),
            heading = num(d.prop.heading, 0.0, -360.0, 720.0) % 360.0,
            px = num(d.prop.px, e.x), py = num(d.prop.py, e.y), pz = num(d.prop.pz, e.z),
        }
    end

    if e.type == 'sound' then
        local s = type(d.sound) == 'table' and d.sound or {}
        e.sound = {
            name = str(s.name, 128, nil),
            set = str(s.set, 128, nil),
            bank = str(s.bank, 128, nil),
            bankType = (s.bankType == 'ambient') and 'ambient' or 'script',
            ['repeat'] = s['repeat'] ~= false,
            delayMin = num(s.delayMin, 0, 0, 600),
            delayMax = num(s.delayMax, 0, 0, 600),
        }
        if e.sound.delayMax < e.sound.delayMin then e.sound.delayMax = e.sound.delayMin end
        if not e.sound.name then return nil, 'missing sound name' end
    elseif e.type == 'ambient' then
        local a = type(d.ambient) == 'table' and d.ambient or {}
        local name = str(a.emitter, 64, nil)
        if not name then return nil, 'missing emitter name' end
        local taken = usedEmitters(e.id)[name:lower()]
        if taken then return nil, ('%s is already used by "%s"'):format(name, taken.label or taken.id) end
        e.ambient = { emitter = name, alarm = str(a.alarm, 64, nil), station = str(a.station, 64, nil) }
    elseif e.type == 'radio' then
        local r = type(d.radio) == 'table' and d.radio or {}
        local station = str(r.station, 64, nil)
        if not station then return nil, 'missing radio station' end
        local emitter = allocRadioEmitter(str(r.emitter, 64, existing and existing.radio and existing.radio.emitter), e.id)
        if not emitter then return nil, 'no free radio emitter left in the pool' end
        e.radio = { station = station, emitter = emitter }
    elseif e.type == 'static' then
        local s = type(d.static) == 'table' and d.static or {}
        local name = str(s.name, 64, nil)
        if not name then return nil, 'missing emitter name' end
        e.static = {
            name = name, enabled = s.enabled == true, default = s.default ~= false,
            station = str(s.station, 64, nil),
            vx = num(s.vx, nil), vy = num(s.vy, nil), vz = num(s.vz, nil),
        }
    elseif e.type == 'prop' then
        if not e.prop then return nil, 'missing object model' end
    elseif e.type == 'zone' then
        e.zone = sanitizeZone(d.zone)
        e.range = zoneRange(e.zone)
    end
    if e.type == 'sound' or e.type == 'radio' or e.type == 'ambient' then
        e.emitter = sanitizeEmitter(d.emitter)
    end
    return e
end

-- ##### Store ##### --

local function persist()
    local out = {}
    for _, e in pairs(store) do if not e.pack then out[#out + 1] = e end end
    table.sort(out, function(a, b) return a.id < b.id end)
    save(Config.Storage.elementsFile, out)
end

function Elements.list(group)
    local out = {}
    for _, e in pairs(store) do
        if not group or e.group == group then out[#out + 1] = e end
    end
    table.sort(out, function(a, b) return a.id < b.id end)
    return out
end

function Elements.get(id) return store[tostring(id)] end

--- Flags elements the game already plays from a loaded native file, so clients skip them.
local function decorate(e)
    local c = {}
    for k, v in pairs(e) do c[k] = v end
    c.native = JDT.Export and JDT.Export.isNativeLoaded(e) or nil
    return c
end

function Elements.broadcastAll(target)
    local out = {}
    for _, e in ipairs(Elements.list()) do out[#out + 1] = decorate(e) end
    TriggerLatentClientEvent('jdt:elements', target or -1, Config.Network.serverToClientBPS, out)
end

function Elements.upsert(src, d)
    local existing = type(d) == 'table' and d.id and store[tostring(d.id)] or nil
    if existing and existing.pack then return nil, 'pack element: read-only' end
    local e, err = Elements.sanitize(d, existing)
    if not e then return nil, err end
    store[e.id] = e
    persist()
    TriggerClientEvent('jdt:element', -1, decorate(e))
    return e, existing and 'updated' or 'placed'
end

function Elements.remove(id)
    id = tostring(id)
    local e = store[id]
    if not e then return nil, 'not found' end
    if e.pack then return nil, 'pack element: read-only' end
    store[id] = nil
    persist()
    TriggerClientEvent('jdt:elementRemoved', -1, id)
    return e
end

--- Not saved: switch an element for everyone (e.g. when a club opens).
function Elements.setEnabled(id, state)
    local e = store[tostring(id)]
    if not e then return false end
    e.enabled = state and true or false
    TriggerClientEvent('jdt:element', -1, decorate(e))
    return true
end

function Elements.renameGroup(from, to)
    local n = 0
    for _, e in pairs(store) do
        if e.group == from and not e.pack then e.group = to; n = n + 1 end
    end
    if n > 0 then persist(); Elements.broadcastAll() end
    return n
end

function Elements.packJson(group)
    local items = {}
    for _, e in ipairs(Elements.list(group)) do
        if not e.pack then
            local c = Lib.deepcopy(e)
            c.pack, c.native = nil, nil
            items[#items + 1] = c
        end
    end
    return json.encode(items, { indent = true }), #items
end

-- ##### Sound check ##### --

local function broadcastCheck()
    save(CHECK_FILE, soundCheck)
    TriggerLatentClientEvent('jdt:soundCheck', -1, Config.Network.serverToClientBPS, soundCheck)
end

local function keyList(t, max)
    local out = {}
    if type(t) ~= 'table' then return out end
    for _, k in ipairs(t) do
        if type(k) == 'string' and #k < 260 then out[#out + 1] = k:lower() end
        if #out >= max then break end
    end
    return out
end

function Elements.scanResult(bad, good, total, full)
    bad, good = keyList(bad, 20000), keyList(good, 20000)
    if full then
        soundCheck.bad = bad
        soundCheck.checked = math.floor(num(total, #bad + #good))
    else
        local set = {}
        for _, k in ipairs(soundCheck.bad) do set[k] = true end
        for _, k in ipairs(good) do set[k] = nil end
        for _, k in ipairs(bad) do set[k] = true end
        soundCheck.bad = {}
        for k in pairs(set) do soundCheck.bad[#soundCheck.bad + 1] = k end
        soundCheck.checked = math.max(soundCheck.checked or 0, math.floor(num(total, 0)))
    end
    soundCheck.at = os.date('%Y-%m-%d %H:%M')
    broadcastCheck()
    return #bad
end

function Elements.hideSound(key, state)
    if type(key) ~= 'string' or #key > 260 then return end
    key = key:lower()
    local out = {}
    for _, k in ipairs(soundCheck.hidden) do if k ~= key then out[#out + 1] = k end end
    if state then out[#out + 1] = key end
    soundCheck.hidden = out
    broadcastCheck()
end

function Elements.resetCheck()
    soundCheck = { bad = {}, hidden = {}, checked = 0, at = nil }
    broadcastCheck()
end

function Elements.sendCheck(target)
    TriggerLatentClientEvent('jdt:soundCheck', target, Config.Network.serverToClientBPS, soundCheck)
end

-- ##### Loading ##### --

local function loadFile(path, packName)
    local data = load(path)
    if type(data) ~= 'table' then return 0 end
    local n = 0
    for _, d in ipairs(data) do
        local e, err = Elements.sanitize(d, d.id and { id = tostring(d.id), radio = d.radio } or nil)
        if e then
            if packName then e.pack = packName end
            store[e.id] = e
            n = n + 1
        else
            Lib.print.warn('skipped element in %s: %s', path, tostring(err))
        end
    end
    return n
end

function Elements.init()
    local check = load(CHECK_FILE)
    if type(check) == 'table' then
        soundCheck.bad, soundCheck.hidden = check.bad or {}, check.hidden or {}
        soundCheck.checked, soundCheck.at = check.checked or 0, check.at
    end

    local n = loadFile(Config.Storage.elementsFile)
    -- older emitter saves (data/emitters.json) can be dropped in as-is
    if n == 0 then
        local m = loadFile('data/emitters.json')
        if m > 0 then
            persist()
            Lib.print.info('Imported %d elements from data/emitters.json', m)
            n = m
        end
    end
    for _, p in ipairs(Config.Packs or {}) do
        local c = loadFile(p, p:match('([^/]+)%.json$') or p)
        Lib.print.info('pack %s: %d elements', p, c)
    end
    Lib.print.info('%d placed elements loaded', n)
end

return Elements
