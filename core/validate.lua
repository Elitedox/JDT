--[[
    Validation report (pure Lua 5.4). Returns locale keys + arguments so the UI can translate them.
]]

JDT = JDT or {}

local Model = JDT.Model
local Occlusion = JDT.Occlusion

local Validate = {}
JDT.Validate = Validate

---@return { level: 'error'|'warning'|'info', key: string, args: any[], room: integer?, portal: integer? }[]
function Validate.run(interior, opts)
    opts = opts or {}
    local maxDistance = opts.maxPathDistance or 5
    local issues = {}

    local function add(level, key, args, ref)
        local issue = { level = level, key = key, args = args or {} }
        if ref then issue.room, issue.portal = ref.room, ref.portal end
        issues[#issues + 1] = issue
    end

    if #interior.rooms <= 1 then add('error', 'val_no_rooms') end
    if #interior.portals == 0 then add('error', 'val_no_portals') end

    local match = Model.archetypeNameMatches(interior)
    if match == false then
        add('warning', 'val_archetype_mismatch', { interior.archetypeName })
    elseif match == nil then
        add('info', 'val_archetype_unknown', { interior.name })
    end

    if interior.proxyHashOverride then
        add('warning', 'val_proxy_override', { interior.proxyHash, interior.originalProxyHash })
    end

    -- Doors: every portal door should make a sound, every door sound should have a preset
    if interior.output and interior.output.doors ~= false then
        local doors = interior.doors or {}
        local missing = {}
        for _, p in ipairs(interior.portals) do
            for _, e in ipairs(p.entities) do
                local key = JDT.Model.doorKey(e.modelHashKey)
                if e.isDoor and key and not doors[key] and not missing[key] then
                    missing[key] = true
                    add('info', 'val_door_no_sound', { e.modelName }, { portal = p.index })
                end
            end
        end
    end

    -- Placed sounds the game would treat as outside sounds (no room)
    for _, e in ipairs(opts.elements or {}) do
        if e.group == interior.group and e.type ~= 'zone' and JDT.AudioBuild and JDT.AudioBuild.isNativeEligible(e)
            and (not e.roomName or e.roomName == '' or e.roomName == 'limbo') then
            add('warning', 'val_element_no_room', { e.label or e.id })
        end
        if e.group == interior.group and e.type == 'zone' and e.zone
            and #(e.zone.rules or {}) + #(e.zone.vanillaRules or {}) + #(e.zone.dirAmbiences or {}) == 0 then
            add('warning', 'val_zone_empty', { e.label or e.id })
        end
    end

    -- Room ambience zones and custom room tones
    local zones = {}
    for _, e in ipairs(opts.elements or {}) do if e.type == 'zone' then zones[tostring(e.id)] = e end end
    local custom = opts.custom
    for _, room in ipairs(interior.rooms) do
        if room.index ~= 0 then
            local d = room.dat151
            local zid = d.ambientZone and d.ambientZone:match('^zone:(.+)$')
            if zid then
                local z = zones[zid]
                if not z then
                    add('warning', 'val_room_zone_missing', { room.name }, { room = room.index })
                elseif z.enabled == false or z.group ~= interior.group then
                    add('warning', 'val_room_zone_other', { room.name, z.label or z.id }, { room = room.index })
                end
            elseif d.ambientZone and d.ambientZone ~= '' then
                add('info', 'val_room_zone_external', { room.name, d.ambientZone }, { room = room.index })
            end
            local tone = d.roomToneSound and d.roomToneSound:lower()
            if custom and tone and tone:match('^mas_') and not custom[tone] then
                add('warning', 'val_custom_missing', { room.name, d.roomToneSound }, { room = room.index })
            end
        end
    end

    if interior.output and interior.output.rooms == false and interior.output.occlusion == false and interior.output.doors == false then
        add('warning', 'val_nothing_exported')
    end

    local reach = Occlusion.reachability(interior)
    local occlNames = {}

    for _, room in ipairs(interior.rooms) do
        if room.index ~= 0 then
            local ref = { room = room.index }
            if room.portalCount == 0 then
                add('warning', 'val_room_no_portals', { room.index, room.name }, ref)
            elseif reach[room.index] == -1 then
                add('warning', 'val_room_unreachable', { room.index, room.name }, ref)
            elseif reach[room.index] > maxDistance then
                add('info', 'val_room_too_deep', { room.index, room.name, reach[room.index], maxDistance }, ref)
            end

            local occl = Model.occlRoomName(interior, room)
            if occlNames[occl] then
                add('error', 'val_duplicate_occl', { occl, occlNames[occl], room.name }, ref)
            else
                occlNames[occl] = room.name
            end

            local d = room.dat151
            if d.reverbSmall == 0 and d.reverbMedium == 0 and d.reverbLarge == 0 then
                add('info', 'val_room_dry', { room.index, room.name }, ref)
            end
        end
    end

    for pi, portal in ipairs(interior.portals) do
        local ref = { portal = pi - 1 }
        if portal.needsGeometry then
            add('info', 'val_portal_needs_geometry', { pi - 1 }, ref)
        end
        if not portal.isMirror then
            if not portal.isEnabled[1] and not portal.isEnabled[2] then
                add('warning', 'val_portal_disabled', { pi - 1 }, ref)
            end
            if portal.isInteriorConnector then
                add('info', 'val_portal_connector', { pi - 1 }, ref)
            end
            for _, e in ipairs(portal.entities) do
                if e.isDoor and e.isGlass then
                    add('warning', 'val_entity_door_glass', { pi - 1, e.modelName }, ref)
                end
                if e.maxOcclusion <= 0.0 and (e.isDoor or e.isGlass) then
                    add('info', 'val_entity_zero_occlusion', { pi - 1, e.modelName }, ref)
                end
            end
        end
    end

    local order = { error = 1, warning = 2, info = 3 }
    table.sort(issues, function(a, b)
        if order[a.level] ~= order[b.level] then return order[a.level] < order[b.level] end
        return a.key < b.key
    end)

    return issues
end

function Validate.summary(interior, opts)
    local ao = Occlusion.build(interior, opts and opts.maxPathDistance)
    local enabledPortals, entities, doors, glass, mirrors = 0, 0, 0, 0, 0
    for _, p in ipairs(interior.portals) do
        if p.isMirror then mirrors = mirrors + 1 end
        if not p.isMirror and (p.isEnabled[1] or p.isEnabled[2]) then enabledPortals = enabledPortals + 1 end
        for _, e in ipairs(p.entities) do
            entities = entities + 1
            if e.isDoor then doors = doors + 1 end
            if e.isGlass then glass = glass + 1 end
        end
    end
    return {
        rooms = #interior.rooms,
        portals = #interior.portals,
        enabledPortals = enabledPortals,
        mirrors = mirrors,
        portalInfos = interior.globalPortalCount or 0,
        paths = ao.pathCount,
        entities = entities,
        doors = doors,
        glass = glass,
        doorSounds = (function() local n = 0 for _ in pairs(interior.doors or {}) do n = n + 1 end return n end)(),
        reach = (function()
            local r, list = Occlusion.reachability(interior), {}
            for i, room in ipairs(interior.rooms) do list[i] = r[room.index] end
            return list -- same order as interior.rooms (JSON-safe array)
        end)(),
    }
end

return Validate
