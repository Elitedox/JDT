--[[
    Utilities (Player, World and Vehicles tabs): noclip, god mode, teleport, weather and time, vehicle spawner (maxed performance parts), repair.
    Natives only - the panel, lists, recent spawns and the noclip HUD are HTML / JS.
    Noclip is a free camera: mouse to aim, W to fly where you look, Shift to boost, wheel for speed.

    Cost when idle: nothing. Noclip runs one frame loop only while flying; god mode re-asserts
    itself twice a second only while it is on.
]]

local Lib = JDT.Lib
local P = {}
JDT.PlayerTools = P

local cfg = Config.Player or {}
local function enabled() return cfg.enabled ~= false end
local function nui(action, data) SendNUIMessage({ action = action, data = data }) end

-- ##### Noclip (free camera) ##### --
--[[ A scripted camera flies freely: the mouse aims it, W / S move along where it looks, A / D strafe,
     E / Q rise and sink, Shift boosts (x4), Ctrl creeps (x0.25), the mouse wheel sets the base speed.
     Your ped (or the vehicle you drive) rides along at the camera, invisible and without collision,
     so the world keeps streaming around you; switching off sets you down on the surface below. ]]

local fly = { on = false, speed = tonumber(cfg.noclipSpeed) or 8.0, ent = 0, cam = nil, yaw = 0.0, pitch = 0.0 }
local SENS = 6.0          -- degrees per frame at full mouse deflection
local KEEP = { 199, 200, 245, 249 }   -- pause menu, chat, push to talk stay usable

local function flyEntity()
    local ped = PlayerPedId()
    local veh = GetVehiclePedIsIn(ped, false)
    if veh ~= 0 and GetPedInVehicleSeat(veh, -1) == ped then return veh end
    return ped
end

local function hud()
    nui('noclipHud', fly.on and { on = true, speed = math.floor(fly.speed * 10 + 0.5) / 10 } or { on = false })
end

local function setFlying(ent, on)
    if ent == 0 or not DoesEntityExist(ent) then return end
    FreezeEntityPosition(ent, on)
    SetEntityCollision(ent, not on, not on)
    SetEntityInvincible(ent, on or P.god == true)
    SetEntityVisible(ent, not on, false)
    if not on then SetEntityVelocity(ent, 0.0, 0.0, 0.0) end
end

local function flyLoop()
    if fly.running then return end   -- off and on again within one frame: the loop that is still alive carries on
    fly.running = true
    CreateThread(function()
        local ped = PlayerPedId()
        local cp = GetGameplayCamCoord()
        local cr = GetGameplayCamRot(2)
        fly.yaw, fly.pitch = cr.z, cr.x
        fly.cam = CreateCamWithParams('DEFAULT_SCRIPTED_CAMERA', cp.x, cp.y, cp.z, cr.x, 0.0, cr.z, GetGameplayCamFov(), true, 2)
        RenderScriptCams(true, true, 250, true, false)
        local x, y, z = cp.x, cp.y, cp.z

        while fly.on do
            local ent = flyEntity()
            if ent ~= fly.ent then setFlying(fly.ent, false) fly.ent = ent setFlying(ent, true) end
            DisableAllControlActions(0)
            for i = 1, #KEEP do EnableControlAction(0, KEEP[i], true) end

            -- the panel has the mouse while it is open: the camera only turns when it is closed
            if not IsNuiFocused() then
                fly.yaw = fly.yaw - GetDisabledControlNormal(0, 1) * SENS
                fly.pitch = math.max(-89.0, math.min(89.0, fly.pitch - GetDisabledControlNormal(0, 2) * SENS))
            end
            if IsDisabledControlJustPressed(0, 241) then fly.speed = math.min(200.0, fly.speed * 1.25) hud() end
            if IsDisabledControlJustPressed(0, 242) then fly.speed = math.max(0.5, fly.speed / 1.25) hud() end

            local mul = IsDisabledControlPressed(0, 21) and 4.0 or (IsDisabledControlPressed(0, 36) and 0.25 or 1.0)
            local step = fly.speed * mul * GetFrameTime()
            local rz, rx = math.rad(fly.yaw), math.rad(fly.pitch)
            local fx, fy, fz = -math.sin(rz) * math.cos(rx), math.cos(rz) * math.cos(rx), math.sin(rx)   -- where the camera looks
            local sx, sy = math.cos(rz), math.sin(rz)                                                    -- camera right, flat
            local mf = (IsDisabledControlPressed(0, 32) and 1 or 0) - (IsDisabledControlPressed(0, 33) and 1 or 0)
            local ms = (IsDisabledControlPressed(0, 35) and 1 or 0) - (IsDisabledControlPressed(0, 34) and 1 or 0)
            local mu = (IsDisabledControlPressed(0, 38) and 1 or 0) - (IsDisabledControlPressed(0, 44) and 1 or 0)   -- E up, Q down
            x = x + (fx * mf + sx * ms) * step
            y = y + (fy * mf + sy * ms) * step
            z = z + (fz * mf + mu) * step

            SetCamCoord(fly.cam, x, y, z)
            SetCamRot(fly.cam, fly.pitch, 0.0, fly.yaw, 2)
            -- the body follows just below the lens, so the world streams around the camera
            SetEntityCoordsNoOffset(ent, x, y, z - 1.0, true, true, true)
            SetEntityHeading(ent, fly.yaw)
            Wait(0)
        end

        local ent = fly.ent
        fly.ent = 0
        setFlying(ent, false)
        RenderScriptCams(false, true, 250, true, false)
        if fly.cam then DestroyCam(fly.cam, false) fly.cam = nil end
        if ent ~= 0 and DoesEntityExist(ent) then
            -- set down on the surface below the camera, facing where you looked
            local ok, gz = GetGroundZFor_3dCoord(x, y, z + 0.5, false)
            SetEntityCoordsNoOffset(ent, x, y, (ok and gz < z) and gz or z - 1.0, true, true, true)
            SetEntityHeading(ent, fly.yaw)
            if IsEntityAVehicle(ent) then SetVehicleOnGroundProperly(ent) end
            SetGameplayCamRelativeHeading(0.0)
        end
        fly.running = false
        if fly.on then fly.ent = 0 flyLoop() end   -- switched back on while landing
    end)
