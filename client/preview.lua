--[[
    "Now playing": every preview the user starts (sounds, room tones, radios, vanilla emitters, door tests),
    each with play / pause / stop, shown in the panel's bottom bar.
]]

local Player = JDT.Player

local Preview = {}
JDT.Preview = Preview

local items = {}       -- pid -> preview
local order = {}       -- pids in start order
local nextPid = 0
local MAX = 6

local function push()
    if JDT.onPreviewChanged then JDT.onPreviewChanged(Preview.list()) end
end

function Preview.list()
    local out = {}
    for _, pid in ipairs(order) do
        local p = items[pid]
        if p then out[#out + 1] = { id = pid, kind = p.kind, label = p.label, sub = p.sub, playing = p.playing, at = p.atLabel } end
    end
    return out
end

local function soundStart(p)
    local virtual = Player.isVirtual and Player.isVirtual(p.name, p.set)
    if p.bank and not virtual then
        local deadline = GetGameTimer() + 2000
        repeat
            local ok
            if p.bankType == 'ambient' then ok = RequestAmbientAudioBank(p.bank, false) else ok = RequestScriptAudioBank(p.bank, false) end
            if ok then break end
            Wait(50)
        until GetGameTimer() > deadline
    end
    p.soundId = Player.playSound(p.name, p.set, p.pos.x, p.pos.y, p.pos.z, p.range or 20)
    local id = p.soundId
    if type(id) == 'table' then return end -- custom sound previewed by the panel (not in the game yet)
    -- A sound already finished a couple of frames after starting never played (missing bank / bad name)
    CreateThread(function()
        Wait(0) Wait(0)
        if items[p.pid] and p.soundId == id and HasSoundFinished(id) and not p.warned then
            p.warned = true
            if JDT.onSoundFailed then JDT.onSoundFailed(p.name, p.set) end
        end
    end)
end

local function soundStop(p)
    if p.soundId then
        Player.soundStop(p.soundId)
        p.soundId = nil
    end
end

local handlers = {
    sound = {
        play = soundStart,
        pause = soundStop,
        stop = function(p)
            soundStop(p)
            if p.bank and p.bankType ~= 'ambient' then ReleaseNamedScriptAudioBank(p.bank) end
        end,
    },
    emitter = {
        play = function(p)
            if not p.owned or not DoesEntityExist(p.owned) then
                p.owned = Player.attachEmitter(p.name, p.pos.x, p.pos.y, p.pos.z, nil)
            else
                SetStaticEmitterEnabled(p.name, true)
            end
            if p.station then SetEmitterRadioStation(p.name, p.station) end
            if p.alarm then CreateThread(function() Player.startAlarm(p.alarm) end) end
        end,
        pause = function(p)
            SetStaticEmitterEnabled(p.name, false)
            if p.alarm then StopAlarm(p.alarm, true) end
        end,
        stop = function(p)
            if p.alarm then StopAlarm(p.alarm, true) end
            Player.detachEmitter(p.name, p.owned)
        end,
    },
    static = {
        play = function(p)
            SetStaticEmitterEnabled(p.name, true)
            if p.station then SetEmitterRadioStation(p.name, p.station) end
        end,
        pause = function(p) SetStaticEmitterEnabled(p.name, false) end,
        stop = function(p) SetStaticEmitterEnabled(p.name, p.default ~= false) end,
    },
    door = {
        play = function(p) CreateThread(function() JDT.Scanner.cycleDoor(p.model, p.pos) end) end,
        pause = function() end,
        stop = function() end,
    },
}

local function remove(pid)
    local p = items[pid]
    if not p then return end
    if p.playing or p.kind ~= 'door' then handlers[p.kind].stop(p) end
    items[pid] = nil
    for i, v in ipairs(order) do if v == pid then table.remove(order, i) break end end
end

--- Only one preview per vanilla emitter / radio slot at a time
local function removeSame(kind, name)
    for _, pid in ipairs(order) do
        local p = items[pid]
        if p and p.kind == kind and p.name == name then remove(pid) return end
    end
end

--[[
    t = { type = 'sound'|'ambient'|'radio'|'static'|'door', sound = {...}, ambient = {...}, radio = {...}, static = {...},
          label, sub, model, pos = {x,y,z}, range }
]]
function Preview.start(t, pos)
    pos = pos or t.pos
    if not pos then
        local c = GetEntityCoords(PlayerPedId())
        pos = { x = c.x, y = c.y, z = c.z + 0.5 }
    end
    nextPid = nextPid + 1
    local p = { pid = nextPid, pos = pos, label = t.label, sub = t.sub, range = t.range, playing = true }

    if t.type == 'sound' then
        p.kind, p.name, p.set = 'sound', t.sound.name, t.sound.set
        p.bank, p.bankType = t.sound.bank, t.sound.bankType
        p.label = p.label or t.sound.name
        p.sub = p.sub or ((t.sound.set and t.sound.set ~= '') and t.sound.set or locale('type_sound'))
    elseif t.type == 'ambient' then
        p.kind, p.name, p.alarm, p.station = 'emitter', t.ambient.emitter, t.ambient.alarm, t.ambient.station
        p.label = p.label or t.ambient.emitter
        p.sub = p.sub or locale('type_ambient')
    elseif t.type == 'radio' then
        p.kind, p.name, p.station = 'emitter', RadioPreviewEmitter, t.radio.station
        p.label = p.label or t.radio.station
        p.sub = p.sub or locale('type_radio')
    elseif t.type == 'static' then
        p.kind, p.name, p.station, p.default = 'static', t.static.name, t.static.station, t.static.default
        p.label = p.label or t.static.name
        p.sub = p.sub or locale('type_static')
    elseif t.type == 'door' then
        p.kind, p.model, p.pos = 'door', t.model, t.pos
        p.label = p.label or locale('ui_tab_doors')
        p.sub = p.sub or locale('ui_door_test_info')
    else
        return nil
    end

    if p.kind ~= 'sound' and p.kind ~= 'door' then removeSame(p.kind, p.name) end
    if #order >= MAX then remove(order[1]) end

    items[p.pid] = p
    order[#order + 1] = p.pid
    handlers[p.kind].play(p)
    if p.kind == 'door' then
        p.playing = false
        SetTimeout(2600, push)
    end
    push()
    return p.pid
end

function Preview.toggle(pid)
    local p = items[pid]
    if not p then return end
    if p.playing then
        handlers[p.kind].pause(p)
        p.playing = false
    else
        handlers[p.kind].play(p)
        p.playing = p.kind ~= 'door'
    end
    push()
end

function Preview.stop(pid)
    remove(pid)
    push()
end

function Preview.stopAll()
    for i = #order, 1, -1 do remove(order[i]) end
    push()
end

-- Sounds that end on their own (one-shots) flip back to "paused" so the bar stays truthful
CreateThread(function()
    while true do
        local dirty = false
        for _, pid in ipairs(order) do
            local p = items[pid]
            if p and p.kind == 'sound' and p.playing and p.soundId and Player.soundFinished(p.soundId) then
                if p.loop then
                    soundStop(p)
                    soundStart(p)
                else
                    soundStop(p)
                    p.playing = false
                    dirty = true
                end
            end
        end
        if dirty then push() end
        Wait(400)
    end
end)

--- Loop a sound until stopped (room tone listening).
function Preview.loop(pid, on)
    local p = items[pid]
    if p then p.loop = on ~= false end
end

AddEventHandler('onResourceStop', function(res)
    if res == JDT.Lib.resourceName then Preview.stopAll() end
end)

return Preview
