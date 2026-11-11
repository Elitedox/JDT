--[[
    In-world visualisation of portals, entities and the current room (client only).
]]

local Lib = JDT.Lib

local Draw = {}
JDT.DebugDraw = Draw

local state = {
    outline = false,
    fill = false,
    info = false,
    entities = false,     -- outline every portal entity
    navigate = nil,       -- portal index (0-based) to point at
    selected = nil,       -- portal index highlighted in the UI
    debugEntities = {},   -- ["p:e"] = true
}

local interior = nil      -- interior data being drawn
local running = false
local outlined = {}       -- entity handle -> true

local DrawLine, DrawMarker = DrawLine, DrawMarker

local function anyActive()
    if state.entities or state.navigate ~= nil then return true end
    return next(state.debugEntities) ~= nil
end

local function setOutline(entity, on)
    if not entity or entity == 0 or not DoesEntityExist(entity) then return end
    SetEntityDrawOutline(entity, on)
    outlined[entity] = on or nil
end

local function clearOutlines()
    for entity in pairs(outlined) do
        if DoesEntityExist(entity) then SetEntityDrawOutline(entity, false) end
    end
    outlined = {}
end

--- Point-to path, shared by portal navigation and the emitter radar: dashes on the floor that flow
--- toward the target, a beam from the floor up to it and a chevron over it. Returns the 3D distance.
function Draw.path(ped, t, r, g, b)
    local dx, dy, dz = t.x - ped.x, t.y - ped.y, t.z - ped.z
    local flat = math.sqrt(dx * dx + dy * dy)
    local gz = ped.z - 0.95                      -- the ped's feet
    if flat > 0.4 then
        local ux, uy = dx / flat, dy / flat
        local dash, gap = 0.35, 0.25
        local period = dash + gap
        local s0 = 0.4 - period + ((GetGameTimer() / 1000.0) * 1.6) % period
        while s0 < flat do
            local a0, a1 = math.max(s0, 0.4), math.min(s0 + dash, flat)
            if a1 > a0 then
                -- the far end fades so the path reads as "go this way"
                local al = math.floor(230 * (1.0 - 0.6 * (a0 / math.max(flat, 1.0))))
                DrawLine(ped.x + ux * a0, ped.y + uy * a0, gz, ped.x + ux * a1, ped.y + uy * a1, gz, r, g, b, al)
                DrawLine(ped.x + ux * a0, ped.y + uy * a0, gz + 0.01, ped.x + ux * a1, ped.y + uy * a1, gz + 0.01, r, g, b, al)
            end
            s0 = s0 + period
        end
    end
    DrawLine(t.x, t.y, math.min(gz, t.z), t.x, t.y, t.z, r, g, b, 140)
    DrawMarker(2, t.x, t.y, t.z + 0.55, 0.0, 0.0, 0.0, 180.0, 0.0, 0.0, 0.26, 0.26, 0.26,
        r, g, b, 230, false, true, 2, false, nil, nil, false)
    return math.sqrt(dx * dx + dy * dy + dz * dz)
end

local function drawNavigate(ped)
    local portal = interior.portals[state.navigate + 1]
    if not portal or not portal.centroid then return end
    local col = Config.DebugDraw.arrowColor or JDT.accent
    return portal.centroid, Draw.path(ped, portal.centroid, col[1], col[2], col[3])
end

local function updateEntityOutlines()
    local wanted = {}
    for i, portal in ipairs(interior.portals) do
        for ei, e in ipairs(portal.entities) do
            if (state.entities or state.debugEntities[(i - 1) .. ':' .. (ei - 1)]) and e.position then
                local obj = GetClosestObjectOfType(e.position.x, e.position.y, e.position.z, 2.0, e.modelHashKey, false, false, false)
                if obj and obj ~= 0 then wanted[obj] = true end
            end
        end
    end
    for entity in pairs(outlined) do
        if not wanted[entity] then setOutline(entity, false) end
    end
    for entity in pairs(wanted) do
        if not outlined[entity] then setOutline(entity, true) end
    end
end

local function loop()
    if running then return end
    running = true

    local c = Config.DebugDraw.entityOutlineColor
    SetEntityDrawOutlineColor(c[1], c[2], c[3], c[4])
    SetEntityDrawOutlineShader(1)

    CreateThread(function()
        local lastEntityRefresh, lastNav = 0, 0
        while running and interior and anyActive() do
            local ped = PlayerPedId()
            local p = GetEntityCoords(ped)
            local pos = { x = p.x, y = p.y, z = p.z }
            local now = GetGameTimer()

            if state.navigate ~= nil then
                local target, d = drawNavigate(pos)
                if target and now - lastNav > 100 then
                    lastNav = now
                    JDT.Labels.set('nav', { nav = { x = pos.x, y = pos.y, z = pos.z + 1.15,
                        data = { k = 'nav', portal = state.navigate, dist = math.floor(d * 10 + 0.5) / 10 } } })
                end
            elseif lastNav > 0 then
                lastNav = 0
                JDT.Labels.clear('nav')
            end

            if now - lastEntityRefresh > 1000 then
                lastEntityRefresh = now
                updateEntityOutlines()
            end

            Wait(0)
        end
        clearOutlines()
        JDT.Labels.clear('nav')
        running = false
    end)
end

-- ##### API ##### --

function Draw.setInterior(data)
    interior = data
    if not data then
        state.navigate, state.selected = nil, nil
        state.debugEntities = {}
        clearOutlines()
    elseif anyActive() then
        loop()
    end
end

--- patch = { outline?, fill?, info?, entities?, navigate? (number|false), selected? (number|false) }
--- Portal outline / fill / labels / highlight are drawn by ONE renderer (JDT.Inspect overlay), shared with
--- the MLO > Portals tab, so the two tabs can never draw the same portals twice.
function Draw.update(patch)
    for _, k in ipairs({ 'outline', 'fill', 'info', 'entities' }) do
        if patch[k] ~= nil then state[k] = patch[k] == true end
    end
    if patch.navigate ~= nil then state.navigate = tonumber(patch.navigate) end
    if patch.selected ~= nil then state.selected = tonumber(patch.selected) end
    local fwd = {}
    if patch.outline ~= nil or patch.fill ~= nil or patch.info ~= nil then
        fwd.portals = state.outline or state.fill or state.info
        -- switching a part on turns it on in the shared overlay; switching off only hides the overlay,
        -- it never rewrites the style chosen in MLO > Portals
        if patch.outline == true then fwd.outline = true end
        if patch.fill == true then fwd.fill = true end
        if patch.info == true then fwd.labels = true end
    end
    if patch.selected ~= nil then fwd.selected = state.selected or false end
    if next(fwd) and JDT.Inspect then JDT.Inspect.overlay(fwd) end
    if anyActive() and interior then loop() end
end

function Draw.toggleEntity(portalIndex, entityIndex, on)
    local key = ('%d:%d'):format(portalIndex, entityIndex)
    state.debugEntities[key] = on and true or nil
    if anyActive() and interior then loop() end
end

function Draw.getState()
    local entities = {}
    for k in pairs(state.debugEntities) do entities[#entities + 1] = k end
    return {
        outline = state.outline, fill = state.fill, info = state.info, entities = state.entities,
        navigate = state.navigate, selected = state.selected, debugEntities = entities,
    }
end

AddEventHandler('onResourceStop', function(res)
    if res == Lib.resourceName then clearOutlines() end
end)

return Draw