end

function P.noclip(on)
    if not enabled() then return fly.on end
    if on == nil then on = not fly.on end
    on = on == true
    if on == fly.on then return fly.on end
    fly.on = on
    if on then fly.ent = 0 flyLoop() end
    hud()
    return fly.on
end

-- ##### God mode ##### --

P.god = false

local function applyGod(on)
    local ped, pid = PlayerPedId(), PlayerId()
    SetPlayerInvincible(pid, on)
    SetEntityInvincible(ped, on or fly.on)
    SetEntityProofs(ped, on, on, on, on, on, on, on, on)
    SetPedCanRagdoll(ped, not on)
    if on then
        local max = GetEntityMaxHealth(ped)
        if GetEntityHealth(ped) < max then SetEntityHealth(ped, max) end
        if GetPedArmour(ped) < 100 then SetPedArmour(ped, 100) end
    end
end

function P.godMode(on)
    if not enabled() then return P.god end
    if on == nil then on = not P.god end
    on = on == true
    if on == P.god then return P.god end
    P.god = on
    applyGod(on)
    if on then
        CreateThread(function()
            -- respawns, model changes and other scripts can undo it: re-apply twice a second
            while P.god do applyGod(true) Wait(500) end
            applyGod(false)
        end)
    end
    return P.god
end

-- ##### World: weather and time (local to you) ##### --

local world = { on = false, weather = nil, hour = 12, minute = 0, freeze = true }
local WEATHERS = { EXTRASUNNY = 1, CLEAR = 1, NEUTRAL = 1, SMOG = 1, FOGGY = 1, OVERCAST = 1, CLOUDS = 1, CLEARING = 1,
    RAIN = 1, THUNDER = 1, SNOW = 1, BLIZZARD = 1, SNOWLIGHT = 1, XMAS = 1, HALLOWEEN = 1 }
local SNOWY = { XMAS = true, SNOW = true, BLIZZARD = true, SNOWLIGHT = true }

local function applyWeather(w)
    ClearOverrideWeather()
    ClearWeatherTypePersist()
    SetWeatherTypeOvertimePersist(w, 0.0)
    SetWeatherTypeNow(w)
    SetWeatherTypeNowPersist(w)
    SetOverrideWeather(w)
    SetForceVehicleTrails(SNOWY[w] == true)
    SetForcePedFootstepsTracks(SNOWY[w] == true)
end

