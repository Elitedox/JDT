--[[
    Tiny dependency-free runtime.
    Pure Lua 5.4 - also loaded by the offline test-suite.
]]

JDT = JDT or {}

local Lib = {}
JDT.Lib = Lib

Lib.resourceName = (GetCurrentResourceName and GetCurrentResourceName()) or 'jdt'
Lib.isServer = IsDuplicityVersion and IsDuplicityVersion() or false
Lib.version = (GetResourceMetadata and GetResourceMetadata(Lib.resourceName, 'version', 0)) or '3.0.0'

local function convar(name, default)
    if not GetConvar then return default end
    local v = GetConvar(name, '')
    if v == nil or v == '' then return default end
    return v
end
Lib.convar = convar

-- ##### Logging ##### --

local LEVELS = { error = 1, warn = 2, info = 3, verbose = 4, debug = 5 }
local LEVEL_COLOURS = { error = '^1', warn = '^3', info = '^7', verbose = '^4', debug = '^6' }

local function currentLevel()
    local name = convar('jdt:loglevel', Config and Config.LogLevel or 'warn')
    return LEVELS[name] or 2
end

Lib.print = {}
for name, level in pairs(LEVELS) do
    Lib.print[name] = function(fmt, ...)
        if level > currentLevel() then return end
        local msg = select('#', ...) > 0 and fmt:format(...) or tostring(fmt)
        print(('%s[%s] [%s] %s^7'):format(LEVEL_COLOURS[name], Lib.resourceName, name:upper(), msg))
    end
end

-- ##### Tables ##### --

function Lib.deepcopy(value, seen)
    if type(value) ~= 'table' then return value end
    seen = seen or {}
    if seen[value] then return seen[value] end
    local out = {}
    seen[value] = out
    for k, v in pairs(value) do out[Lib.deepcopy(k, seen)] = Lib.deepcopy(v, seen) end
    return out
end

function Lib.merge(into, from)
    for k, v in pairs(from or {}) do into[k] = v end
    return into
end

--- An object's model name, or nil. GetEntityArchetypeName (0x47C2A06D4F5F424B) throws on some
--- objects (e.g. ones without a loaded archetype), so it is always called through pcall.
function Lib.archetypeName(ent)
    if not GetEntityArchetypeName or not ent or ent == 0 then return nil end
    local ok, name = pcall(GetEntityArchetypeName, ent)
    if ok and type(name) == 'string' and name ~= '' then return name end
    return nil
end

function Lib.clamp(v, lo, hi)
    v = tonumber(v)
    if v == nil then return nil end
    if lo and v < lo then v = lo end
    if hi and v > hi then v = hi end
    return v
end

--- Truncate towards zero (matches the game's float -> int conversion).
function Lib.trunc(v)
    if v >= 0 then return math.floor(v) end
    return math.ceil(v)
end

-- ##### Locale ##### --

local localeTable = {}
local fallbackTable = {}

function Lib.localeCode()
    return convar('jdt:locale', convar('ox:locale', Config and Config.Locale or 'en'))
end

function Lib.loadLocales()
    if not LoadResourceFile or not json then return end

    local function load(code)
        local raw = LoadResourceFile(Lib.resourceName, ('locales/%s.json'):format(code))
        if not raw then return nil end
        local ok, data = pcall(json.decode, raw)
        return ok and data or nil
    end

    fallbackTable = load('en') or {}
    local code = Lib.localeCode()
    localeTable = code ~= 'en' and (load(code) or {}) or fallbackTable

    if code ~= 'en' and next(localeTable) == nil then
        Lib.print.warn('Locale "%s" not found, falling back to English. Translations are welcome!', code)
    end
end

--- Merged table of all strings for the selected language (missing keys -> English).
function Lib.allLocales()
    local out = {}
    for k, v in pairs(fallbackTable) do out[k] = v end
    for k, v in pairs(localeTable) do out[k] = v end
    return out
end

function Lib.locale(key, ...)
    local str = localeTable[key] or fallbackTable[key] or key
    if select('#', ...) > 0 then
        local ok, res = pcall(string.format, str, ...)
        if ok then return res end
    end
    return str
end

locale = locale or Lib.locale

-- ##### Misc ##### --

function Lib.sanitizeFilename(name)
    name = tostring(name or ''):gsub('^%s+', ''):gsub('%s+$', '')
    name = name:gsub('%s+', '_'):gsub('[^%w%-%_%.]', '')
    name = name:gsub('%.%.+', '.')
    if name == '' or name == '.' then return nil end
    return name:sub(1, 96)
end

return Lib
