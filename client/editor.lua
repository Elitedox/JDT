--[[
    Aim & place mode: pick something in the panel, press "Place it", aim and press E.
    Ambient zones are drawn as boxes / spheres; while placing one the wheel sets its size and the arrows its rotation.
    Also moves, edits and deletes placed elements by aiming at them.
]]

local Lib, Hash, Player, Preview = JDT.Lib, JDT.Hash, JDT.Player, JDT.Preview

local Editor = {}
JDT.Editor = Editor

local K = Config.Place.keys
local aiming = false           -- aim mode active (panel hidden)
local showMarkers = false      -- draw placed elements (panel open or aiming)
local template = nil           -- element to place
local range = Config.Place.defaultRange
local heightOff, heading = 0.0, 0.0
local group = Config.Place.defaultGroup
local movingId, hoverId = nil, nil
local deleteArmed = { id = nil, t = 0 }
local aim = nil
local ghostObj, ghostModel = nil, nil
local previewPid = nil
local loopRunning = false

local COLORS = {
    sound = { 90, 170, 255 }, ambient = { 70, 210, 195 }, radio = { 255, 165, 60 },
    static = { 120, 215, 130 }, prop = { 190, 140, 255 }, zone = { 255, 110, 190 }, off = { 140, 140, 140 },
}

local function nui(action, data) SendNUIMessage({ action = action, data = data }) end

-- ##### Helpers ##### --

local function rotToDir(rot)
    local rz, rx = math.rad(rot.z), math.rad(rot.x)
    local n = math.abs(math.cos(rx))
    return vector3(-math.sin(rz) * n, math.cos(rz) * n, math.sin(rx))
end

local function raycast()
    local cam = GetGameplayCamCoord()
    local dir = rotToDir(GetGameplayCamRot(2))
    local dest = cam + dir * Config.Place.rayDistance
    local h = StartExpensiveSynchronousShapeTestLosProbe(cam.x, cam.y, cam.z, dest.x, dest.y, dest.z, 1 | 16, PlayerPedId(), 7)
    local _, hit, endC, normal, ent = GetShapeTestResult(h)
    if hit == true or hit == 1 then return endC, normal, cam, dir, ent end -- BOOL out-params come back as booleans in Lua
    return cam + dir * 8.0, vector3(0.0, 0.0, 1.0), cam, dir, 0
end

local function distToRay(p, origin, dir)
    local v = p - origin
    local t = v.x * dir.x + v.y * dir.y + v.z * dir.z
    if t < 0 then return 9999.0 end
    return #(v - dir * t)
end

local function sphere(p, r, c, a)
    DrawMarker(28, p.x, p.y, p.z, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, r, r, r, c[1], c[2], c[3], a, false, false, 2, false, nil, nil, false)
end

local function hasProp(t) return t and t.prop and t.prop.model and t.prop.model ~= '' end

--- The wheel "range" of a zone: its radius, or half its longest side.
local function zoneRange(z)
    if z.shape == 'sphere' then return z.radius or 8.0 end
    return math.max(z.width or 10.0, z.length or 10.0) / 2
end

--- Resizes a zone so its range matches `r`, keeping a box's proportions.
local function sizeZone(z, r)
    if z.shape == 'sphere' then z.radius = r return end
    local k = r / zoneRange(z)
    z.width, z.length = (z.width or 10.0) * k, (z.length or 10.0) * k
end

--- Outline of an ambient zone: inner (where sounds spawn) solid, outer (where it switches on) faint.
local function boxLines(cx, cy, cz, w, l, h, rot, c, a)
    local r = math.rad(rot or 0.0)
    local cs, sn = math.cos(r), math.sin(r)
    local pts = {}
    local sxs, sys = { -1, 1, 1, -1 }, { -1, -1, 1, 1 }
    for i = 1, 4 do
        local lx, ly = sxs[i] * w / 2, sys[i] * l / 2
        pts[i] = { cx + lx * cs - ly * sn, cy + lx * sn + ly * cs }
    end
    local z0, z1 = cz - h / 2, cz + h / 2
    for i = 1, 4 do
        local a1, b1 = pts[i], pts[i % 4 + 1]
        DrawLine(a1[1], a1[2], z0, b1[1], b1[2], z0, c[1], c[2], c[3], a)
        DrawLine(a1[1], a1[2], z1, b1[1], b1[2], z1, c[1], c[2], c[3], a)
        DrawLine(a1[1], a1[2], z0, a1[1], a1[2], z1, c[1], c[2], c[3], a)
    end