local function worldLoop()
    CreateThread(function()
        -- weather-sync scripts re-send the server's weather and time: re-assert ours twice a second
        while world.on do
            if world.weather then SetOverrideWeather(world.weather) SetWeatherTypeNowPersist(world.weather) end
            if world.freeze then NetworkOverrideClockTime(world.hour, world.minute, 0) end
            Wait(500)
        end
    end)
end

--- d = { weather, hour, minute, freeze, reset }
function P.world(d)
    if not enabled() then return P.worldState() end
    d = type(d) == 'table' and d or {}
    if d.reset then
        world.on, world.weather = false, nil
        ClearOverrideWeather()
        ClearWeatherTypePersist()
        SetForceVehicleTrails(false)
        SetForcePedFootstepsTracks(false)
        NetworkClearClockTimeOverride()
        return P.worldState()
    end
    local was = world.on
    if d.weather and WEATHERS[tostring(d.weather):upper()] then
        world.weather = tostring(d.weather):upper()
        applyWeather(world.weather)
        world.on = true
    end
    if d.hour ~= nil or d.minute ~= nil then
        world.hour = math.floor(Lib.clamp(tonumber(d.hour) or world.hour, 0, 23))
        world.minute = math.floor(Lib.clamp(tonumber(d.minute) or world.minute, 0, 59))
        NetworkOverrideClockTime(world.hour, world.minute, 0)
        world.on = true
    end
    if d.freeze ~= nil then world.freeze = d.freeze == true world.on = true end
    if world.on and not was then worldLoop() end
    return P.worldState()
end

function P.worldState()
    return { on = world.on, weather = world.weather, hour = world.on and world.hour or GetClockHours(),
        minute = world.on and world.minute or GetClockMinutes(), freeze = world.freeze }
end

-- ##### Teleport ##### --

local function teleportReady()
    if Config.UI and Config.UI.allowTeleport == false then return false, 'Teleporting is switched off on this server (Config.UI.allowTeleport)' end
    if fly.on then P.noclip(false) Wait(300) end   -- the free camera would pull you straight back
    return true
end

--- To exact coordinates (z as given; heading optional).
function P.teleport(x, y, z, h)
    if not enabled() then return { ok = false } end
    x, y, z = tonumber(x), tonumber(y), tonumber(z)
    if not x or not y or not z or math.abs(x) > 20000 or math.abs(y) > 20000 or z < -300 or z > 3000 then
        return { ok = false, error = 'Give x, y and z, e.g. 1769.4193, 2593.2776, 45.7680' }
    end
    local ok, err = teleportReady()
    if not ok then return { ok = false, error = err } end
    JDT.Inspect.teleport(x, y, z, h)
    return { ok = true, x = x, y = y, z = z }
end

--- To the waypoint on the map, standing on the ground there.
function P.toMarker()
    if not enabled() then return { ok = false } end
    local blip = GetFirstBlipInfoId(8)
    if not blip or blip == 0 or not DoesBlipExist(blip) then return { ok = false, error = 'Set a waypoint on the map first' } end
    local ok, err = teleportReady()
    if not ok then return { ok = false, error = err } end
    local c = GetBlipInfoIdCoord(blip)
    local ped = PlayerPedId()
    local ent = IsPedInAnyVehicle(ped, false) and GetVehiclePedIsIn(ped, false) or ped
    FreezeEntityPosition(ent, true)
    -- the map gives no height: drop from high up until the ground under the marker has loaded
    local gz
    for z = 950.0, 0.0, -25.0 do
        SetEntityCoordsNoOffset(ent, c.x, c.y, z, false, false, false)
        RequestCollisionAtCoord(c.x, c.y, z)
        local t = GetGameTimer() + 120
        repeat
            Wait(0)
            local found, g = GetGroundZFor_3dCoord(c.x, c.y, z, false)
            if found then gz = g end
        until gz or GetGameTimer() > t
        if gz then break end
    end
    FreezeEntityPosition(ent, false)
    if not gz then
        local found, g = GetGroundZFor_3dCoord(c.x, c.y, 1000.0, false)
        gz = found and g or c.z
    end
    JDT.Inspect.teleport(c.x, c.y, gz + 1.0)
    return { ok = true, x = c.x, y = c.y, z = gz + 1.0 }
end

-- ##### Vehicles ##### --

local lastSpawn = 0
local PERF = { 11, 12, 13, 15 }   -- engine, brakes, transmission, suspension (top level each); 18 = turbo, 16 = armour

