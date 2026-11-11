--[[
    Hash helpers (pure Lua 5.4).
]]

JDT = JDT or {}

local Hash = {}
JDT.Hash = Hash

local INT32MAX <const> = 2147483647
local MASK <const> = 0xffffffff

---@param value number
---@return integer
function Hash.toUInt32(value)
    return math.tointeger(value) & MASK
end

---@param value number
---@return integer
function Hash.toInt32(value)
    local u = math.tointeger(value) & MASK
    if u > INT32MAX then return u - 0x100000000 end
    return u
end

--- Jenkins one-at-a-time hash as used by GTA V (lower-cased input).
---@param str string
---@return integer unsigned 32-bit hash
function Hash.joaatU(str)
    str = tostring(str):lower()
    local h = 0
    for i = 1, #str do
        h = (h + str:byte(i)) & MASK
        h = (h + (h << 10)) & MASK
        h = h ~ (h >> 6)
    end
    h = (h + (h << 3)) & MASK
    h = h ~ (h >> 11)
    h = (h + (h << 15)) & MASK
    return h
end

--- Signed variant (matches GetHashKey / backtick hashes in CfxLua).
---@param str string
---@return integer
function Hash.joaat(str)
    return Hash.toInt32(Hash.joaatU(str))
end

---@param value number
---@return string 8 digit upper-case hex of the unsigned value
function Hash.hex(value)
    return ('%08X'):format(Hash.toUInt32(value))
end

--- Accepts '123', '-123', '0xDEADBEEF', 'hash_DEADBEEF' or a plain name (joaat'd).
---@param input string|number
---@return integer? signed
function Hash.parse(input)
    if type(input) == 'number' then return Hash.toInt32(input) end
    if type(input) ~= 'string' then return nil end
    local s = input:gsub('^%s+', ''):gsub('%s+$', '')
    if s == '' then return nil end
    local hex = s:match('^0[xX](%x+)$') or s:match('^hash_(%x+)$')
    if hex and #hex <= 8 then return Hash.toInt32(tonumber(hex, 16)) end
    local num = s:match('^%-?%d+$') and tonumber(s)
    if num then return Hash.toInt32(num) end
    return Hash.joaat(s)
end

return Hash
