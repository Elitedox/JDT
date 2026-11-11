--[[
    Pure helpers for the live interior inspector (no natives).
]]

JDT = JDT or {}

local U = {}
JDT.InspectUtil = U

local MASK <const> = 0xffffffff

--- Natives with Vector3 out-params return either numbers or a vector. Accept both.
function U.xyz(a, b, c)
    if type(a) == 'number' then return a, b, c end
    if type(a) == 'table' or type(a) == 'vector3' or type(a) == 'userdata' then return a.x, a.y, a.z end
    return 0.0, 0.0, 0.0
end

--- GetInteriorRoomExtents returns 6 numbers on most builds, 2 vectors on some.
function U.extents(a, b, c, d, e, f)
    if type(a) == 'number' then return { a, b, c }, { d, e, f } end
    if a and b then return { a.x, a.y, a.z }, { b.x, b.y, b.z } end
    return { 0, 0, 0 }, { 0, 0, 0 }
end

function U.round(n, d)
    if type(n) ~= 'number' or n ~= n then return 0 end
    local f = 10 ^ (d or 3)
    return math.floor(n * f + 0.5) / f
end

local function norm(v)
    local m = math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
    if m < 1e-6 then return { x = 0.0, y = 0.0, z = 0.0 } end
    return { x = v.x / m, y = v.y / m, z = v.z / m }
end

U.norm = norm

--- Edges of a box given as 8 corners (1-4 bottom face, 5-8 top face).
U.OBB_EDGES = { { 1, 2 }, { 2, 3 }, { 3, 4 }, { 4, 1 }, { 5, 6 }, { 6, 7 }, { 7, 8 }, { 8, 5 }, { 1, 5 }, { 2, 6 }, { 3, 7 }, { 4, 8 } }

--- Order-sensitive 32-bit checksum of a list of integers (detects any flag / timecycle / link change).
function U.checksum(values)
    local h = 2166136261
    for i = 1, #values do
        local v = (math.tointeger(values[i]) or 0) & MASK
        for _ = 1, 4 do
            h = ((h ~ (v & 0xff)) * 16777619) & MASK
            v = v >> 8
        end
    end
    return h
end

--- Parses a timecycle input: '0x1234ABCD', a decimal number or a name (joaat).
function U.parseHash(input, joaat)
    if type(input) == 'number' then return math.tointeger(input) and (math.tointeger(input) & MASK) or nil end
    local s = tostring(input or ''):match('^%s*(.-)%s*$')
    if s == '' then return nil end
    local hx = s:match('^0[xX](%x+)$')
    if hx and #hx <= 8 then return tonumber(hx, 16) & MASK end
    if s:match('^%-?%d+$') then return (math.tointeger(tonumber(s)) or 0) & MASK end
    return joaat(s)
end

--- Entity set names are identifiers: letters, digits, _ - . only.
function U.cleanSetName(name)
    local s = tostring(name or ''):gsub('[^%w_%-%.]', '')
    if s == '' or #s > 64 then return nil end
    return s
end

return U
