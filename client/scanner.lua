--[[
    Reads interior structure from the game (client only).
]]

local Lib, Hash, Model = JDT.Lib, JDT.Hash, JDT.Model

local Scanner = {}
JDT.Scanner = Scanner

--- Rotate vector v by quaternion q (x, y, z, w).
local function rotate(q, v)
    local x2, y2, z2 = q.x * 2, q.y * 2, q.z * 2
    local wx, wy, wz = q.w * x2, q.w * y2, q.w * z2
    local xx, xy, xz = q.x * x2, q.x * y2, q.x * z2
    local yy, yz, zz = q.y * y2, q.y * z2, q.z * z2
    return {
        x = v.x * (1.0 - yy - zz) + v.y * (xy - wz) + v.z * (xz + wy),
        y = v.x * (xy + wz) + v.y * (1.0 - xx - zz) + v.z * (yz - wx),
        z = v.x * (xz - wy) + v.y * (yz + wx) + v.z * (1.0 - xx - yy),
    }
end
Scanner.rotate = rotate

--- Natives with Vector3* out-params return 3 numbers; some builds return a vector3. Accept both.
local function xyz(a, b, c)
    if type(a) == 'number' then return a, b, c end
    return a.x, a.y, a.z
end
Scanner.xyz = xyz

local function transform(interiorId)
    local px, py, pz = xyz(GetInteriorPosition(interiorId))
    local rx, ry, rz, rw = GetInteriorRotation(interiorId)
    local q = { x = rx, y = ry, z = rz, w = rw }
    local origin = { x = px, y = py, z = pz }
    return function(lx, ly, lz)
        local r = rotate(q, { x = lx, y = ly, z = lz })
        return { x = origin.x + r.x, y = origin.y + r.y, z = origin.z + r.z }
    end, q
end
Scanner.transform = transform

-- hash -> model name, from catalog/objects.json (21k game props), loaded on first use
local modelNames = nil
local function catalogName(hash)
    if not modelNames then
        modelNames = {}
        local raw = LoadResourceFile(Lib.resourceName, 'catalog/objects.json')
        local ok, list = pcall(json.decode, raw or '[]')
        if ok and type(list) == 'table' then
            for _, name in ipairs(list) do modelNames[Hash.joaatU(name)] = name end
        end
    end
    return modelNames[Hash.toUInt32(hash)]
end
Scanner.catalogName = catalogName

local function modelNameFor(hash, pos)
    if pos then
        local obj = GetClosestObjectOfType(pos.x, pos.y, pos.z, 2.0, hash, false, false, false)
        if obj and obj ~= 0 and DoesEntityExist(obj) then
            local name = Lib.archetypeName(obj)
            if name and name ~= '' then return name end
        end
    end
    return catalogName(hash) or ('0x' .. Hash.hex(hash))
end

local function scanPortal(interiorId, toWorld, p)
    local corners = {}
    for c = 0, 3 do
        local lx, ly, lz = xyz(GetInteriorPortalCornerPosition(interiorId, p, c))
        corners[c + 1] = toWorld(lx, ly, lz)
    end

    local entities = {}
    for e = 0, GetInteriorPortalEntityCount(interiorId, p) - 1 do
        local hash = GetInteriorPortalEntityArchetype(interiorId, p, e)
        local lx, ly, lz = xyz(GetInteriorPortalEntityPosition(interiorId, p, e))
        local pos = toWorld(lx, ly, lz)
        entities[e + 1] = { index = e, modelHashKey = hash, modelName = modelNameFor(hash, pos), position = pos }
    end

    return {
        index = p,
        fromRoomIndex = GetInteriorPortalRoomFrom(interiorId, p),
        toRoomIndex = GetInteriorPortalRoomTo(interiorId, p),
        flags = GetInteriorPortalFlag(interiorId, p),
        corners = corners,
        entities = entities,
    }
end

local function modelSize(hash)
    local mn, mx = GetModelDimensions(hash)
    if not mn or not mx then return nil end
    return { x = mx.x - mn.x, y = mx.y - mn.y, z = mx.z - mn.z }
end

