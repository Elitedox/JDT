--[[
    Emitter radar: finds the audio emitters around you and shows them live in the world.

    Sources
      * placed  - everything placed with JDT (sounds, radios, ambient / static emitters, zones)
      * static  - GTA's own static emitters (radios, TVs, alarms ...) from catalog/static_emitters.json

    In the world (only while switched on, only within the chosen distance, nearest N):
      * a core marker in the emitter's colour (larger while it is playing), a thin beam down to the floor
      * optional range sphere
      * an HTML label (name, what it plays, distance, playing) drawn by the panel
    Locate: the shared point-to path (JDT.DebugDraw.path) from you to the chosen emitter.
]]

local Lib, Hash = JDT.Lib, JDT.Hash

local Emitters = {}
JDT.Emitters = Emitters

local COLORS = {
    sound = { 127, 168, 217 }, ambient = { 79, 209, 197 }, radio = { 255, 173, 107 },
    static = { 88, 201, 139 }, zone = { 228, 106, 140 }, prop = { 177, 140, 255 },
    vanilla = { 255, 209, 102 }, off = { 140, 140, 140 },
}

-- ##### Vanilla static emitters (loaded once, bucketed on a 100 m grid for fast lookups) ##### --

local CELL = 100.0
local grid = nil
local staticState = {}   -- emitter name -> true / false set from the panel (nil = game default)

local function cellKey(x, y) return math.floor(x / CELL) .. ':' .. math.floor(y / CELL) end

local function loadStatic()
    if grid then return grid end
    grid = {}
    local raw = LoadResourceFile(Lib.resourceName, 'catalog/static_emitters.json')
    local ok, list = pcall(json.decode, raw or '[]')
    if not ok or type(list) ~= 'table' then return grid end
    for i, s in ipairs(list) do
        if tonumber(s.x) and tonumber(s.y) and tonumber(s.z) then
            local k = cellKey(s.x, s.y)
            grid[k] = grid[k] or {}
            local cat = s.c or ''
            grid[k][#grid[k] + 1] = {
                id = 'v' .. i, src = 'static', type = 'vanilla', label = s.n, x = s.x + 0.0, y = s.y + 0.0, z = s.z + 0.0,
                what = (s.rs and s.rs ~= '') and s.rs or ((s.a and s.a ~= '') and s.a or cat),
                cat = cat, enabled = s.on ~= false, interior = s.i or '', range = 12.0,
            }
        end
    end
    return grid
end

-- ##### Gathering ##### --

local function placedList()
    local out = {}
    for id, e in pairs(JDT.Elements or {}) do
        if e.x and e.y and e.z then
            local what = JDT.Editor and JDT.Editor.describe and JDT.Editor.describe(e) or e.type
            out[#out + 1] = {
                id = id, src = 'placed', type = e.type, label = e.label or id, x = e.x, y = e.y, z = e.z,
                what = what, enabled = e.enabled ~= false, range = tonumber(e.range) or 10.0,
                playing = JDT.Player and JDT.Player.isActive and JDT.Player.isActive(id) or false,
                group = e.group, pack = e.pack == true,
            }
        end
    end
    return out
end

