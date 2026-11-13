--[[
    Live interior inspector (native Lua):
      * rooms: flags + timecycle, read from and written to the running game
      * portals: flags + room links
      * entity sets: activate / deactivate, remembered per interior
      * entities: scan, live visibility / opacity / collision, teleport, in-world box
      * locations: saved positions (kept between sessions), safe teleport
    Everything is pulled by the panel on demand: nothing runs while the panel is closed
    except the in-world box of a selected entity (only while it is switched on).
]]

local Lib, Hash, U = JDT.Lib, JDT.Hash, JDT.InspectUtil

local Inspect = {}
JDT.Inspect = Inspect

local MAX_ENTITIES = 600

-- ##### Helpers ##### --

local function cfg() return Config.Inspect or {} end

local function interiorId()
    local id = GetInteriorFromEntity(PlayerPedId())
    if id ~= 0 and IsValidInterior(id) then return id end
    return 0
end

local function nameHashOf(int)
    local _, nameHash = GetInteriorLocationAndNamehash(int)
    return Hash.toUInt32(math.tointeger(nameHash) or 0)
end

local function u32(v) return Hash.toUInt32(math.tointeger(v) or 0) end

local function currentRoom(int)
    return JDT.Scanner.currentRoomIndex(int)
end

-- Debounced RefreshInterior: many edits in a row cost one reload.
local refreshPending = {}
local function refresh(int)
    if refreshPending[int] then return end
    refreshPending[int] = true
    SetTimeout(120, function()
        refreshPending[int] = nil
        if IsValidInterior(int) then RefreshInterior(int) end
    end)
end

-- ##### Static per-interior data (names, extents, corners never change) ##### --

local meta = {}   -- interior id -> { rooms = { {name, min, max} }, portals = { {corners local, centroid world} } }

local function metaFor(int)
    local m = meta[int]
    local rc, pc = GetInteriorRoomCount(int), GetInteriorPortalCount(int)
    if m and #m.rooms == rc and #m.portals == pc and m.complete then return m end

    m = { rooms = {}, portals = {}, complete = true }
    for r = 0, rc - 1 do
        local name = GetInteriorRoomName(int, r)
        local mn, mx = U.extents(GetInteriorRoomExtents(int, r))
        m.rooms[r + 1] = {
            name = (name and name ~= '') and name or ('room_' .. r),
            min = { U.round(mn[1]), U.round(mn[2]), U.round(mn[3]) },
            max = { U.round(mx[1]), U.round(mx[2]), U.round(mx[3]) },
        }
    end
    local toWorld = JDT.Scanner.transform(int)
    for p = 0, pc - 1 do
        local corners, world, cx, cy, cz = {}, {}, 0.0, 0.0, 0.0
        for c = 0, 3 do
            local lx, ly, lz = U.xyz(GetInteriorPortalCornerPosition(int, p, c))
            if lx == nil then m.complete = false lx, ly, lz = 0.0, 0.0, 0.0 end
            corners[c + 1] = { U.round(lx), U.round(ly), U.round(lz) }
            local w = toWorld(lx, ly, lz)
            world[c + 1] = w
            cx, cy, cz = cx + w.x, cy + w.y, cz + w.z
        end
        local centroid = { x = cx / 4, y = cy / 4, z = cz / 4 }
        m.portals[p + 1] = { corners = corners, world = world, centroid = centroid, insets = {} }
    end
    meta[int] = m
    return m
end

-- ##### Live values + originals (for reset) ##### --

local originals = {} -- interior id -> { rooms = { {flag, tc} }, portals = { {flag, from, to} } }

-- An MLO resource that restarts can come back with moved portals or new flags under the same interior
-- id and the same room / portal counts: forget what is cached, so the next read is the game's.
-- The undo baseline is only dropped for interiors that really went away with the resource, so edits
-- you made elsewhere can still be undone.
local function forgetInteriors(res)
    if res == Lib.resourceName then return end
    meta = {}
    for _, delay in ipairs({ 500, 2500 }) do
        SetTimeout(delay, function()
            meta = {}
            for int in pairs(originals) do
                if not IsValidInterior(int) then originals[int] = nil end
            end
        end)
    end
end
AddEventHandler('onClientResourceStart', forgetInteriors)
AddEventHandler('onClientResourceStop', forgetInteriors)

local function readRoom(int, r)
    return math.tointeger(GetInteriorRoomFlag(int, r)) or 0, u32(GetInteriorRoomTimecycle(int, r))
end

local function readPortal(int, p)
    return math.tointeger(GetInteriorPortalFlag(int, p)) or 0,
        math.tointeger(GetInteriorPortalRoomFrom(int, p)) or 0,
        math.tointeger(GetInteriorPortalRoomTo(int, p)) or 0
end

local function originalsFor(int)
    local o = originals[int]
    local rc, pc = GetInteriorRoomCount(int), GetInteriorPortalCount(int)
    if o and #o.rooms == rc and #o.portals == pc then return o end
    o = { rooms = {}, portals = {} }
    for r = 0, rc - 1 do
        local flag, tc = readRoom(int, r)
        o.rooms[r + 1] = { flag = flag, tc = tc }
    end
    for p = 0, pc - 1 do
        local flag, from, to = readPortal(int, p)
        o.portals[p + 1] = { flag = flag, from = from, to = to }
    end
    originals[int] = o
    return o
end