--- Door props inside the interior: door-like names, or anything the game's door system knows.
--- Returns { { hash, model, size, pos, registered } }
function Scanner.detectDoors(interiorId)
    local out, seen = {}, {}
    for _, obj in ipairs(GetGamePool('CObject')) do
        if GetInteriorFromEntity(obj) == interiorId then
            local hash = GetEntityModel(obj)
            local u = Hash.toUInt32(hash)
            if not seen[u] then
                local name = Lib.archetypeName(obj)
                local c = GetEntityCoords(obj)
                local registered = DoorSystemFindExistingDoor(c.x, c.y, c.z, hash) and true or false
                if JDT.Doors.isDoorName(name) or registered then
                    seen[u] = true
                    out[#out + 1] = {
                        hash = u, model = (name and name ~= '') and name or ('0x' .. Hash.hex(hash)),
                        size = modelSize(hash), pos = { x = c.x, y = c.y, z = c.z }, registered = registered,
                    }
                end
            end
        end
    end
    return out
end

local function angleDiff(a, b) local d = (a - b + 180.0) % 360.0 - 180.0 return math.abs(d) end

--- Opens a door through the game's door system for a moment (you hear its real sound), then puts it back.
--- Also measures how it moves: swing / sliding / vertical / garage / barrier.
function Scanner.cycleDoor(model, pos)
    model = math.tointeger(tonumber(model)) or 0
    local obj = GetClosestObjectOfType(pos.x, pos.y, pos.z, 2.5, model, false, false, false)
    if obj == 0 or not DoesEntityExist(obj) then return { error = 'not_streamed' } end
    local c0, r0 = GetEntityCoords(obj), GetEntityRotation(obj, 2)
    local right, fwd, up = GetEntityMatrix(obj)

    local found, hash = DoorSystemFindExistingDoor(c0.x, c0.y, c0.z, model)
    local temp = not found
    local prevState, prevRatio = 0, 0.0
    if temp then
        hash = GetHashKey(('mas_probe_%d_%d'):format(model, GetGameTimer()))
        AddDoorToSystem(hash, model, c0.x, c0.y, c0.z, false, false, true)
    else
        prevState, prevRatio = DoorSystemGetDoorState(hash), DoorSystemGetOpenRatio(hash)
    end
    DoorSystemSetDoorState(hash, 0, false, true)
    DoorSystemSetHoldOpen(hash, true)
    DoorSystemSetOpenRatio(hash, 1.0, false, true)

    local yaw, pitch, side, vert = 0.0, 0.0, 0.0, 0.0
    local deadline = GetGameTimer() + 1600
    while GetGameTimer() < deadline do
        Wait(50)
        if not DoesEntityExist(obj) then break end
        local c, r = GetEntityCoords(obj), GetEntityRotation(obj, 2)
        local dv = c - c0
        yaw = math.max(yaw, angleDiff(r.z, r0.z))
        pitch = math.max(pitch, angleDiff(r.x, r0.x), angleDiff(r.y, r0.y))
        side = math.max(side, math.abs(dv.x * right.x + dv.y * right.y + dv.z * right.z), math.abs(dv.x * fwd.x + dv.y * fwd.y + dv.z * fwd.z))
        vert = math.max(vert, math.abs(dv.x * up.x + dv.y * up.y + dv.z * up.z))
    end

    DoorSystemSetOpenRatio(hash, temp and 0.0 or prevRatio, false, true)
    DoorSystemSetHoldOpen(hash, false)
    if temp then
        Wait(900)
        RemoveDoorFromSystem(hash)
    else
        DoorSystemSetDoorState(hash, prevState, false, true)
    end

    local size = modelSize(model) or { x = 1, y = 1, z = 2 }
    local long = math.max(size.x, size.y)
    local kind
    if yaw > 20.0 then kind = 'swing'
    elseif pitch > 20.0 then kind = (long > 3.0 and size.z < 1.2) and 'barrier' or 'garage'
    elseif vert > 0.4 then kind = 'vertical'
    elseif side > 0.3 then kind = 'sliding' end
    return { kind = kind }
end