local function control(ent)
    if NetworkHasControlOfEntity(ent) then return true end
    NetworkRequestControlOfEntity(ent)
    local t = GetGameTimer() + 600
    while not NetworkHasControlOfEntity(ent) and GetGameTimer() < t do Wait(0) NetworkRequestControlOfEntity(ent) end
    return NetworkHasControlOfEntity(ent)
end

local function fullTank(veh)
    SetVehicleFuelLevel(veh, 100.0)
    -- the usual fuel scripts keep their own value in a decorator
    if DecorIsRegisteredAsType('_FUEL_LEVEL', 1) then DecorSetFloat(veh, '_FUEL_LEVEL', 100.0) end
end

local function maxPerformance(veh, opts)
    SetVehicleModKit(veh, 0)
    for _, slot in ipairs(PERF) do
        local n = GetNumVehicleMods(veh, slot)
        if n > 0 then SetVehicleMod(veh, slot, n - 1, false) end
    end
    ToggleVehicleMod(veh, 18, true)                                   -- turbo
    if opts.armour ~= false then
        local n = GetNumVehicleMods(veh, 16)
        if n > 0 then SetVehicleMod(veh, 16, n - 1, false) end
    end
    if opts.tyres ~= false then SetVehicleTyresCanBurst(veh, false) end
end

