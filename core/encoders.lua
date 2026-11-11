--[[
    Occlusion encoders (pure Lua 5.4). One data structure feeds both the CodeWalker XML
    (<proxy>.ymt.pso.xml) and the native binary (<proxy>.ymt).
]]

JDT = JDT or {}

local Hash = JDT.Hash
local Xml = JDT.Xml
local Occlusion = JDT.Occlusion

local Encoders = {}
JDT.Encoders = Encoders

local V, N = Xml.val, Xml.node

--- PortalInfoList + PathNodeList for an interior.
---@return table data { portals, nodes }, table stats { portalInfos, paths }
function Encoders.ymtData(interior, opts)
    opts = opts or {}
    local ao = opts.ao or Occlusion.build(interior, opts.maxPathDistance)
    local data = { portals = {}, nodes = {}, name = interior.name }

    local global = 0
    for _, room in ipairs(interior.rooms) do
        local roomPortalIndex = 0
        for _, portal in ipairs(interior.portals) do
            if portal.fromRoomIndex == room.index or portal.toRoomIndex == room.index then
                if not portal.isMirror then
                    local destIndex
                    if portal.fromRoomIndex == room.index then destIndex = portal.toRoomIndex else destIndex = portal.fromRoomIndex end
                    local dest = interior.rooms[destIndex + 1] or { index = destIndex, name = '?' }

                    local entities = {}
                    for _, e in ipairs(portal.entities) do
                        entities[#entities + 1] = {
                            linkType = math.tointeger(e.linkType) or 1,
                            maxOcclusion = e.maxOcclusion + 0.0,
                            model = Hash.toInt32(e.modelHashKey),
                            isDoor = e.isDoor == true,
                            isGlass = e.isGlass == true,
                            comment = e.modelName,
                        }
                    end

                    data.portals[#data.portals + 1] = {
                        proxy = interior.proxyHash, portalIdx = roomPortalIndex, roomIdx = room.index,
                        destProxy = interior.proxyHash, destRoomIdx = destIndex, entities = entities, source = portal.index,
                        comment = ('(%d) %d %s -> %d %s'):format(global, room.index, room.name, dest.index, dest.name),
                    }
                    global = global + 1
                end
                roomPortalIndex = roomPortalIndex + 1
            end
        end
    end

    for distance = 1, #ao.pathKeys do
        for _, key in ipairs(ao.pathKeys[distance]) do
            local path = ao.paths[key]
            if #path.children > 0 then
                table.sort(path.children, function(a, b) return a.globalPortalIndex < b.globalPortalIndex end)
                local children = {}
                for _, child in ipairs(path.children) do
                    children[#children + 1] = {
                        key = child.path.key, portalInfoIdx = child.globalPortalIndex,
                        comment = ('(%d %s -> %d %s) + %d'):format(child.path.origin.index, child.path.origin.name,
                            child.path.destination.index, child.path.destination.name, child.path.distance),
                    }
                end
                data.nodes[#data.nodes + 1] = {
                    key = path.key, children = children,
                    comment = ('(%d %s -> %d %s) + %d'):format(path.origin.index, path.origin.name,
                        path.destination.index, path.destination.name, path.distance),
                }
            end
        end
    end

    return data, { portalInfos = global, paths = #data.nodes }
end

--- CodeWalker XML (.ymt.pso.xml).
---@return string xml, table stats
function Encoders.ymt(interior, opts)
    opts = opts or {}
    local data, stats = opts.data or Encoders.ymtData(interior, opts), nil
    if not stats then stats = { portalInfos = #data.portals, paths = #data.nodes } end

    local portalList = N('PortalInfoList', { { 'itemType', 'naOcclusionPortalInfoMetadata' } }, {})
    local pathList = N('PathNodeList', { { 'itemType', 'naOcclusionPathNodeMetadata' } }, {})
    local root = N('naOcclusionInteriorMetadata', nil, { portalList, pathList }, data.name)

    for _, p in ipairs(data.portals) do
        local entities = {}
        for _, e in ipairs(p.entities) do
            entities[#entities + 1] = N('Item', nil, {
                V('LinkType', e.linkType),
                V('MaxOcclusion', e.maxOcclusion),
                V('EntityModelHashkey', e.model),
                V('IsDoor', e.isDoor),
                V('IsGlass', e.isGlass),
            }, e.comment)
        end
        portalList.children[#portalList.children + 1] = N('Item', nil, {
            V('InteriorProxyHash', p.proxy),
            V('PortalIdx', p.portalIdx),
            V('RoomIdx', p.roomIdx),
            V('DestInteriorHash', p.destProxy),
            V('DestRoomIdx', p.destRoomIdx),
            N('PortalEntityList', { { 'itemType', 'naOcclusionPortalEntityMetadata' } }, entities),
        }, p.comment)
    end

    for _, n in ipairs(data.nodes) do
        local children = {}
        for _, c in ipairs(n.children) do
            children[#children + 1] = N('Item', nil, { V('PathNodeKey', c.key), V('PortalInfoIdx', c.portalInfoIdx) }, c.comment)
        end
        pathList.children[#pathList.children + 1] = N('Item', nil, {
            V('Key', n.key),
            N('PathNodeChildList', { { 'itemType', 'naOcclusionPathNodeChildMetadata' } }, children),
        }, n.comment)
    end

    return Xml.render(root, opts.comments), stats
end

function Encoders.ymtName(interior)
    return tostring(interior.uintProxyHash)
end

return Encoders