end

local function drawZone(e, x, y, z, strong)
    local zz = e.zone
    if not zz then return end
    local c = (e.enabled ~= false) and COLORS.zone or COLORS.off
    local fade = zz.fade or 5.0
    if zz.shape == 'sphere' then
        local r = zz.radius or 8.0
        sphere(vector3(x, y, z), r, c, strong and 45 or 22)
        sphere(vector3(x, y, z), r + fade, c, strong and 18 or 8)
    else
        boxLines(x, y, z, zz.width or 10, zz.length or 10, zz.height or 5, zz.rotation, c, strong and 255 or 170)
        boxLines(x, y, z, (zz.width or 10) + fade * 2, (zz.length or 10) + fade * 2, (zz.height or 5) + fade * 2, zz.rotation, c, strong and 90 or 45)
    end
    for _, r in ipairs(zz.rules or {}) do
        if r.fixed and r.x then sphere(vector3(r.x, r.y, r.z), 0.25, c, 200) end
    end
end
Editor.drawZone = drawZone

function Editor.describe(t)
    if not t then return nil end
    local base
    if t.type == 'sound' then base = ((t.sound.set and t.sound.set ~= '') and (t.sound.set .. ' > ') or '') .. t.sound.name
    elseif t.type == 'ambient' then base = locale('type_ambient') .. ' > ' .. t.ambient.emitter
    elseif t.type == 'radio' then base = locale('type_radio') .. ' > ' .. t.radio.station
    elseif t.type == 'static' then base = locale('type_static') .. ' > ' .. t.static.name
    elseif t.type == 'prop' then return locale('type_prop') .. ' > ' .. t.prop.model
    elseif t.type == 'zone' then
        local z = t.zone or {}
        return locale('type_zone') .. ' > ' .. (t.label or locale('ui_zone_rules_n', #(z.rules or {}) + #(z.vanillaRules or {})))
    end
    if hasProp(t) then base = base .. '  +  ' .. t.prop.model end
    return base
end
local describe = Editor.describe

local function clearGhost()
    if ghostObj and DoesEntityExist(ghostObj) then DeleteEntity(ghostObj) end
    ghostObj, ghostModel = nil, nil
end

local function updateGhost(model, pos)
    if not model then return clearGhost() end
    if model ~= ghostModel then
        clearGhost()
        ghostModel = model
        local hash = Player.loadModel(model)
        if not hash then JDT.notify('error', locale('model_not_found'), model) return end
        ghostObj = CreateObjectNoOffset(hash, pos.x, pos.y, pos.z, false, false, false)
        SetModelAsNoLongerNeeded(hash)
        SetEntityCollision(ghostObj, false, false)
        FreezeEntityPosition(ghostObj, true)
        SetEntityAlpha(ghostObj, 170, false)
    end
    if ghostObj then
        SetEntityCoordsNoOffset(ghostObj, pos.x, pos.y, pos.z, false, false, false)
        SetEntityHeading(ghostObj, heading)
    end
end

-- ##### Placement ##### --

--- Fills position, interior and room of element data from the aimed point.
local function applyPlacement(d)
    local ped = PlayerPedId()
    local pedPos = GetEntityCoords(ped)
    local int = GetInteriorAtCoords(aim.sound.x, aim.sound.y, aim.sound.z)
    -- a point on a wall / floor is often just outside the interior bounds: use the player's interior then
    local pedInt = GetInteriorFromEntity(ped)
    if pedInt ~= 0 and (int == 0 or #(pedPos - aim.sound) < 60.0) then int = pedInt end
    d.x, d.y, d.z, d.range = aim.sound.x, aim.sound.y, aim.sound.z, range
    if d.type == 'zone' and d.zone then
        -- the aimed point is the floor: the zone sits on it
        d.x, d.y, d.z = aim.hit.x, aim.hit.y, aim.hit.z + heightOff + (d.zone.shape == 'sphere' and 0.0 or (d.zone.height or 5.0) / 2)
        d.zone.rotation = math.floor(heading + 0.5) % 360
        if not movingId then sizeZone(d.zone, range) end
    end
    d.interiorHash, d.roomHash, d.roomName = 0, 0, nil
    if int ~= 0 then
        local _, nameHash = GetInteriorLocationAndNamehash(int)
        d.interiorHash = nameHash
        if pedInt == int then
            local key = GetRoomKeyFromEntity(ped)
            d.roomHash = key
            local idx = GetInteriorRoomIndexByHash(int, key)
            if idx and idx >= 0 then d.roomName = GetInteriorRoomName(int, idx) end
        end
    end
    if hasProp(d) then
        d.prop.px, d.prop.py, d.prop.pz, d.prop.heading = aim.prop.x, aim.prop.y, aim.prop.z, heading
    end
    return d
end

local function save(d)
    CreateThread(function() JDT.Rpc.call('elementSave', d) end)
end

local function placeOrConfirm()
    if not aim then return end
    if movingId then
        local e = JDT.Elements[movingId]
        if e then save(applyPlacement(Lib.deepcopy(e))) end
        movingId = nil
        return
    end
    if not template then return JDT.notify('warning', locale('place_pick_first')) end
    local d = Lib.deepcopy(template)
    d.id, d.group, d.enabled = nil, group, true
    save(applyPlacement(d))
end

local function stopPreview()
    if previewPid then Preview.stop(previewPid) previewPid = nil end
end

-- ##### Mode ##### --

function Editor.isAiming() return aiming end
function Editor.getGroup() return group end
function Editor.getRange() return range end

function Editor.setGroup(g)
    g = Lib.sanitizeFilename(g)
    if g then group = g end
end

--- Group to use by default for an interior hash (its project group), or the configured default.
function Editor.defaultGroupFor(projectGroup)
    group = projectGroup or Config.Place.defaultGroup
end

function Editor.setMarkers(on)
    showMarkers = on and true or false
    if showMarkers then Editor.loop() end
end

local function stopAiming(silent)
    aiming = false
    movingId = nil
    stopPreview()
    clearGhost()
    nui('aim', { active = false })
    if not silent and JDT.onAimEnd then JDT.onAimEnd() end
end
Editor.stopAiming = stopAiming

function Editor.startAiming(t)
    if t then
        template = t
        if t.type == 'zone' and t.zone then range = zoneRange(t.zone)
        elseif t.range then range = tonumber(t.range) or range end
    end
    movingId = nil
    aiming = true
    Editor.loop()
    nui('aim', { active = true })
end

function Editor.startMove(id)
    local e = JDT.Elements[id]
    if not e or e.pack then return false end
    movingId, range, heightOff = e.id, e.range, 0.0
    heading = e.prop and e.prop.heading or (e.zone and e.zone.rotation) or heading
    aiming = true
    Editor.loop()
    nui('aim', { active = true })
    return true
end

function Editor.teleport(id)
    local e = JDT.Elements[id]
    if e then SetEntityCoords(PlayerPedId(), e.x, e.y, e.z + 0.5, false, false, false, false) end
end

-- ##### Loop ##### --

local DISABLED = { 24, 25, 37, 38, 44, 45, 47, 73, 74, 14, 15, 16, 17, 140, 141, 142, 257, 263, 264, 99, 100, 115, 116, 261, 262, 174, 175, 177 }

function Editor.loop()
    if loopRunning then return end
    loopRunning = true
    CreateThread(function()
        local lastHud, lastNear, lastLabels = 0, -1000, -1000
        local near = {}   -- ids within draw distance, refreshed ~3x a second instead of scanning every element every frame
        while aiming or showMarkers do
            local now = GetGameTimer()
            if now - lastNear > 300 then
                lastNear = now
                near = {}
                local pp = GetEntityCoords(PlayerPedId())
                local px, py, pz = pp.x, pp.y, pp.z
                local lim = Config.Place.drawDistance + 5.0
                for id, e in pairs(JDT.Elements) do
                    local dx, dy, dz = e.x - px, e.y - py, e.z - pz
                    if dx * dx + dy * dy + dz * dz < lim * lim then near[#near + 1] = id end
                end
            end
            local current = movingId and JDT.Elements[movingId] or template

            local origin, dir
            if aiming then
                local hit, normal, ent
                hit, normal, origin, dir, ent = raycast()
                local lift = vector3(0.0, 0.0, heightOff)
                if hasProp(current) then
                    aim = { prop = hit + lift, sound = hit + lift + vector3(0.0, 0.0, Config.Place.propSoundOffset) }
                else
                    aim = { prop = hit + lift, sound = hit + normal * Config.Place.surfaceOffset + lift }
                end
                aim.hit = hit
                aim.entity = (ent and ent ~= 0 and DoesEntityExist(ent) and GetEntityType(ent) == 3) and ent or nil
                updateGhost(hasProp(current) and current.prop.model or nil, aim.prop)
            else
                clearGhost()
            end

            -- placed elements
            local ped = GetEntityCoords(PlayerPedId())
            local bestId, bestD = nil, 0.8
            local radarLabels = JDT.Emitters and JDT.Emitters.labelsPlaced()
            if radarLabels then JDT.Labels.clear('placed') end
            local wantLabels = now - lastLabels > 150 and not radarLabels
            local labels = wantLabels and {} or nil
            if wantLabels then lastLabels = now end
            for _, id in ipairs(near) do
                local e = JDT.Elements[id]
                if not e then goto continue end
                local p = vector3(e.x, e.y, e.z)
                local dist = #(ped - p)
                if dist < Config.Place.drawDistance and id ~= movingId then
                    local playing = Player.isActive(id)
                    local c = (e.enabled ~= false) and COLORS[e.type] or COLORS.off
                    sphere(p, playing and 0.26 or 0.2, c, playing and 230 or 150)
                    if e.type == 'zone' then
                        local ze = (Player.edit[id] or e)
                        drawZone(ze, ze.x, ze.y, ze.z, JDT.focusElement == id)
                    end
                    if e.type == 'static' and e.static.vx then
                        DrawLine(p.x, p.y, p.z, e.static.vx, e.static.vy, e.static.vz, c[1], c[2], c[3], 160)
                    end
                    if labels and dist < 25.0 then
                        labels['pl:' .. id] = { x = p.x, y = p.y, z = p.z + 0.35, data = {
                            k = 'emitter', name = e.label or e.id, what = describe(e), type = e.type, dist = math.floor(dist * 10 + 0.5) / 10,
                            playing = playing, enabled = e.enabled ~= false, pack = e.pack == true,
                            color = ('#%02x%02x%02x'):format(c[1], c[2], c[3]), sel = JDT.focusElement == id,
                        } }
                    end
                    if origin then
                        local rd = distToRay(p, origin, dir)
                        if rd < bestD then bestD, bestId = rd, id end
                    end
                end
                ::continue::
            end
            if aiming then hoverId = bestId end
            local focus = JDT.focusElement
            if labels then JDT.Labels.set('placed', labels) end
            if focus and JDT.Elements[focus] then
                local e = JDT.Elements[focus]
                if e.type ~= 'prop' and e.type ~= 'zone' then sphere(vector3(e.x, e.y, e.z), e.range, COLORS[e.type], 26) end
                if e.type == 'zone' then
                    local zs = Player.zoneState(focus)
                    for _, r in ipairs(zs and zs.rules or {}) do
                        if r.at and r.playing then
                            sphere(vector3(r.at[1], r.at[2], r.at[3]), 0.3, { 255, 255, 255 }, 220)
                            if labels then
                                labels['rule:' .. r.index] = { x = r.at[1], y = r.at[2], z = r.at[3] + 0.3, data = { k = 'room', i = r.index, name = 'Rule' } }
                            end
                        end
                    end
                end
            end

            if aiming and hoverId and JDT.Elements[hoverId] and not movingId then
                local e = JDT.Elements[hoverId]
                local p = vector3(e.x, e.y, e.z)
                if e.type ~= 'prop' and e.type ~= 'zone' then sphere(p, e.range, COLORS[e.type], 22) end
                sphere(p, 0.35, { 255, 255, 255 }, 120)
            end

            if aiming and aim then
                local c = current and COLORS[current.type] or { 255, 255, 255 }
                sphere(aim.sound, 0.2, { 255, 255, 255 }, 230)
                if current and current.type == 'zone' then
                    local ghost = Lib.deepcopy(current)
                    ghost.zone = ghost.zone or {}
                    ghost.zone.rotation = heading
                    local zh = ghost.zone.height or 5.0
                    if not movingId then sizeZone(ghost.zone, range) end
                    drawZone(ghost, aim.hit.x, aim.hit.y, aim.hit.z + heightOff + (ghost.zone.shape == 'sphere' and 0.0 or zh / 2), true)
                elseif not current or current.type ~= 'prop' then sphere(aim.sound, range, c, 28) end
                if heightOff ~= 0.0 then DrawLine(aim.hit.x, aim.hit.y, aim.hit.z, aim.prop.x, aim.prop.y, aim.prop.z, 255, 255, 255, 180) end
            end

            if aiming then
                for _, ctl in ipairs(DISABLED) do DisableControlAction(0, ctl, true) end
                HideHudComponentThisFrame(19)
                HideHudComponentThisFrame(20)

                local shift = IsControlPressed(0, K.shift)
                if IsDisabledControlJustPressed(0, K.up) then
                    if shift then heightOff = heightOff + 0.1 else range = math.min(300.0, range + (range < 10 and 0.5 or 1.0)) end
                elseif IsDisabledControlJustPressed(0, K.down) then
                    if shift then heightOff = heightOff - 0.1 else range = math.max(1.0, range - (range <= 10 and 0.5 or 1.0)) end
                end
                local dt = GetFrameTime()
                if IsDisabledControlPressed(0, K.rotL) then heading = (heading + Config.Place.rotateSpeed * dt) % 360.0 end
                if IsDisabledControlPressed(0, K.rotR) then heading = (heading - Config.Place.rotateSpeed * dt) % 360.0 end

                if IsDisabledControlJustPressed(0, K.place) then
                    placeOrConfirm()
                elseif IsDisabledControlJustPressed(0, K.grab) then
                    local e = hoverId and JDT.Elements[hoverId]
                    if e and e.pack then JDT.notify('error', locale('pack_read_only'))
                    elseif e then Editor.startMove(e.id) end
                elseif IsDisabledControlJustPressed(0, K.delete) then
                    local e = hoverId and JDT.Elements[hoverId]
                    if e then
                        if e.pack then JDT.notify('error', locale('pack_read_only'))
                        elseif deleteArmed.id == e.id and now - deleteArmed.t < 2000 then
                            CreateThread(function() JDT.Rpc.call('elementDelete', e.id) end)
                            deleteArmed.id = nil
                        else
                            deleteArmed = { id = e.id, t = now }
                            JDT.notify('warning', locale('delete_press_again', e.label or e.id))
                        end
                    end
                elseif IsDisabledControlJustPressed(0, K.edit) then
                    if hoverId and JDT.openEdit then
                        stopAiming(true)
                        JDT.openEdit(hoverId)
                    end
                elseif IsDisabledControlJustPressed(0, K.listen) then
                    if previewPid then stopPreview()
                    elseif current and current.type ~= 'prop' then
                        local t = Lib.deepcopy(current)
                        t.range = range
                        previewPid = Preview.start(t, { x = aim.sound.x, y = aim.sound.y, z = aim.sound.z })
                    end
                elseif IsDisabledControlJustPressed(0, K.menu) then
                    stopAiming(true)
                    if JDT.openPanel then JDT.openPanel() end
                elseif IsDisabledControlJustPressed(0, K.close) then
                    if movingId then movingId = nil else stopAiming() end
                end

                if now - lastHud > 100 then
                    local hover = hoverId and JDT.Elements[hoverId]
                    local int = GetInteriorFromEntity(PlayerPedId())
                    local roomName
                    if int ~= 0 then
                        local idx = GetInteriorRoomIndexByHash(int, GetRoomKeyFromEntity(PlayerPedId()))
                        if idx and idx >= 0 then roomName = GetInteriorRoomName(int, idx) end
                    end
                    nui('hud', {
                        template = describe(template), type = template and template.type,
                        range = range, height = heightOff, heading = heading, showHeading = hasProp(current) or (current ~= nil and current.type == 'zone'),
                        group = group, room = roomName, inside = int ~= 0,
                        moving = movingId and JDT.Elements[movingId] and (JDT.Elements[movingId].label or movingId) or nil,
                        hover = hover and { label = hover.label or hover.id, what = describe(hover), pack = hover.pack } or nil,
                        previewing = previewPid ~= nil,
                    })
                    lastHud = now
                end
            end
            -- panel open but nothing to draw nearby: no need to run every frame
            if not aiming and #near == 0 and not (JDT.focusElement and JDT.Elements[JDT.focusElement]) then
                Wait(250)
            else
                Wait(0)
            end
        end
        clearGhost()
        JDT.Labels.clear('placed')
        loopRunning = false
    end)
end

AddEventHandler('onResourceStop', function(res)
    if res == Lib.resourceName then stopPreview() clearGhost() end
end)

return Editor