local function staticNear(px, py, radius)
    local g = loadStatic()
    local out = {}
    local r = math.ceil(radius / CELL)
    local cx, cy = math.floor(px / CELL), math.floor(py / CELL)
    for ix = cx - r, cx + r do
        for iy = cy - r, cy + r do
            local list = g[ix .. ':' .. iy]
            if list then for _, s in ipairs(list) do out[#out + 1] = s end end
        end
    end
    return out
end

--- Emitters within radius of the player, nearest first.
--- opts = { radius, limit, placed = bool, static = bool }
function Emitters.near(opts)
    opts = opts or {}
    local radius = Lib.clamp(tonumber(opts.radius) or 80.0, 5.0, 1000.0)
    local limit = math.floor(Lib.clamp(tonumber(opts.limit) or 60, 1, 300))
    local ped = PlayerPedId()
    local p = GetEntityCoords(ped)
    local camH = GetGameplayCamRot(2).z
    local found = {}
    local function add(list)
        for _, e in ipairs(list) do
            local dx, dy, dz = e.x - p.x, e.y - p.y, e.z - p.z
            local d = math.sqrt(dx * dx + dy * dy + dz * dz)
            if d <= radius then
                -- bearing relative to where the camera looks (0 = straight ahead, clockwise)
                local world = math.deg(math.atan(-dx, dy))
                local rel = (world - camH) % 360.0
                found[#found + 1] = { e = e, d = d, rel = rel, dz = dz }
            end
        end
    end
    if opts.placed ~= false then add(placedList()) end
    if opts.static ~= false then add(staticNear(p.x, p.y, radius)) end
    table.sort(found, function(a, b) return a.d < b.d end)
    local out = {}
    for i = 1, math.min(#found, limit) do
        local f = found[i]
        local e = f.e
        local enabled = e.enabled
        if e.src == 'static' and staticState[e.label] ~= nil then enabled = staticState[e.label] end
        out[i] = {
            id = e.id, src = e.src, type = e.type, label = e.label, what = e.what, enabled = enabled, override = e.src == 'static' and staticState[e.label] ~= nil or nil,
            playing = e.playing or false, range = e.range, interior = e.interior, group = e.group, pack = e.pack,
            x = math.floor(e.x * 100 + 0.5) / 100, y = math.floor(e.y * 100 + 0.5) / 100, z = math.floor(e.z * 100 + 0.5) / 100,
            dist = math.floor(f.d * 10 + 0.5) / 10, bearing = math.floor(f.rel + 0.5), dz = math.floor(f.dz * 10 + 0.5) / 10,
        }
    end
    return { list = out, total = #found, radius = radius }
end

local function findById(id)
    if not id then return nil end
    local e = JDT.Elements and JDT.Elements[id]
    if e then
        return { id = id, src = 'placed', type = e.type, label = e.label or id, x = e.x, y = e.y, z = e.z, range = tonumber(e.range) or 10.0 }
    end
    for _, list in pairs(loadStatic()) do
        for _, s in ipairs(list) do if s.id == id then return s end end
    end
    return nil
end

-- ##### Live view ##### --

local view = {
    on = false, distance = 50.0, max = 16, ranges = false, labels = true,
    placed = true, static = true, locate = nil,
}
local running = false

local function colorOf(e)
    if not e.enabled then return COLORS.off end
    return COLORS[e.type] or COLORS.sound
end

local function hex(c) return ('#%02x%02x%02x'):format(c[1], c[2], c[3]) end

local function loop()
    if running then return end
    running = true
    CreateThread(function()
        local picks, lastPick = {}, -1000
        local target = nil
        while view.on or view.locate do
            local now = GetGameTimer()
            local ped = GetEntityCoords(PlayerPedId())
            if now - lastPick > 300 then
                lastPick = now
                picks = {}
                if view.on then
                    local res = Emitters.near({ radius = view.distance, limit = view.max, placed = view.placed, static = view.static })
                    picks = res.list
                end
                target = view.locate and findById(view.locate) or nil
                if view.locate and not target then view.locate = nil end
                -- labels: one per emitter, plus the locate readout
                local labels = {}
                if view.labels then
                    for _, e in ipairs(picks) do
                        labels['em:' .. e.id] = { x = e.x, y = e.y, z = e.z + 0.35, data = {
                            k = 'emitter', name = e.label, what = e.what, type = e.type, dist = e.dist, playing = e.playing,
                            enabled = e.enabled, color = hex(colorOf(e)), sel = view.locate == e.id, vanilla = e.src == 'static',
                        } }
                    end
                end
                if target then
                    local dx, dy, dz = target.x - ped.x, target.y - ped.y, target.z - ped.z
                    labels.locate = { x = ped.x, y = ped.y, z = ped.z + 1.15, data = {
                        k = 'nav', portal = target.label or target.id, title = target.label or target.id,
                        dist = math.floor(math.sqrt(dx * dx + dy * dy + dz * dz) * 10 + 0.5) / 10,
                    } }
                end
                JDT.Labels.set('emitters', labels)
            end

            for _, e in ipairs(picks) do
                local c = colorOf(e)
                local r, g, b = c[1], c[2], c[3]
                -- steady core (a little larger while playing) and a thin beam down to the floor
                local core = e.playing and 0.15 or 0.1
                DrawMarker(28, e.x, e.y, e.z, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, core, core, core,
                    r, g, b, e.enabled and 230 or 110, false, false, 2, false, nil, nil, false)
                DrawLine(e.x, e.y, e.z, e.x, e.y, e.z - 1.2, r, g, b, 70)
                if view.ranges or view.locate == e.id then
                    local rr = (e.range or 10.0) * 2.0
                    DrawMarker(28, e.x, e.y, e.z, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, rr, rr, rr, r, g, b, 18, false, false, 2, false, nil, nil, false)
                end
            end
            if target then local a = JDT.accent JDT.DebugDraw.path(ped, target, a[1], a[2], a[3]) end
            Wait(0)
        end
        JDT.Labels.clear('emitters')
        running = false
    end)
end

--- d: on, distance, max, ranges, labels, placed, static, locate (id | false)
function Emitters.view(d)
    d = d or {}
    for _, k in ipairs({ 'on', 'ranges', 'labels', 'placed', 'static' }) do
        if d[k] ~= nil then view[k] = d[k] == true end
    end
    if d.distance ~= nil then view.distance = Lib.clamp(tonumber(d.distance) or 50, 5, 300) end
    if d.max ~= nil then view.max = math.floor(Lib.clamp(tonumber(d.max) or 16, 1, 60)) end
    if d.locate ~= nil then view.locate = d.locate ~= false and tostring(d.locate) or nil end
    if view.on or view.locate then loop() end
    return { on = view.on, locate = view.locate, distance = view.distance, max = view.max }
end

--- Switch one of GTA's static emitters on / off (on = nil puts the game default back).
function Emitters.setStatic(name, on)
    if type(name) ~= 'string' or name == '' then return false end
    if on == nil then
        staticState[name] = nil
        local def = true
        for _, list in pairs(loadStatic()) do
            for _, s in ipairs(list) do if s.label == name then def = s.enabled end end
        end
        SetStaticEmitterEnabled(name, def)
    else
        staticState[name] = on == true
        SetStaticEmitterEnabled(name, on == true)
    end
    return true
end

--- true while the radar already labels placed elements (the editor then skips its own labels)
function Emitters.labelsPlaced() return view.on and view.labels and view.placed end

function Emitters.teleport(id)
    local e = findById(id)
    if not e then return false end
    if JDT.Inspect and JDT.Inspect.teleport then
        CreateThread(function() JDT.Inspect.teleport(e.x, e.y, e.z + 0.2) end)
        return true
    end
    return false
end

-- ##### NUI ##### --

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

cb('emit:near', function(d) return Emitters.near(d) end)
cb('emit:view', function(d) return Emitters.view(d) end)
cb('emit:teleport', function(d) return { ok = Emitters.teleport(d.id) } end)
cb('emit:static', function(d)
    local on = d.on
    if d.reset then on = nil end
    return { ok = Emitters.setStatic(d.name, on) }
end)

AddEventHandler('onResourceStop', function(res)
    if res ~= Lib.resourceName then return end
    view.on = false
    view.locate = nil
    -- give the game its emitters back
    for name in pairs(staticState) do Emitters.setStatic(name, nil) end
end)

return Emitters
