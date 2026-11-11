--[[
    Placed-element player: streams sounds, vanilla emitters, radios, mute zones, objects and ambient zones
    around the player, and keeps custom sound banks loaded where room tones / zone rules need them.

    Used two ways:
      - by jdt itself (client/player.lua drives it, with live overrides from the editor)
      - copied into exported resources as client/player.lua, preceded by a `local DATA_JSON = ...` line,
        so the audio keeps working without the tool.

]]

local function newPlayer(cfg)
    cfg = cfg or {}
    local C = {
        tickMs = cfg.tickMs or 250,
        maxActive = cfg.maxActive or 24,
        streamMargin = cfg.streamMargin or 5.0,
        propDistance = cfg.propDistance or 120.0,
        supportModel = cfg.supportModel or 'prop_boombox_01',
        label = cfg.label or 'player',
    }

    local P = {
        elements = {},     -- id -> element
        override = {},     -- id -> true / false (local on / off)
        edit = {},         -- id -> element data being edited (live, not saved)
        solo = nil,        -- id: only this element plays
        muted = false,     -- mute every element
        skip = nil,        -- function(e) -> true to never play (native / played elsewhere)
    }

    local active, props, banks, interiorCache = {}, {}, {}, {}
    local joaat = joaat or GetHashKey

    -- ##### Loading helpers ##### --

    local function loadBank(name, kind)
        if not name then return true end
        if banks[name] then banks[name] = banks[name] + 1 return true end
        local deadline, ok = GetGameTimer() + 3000, false
        while GetGameTimer() < deadline do
            if kind == 'ambient' then ok = RequestAmbientAudioBank(name, false) else ok = RequestScriptAudioBank(name, false) end
            if ok then break end
            Wait(50)
        end
        if not ok then
            print(('^3[%s] audio bank not found: %s^7'):format(C.label, name))
            return false
        end
        banks[name] = 1
        return true
    end

    local function releaseBank(name, kind)
        if not name or not banks[name] then return end
        banks[name] = banks[name] - 1
        if banks[name] <= 0 then
            banks[name] = nil
            if kind ~= 'ambient' then ReleaseNamedScriptAudioBank(name) end
        end
    end

    local function loadModel(model)
        local hash = type(model) == 'number' and model or joaat(model)
        if not IsModelInCdimage(hash) then return nil end
        RequestModel(hash)
        local deadline = GetGameTimer() + 3000
        while not HasModelLoaded(hash) and GetGameTimer() < deadline do Wait(10) end
        return HasModelLoaded(hash) and hash or nil
    end
    P.loadModel = loadModel

    -- ##### Audio primitives ##### --

    --- P.router(name, set, x, y, z, range) may return a handle table { stop = fn, finished = fn }
    --- to play a sound some other way (the editor uses it for custom sounds the game has not loaded yet).
    local function playSound(name, set, x, y, z, range, soundId)
        if P.router then
            if type(soundId) == 'table' then soundId.stop() soundId = nil end
            local h = P.router(name, set, x, y, z, range)
            if h then
                if soundId then ReleaseSoundId(soundId) end
                return h
            end
        end
        local id = (type(soundId) == 'number') and soundId or GetSoundId()
        PlaySoundFromCoord(id, name, x, y, z, (set and set ~= '') and set or 0, false, math.floor(range or 0), false)
        return id
    end
    P.playSound = playSound

    local function soundFinished(id)
        if type(id) == 'table' then return id.finished() end
        return HasSoundFinished(id)
    end
    P.soundFinished = soundFinished

    local function soundStop(id)
        if type(id) == 'table' then id.stop() return end
        StopSound(id)
        ReleaseSoundId(id)
    end
    P.soundStop = soundStop

    -- ##### Ambient zones (live emulation of the native AmbientZone / AmbientRule) ##### --

    local function zoneDims(e)
        local z = e.zone
        local fade = z.fade or 5.0
        if z.shape == 'sphere' then
            local r = z.radius or 10.0
            return { r = r }, { r = r + fade }
        end
        local w, l, h = z.width or 10.0, z.length or 10.0, z.height or 5.0
        return { w = w, l = l, h = h }, { w = w + fade * 2, l = l + fade * 2, h = h + fade * 2 }
    end

    local function toLocal(e, x, y, z)
        local a = -math.rad(e.zone.rotation or 0.0)
        local dx, dy = x - e.x, y - e.y
        return dx * math.cos(a) - dy * math.sin(a), dx * math.sin(a) + dy * math.cos(a), z - e.z
    end

    local function toWorld(e, lx, ly, lz)
        local a = math.rad(e.zone.rotation or 0.0)
        return e.x + lx * math.cos(a) - ly * math.sin(a), e.y + lx * math.sin(a) + ly * math.cos(a), e.z + lz
    end

    local function inVolume(e, v, x, y, z)
        if v.r then
            local dx, dy, dz = x - e.x, y - e.y, z - e.z
            return dx * dx + dy * dy + dz * dz <= v.r * v.r
        end
        local lx, ly, lz = toLocal(e, x, y, z)
        return math.abs(lx) <= v.w / 2 and math.abs(ly) <= v.l / 2 and math.abs(lz) <= v.h / 2
    end
    P.zoneDims, P.inVolume = zoneDims, inVolume

    local function randomIn(e, v)
        if v.r then
            local a, b = math.random() * math.pi * 2, math.acos(2 * math.random() - 1)
            local r = v.r * (math.random() ^ (1 / 3))
            return e.x + r * math.sin(b) * math.cos(a), e.y + r * math.sin(b) * math.sin(a), e.z + r * math.cos(b) * 0.5
        end
        return toWorld(e, (math.random() - 0.5) * v.w, (math.random() - 0.5) * v.l, (math.random() - 0.5) * v.h)
    end

    local function spawnPoint(e, rule, inner, px, py, pz)
        if rule.fixed then return rule.x or e.x, rule.y or e.y, rule.z or e.z end
        local lo, hi = rule.minDist or 0.0, rule.maxDist or 25.0
        for _ = 1, 12 do
            local x, y, z = randomIn(e, inner)
            local d = math.sqrt((x - px) ^ 2 + (y - py) ^ 2 + (z - pz) ^ 2)
            if d >= lo and d <= hi then return x, y, z end
        end
        return randomIn(e, inner)
    end

    local function hoursOk(from, to)
        from, to = from or 0, to or 24
        if from == 0 and to == 24 then return true end
        local now = GetClockHours()
        if from <= to then return now >= from and now < to end
        return now >= from or now < to
    end

    local function chooseRules(rules, n)
        local idx = {}
        for i in ipairs(rules) do idx[#idx + 1] = i end
        if #idx <= n then return idx end
        local out, pool = {}, idx
        for _ = 1, n do
            local total = 0
            for _, i in ipairs(pool) do total = total + (rules[i].weight or 1.0) end
            local pick, acc = math.random() * total, 0
            for k, i in ipairs(pool) do
                acc = acc + (rules[i].weight or 1.0)
                if pick <= acc then out[#out + 1] = i; table.remove(pool, k); break end
            end
        end
        return out
    end

    local function zoneStopAll(st)
        for _, rs in pairs(st.rules or {}) do
            if rs.soundId then soundStop(rs.soundId) rs.soundId = nil end
        end
    end

    local function zoneTick(st, e, px, py, pz, now)
        local inner, outer = zoneDims(e)
        local inside = inVolume(e, outer, px, py, pz)
        if not inside then
            if st.inside then zoneStopAll(st) st.rules = {} end
            st.inside = false
            return
        end
        local rules = e.zone.rules or {}
        if not st.inside then
            st.inside = true
            st.rules = {}
            for _, i in ipairs(chooseRules(rules, e.zone.rulesToPlay or 4)) do
                local r = rules[i]
                local first = r.startNow and 0 or math.random() * (r.every or 10)
                st.rules[i] = { nextAt = now + math.floor(first * 1000) }
            end
        end
        for i, rs in pairs(st.rules) do
            local r = rules[i]
            if r and r.sound then
                if not hoursOk(r.from, r.to) then
                    if rs.soundId then soundStop(rs.soundId) rs.soundId = nil end
                elseif rs.soundId and not soundFinished(rs.soundId) then
                    -- still playing (loops keep playing while you are in the zone)
                elseif now >= rs.nextAt then
                    local x, y, z = spawnPoint(e, r, inner, px, py, pz)
                    rs.soundId = playSound(r.sound, nil, x, y, z, r.maxDist or 25.0, rs.soundId)
                    rs.at = { x, y, z }
                    rs.nextAt = now + math.floor(((r.every or 10) + math.random() * (r.variance or 0)) * 1000)
                end
            end
        end
    end

    function P.zoneState(id)
        local st = active[id]
        if not st or st.type ~= 'zone' then return nil end
        local out = { inside = st.inside, rules = {} }
        for i, rs in pairs(st.rules or {}) do
            out.rules[#out.rules + 1] = { index = i, playing = rs.soundId ~= nil and not soundFinished(rs.soundId), at = rs.at }
        end
        return out
    end

    --- Moves a vanilla static emitter onto an entity (a placed object, or an invisible anchor made here).
    local function attachEmitter(emitter, x, y, z, entity)
        local owned = nil
        if not entity or not DoesEntityExist(entity) then
            local hash = loadModel(C.supportModel)
            if not hash then return nil end
            entity = CreateObjectNoOffset(hash, x, y, z, false, false, false)
            SetModelAsNoLongerNeeded(hash)
            SetEntityCollision(entity, false, false)
            FreezeEntityPosition(entity, true)
            SetEntityVisible(entity, false, false)
            owned = entity
        end
        LinkStaticEmitterToEntity(emitter, entity)
        SetStaticEmitterEnabled(emitter, true)
        return owned
    end
    P.attachEmitter = attachEmitter

    local function detachEmitter(emitter, owned)
        SetStaticEmitterEnabled(emitter, false)
        if owned and DoesEntityExist(owned) then DeleteEntity(owned) end
    end
    P.detachEmitter = detachEmitter

    local function startAlarm(alarm)
        local deadline = GetGameTimer() + 3000
        while not PrepareAlarm(alarm) and GetGameTimer() < deadline do Wait(50) end
        StartAlarm(alarm, true)
    end
    P.startAlarm = startAlarm

    -- ##### Objects ##### --

    local function spawnProp(e)
        local p = e.prop
        local hash = loadModel(p.model)
        if not hash then return nil end
        local obj = CreateObjectNoOffset(hash, p.px, p.py, p.pz, false, false, false)
        SetModelAsNoLongerNeeded(hash)
        SetEntityHeading(obj, p.heading or 0.0)
        FreezeEntityPosition(obj, true)
        SetEntityInvincible(obj, true)
        return obj
    end

    local function deleteProp(id)
        local obj = props[id]
        if obj and DoesEntityExist(obj) then DeleteEntity(obj) end
        props[id] = nil
    end

    -- ##### Start / stop ##### --

    local function start(e)
        local st = { type = e.type, ref = e }
        if e.type == 'sound' then
            local s = e.sound
            local virtual = P.isVirtual and P.isVirtual(s.name, s.set)
            if s.bank and not virtual and loadBank(s.bank, s.bankType) then st.bank, st.bankType = s.bank, s.bankType end
            st.soundId = playSound(s.name, s.set, e.x, e.y, e.z, e.range)
        elseif e.type == 'bank' then
            if not (P.isVirtualBank and P.isVirtualBank(e.bank)) and loadBank(e.bank, 'script') then st.bank, st.bankType = e.bank, 'script' end
        elseif e.type == 'zone' then
            st.rules, st.inside = {}, false
        elseif e.type == 'ambient' then
            st.owned = attachEmitter(e.ambient.emitter, e.x, e.y, e.z, props[e.id])
            if e.ambient.station then SetEmitterRadioStation(e.ambient.emitter, e.ambient.station) end
            if e.ambient.alarm then CreateThread(function() startAlarm(e.ambient.alarm) end) end
        elseif e.type == 'radio' then
            st.owned = attachEmitter(e.radio.emitter, e.x, e.y, e.z, props[e.id])
            SetEmitterRadioStation(e.radio.emitter, e.radio.station)
        elseif e.type == 'static' then
            SetStaticEmitterEnabled(e.static.name, e.static.enabled)
            if e.static.enabled and e.static.station then SetEmitterRadioStation(e.static.name, e.static.station) end
        end
        active[e.id] = st
    end

    local function stop(id)
        local st = active[id]
        if not st then return end
        if st.type == 'sound' then
            if st.soundId then soundStop(st.soundId) end
            releaseBank(st.bank, st.bankType)
        elseif st.type == 'bank' then
            releaseBank(st.bank, st.bankType)
        elseif st.type == 'zone' then
            zoneStopAll(st)
        elseif st.type == 'ambient' then
            if st.ref.ambient.alarm then StopAlarm(st.ref.ambient.alarm, true) end
            detachEmitter(st.ref.ambient.emitter, st.owned)
        elseif st.type == 'radio' then
            detachEmitter(st.ref.radio.emitter, st.owned)
        elseif st.type == 'static' then
            SetStaticEmitterEnabled(st.ref.static.name, st.ref.static.default ~= false)
        end
        active[id] = nil
    end

    --- Stops and despawns one element (it restarts on the next tick if it should play).
    function P.reset(id)
        stop(id)
        deleteProp(id)
        interiorCache[id] = nil
    end

    function P.clear()
        for id in pairs(active) do stop(id) end
        for id in pairs(props) do deleteProp(id) end
        interiorCache = {}
    end

    -- ##### Data ##### --

    function P.set(list)
        P.clear()
        P.elements = {}
        for _, e in ipairs(list or {}) do P.elements[e.id] = e end
    end

    function P.upsert(e)
        P.reset(e.id)
        P.elements[e.id] = e
    end

    function P.remove(id)
        P.reset(id)
        P.elements[id] = nil
        P.edit[id] = nil
        P.override[id] = nil
        if P.solo == id then P.solo = nil end
    end

    --- Live edit: play `data` instead of the saved element until P.endEdit(id).
    function P.setEdit(id, data)
        P.reset(id)
        P.edit[id] = data
    end

    function P.endEdit(id)
        if P.edit[id] then
            P.edit[id] = nil
            P.reset(id)
        end
    end

    function P.setOverride(id, state)
        P.override[id] = state
        P.reset(id)
    end

    function P.isActive(id) return active[id] ~= nil end
    function P.getProp(id) return props[id] end
    function P.activeIds()
        local out = {}
        for id in pairs(active) do out[#out + 1] = id end
        return out
    end

    -- ##### Conditions ##### --

    local function inHours(h)
        if not h then return true end
        local now = GetClockHours()
        if h.from <= h.to then return now >= h.from and now < h.to end
        return now >= h.from or now < h.to -- window across midnight (e.g. 22 -> 6)
    end

    local function interiorOk(e, pedInterior)
        if not e.interiorOnly then return true end
        local int = interiorCache[e.id]
        if not int or int == 0 then
            int = GetInteriorAtCoords(e.x, e.y, e.z)
            interiorCache[e.id] = int
        end
        return int ~= 0 and int == pedInterior
    end

    local function wanted(id, e)
        if P.override[id] ~= nil then return P.override[id] end
        if P.muted then return false end
        if P.solo and P.solo ~= id then return false end
        return e.enabled ~= false
    end

    -- ##### Streaming loop ##### --

    local function dist3(ax, ay, az, bx, by, bz)
        local dx, dy, dz = ax - bx, ay - by, az - bz
        return math.sqrt(dx * dx + dy * dy + dz * dz)
    end

    --- One streaming step. Returns how far (m) the player is from the nearest thing that could start,
    --- so the loop can slow down when everything is far away.
    function P.tick()
        local ped = PlayerPedId()
        local p = GetEntityCoords(ped)
        local px, py, pz = p.x, p.y, p.z
        local pedInterior = GetInteriorFromEntity(ped)
        local candidates = {}
        local gap = math.huge

        for id, saved in pairs(P.elements) do
            local e = P.edit[id] or saved
            local skipped = P.skip and P.skip(e)
            local enabled = not skipped and wanted(id, e)

            if e.prop then
                local pd = dist3(px, py, pz, e.prop.px, e.prop.py, e.prop.pz)
                local showProp = not skipped and (e.type ~= 'prop' or e.enabled ~= false) and pd < C.propDistance
                if pd - C.propDistance < gap then gap = pd - C.propDistance end
                if showProp and props[id] == nil then
                    props[id] = spawnProp(e) or false
                elseif not showProp and props[id] ~= nil then
                    if active[id] then stop(id) end
                    deleteProp(id)
                end
            end

            if enabled and e.type ~= 'prop' and not e.native then
                local d = dist3(px, py, pz, e.x, e.y, e.z)
                local limit = e.range + (active[id] and C.streamMargin or 0.0)
                if d - e.range < gap then gap = d - e.range end
                if d <= limit and inHours(e.hours) and interiorOk(e, pedInterior) then
                    candidates[#candidates + 1] = { id = id, d = d }
                end
            end
        end

        table.sort(candidates, function(a, b) return a.d < b.d end)
        local keep = {}
        for i = 1, math.min(#candidates, C.maxActive) do keep[candidates[i].id] = true end
        for id in pairs(active) do if not keep[id] then stop(id) end end

        local now = GetGameTimer()
        for id in pairs(keep) do
            local st = active[id]
            local e = P.edit[id] or P.elements[id]
            if not st then
                start(e)
            elseif st.type == 'zone' then
                zoneTick(st, e, p.x, p.y, p.z, now)
            elseif st.type == 'sound' and st.soundId and soundFinished(st.soundId) then
                local s = st.ref.sound
                if s['repeat'] ~= false then
                    if not st.nextAt then
                        local dmin, dmax = s.delayMin or 0, s.delayMax or 0
                        st.nextAt = now + math.floor((dmin + math.random() * (dmax - dmin)) * 1000)
                    elseif now >= st.nextAt then
                        st.nextAt = nil
                        playSound(s.name, s.set, st.ref.x, st.ref.y, st.ref.z, st.ref.range, st.soundId)
                    end
                end
            end
        end
        if next(active) then gap = 0.0 end
        return gap
    end

    function P.run()
        CreateThread(function()
            while true do
                local ok, gap = pcall(P.tick)
                if not ok then print(('^1[%s] audio player error: %s^7'):format((cfg and cfg.label) or 'jdt', tostring(gap))) gap = 0.0 end
                -- adaptive rate: full speed near anything audible, up to ~6x slower when everything is
                -- far away (still far quicker than anyone can run the gap)
                local wait = C.tickMs
                if gap > 60.0 then wait = math.min(C.tickMs * 6, 1500)
                elseif gap > 25.0 then wait = math.min(C.tickMs * 3, 750) end
                Wait(wait)
            end
        end)
    end

    return P
end

if DATA_JSON then
    -- Standalone (inside an exported resource)
    local player = newPlayer({ label = GetCurrentResourceName() })
    player.set(json.decode(DATA_JSON) or {})
    player.run()
    AddEventHandler('onResourceStop', function(res)
        if res == GetCurrentResourceName() then player.clear() end
    end)
else
    MASPlayer = { new = newPlayer }
end