local function vehicleInfo(veh)
    if not veh or veh == 0 or not DoesEntityExist(veh) then return nil end
    local model = GetEntityModel(veh)
    local name = GetDisplayNameFromVehicleModel(model)
    local label = name and GetLabelText(name) or nil
    if not label or label == 'NULL' then label = name end
    local mods = {}
    for _, slot in ipairs(PERF) do
        local n = GetNumVehicleMods(veh, slot)
        if n > 0 then mods[#mods + 1] = { slot = slot, level = GetVehicleMod(veh, slot) + 1, max = n } end
    end
    return {
        handle = veh, name = (name or ''):lower(), label = label or 'Vehicle',
        engine = math.floor(GetVehicleEngineHealth(veh) / 10 + 0.5), body = math.floor(GetVehicleBodyHealth(veh) / 10 + 0.5),
        dirt = math.floor(GetVehicleDirtLevel(veh) / 15 * 100 + 0.5), turbo = IsToggleModOn(veh, 18), mods = mods,
        plate = GetVehicleNumberPlateText(veh), spawned = veh == lastSpawn,
    }
end

--- The vehicle you sit in, or the last one you drove if it is within 10 m.
local function myVehicle()
    local ped = PlayerPedId()
    local veh = GetVehiclePedIsIn(ped, false)
    if veh ~= 0 then return veh end
    veh = GetVehiclePedIsIn(ped, true)
    if veh ~= 0 and DoesEntityExist(veh) and #(GetEntityCoords(veh) - GetEntityCoords(ped)) < 10.0 then return veh end
    return 0
end

--- opts = { model, armour, tyres, seat, replace }
function P.spawn(opts)
    if not enabled() then return { ok = false, error = 'Player tools are switched off in config.lua' } end
    opts = type(opts) == 'table' and opts or {}
    local model = tostring(opts.model or ''):gsub('%s+', '')
    if model == '' then return { ok = false, error = 'Type a vehicle model' } end
    local hash = tonumber(model) or GetHashKey(model)
    if not IsModelInCdimage(hash) or not IsModelAVehicle(hash) then return { ok = false, error = ('"%s" is not a vehicle model in this game build'):format(model) } end

    RequestModel(hash)
    local t = GetGameTimer() + 8000
    while not HasModelLoaded(hash) and GetGameTimer() < t do Wait(0) end
    if not HasModelLoaded(hash) then return { ok = false, error = 'The model did not load in time, try again' } end

    local ped = PlayerPedId()
    -- the vehicle you are leaving behind, and the last spawn (if empty), make room for the new one
    local old = GetVehiclePedIsIn(ped, false)
    if (opts.replace ~= false and (cfg.deletePrevious ~= false)) and lastSpawn ~= 0 and DoesEntityExist(lastSpawn) then
        local empty = true
        for seat = -1, GetVehicleMaxNumberOfPassengers(lastSpawn) - 1 do
            local occ = GetPedInVehicleSeat(lastSpawn, seat)
            if occ ~= 0 and occ ~= ped then empty = false break end
        end
        if empty and control(lastSpawn) then
            if old == lastSpawn then TaskLeaveVehicle(ped, old, 16) old = 0 end
            SetEntityAsMissionEntity(lastSpawn, true, true)
            DeleteVehicle(lastSpawn)
        end
    end

    local p = GetEntityCoords(ped)
    local h = GetEntityHeading(ped)
    local seat = opts.seat ~= false
    local x, y = p.x, p.y
    if not seat then x, y = p.x - math.sin(math.rad(h)) * 4.0, p.y + math.cos(math.rad(h)) * 4.0 end   -- 4 m in front
    local veh = CreateVehicle(hash, x, y, p.z + 0.3, h, true, false)
    SetModelAsNoLongerNeeded(hash)
    if veh == 0 then return { ok = false, error = 'The game refused to create the vehicle (entity limit?)' } end

    SetVehicleOnGroundProperly(veh)
    SetEntityAsMissionEntity(veh, true, true)
    SetVehicleHasBeenOwnedByPlayer(veh, true)
    SetVehicleNeedsToBeHotwired(veh, false)
    SetVehRadioStation(veh, 'OFF')
    SetVehicleDirtLevel(veh, 0.0)
    if cfg.plate and cfg.plate ~= '' then SetVehicleNumberPlateText(veh, tostring(cfg.plate):sub(1, 8)) end
    maxPerformance(veh, opts)
    fullTank(veh)
    if seat then
        SetPedIntoVehicle(ped, veh, -1)
        SetVehicleEngineOn(veh, true, true, false)
    end
    if fly.on then fly.ent = 0 end   -- noclip picks the new vehicle up next frame
    lastSpawn = veh
    return { ok = true, vehicle = vehicleInfo(veh) }
end

function P.repair()
    if not enabled() then return { ok = false, error = 'Player tools are switched off in config.lua' } end
    local veh = myVehicle()
    if veh == 0 then return { ok = false, error = 'Sit in a vehicle (or stand next to the last one you drove)' } end
    if not control(veh) then return { ok = false, error = 'Someone else controls this vehicle' } end
    SetVehicleFixed(veh)
    SetVehicleDeformationFixed(veh)
    SetVehicleEngineHealth(veh, 1000.0)
    SetVehicleBodyHealth(veh, 1000.0)
    SetVehiclePetrolTankHealth(veh, 1000.0)
    SetVehicleDirtLevel(veh, 0.0)
    WashDecalsFromVehicle(veh, 1.0)
    SetVehicleUndriveable(veh, false)
    fullTank(veh)
    if GetPedInVehicleSeat(veh, -1) == PlayerPedId() then SetVehicleEngineOn(veh, true, true, false) end
    return { ok = true, vehicle = vehicleInfo(veh) }
end

--- Max the performance parts of the vehicle you are in.
function P.upgrade(opts)
    if not enabled() then return { ok = false } end
    local veh = myVehicle()
    if veh == 0 then return { ok = false, error = 'Sit in a vehicle first' } end
    if not control(veh) then return { ok = false, error = 'Someone else controls this vehicle' } end
    maxPerformance(veh, type(opts) == 'table' and opts or {})
    return { ok = true, vehicle = vehicleInfo(veh) }
end

function P.state()
    return { enabled = enabled(), noclip = fly.on, god = P.god, speed = fly.speed, key = JDT.Keybinds and JDT.Keybinds.keyName('noclip') or '', vehicle = vehicleInfo(myVehicle()), world = P.worldState() }
end

-- ##### NUI, cleanup (keys: client/keybinds.lua) ##### --


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

cb('pl:state', function() return P.state() end)
cb('pl:noclip', function(d) P.noclip(d.on) return P.state() end)
cb('pl:god', function(d) P.godMode(d.on) return P.state() end)
cb('pl:spawn', function(d) return P.spawn(d) end)
cb('pl:repair', function() return P.repair() end)
cb('pl:upgrade', function(d) return P.upgrade(d) end)
cb('pl:world', function(d) return { ok = true, world = P.world(d) } end)
cb('pl:tp', function(d) return P.teleport(d.x, d.y, d.z, d.h) end)
cb('pl:marker', function() return P.toMarker() end)

AddEventHandler('onResourceStop', function(res)
    if res ~= Lib.resourceName then return end
    if fly.on then
        fly.on = false
        setFlying(fly.ent, false)
        if fly.cam then RenderScriptCams(false, false, 0, true, false) DestroyCam(fly.cam, false) end
    end
    if P.god then P.god = false applyGod(false) end
    if world.on then P.world({ reset = true }) end
end)

return P
