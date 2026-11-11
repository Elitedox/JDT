--[[
    In-world labels drawn by the panel (HTML / CSS) instead of GTA text.

    Producers (portal overlay, selected entity, room name, point-to distance) hand over a group of
    labels: a world anchor + a small data table. This module projects the anchors to the screen and
    sends them to the panel:
      * positions at most 30x a second, and only when something moved more than ~2 px
      * label data only when it actually changed
    Nothing runs while no label exists.
]]

local Labels = {}
JDT.Labels = Labels

local groups = {}        -- group -> { [id] = { x, y, z, data } }
local lastData = {}      -- group -> encoded data (to skip unchanged sends)
local running = false
local lastPositions = ''

local function nui(action, data) SendNUIMessage({ action = action, data = data }) end

local function loop()
    if running then return end
    running = true
    CreateThread(function()
        while next(groups) do
            local cam = GetFinalRenderedCamCoord()
            local out, n = {}, 0
            for _, items in pairs(groups) do
                for id, it in pairs(items) do
                    local onScreen, sx, sy = GetScreenCoordFromWorldCoord(it.x, it.y, it.z)
                    if onScreen then
                        local dx, dy, dz = it.x - cam.x, it.y - cam.y, it.z - cam.z
                        n = n + 1
                        -- quantised so a still camera produces identical frames (and no message)
                        out[n] = { id, math.floor(sx * 1000 + 0.5) / 1000, math.floor(sy * 1000 + 0.5) / 1000,
                            math.floor(math.sqrt(dx * dx + dy * dy + dz * dz) * 10 + 0.5) / 10 }
                    end
                end
            end
            table.sort(out, function(a, b) return a[4] > b[4] end) -- far first: near labels stack on top
            local encoded = json.encode(out)
            if encoded ~= lastPositions then
                lastPositions = encoded
                nui('labels', out)
            end
            Wait(33)
        end
        lastPositions = ''
        nui('labels', {})
        running = false
    end)
end

--- Replace every label of a group. items = { [id] = { x =, y =, z =, data = {...} } } (ids must be unique across groups)
function Labels.set(group, items)
    if not items or next(items) == nil then return Labels.clear(group) end
    groups[group] = items
    local data = {}
    for id, it in pairs(items) do data[id] = it.data end
    local encoded = json.encode(data)
    if encoded ~= lastData[group] then
        lastData[group] = encoded
        nui('labelsData', { group = group, items = data })
    end
    loop()
end

function Labels.clear(group)
    if groups[group] == nil and lastData[group] == nil then return end
    groups[group] = nil
    lastData[group] = nil
    nui('labelsData', { group = group, items = {} })
end

function Labels.active() return next(groups) ~= nil end

AddEventHandler('onResourceStop', function(res)
    if res == JDT.Lib.resourceName then groups = {} end
end)

return Labels
