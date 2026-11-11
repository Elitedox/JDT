--[[
    Plays every placed element for this player (live: changes from anyone on the server apply instantly).
]]

local Player = MASPlayer.new({
    tickMs = Config.Playback.tickMs,
    maxActive = Config.Playback.maxActive,
    streamMargin = Config.Playback.streamMargin,
    propDistance = Config.Playback.propDistance,
    supportModel = Config.Playback.supportModel,
    label = JDT.Lib.resourceName,
})
JDT.Player = Player

JDT.Elements = {}          -- id -> element (mirror of the server, used by the editor and UI)
JDT.ExportStatus = {}

local function changed()
    if JDT.onElementsChanged then JDT.onElementsChanged() end
end

-- Groups exported with their own player into an MLO resource that is running: don't play them twice
Player.skip = function(e)
    local st = JDT.ExportStatus[e.group]
    return st ~= nil and st.external and st.target ~= nil and GetResourceState(st.target) == 'started'
end

RegisterNetEvent('jdt:elements', function(list)
    JDT.Elements = {}
    for _, e in ipairs(list or {}) do JDT.Elements[e.id] = e end
    Player.set(list)
    changed()
end)

RegisterNetEvent('jdt:element', function(e)
    JDT.Elements[e.id] = e
    Player.endEdit(e.id)
    Player.upsert(e)
    changed()
end)

RegisterNetEvent('jdt:elementRemoved', function(id)
    JDT.Elements[id] = nil
    Player.remove(id)
    changed()
end)

RegisterNetEvent('jdt:exportStatus', function(status)
    JDT.ExportStatus = status or {}
    if JDT.onExportStatus then JDT.onExportStatus(JDT.ExportStatus) end
end)

CreateThread(function()
    Wait(500)
    local hello = JDT.Rpc.call('hello')
    if hello then
        JDT.ExportStatus = hello.status or {}
        JDT.DoorSamples = hello.doorSamples or {}
        SendNUIMessage({ action = 'doorSamples', data = JDT.DoorSamples })
    end
    Player.run()
end)

AddEventHandler('onResourceStop', function(res)
    if res == JDT.Lib.resourceName then Player.clear() end
end)

-- ##### Client exports ##### --

exports('SetLocalEmitterEnabled', function(id, state) Player.setOverride(id, state) end) -- nil = back to server state
exports('IsEmitterActive', function(id) return Player.isActive(id) end)
exports('GetEmitters', function() return JDT.Elements end)
exports('GetPropEntity', function(id) return Player.getProp(id) end)