local function signature(int)
    local vals = { GetInteriorRoomCount(int), GetInteriorPortalCount(int) }
    for r = 0, vals[1] - 1 do
        local flag, tc = readRoom(int, r)
        vals[#vals + 1] = flag
        vals[#vals + 1] = tc
    end
    for p = 0, vals[2] - 1 do
        local flag, from, to = readPortal(int, p)
        vals[#vals + 1] = flag
        vals[#vals + 1] = from
        vals[#vals + 1] = to
    end
    return U.checksum(vals)
end

local function playerPos()
    local ped = PlayerPedId()
    local c = GetEntityCoords(ped)
    return { x = U.round(c.x, 2), y = U.round(c.y, 2), z = U.round(c.z, 2), h = U.round(GetEntityHeading(ped), 1) }
end

--- Light poll for the open panel: where am I, and did anything in the interior change.
function Inspect.live()
    local int = interiorId()
    local out = { id = int, pos = playerPos(), room = -1, sig = 0, key = u32(GetRoomKeyFromEntity(PlayerPedId())),
        ft = U.round(GetFrameTime() * 1000.0, 2) }
    if int ~= 0 then
        out.room = currentRoom(int)
        out.sig = signature(int)
        out.roomName = out.room >= 0 and GetInteriorRoomName(int, out.room) or ''
    end
    return out
end

--- Full snapshot of the interior the player stands in.
function Inspect.state()
    local int = interiorId()
    if int == 0 then return { id = 0, pos = playerPos() } end
    local m = metaFor(int)
    local o = originalsFor(int)
    local rooms, portals = {}, {}
    for r = 0, #m.rooms - 1 do
        local flag, tc = readRoom(int, r)
        local mr, orr = m.rooms[r + 1], o.rooms[r + 1]
        rooms[r + 1] = { i = r, name = mr.name, flag = flag, tc = tc, oflag = orr.flag, otc = orr.tc, min = mr.min, max = mr.max }
    end
    for p = 0, #m.portals - 1 do
        local flag, from, to = readPortal(int, p)
        local mp, op = m.portals[p + 1], o.portals[p + 1]
        portals[p + 1] = { i = p, flag = flag, from = from, to = to, oflag = op.flag, ofrom = op.from, oto = op.to, corners = mp.corners,
            w = { U.round(mp.centroid.x, 2), U.round(mp.centroid.y, 2), U.round(mp.centroid.z, 2) } }
    end
    local loc = GetInteriorLocationAndNamehash(int)
    local lx, ly, lz = U.xyz(loc)
    return {
        id = int, nameHash = nameHashOf(int), room = currentRoom(int), pos = playerPos(), key = u32(GetRoomKeyFromEntity(PlayerPedId())),
        location = { U.round(lx), U.round(ly), U.round(lz) },
        rooms = rooms, portals = portals, sig = signature(int),
    }
end

-- ##### Edits ##### --

local function validRoom(int, r) return math.tointeger(r) and r >= 0 and r < GetInteriorRoomCount(int) end
local function validPortal(int, p) return math.tointeger(p) and p >= 0 and p < GetInteriorPortalCount(int) end

function Inspect.setRoomFlag(r, flag)
    local int = interiorId()
    r, flag = math.tointeger(tonumber(r)), math.tointeger(tonumber(flag))
    if int == 0 or not validRoom(int, r) or not flag then return false end
    originalsFor(int)
    SetInteriorRoomFlag(int, r, flag & 0xffffffff)
    refresh(int)
    return true
end

function Inspect.setRoomTimecycle(r, value)
    local int = interiorId()
    r = math.tointeger(tonumber(r))
    if int == 0 or not validRoom(int, r) then return false end
    local h = U.parseHash(value, Hash.joaatU)
    if not h then return false end
    originalsFor(int)
    SetInteriorRoomTimecycle(int, r, Hash.toInt32(h))
    refresh(int)
    return true
end

function Inspect.setPortalFlag(p, flag)
    local int = interiorId()
    p, flag = math.tointeger(tonumber(p)), math.tointeger(tonumber(flag))
    if int == 0 or not validPortal(int, p) or not flag then return false end
    originalsFor(int)
    SetInteriorPortalFlag(int, p, flag & 0xffffffff)
    refresh(int)
    return true
end

function Inspect.setPortalLink(p, from, to)
    local int = interiorId()
    p = math.tointeger(tonumber(p))
    if int == 0 or not validPortal(int, p) then return false end
    originalsFor(int)
    from, to = math.tointeger(tonumber(from)), math.tointeger(tonumber(to))
    if from and validRoom(int, from) then SetInteriorPortalRoomFrom(int, p, from) end
    if to and validRoom(int, to) then SetInteriorPortalRoomTo(int, p, to) end
    refresh(int)
    return true
end

--- Puts rooms / portals back to the values the game had when JDT first read them.
--- kind = 'all' | 'room' | 'portal', index for the single ones.
function Inspect.reset(kind, index)
    local int = interiorId()
    if int == 0 then return 0 end
    local o = originalsFor(int)
    local n = 0
    if kind == 'all' or kind == 'room' then
        for r, v in ipairs(o.rooms) do
            if kind == 'all' or index == r - 1 then
                local flag, tc = readRoom(int, r - 1)
                if flag ~= v.flag then SetInteriorRoomFlag(int, r - 1, v.flag) n = n + 1 end
                if tc ~= v.tc then SetInteriorRoomTimecycle(int, r - 1, Hash.toInt32(v.tc)) n = n + 1 end
            end
        end
    end
    if kind == 'all' or kind == 'portal' then
        for p, v in ipairs(o.portals) do
            if kind == 'all' or index == p - 1 then
                local flag, from, to = readPortal(int, p - 1)
                if flag ~= v.flag then SetInteriorPortalFlag(int, p - 1, v.flag) n = n + 1 end
                if from ~= v.from then SetInteriorPortalRoomFrom(int, p - 1, v.from) n = n + 1 end
                if to ~= v.to then SetInteriorPortalRoomTo(int, p - 1, v.to) n = n + 1 end
            end
        end
    end
    if n > 0 then refresh(int) end
    return n
end

function Inspect.refreshInterior()
    local int = interiorId()
    if int == 0 then return false end
    RefreshInterior(int)
    return true
end

-- ##### Entity sets (the list of names lives in the panel; Lua only talks to the game) ##### --

function Inspect.sets(names)
    local int = interiorId()
    if int == 0 then return { id = 0, states = {} } end
    local states = {}
    for _, name in ipairs(type(names) == 'table' and names or {}) do
        local clean = U.cleanSetName(name)
        if clean then states[clean] = IsInteriorEntitySetActive(int, clean) == true end
    end
    return { id = int, nameHash = nameHashOf(int), states = states }
end

function Inspect.toggleSet(name, on)
    local int = interiorId()
    name = U.cleanSetName(name)
    if int == 0 or not name then return false end
    if on then ActivateInteriorEntitySet(int, name) else DeactivateInteriorEntitySet(int, name) end
    refresh(int)
    return true
end

--- The interior's entity sets, read by the server from the MLO's .ytyp (server/ytyp.js).
local discoverWait, discoverId = {}, 0
RegisterNetEvent('jdt:ytypSetsResult', function(id, result)
    local p = discoverWait[id]
    if p then discoverWait[id] = nil p:resolve(result) end
end)

function Inspect.discoverSets()
    local int = interiorId()
    if int == 0 then return { found = false, outside = true } end
    discoverId = discoverId + 1
    local id, p = discoverId, promise.new()
    discoverWait[id] = p
    TriggerServerEvent('jdt:ytypSets', id, nameHashOf(int))
    SetTimeout(20000, function() if discoverWait[id] then discoverWait[id] = nil p:resolve({ found = false, error = 'timeout' }) end end)
    local r = Citizen.Await(p) or { found = false }
    r.nameHash = nameHashOf(int)
    return r
end

--- GTA's own interiors: their .ytyp lives in the game archives, out of reach, and no native lists
--- entity sets. But the game only keeps a set switched on when the interior really has it, so every
--- known GTA set name is tried here: on -> still on? -> it exists -> off again. Nothing is refreshed in
--- between, so nothing changes on screen. A made-up name is tried first: if the game "keeps" that too,
--- the test cannot be trusted on this build and only sets that are already on (plus the names known
--- for this interior) are returned.
local gtaCatalog, gtaMap
local function loadJson(file)
    local ok, t = pcall(json.decode, LoadResourceFile(Lib.resourceName, file) or '')
    return ok and type(t) == 'table' and t or nil
end

function Inspect.gtaSets(extra)
    local int = interiorId()
    if int == 0 then return { ok = false } end
    gtaCatalog = gtaCatalog or loadJson('catalog/entitysets.json') or {}
    gtaMap = gtaMap or loadJson('catalog/entitysets_map.json') or { ids = {} }
    local known = (gtaMap.ids or {})[tostring(int)] or {}
    local names, seen = {}, {}
    local function add(n)
        n = U.cleanSetName(n)
        if n and not seen[n:lower()] then seen[n:lower()] = true names[#names + 1] = n end
    end
    for _, n in ipairs(known) do add(n) end
    for _, n in ipairs(type(extra) == 'table' and extra or {}) do add(n) end
    for _, n in ipairs(gtaCatalog) do add(n) end

    local canary = ('jdt_probe_%d_%d'):format(GetGameTimer(), math.random(100000, 999999))
    ActivateInteriorEntitySet(int, canary)
    local reliable = IsInteriorEntitySetActive(int, canary) ~= true
    DeactivateInteriorEntitySet(int, canary)

    local found, has = {}, {}
    for _, n in ipairs(names) do
        if IsInteriorEntitySetActive(int, n) then
            found[#found + 1] = { name = n, on = true } has[n:lower()] = true
        elseif reliable then
            ActivateInteriorEntitySet(int, n)
            if IsInteriorEntitySetActive(int, n) then found[#found + 1] = { name = n, on = false } has[n:lower()] = true end
            DeactivateInteriorEntitySet(int, n)
        end
    end
    if not reliable then
        for _, n in ipairs(known) do if not has[n:lower()] then found[#found + 1] = { name = n, on = false, known = true } end end
    end
    return { ok = true, reliable = reliable, tested = #names, sets = found, id = int }
end

--- Tint an entity set (it has to be on for the tint to show). SetInteriorEntitySetTintIndex is the
--- newer name of SetInteriorEntitySetColor; whichever this build has is used.
function Inspect.tintSet(name, tint)
    local int = interiorId()
    name = U.cleanSetName(name)
    tint = math.floor(tonumber(tint) or -1)
    if int == 0 or not name or tint < 0 or tint > 255 then return false end
    if not IsInteriorEntitySetActive(int, name) then ActivateInteriorEntitySet(int, name) end
    local fn = SetInteriorEntitySetTintIndex or SetInteriorEntitySetColor
    fn(int, name, tint)
    refresh(int)
    return true
end

--- Tint the objects themselves (props with a tint palette: sofas, cabinets, bars...), not an entity set.
--- scope 'room' = objects in the room you stand in, else the whole interior. tint < 0 puts every object
--- JDT tinted back to the tint it had. Objects without a palette simply keep their look.
local objTints = {}   -- entity -> tint it had before JDT touched it
local getObjTint = GetObjectTintIndex or GetObjectTextureVariation
local setObjTint = SetObjectTintIndex or SetObjectTextureVariation
local function objTint(ent)
    local ok, v = pcall(getObjTint, ent)
    return ok and tonumber(v) or 0
end
function Inspect.restoreObjectTints()
    local n = 0
    for ent, orig in pairs(objTints) do
        if DoesEntityExist(ent) then setObjTint(ent, orig) n = n + 1 end
    end
    objTints = {}
    return n
end
function Inspect.tintObjects(tint, scope)
    tint = math.floor(tonumber(tint) or -1)
    if tint < 0 then return { ok = true, count = Inspect.restoreObjectTints() } end
    if tint > 255 then return { ok = false, error = 'Tint goes from 0 to 255' } end
    local int = interiorId()
    if int == 0 then return { ok = false, error = 'Stand inside the interior.' } end
    local ped = PlayerPedId()
    local room = scope == 'room' and GetRoomKeyFromEntity(ped) or nil
    local n = 0
    for _, ent in ipairs(GetGamePool('CObject')) do
        if DoesEntityExist(ent) and GetInteriorFromEntity(ent) == int and (not room or GetRoomKeyFromEntity(ent) == room)
            and not IsEntityAttachedToEntity(ent, ped) then
            if objTints[ent] == nil then objTints[ent] = objTint(ent) end
            setObjTint(ent, tint)
            n = n + 1
        end
    end
    return { ok = true, count = n, tinted = (function() local c = 0 for _ in pairs(objTints) do c = c + 1 end return c end)() }
end

-- ##### Entities ##### --

local modified = {}   -- entity handle -> original { visible, alpha, collision }
local selected = nil  -- entity handle shown in the world
local showBox = false
local dims = {}       -- model hash -> { min, max } (model dimensions never change)

local function modelDims(hash)
    local d = dims[hash]
    if d == nil then
        local ok, mn, mx = pcall(GetModelDimensions, hash)
        d = (ok and mn and mx) and { mn, mx } or false
        dims[hash] = d
    end
    return d or nil
end

local function entityName(ent, hash)
    local name = Lib.archetypeName(ent)
    if name then return name end
    return JDT.Scanner.catalogName(hash) or tostring(Hash.toUInt32(hash))   -- unknown model: its hash as a plain number
end

local function collisionOn(ent)
    if GetEntityCollisionDisabled then return not GetEntityCollisionDisabled(ent) end
    return nil
end

local function remember(ent)
    if modified[ent] then return end
    modified[ent] = { visible = IsEntityVisible(ent), alpha = GetEntityAlpha(ent), collision = collisionOn(ent) }
end

local function describeEntity(ent, from, int)
    local hash = GetEntityModel(ent)
    local c = GetEntityCoords(ent)
    local r = GetEntityRotation(ent, 2)
    local d = modelDims(hash)
    local size = d and { x = U.round(d[2].x - d[1].x, 2), y = U.round(d[2].y - d[1].y, 2), z = U.round(d[2].z - d[1].z, 2) } or { x = 0, y = 0, z = 0 }
    local room = -1
    local eint = GetInteriorFromEntity(ent)
    if eint ~= 0 then
        local key = GetRoomKeyFromEntity(ent)
        if key and key ~= 0 then room = GetInteriorRoomIndexByHash(eint, key) end
    end
    local dist = #(c - from)
    local qx, qy, qz, qw = GetEntityQuaternion(ent)
    return {
        q = { U.round(qx or 0, 6), U.round(qy or 0, 6), U.round(qz or 0, 6), U.round(qw or 1, 6) },
        handle = ent, name = entityName(ent, hash), hash = u32(hash), etype = 'Object',
        x = U.round(c.x), y = U.round(c.y), z = U.round(c.z),
        rx = U.round(r.x, 2), ry = U.round(r.y, 2), rz = U.round(r.z, 2), h = U.round(GetEntityHeading(ent), 2),
        size = size, visible = IsEntityVisible(ent), alpha = GetEntityAlpha(ent), collision = collisionOn(ent),
        lod = GetEntityLodDist and GetEntityLodDist(ent) or nil,
        dist = U.round(dist, 2), room = room, interior = eint, inside = int ~= 0 and eint == int,
        modified = modified[ent] ~= nil, door = DoorSystemFindExistingDoor(c.x, c.y, c.z, hash) and true or false,
    }
end

--- mode 'interior' (objects of the interior you stand in) or 'radius' (objects around you).
function Inspect.scan(mode, radius)
    local ped = PlayerPedId()
    local from = GetEntityCoords(ped)
    local int = interiorId()
    radius = Lib.clamp(tonumber(radius) or (cfg().scanRadius or 40.0), 2.0, 300.0)
    if mode ~= 'radius' and int == 0 then mode = 'radius' end
    local list = {}
    for _, ent in ipairs(GetGamePool('CObject')) do
        if DoesEntityExist(ent) then
            local ok
            if mode == 'radius' then ok = #(GetEntityCoords(ent) - from) <= radius
            else ok = GetInteriorFromEntity(ent) == int end
            if ok then
                -- one object a native chokes on must not cost the whole list
                local good, info = pcall(describeEntity, ent, from, int)
                if good and info then list[#list + 1] = info end
            end
        end
    end
    local total = #list
    while #list > MAX_ENTITIES do list[#list] = nil end
    return { mode = mode, radius = radius, interior = int, total = total, list = list }
end

local function valid(ent)
    ent = math.tointeger(tonumber(ent))
    if ent and ent ~= 0 and DoesEntityExist(ent) and GetEntityType(ent) == 3 then return ent end
    return nil
end

function Inspect.entity(ent)
    ent = valid(ent)
    if not ent then return nil end
    return describeEntity(ent, GetEntityCoords(PlayerPedId()), interiorId())
end

function Inspect.setVisible(ent, on)
    ent = valid(ent)
    if not ent then return nil end
    remember(ent)
    SetEntityVisible(ent, on == true, false)
    return Inspect.entity(ent)
end

function Inspect.setAlpha(ent, alpha)
    ent = valid(ent)
    if not ent then return nil end
    remember(ent)
    local a = math.floor(Lib.clamp(tonumber(alpha) or 255, 0, 255) + 0.5)
    if a >= 255 then ResetEntityAlpha(ent) else SetEntityAlpha(ent, a, false) end
    return Inspect.entity(ent)
end

function Inspect.setCollision(ent, on)
    ent = valid(ent)
    if not ent then return nil end
    remember(ent)
    SetEntityCollision(ent, on == true, on == true)
    return Inspect.entity(ent)
end

--- Undoes every visibility / opacity / collision change JDT made.
function Inspect.restoreEntities()
    local n = 0
    for ent, o in pairs(modified) do
        if DoesEntityExist(ent) then
            SetEntityVisible(ent, o.visible, false)
            if o.alpha >= 255 then ResetEntityAlpha(ent) else SetEntityAlpha(ent, o.alpha, false) end
            if o.collision ~= nil then SetEntityCollision(ent, o.collision, o.collision) end
            n = n + 1
        end
    end
    modified = {}
    return n
end

-- In-world box + label of the selected entity (native drawing; no NUI traffic)
local drawing = false
-- room name for labels: the cached name (GetInteriorRoomName can return nothing for some rooms)
local function roomLabelName(int, r)
    local m = meta[int]
    local mr = m and m.rooms[(r or -1) + 1]
    if mr and mr.name then return mr.name end
    local n = GetInteriorRoomName(int, r)
    return (n and n ~= '') and n or ('room_' .. tostring(r))
end

local function drawLoop()
    if drawing then return end
    drawing = true
    CreateThread(function()
        local c = nil
        local outlined = nil
        local lastLabel = 0
        while selected and showBox do
            local ent = selected
            if not DoesEntityExist(ent) then selected = nil break end
            local want = cfg().boxColor or JDT.accent   -- the panel's accent colour unless config.lua sets one
            if outlined ~= ent or want ~= c then
                -- the object's own silhouette, traced by the game (no box around it)
                if outlined and outlined ~= ent and DoesEntityExist(outlined) then SetEntityDrawOutline(outlined, false) end
                c = want
                SetEntityDrawOutlineColor(c[1], c[2], c[3], 255)
                SetEntityDrawOutlineShader(1)
                SetEntityDrawOutline(ent, true)
                outlined = ent
            end
            local right, fwd, up, origin = GetEntityMatrix(ent)
            -- small axis gizmo at the origin: X red, Y green, Z blue (the object's own rotation)
            local L = 0.35
            local rn, fn, un = U.norm(right), U.norm(fwd), U.norm(up)
            DrawLine(origin.x, origin.y, origin.z, origin.x + rn.x * L, origin.y + rn.y * L, origin.z + rn.z * L, 255, 84, 84, 255)
            DrawLine(origin.x, origin.y, origin.z, origin.x + fn.x * L, origin.y + fn.y * L, origin.z + fn.z * L, 88, 220, 120, 255)
            DrawLine(origin.x, origin.y, origin.z, origin.x + un.x * L, origin.y + un.y * L, origin.z + un.z * L, 90, 150, 255, 255)
            local now = GetGameTimer()
            if now - lastLabel > 120 then
                lastLabel = now
                local dist = #(origin - GetEntityCoords(PlayerPedId()))
                local d = modelDims(GetEntityModel(ent))
                if dist < 60.0 and d then
                    local hash = GetEntityModel(ent)
                    local int, room = GetInteriorFromEntity(ent), -1
                    if int ~= 0 then
                        local key = GetRoomKeyFromEntity(ent)
                        if key and key ~= 0 then room = GetInteriorRoomIndexByHash(int, key) end
                    end
                    JDT.Labels.set('entity', { e = {
                        x = origin.x, y = origin.y, z = origin.z + d[2].z + 0.12,
                        data = {
                            k = 'entity', name = entityName(ent, hash), hash = u32(hash),
                            x = U.round(origin.x, 2), y = U.round(origin.y, 2), z = U.round(origin.z, 2), h = U.round(GetEntityHeading(ent), 1),
                            dist = U.round(dist, 1),
                            sx = U.round(d[2].x - d[1].x, 2), sy = U.round(d[2].y - d[1].y, 2), sz = U.round(d[2].z - d[1].z, 2),
                            visible = IsEntityVisible(ent), alpha = GetEntityAlpha(ent), collision = collisionOn(ent),
                            frozen = IsEntityPositionFrozen(ent), lod = GetEntityLodDist and GetEntityLodDist(ent) or nil,
                            room = room >= 0 and roomLabelName(int, room) or nil,
                            door = DoorSystemFindExistingDoor(origin.x, origin.y, origin.z, hash) and true or false,
                            changed = modified[ent] ~= nil,
                        },
                    } })
                else
                    JDT.Labels.clear('entity')
                end
            end
            Wait(0)
        end
        if outlined and DoesEntityExist(outlined) then SetEntityDrawOutline(outlined, false) end
        JDT.Labels.clear('entity')
        drawing = false
    end)
end

-- ##### Portal overlay (live game data, native drawing, fully configurable from the Portals tab) ##### --

local overlay = {
    portals = false, max = 8, distance = 40.0, labelDistance = 15.0,
    outline = true, fill = true, diagonals = false, fillAlpha = 40, fade = true, onlyRoom = false,
    thickness = 2, glow = true,
    labels = true, textScale = 1.0,
    fields = { id = true, rooms = true, ids = false, flags = true, flagNames = false, distance = false, entities = false },
    colorMode = 'type',   -- 'single' | 'type'
    colors = {
        normal = { 127, 168, 217 }, oneway = { 255, 209, 102 }, mirror = { 79, 209, 197 },
        link = { 88, 201, 139 }, broken = { 255, 94, 98 }, selected = { 255, 122, 26 },
    },
    selected = nil,       -- portal index (0-based) always drawn, highlighted
}
local overlayRunning = false
-- outline thickness -> ribbon width in metres (1 = the plain 1 px line)
local RIBBON = { [2] = 0.012, [3] = 0.024, [4] = 0.04 }
-- inner glow: four thin bands inside the outline, fading out toward the middle ({ from m, to m, opacity })
local GLOW = { { 0, 0.025, 0.46 }, { 0.025, 0.06, 0.27 }, { 0.06, 0.11, 0.14 }, { 0.11, 0.17, 0.06 } }
local PORTAL_HARD_DIST = 150.0

local function portalColor(flag, broken, index)
    local c = overlay.colors
    if overlay.selected == index then return c.selected end
    if overlay.colorMode ~= 'type' then return c.normal end
    if broken then return c.broken end
    if flag & 4 ~= 0 then return c.mirror end
    if flag & 1 ~= 0 then return c.oneway end
    if flag & 2 ~= 0 then return c.link end
    return c.normal
end

local function portalLabel(int, i, flag, from, to, d, col, sel)
    return {
        k = 'portal', i = i, from = from, to = to, flag = flag,
        fromName = roomLabelName(int, from), toName = roomLabelName(int, to),
        attached = GetInteriorPortalEntityCount(int, i), dist = math.floor(d * 10 + 0.5) / 10,
        color = ('#%02x%02x%02x'):format(col[1], col[2], col[3]), sel = sel or nil,
    }
end

-- ##### In-world drawing helpers (DrawLine is 1 px; everything here is a few lines per frame) ##### --

local function tint(c, k) return math.floor(c + (255 - c) * k) end   -- toward white

--- The portal outline pulled `w` metres toward its centre (cached per portal and width).
local function inset(p, wdt)
    if wdt <= 0 then return p.w end
    local key = math.floor(wdt * 1000 + 0.5)
    local pts = p.insets[key]
    if pts then return pts end
    pts = {}
    for i = 1, 4 do
        local q = p.w[i]
        local dx, dy, dz = p.c.x - q.x, p.c.y - q.y, p.c.z - q.z
        local len = math.sqrt(dx * dx + dy * dy + dz * dz)
        local f = len > 0.0001 and math.min(0.45, wdt / len) or 0.0
        pts[i] = { x = q.x + dx * f, y = q.y + dy * f, z = q.z + dz * f }
    end
    p.insets[key] = pts
    return pts
end

--- A solid band between two nested outlines. DrawPoly is one-sided, so each quad is drawn from both sides.
local function band(o, n, r, g, bl, a)
    if a <= 0 then return end
    for i = 1, 4 do
        local j = i == 4 and 1 or i + 1
        local o1, o2, i1, i2 = o[i], o[j], n[i], n[j]
        DrawPoly(o1.x, o1.y, o1.z, o2.x, o2.y, o2.z, i2.x, i2.y, i2.z, r, g, bl, a)
        DrawPoly(o1.x, o1.y, o1.z, i2.x, i2.y, i2.z, i1.x, i1.y, i1.z, r, g, bl, a)
        DrawPoly(i2.x, i2.y, i2.z, o2.x, o2.y, o2.z, o1.x, o1.y, o1.z, r, g, bl, a)
        DrawPoly(i1.x, i1.y, i1.z, i2.x, i2.y, i2.z, o1.x, o1.y, o1.z, r, g, bl, a)
    end
end

local function overlayLoop()
    if overlayRunning then return end
    overlayRunning = true
    CreateThread(function()
        local pick, lastPick, pickInt = {}, -1000, 0
        while overlay.portals or overlay.selected do
            local int = interiorId()
            if int == 0 then
                if #pick > 0 then JDT.Labels.clear('portals') end
                pick = {}
                Wait(300)
            else
                local now = GetGameTimer()
                if now - lastPick > 250 or pickInt ~= int or overlay.dirty then
                    lastPick, pickInt, overlay.dirty = now, int, false
                    local m = metaFor(int)
                    local rc = #m.rooms
                    local cam = GetFinalRenderedCamCoord()
                    local myRoom = overlay.onlyRoom and currentRoom(int) or nil
                    local ranked = {}
                    for i, mp in ipairs(m.portals) do
                        local c = mp.centroid
                        local dx, dy, dz = c.x - cam.x, c.y - cam.y, c.z - cam.z
                        local d = math.sqrt(dx * dx + dy * dy + dz * dz)
                        local sel = overlay.selected == i - 1
                        if sel or (overlay.portals and d <= math.min(overlay.distance, PORTAL_HARD_DIST)) then ranked[#ranked + 1] = { i = i, d = d, sel = sel } end
                    end
                    table.sort(ranked, function(a, b)
                        if a.sel ~= b.sel then return a.sel end
                        return a.d < b.d
                    end)
                    pick = {}
                    local labels = {}
                    for _, r in ipairs(ranked) do
                        if #pick >= overlay.max and not r.sel then break end
                        local idx = r.i - 1
                        local flag, from, to = readPortal(int, idx)
                        if not myRoom or myRoom < 0 or from == myRoom or to == myRoom or r.sel then
                            local broken = from < 0 or to < 0 or from >= rc or to >= rc
                            local col = portalColor(flag, broken, idx)
                            local alpha = 1.0
                            if overlay.fade and not r.sel then alpha = math.max(0.25, 1.0 - (r.d / math.max(overlay.distance, 1.0)) * 0.75) end
                            pick[#pick + 1] = {
                                w = m.portals[r.i].world, c = m.portals[r.i].centroid, col = col, insets = m.portals[r.i].insets,
                                la = math.floor(235 * alpha), fa = math.floor(overlay.fillAlpha * alpha),
                                label = (overlay.labels and (r.d <= overlay.labelDistance or r.sel)) and portalLabel(int, idx, flag, from, to, r.d, col, r.sel) or nil,
                                idx = idx,
                            }
                        end
                    end
                    for _, p in ipairs(pick) do
                        if p.label then labels['p' .. p.idx] = { x = p.c.x, y = p.c.y, z = p.c.z, data = p.label } end
                    end
                    JDT.Labels.set('portals', labels)
                end
                for _, p in ipairs(pick) do
                    local w = p.w
                    if w and #w == 4 then
                        local a, b, c, d = w[1], w[2], w[3], w[4]
                        local r, g, bl = p.col[1], p.col[2], p.col[3]
                        local sel = overlay.selected == p.idx
                        if overlay.fill and p.fa > 0 then
                            local fa = sel and math.min(255, math.floor(p.fa * 1.8)) or p.fa
                            DrawPoly(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, r, g, bl, fa)
                            DrawPoly(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z, r, g, bl, fa)
                            DrawPoly(c.x, c.y, c.z, b.x, b.y, b.z, a.x, a.y, a.z, r, g, bl, fa)
                            DrawPoly(d.x, d.y, d.z, c.x, c.y, c.z, a.x, a.y, a.z, r, g, bl, fa)
                        end
                        if overlay.outline then
                            -- neon tube: a bright rim, the solid outline (thickness), then a soft glow fading inward
                            local la = p.la
                            local bw = RIBBON[overlay.thickness] or 0.0
                            if overlay.glow then
                                local k = sel and 1.6 or 1.0
                                for _, gs in ipairs(GLOW) do
                                    band(inset(p, bw + gs[1]), inset(p, bw + gs[2]), r, g, bl, math.floor(math.min(255, la * gs[3] * k)))
                                end
                            end
                            if bw > 0 then band(w, inset(p, bw), r, g, bl, la) end
                            local tr, tg, tb = tint(r, 0.4), tint(g, 0.4), tint(bl, 0.4)
                            for i = 1, 4 do
                                local q1, q2 = w[i], w[i == 4 and 1 or i + 1]
                                DrawLine(q1.x, q1.y, q1.z, q2.x, q2.y, q2.z, tr, tg, tb, math.min(255, la + 20))
                            end
                            if overlay.diagonals then
                                DrawLine(a.x, a.y, a.z, c.x, c.y, c.z, r, g, bl, la)
                                DrawLine(b.x, b.y, b.z, d.x, d.y, d.z, r, g, bl, la)
                            end
                        end
                    end
                end
                Wait(0)
            end
        end
        JDT.Labels.clear('portals')
        overlayRunning = false
    end)
end

local function rgb(v, fallback)
    if type(v) ~= 'table' then return fallback end
    local out = {}
    for k = 1, 3 do out[k] = math.floor(Lib.clamp(tonumber(v[k]) or fallback[k], 0, 255)) end
    return out
end

--- d: any of portals, maxPortals, distance, labelDistance, outline, fill, diagonals, fillAlpha, fade, onlyRoom,
---    labels, textScale, fields{...}, colorMode, colors{...}, selected (portal index | false), entities
function Inspect.overlay(d)
    local o = overlay
    if d.portals ~= nil then o.portals = d.portals == true end
    if d.maxPortals ~= nil then o.max = math.floor(Lib.clamp(tonumber(d.maxPortals) or 8, 1, 40)) end
    if d.distance ~= nil then o.distance = Lib.clamp(tonumber(d.distance) or 40, 2, PORTAL_HARD_DIST) end
    if d.labelDistance ~= nil then o.labelDistance = Lib.clamp(tonumber(d.labelDistance) or 15, 1, PORTAL_HARD_DIST) end
    if d.fillAlpha ~= nil then o.fillAlpha = math.floor(Lib.clamp(tonumber(d.fillAlpha) or 40, 0, 255)) end
    if d.textScale ~= nil then o.textScale = Lib.clamp(tonumber(d.textScale) or 1, 0.5, 2.0) end
    if d.thickness ~= nil then o.thickness = math.floor(Lib.clamp(tonumber(d.thickness) or 2, 1, 4)) end
    for _, k in ipairs({ 'outline', 'fill', 'diagonals', 'fade', 'onlyRoom', 'labels', 'glow' }) do
        if d[k] ~= nil then o[k] = d[k] == true end
    end
    if type(d.fields) == 'table' then
        for k in pairs(o.fields) do if d.fields[k] ~= nil then o.fields[k] = d.fields[k] == true end end
    end
    if d.colorMode == 'single' or d.colorMode == 'type' then o.colorMode = d.colorMode end
    if type(d.colors) == 'table' then
        for k, v in pairs(o.colors) do o.colors[k] = rgb(d.colors[k], v) end
    end
    if d.selected ~= nil then o.selected = (d.selected ~= false and math.tointeger(tonumber(d.selected))) or nil end
    if d.entities ~= nil then
        showBox = d.entities == true
        if selected and showBox then drawLoop() end
    end
    o.dirty = true
    if o.portals or o.selected then overlayLoop() end
    return { portals = o.portals, maxPortals = o.max, distance = o.distance, entities = showBox, selected = o.selected,
        outline = o.outline, fill = o.fill, labels = o.labels }
end

function Inspect.select(ent, box)
    if box ~= nil then showBox = box == true end
    selected = valid(ent)
    if selected and showBox then drawLoop() end
    return { selected = selected, box = showBox }
end

-- ##### Auto-select: follow the nearest object, or whatever you look at (no clicking) ##### --

local auto = { mode = 'off', radius = 25.0 }
local autoRunning = false

local function aimedHandle()
    local cam = GetGameplayCamCoord()
    local rot = GetGameplayCamRot(2)
    local rz, rx = math.rad(rot.z), math.rad(rot.x)
    local n = math.abs(math.cos(rx))
    local dir = vector3(-math.sin(rz) * n, math.cos(rz) * n, math.sin(rx))
    local dest = cam + dir * (cfg().aimDistance or 30.0)
    local h = StartExpensiveSynchronousShapeTestLosProbe(cam.x, cam.y, cam.z, dest.x, dest.y, dest.z, 16, PlayerPedId(), 7)
    local _, hit, _, _, ent = GetShapeTestResult(h)
    if (hit == true or hit == 1) and valid(ent) then return ent end
    return nil
end

local function nearestHandle()
    local ped = PlayerPedId()
    local p = GetEntityCoords(ped)
    local int = interiorId()
    local best, bestD = nil, auto.radius * auto.radius
    for _, ent in ipairs(GetGamePool('CObject')) do
        local c = GetEntityCoords(ent)
        local dx, dy, dz = c.x - p.x, c.y - p.y, c.z - p.z
        local d = dx * dx + dy * dy + dz * dz
        -- inside an interior only its own objects count (props of the house next door are ignored)
        if d < bestD and (int == 0 or GetInteriorFromEntity(ent) == int) and not IsEntityAttachedToEntity(ent, ped) then
            best, bestD = ent, d
        end
    end
    return best
end

local function autoLoop()
    if autoRunning then return end
    autoRunning = true
    CreateThread(function()
        local last = nil
        while auto.mode ~= 'off' do
            local ent = auto.mode == 'aim' and aimedHandle() or nearestHandle()
            -- looking at nothing keeps the last pick, so the label does not flicker off between objects
            if ent and ent ~= last then
                last = ent
                selected = ent
                showBox = true
                drawLoop()
                SendNUIMessage({ action = 'entAuto', data = describeEntity(ent, GetEntityCoords(PlayerPedId()), interiorId()) })
            end
            Wait(auto.mode == 'aim' and 120 or 250)
        end
        autoRunning = false
    end)
end

--- Object under the crosshair (hold the free-look mouse button to aim with the panel open).
function Inspect.aimed()
    local ent = aimedHandle()
    return ent and Inspect.entity(ent) or nil
end

--- mode: 'off' | 'nearest' | 'aim'
function Inspect.auto(mode, radius)
    if mode == 'nearest' or mode == 'aim' or mode == 'off' then auto.mode = mode end
    if tonumber(radius) then auto.radius = Lib.clamp(tonumber(radius), 2.0, 150.0) end
    if auto.mode ~= 'off' then autoLoop() end
    return { mode = auto.mode, radius = auto.radius, box = showBox }
end

-- ##### Teleport (collision + interior streamed before releasing the player) ##### --

local teleporting = false
function Inspect.teleport(x, y, z, h)
    x, y, z = tonumber(x), tonumber(y), tonumber(z)
    if not x or not y or not z or teleporting then return false end
    if Config.UI and Config.UI.allowTeleport == false then
        JDT.notify('error', locale('ins_teleport_disabled'))
        return false
    end
    teleporting = true
    local ped = PlayerPedId()
    local target = IsPedInAnyVehicle(ped, false) and GetVehiclePedIsIn(ped, false) or ped
    -- whatever goes wrong on the way, the player is released and the next teleport still works
    local ok, err = pcall(function()
        FreezeEntityPosition(target, true)
        SetEntityCoords(target, x + 0.0, y + 0.0, z + 0.0, false, false, false, false)
        if tonumber(h) then SetEntityHeading(target, tonumber(h) + 0.0) end
        local deadline = GetGameTimer() + 5000
        local int = GetInteriorAtCoords(x + 0.0, y + 0.0, z + 0.0)
        if int ~= 0 then PinInteriorInMemory(int) end
        while GetGameTimer() < deadline do
            RequestCollisionAtCoord(x + 0.0, y + 0.0, z + 0.0)
            local ready = HasCollisionLoadedAroundEntity(target) and (int == 0 or IsInteriorReady(int))
            if ready then break end
            Wait(0)
        end
        if int ~= 0 then UnpinInterior(int) end
    end)
    if DoesEntityExist(target) then FreezeEntityPosition(target, false) end
    teleporting = false
    if not ok then Lib.print.error('teleport failed: %s', tostring(err)) return false end
    return true
end

-- ##### Where am I (for saving a location in the panel) ##### --

function Inspect.here()
    local int = interiorId()
    local out = playerPos()
    out.interior, out.room = '', ''
    if int ~= 0 then
        out.interior = tostring(Hash.toUInt32(nameHashOf(int)))
        local r = currentRoom(int)
        if r >= 0 then out.room = GetInteriorRoomName(int, r) end
    end
    return out
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

cb('ins:live', function() return Inspect.live() end)
cb('ins:state', function() return Inspect.state() end)
cb('ins:roomFlag', function(d) return { ok = Inspect.setRoomFlag(d.room, d.flag), state = Inspect.state() } end)
cb('ins:roomTc', function(d) return { ok = Inspect.setRoomTimecycle(d.room, d.value), state = Inspect.state() } end)
cb('ins:portalFlag', function(d) return { ok = Inspect.setPortalFlag(d.portal, d.flag), state = Inspect.state() } end)
cb('ins:portalLink', function(d) return { ok = Inspect.setPortalLink(d.portal, d.from, d.to), state = Inspect.state() } end)
cb('ins:reset', function(d)
    local n = Inspect.reset(d.kind or 'all', math.tointeger(tonumber(d.index)))
    return { ok = true, changed = n, state = Inspect.state() }
end)
cb('ins:overlay', function(d) return Inspect.overlay(d) end)
cb('ins:refresh', function() return { ok = Inspect.refreshInterior() } end)
cb('sets:discover', function() return Inspect.discoverSets() end)
cb('sets:gta', function(d) return Inspect.gtaSets(d.names) end)
cb('sets:tint', function(d) return { ok = Inspect.tintSet(d.name, d.tint) } end)
cb('objs:tint', function(d) return Inspect.tintObjects(d.tint, d.scope) end)

cb('sets:check', function(d) return Inspect.sets(d.names) end)
cb('sets:toggle', function(d)
    local ok = Inspect.toggleSet(d.name, d.on == true)
    local out = Inspect.sets(d.names or { d.name })
    out.ok = ok
    return out
end)

cb('ent:scan', function(d) return Inspect.scan(d.mode, d.radius) end)
cb('ent:get', function(d) return { entity = Inspect.entity(d.handle) } end)
cb('ent:visible', function(d) return { entity = Inspect.setVisible(d.handle, d.on) } end)
cb('ent:alpha', function(d) return { entity = Inspect.setAlpha(d.handle, d.alpha) } end)
cb('ent:collision', function(d) return { entity = Inspect.setCollision(d.handle, d.on) } end)
cb('ent:select', function(d) return Inspect.select(d.handle, d.box) end)
cb('ent:aimed', function() return { entity = Inspect.aimed() } end)
cb('ent:auto', function(d) return Inspect.auto(d.mode, d.radius) end)
cb('ent:restore', function() return { restored = Inspect.restoreEntities() } end)
cb('ent:teleport', function(d)
    local e = Inspect.entity(d.handle)
    if not e then return { ok = false } end
    return { ok = Inspect.teleport(e.x, e.y, e.z + 1.0) }
end)

cb('here', function() return Inspect.here() end)
cb('teleport', function(d) return { ok = Inspect.teleport(d.x, d.y, d.z, d.h) } end)

--- GTA's own interiors (Locations > GTA interiors): load the IPLs an interior needs, then go there.
--- IPLs stay loaded (another resource may use them too); ones already on are left alone.
function Inspect.gotoInterior(d)
    local loaded = 0
    if type(d.ipls) == 'table' then
        for i = 1, math.min(#d.ipls, 60) do
            local n = d.ipls[i]
            if type(n) == 'string' and n:match('^[%w_]+$') and #n <= 96 and not IsIplActive(n) then
                RequestIpl(n)
                loaded = loaded + 1
            end
        end
    end
    if loaded > 0 then Wait(100) end
    local ok = Inspect.teleport(d.x, d.y, (tonumber(d.z) or 0) + 0.5, d.h)
    local int = ok and GetInteriorAtCoords(tonumber(d.x) + 0.0, tonumber(d.y) + 0.0, tonumber(d.z) + 0.0) or 0
    if int ~= 0 then RefreshInterior(int) end
    return { ok = ok, loaded = loaded, interior = int }
end
cb('interior:goto', function(d) return Inspect.gotoInterior(d) end)

AddEventHandler('onResourceStop', function(res)
    if res ~= Lib.resourceName then return end
    selected = nil
    auto.mode = 'off'
    overlay.portals = false
    overlay.selected = nil
    Inspect.restoreEntities()
    Inspect.restoreObjectTints()
end)

return Inspect