--- Raw scan table understood by Model.fromScan.
function Scanner.scan(interiorId)
    local location, nameHash = GetInteriorLocationAndNamehash(interiorId)
    local toWorld, q = transform(interiorId)

    local scan = {
        nameHash = nameHash,
        location = (function() local x, y, z = xyz(location) return { x = x, y = y, z = z } end)(),
        rotation = q,
        rooms = {},
        portals = {},
    }

    for r = 0, GetInteriorRoomCount(interiorId) - 1 do
        scan.rooms[r + 1] = { index = r, name = GetInteriorRoomName(interiorId, r) }
    end

    for p = 0, GetInteriorPortalCount(interiorId) - 1 do
        scan.portals[p + 1] = scanPortal(interiorId, toWorld, p)
    end

    scan.doors = Scanner.detectDoors(interiorId)

    Lib.print.verbose('Scanned interior %s: %d rooms, %d portals, %d doors', Hash.hex(nameHash), #scan.rooms, #scan.portals, #scan.doors)
    return scan
end

--- Builds a fresh interior from the game.
function Scanner.build(interiorId)
    local interior = Model.fromScan(Scanner.scan(interiorId))
    interior.interiorId = interiorId
    return interior
end

--- Re-reads geometry (corners, flags, entity positions/names) into loaded save data.
--- Returns false if the MLO layout changed since the save (room / portal counts differ).
function Scanner.refreshGeometry(interior, interiorId)
    if GetInteriorRoomCount(interiorId) ~= #interior.rooms or GetInteriorPortalCount(interiorId) ~= #interior.portals then
        return false
    end

    local toWorld, q = transform(interiorId)
    interior.rotation = q

    for i, portal in ipairs(interior.portals) do
        local fresh = scanPortal(interiorId, toWorld, portal.index or (i - 1))
        portal.flags = math.tointeger(fresh.flags) or 0
        portal.isMirror = (portal.flags & 4) ~= 0
        portal.isInteriorConnector = (portal.flags & 2) ~= 0
        portal.corners = fresh.corners
        portal.needsGeometry = nil
        Model.computePortalGeometry(portal)

        for ei, e in ipairs(portal.entities) do
            local f = fresh.entities[ei]
            if f then
                e.position = f.position
                if not e.modelName or e.modelName == '' or e.modelName:match('^%-?%d+$') or e.modelName:match('^0x') then
                    e.modelName = f.modelName
                end
            end
        end
    end

    Model.computeTopology(interior)
    return true
end

--- Rescans the game but keeps the user's settings where rooms / portals still match.
function Scanner.rescanKeepSettings(old, interiorId)
    local fresh = Scanner.build(interiorId)
    fresh.saveName = old.saveName
    fresh.archetypeName = old.archetypeName
    fresh.notes = old.notes
    fresh.settings = Lib.deepcopy(old.settings)
    fresh.proxyHashOverride = old.proxyHashOverride
    fresh.createdAt = old.createdAt

    local byName = {}
    for _, r in ipairs(old.rooms) do byName[r.name] = r end
    for _, r in ipairs(fresh.rooms) do
        local o = byName[r.name]
        if o then
            r.dat151 = Lib.deepcopy(o.dat151)
            r.preset = o.preset
        end
    end

    for i, p in ipairs(fresh.portals) do
        local o = old.portals[i]
        if o and o.fromRoomIndex == p.fromRoomIndex and o.toRoomIndex == p.toRoomIndex then
            p.isEnabled = { o.isEnabled[1], o.isEnabled[2] }
            for ei, e in ipairs(p.entities) do
                local oe = o.entities[ei]
                if oe and oe.modelHashKey == e.modelHashKey then
                    e.maxOcclusion, e.isDoor, e.isGlass, e.linkType = oe.maxOcclusion, oe.isDoor, oe.isGlass, oe.linkType
                end
            end
        end
    end

    Model.computeHashes(fresh)
    Model.computeTopology(fresh)
    return fresh
end

--- Index of the room the ped is standing in (or -1).
function Scanner.currentRoomIndex(interiorId, ped)
    if not interiorId or interiorId == 0 then return -1 end
    local key = GetRoomKeyFromEntity(ped or PlayerPedId())
    if not key or key == 0 then return -1 end
    return GetInteriorRoomIndexByHash(interiorId, key)
end

return Scanner
