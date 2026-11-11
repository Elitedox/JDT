--[[
    Audio occlusion path generation (pure Lua 5.4).

    MIT License - Copyright (c) 2021 snakewiz

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
]]

JDT = JDT or {}

local Hash = JDT.Hash

local Occlusion = {}
JDT.Occlusion = Occlusion

-- ##### Helpers ##### --

--- Portals a listener in `roomIndex` can hear through.
--- isEnabled[1] = sound from -> to, isEnabled[2] = sound to -> from (listener perspective as in v2).
function Occlusion.activePortalsForRoom(interior, roomIndex)
    local list = {}
    for _, portal in ipairs(interior.portals) do
        if not portal.isMirror
            and ((portal.fromRoomIndex == roomIndex and portal.isEnabled[2])
                or (portal.toRoomIndex == roomIndex and portal.isEnabled[1]))
        then
            list[#list + 1] = portal
        end
    end
    return list
end

local function newPath(origin, destination, distance)
    local path = { distance = distance, origin = origin, destination = destination, children = {} }
    if origin.index == destination.index then
        path.uintKey = 0
        path.key = 0
    else
        path.uintKey = Hash.toUInt32(origin.key - destination.key) + distance
        path.key = Hash.toInt32(path.uintKey)
    end
    return path
end

local function isRelevant(path, from, to)
    return path.origin.index == from.index and path.destination.index == to.index
end

local function addChildrenFromPortals(path, fromNode, edgeNode, childOrigin, childDestination, dmo, predicate)
    for _, portal in ipairs(fromNode.activePortals) do
        if not portal.isMirror then
            local gpi
            if portal.toRoomIndex == edgeNode.index then
                gpi = portal.globalPortalIndices[1]
            elseif portal.fromRoomIndex == edgeNode.index then
                gpi = portal.globalPortalIndices[2]
            end

            if gpi ~= nil and (not predicate or predicate(portal, edgeNode)) then
                path.children[#path.children + 1] = {
                    path = newPath(childOrigin, childDestination, dmo),
                    globalPortalIndex = gpi,
                }
            end
        end
    end
end

-- ##### Build ##### --

local function buildNodes(interior)
    local nodes = {}
    for i, room in ipairs(interior.rooms) do
        nodes[i] = {
            room = room,
            index = room.index,
            name = room.name,
            key = room.uintRoomKey,
            activePortals = Occlusion.activePortalsForRoom(interior, room.index),
            edges = {},
        }
    end

    for _, node in ipairs(nodes) do
        local added = {}
        for _, portal in ipairs(node.activePortals) do
            local check
            if portal.fromRoomIndex == node.index then
                check = portal.toRoomIndex
            elseif portal.toRoomIndex == node.index then
                check = portal.fromRoomIndex
            end

            if check ~= nil then
                for _, other in ipairs(nodes) do
                    if not added[other.index] and other.index == check then
                        added[other.index] = true
                        node.edges[#node.edges + 1] = other
                        break
                    end
                end
            end
        end
    end

    return nodes
end

local function nonLimboEdges(node)
    local out = {}
    for _, e in ipairs(node.edges) do
        if e.index ~= 0 then out[#out + 1] = e end
    end
    return out
end

---@param interior table v3 interior (Model.computeHashes / computeTopology already applied)
---@param maxDistance integer?
---@return table ao { nodes, paths = { [uintKey] = path }, pathKeys = { [distance] = { uintKey... } }, pathCount }
function Occlusion.build(interior, maxDistance)
    maxDistance = math.max(1, math.min(math.tointeger(maxDistance or 5) or 5, 10))

    local nodes = buildNodes(interior)
    local pairs_ = {}
    for _, a in ipairs(nodes) do
        for _, b in ipairs(nodes) do
            if a.index ~= b.index then
                pairs_[#pairs_ + 1] = { from = a, to = b, isLimboPair = a.index == 0 or b.index == 0 }
            end
        end
    end

    local paths, pathKeys = {}, {}

    local function findPath(fromKey, toKey, distance)
        return paths[Hash.toUInt32(fromKey - toKey) + distance]
    end

    local function hasFoundPath(fromKey, toKey, distance)
        local base = Hash.toUInt32(fromKey - toKey)
        for i = 1, distance do
            if paths[base + i] then return true end
        end
        return false
    end

    local function getOrCreate(from, to, distance)
        local p = findPath(from.key, to.key, distance)
        if p then return p, false end
        return newPath(from, to, distance), true
    end

    local function commit(path, isNew, distance)
        if isNew and #path.children > 0 then
            paths[path.uintKey] = path
            local keys = pathKeys[distance]
            keys[#keys + 1] = path.uintKey
        end
    end

    for distance = 1, maxDistance do
        pathKeys[distance] = {}

        if distance == 1 then
            for _, node in ipairs(nodes) do
                for _, edge in ipairs(node.edges) do
                    local path = newPath(node, edge, 1)
                    addChildrenFromPortals(path, node, edge, node, node, 0)
                    if #path.children > 0 then
                        paths[path.uintKey] = path
                        pathKeys[1][#pathKeys[1] + 1] = path.uintKey
                    end
                end
            end
        else
            for _, pair in ipairs(pairs_) do
                local edges = pair.isLimboPair and pair.from.edges or nonLimboEdges(pair.from)
                local prevKeys = pathKeys[distance - 1]

                for k = 1, #prevKeys do
                    local prev = paths[prevKeys[k]]

                    if distance <= 3 then
                        if isRelevant(prev, pair.from, pair.to) then
                            local cur, isNew = getOrCreate(pair.from, pair.to, distance)
                            addChildrenFromPortals(cur, pair.from, pair.to, pair.from, pair.from, distance - 1)
                            commit(cur, isNew, distance)
                        else
                            for _, edge in ipairs(edges) do
                                if isRelevant(prev, edge, pair.to) then
                                    local cur, isNew = getOrCreate(pair.from, pair.to, distance)
                                    addChildrenFromPortals(cur, pair.from, edge, edge, pair.to, distance - 1, function(portal, edgeNode)
                                        return edgeNode.index == portal.fromRoomIndex
                                            or (portal.fromRoomIndex ~= 0 and portal.toRoomIndex ~= 0)
                                    end)
                                    commit(cur, isNew, distance)
                                end
                            end
                        end
                    else
                        for _, edge in ipairs(edges) do
                            if isRelevant(prev, edge, pair.to) and not hasFoundPath(pair.from.key, pair.to.key, distance) then
                                local cur, isNew = getOrCreate(pair.from, pair.to, distance)
                                addChildrenFromPortals(cur, pair.from, edge, edge, pair.to, distance - 1, function(portal, edgeNode)
                                    return edgeNode.index == pair.to.index
                                        or (portal.fromRoomIndex ~= 0 and portal.toRoomIndex ~= 0)
                                end)
                                commit(cur, isNew, distance)
                            end
                        end
                    end
                end
            end
        end

        table.sort(pathKeys[distance])
    end

    local count = 0
    for _ in pairs(paths) do count = count + 1 end

    return { nodes = nodes, paths = paths, pathKeys = pathKeys, pathCount = count, maxDistance = maxDistance }
end

--- Shortest number of portal hops between rooms (BFS over enabled portals). -1 when unreachable.
function Occlusion.reachability(interior)
    local adj = {}
    for _, room in ipairs(interior.rooms) do adj[room.index] = {} end
    for _, portal in ipairs(interior.portals) do
        if not portal.isMirror and (portal.isEnabled[1] or portal.isEnabled[2]) then
            local a, b = portal.fromRoomIndex, portal.toRoomIndex
            if adj[a] and adj[b] then
                adj[a][#adj[a] + 1] = b
                adj[b][#adj[b] + 1] = a
            end
        end
    end

    local dist = { [0] = 0 }
    local queue, head = { 0 }, 1
    while head <= #queue do
        local cur = queue[head]
        head = head + 1
        for _, nxt in ipairs(adj[cur] or {}) do
            if dist[nxt] == nil then
                dist[nxt] = dist[cur] + 1
                queue[#queue + 1] = nxt
            end
        end
    end

    local out = {}
    for _, room in ipairs(interior.rooms) do out[room.index] = dist[room.index] or -1 end
    return out
end

return Occlusion
