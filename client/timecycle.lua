--[[
    Live timecycle editor (Timecycles > Editor).

    Reads and writes the variables of a timecycle modifier in the running game, so a change shows on
    screen at once: add, change and remove variables, clone a modifier under a new name, preview any
    modifier on screen with a strength, and hand the result back as timecycle XML.

    Everything here is asked for by the panel; nothing runs on its own. Edits live in the game's
    memory only: Export gives the XML that makes them permanent. When JDT stops, every modifier it
    changed goes back to what it was and modifiers it created are removed.
]]

local Lib = JDT.Lib

local TC = {}
JDT.Timecycle = TC

-- FiveM's timecycle natives (older clients do not have them: the panel then hides the editor)
local supported = type(GetTimecycleModifierVarCount) == 'function' and type(SetTimecycleModifierVar) == 'function'
    and type(GetTimecycleModifierVarNameByIndex) == 'function' and type(GetTimecycleModifierVar) == 'function'

local originals = {}   -- modifier name -> { [var] = { a, b } } as first read
local created = {}     -- modifier name -> true (made here by Clone / New)
local preview = nil    -- { name, strength } while a modifier is forced on screen
local varList = nil    -- { { n = name, d = default } } every variable the game knows

local function cleanName(name)
    if type(name) ~= 'string' then return nil end
    name = name:gsub('^%s+', ''):gsub('%s+$', '')
    if name == '' or #name > 64 or not name:match('^[%w_%-%.]+$') then return nil end
    return name
end

local function num(v) return (tonumber(v) or 0.0) + 0.0 end
local function round(v) return math.floor(v * 100000 + 0.5) / 100000 end

--- Does the game have a modifier with this name? (a modifier without variables still counts if we made it)
local function exists(name)
    if created[name] then return true end
    if type(GetTimecycleModifierIndexByName) == 'function' then
        local i = GetTimecycleModifierIndexByName(name)
        if i and i >= 0 then return true end
    end
    return (GetTimecycleModifierVarCount(name) or 0) > 0
end

local function readVars(name)
    local out, seen = {}, {}
    local n = GetTimecycleModifierVarCount(name) or 0
    for i = 0, n - 1 do
        local var = GetTimecycleModifierVarNameByIndex(name, i)
        if var and var ~= '' and not seen[var] then
            seen[var] = true
            local ok, a, b = GetTimecycleModifierVar(name, var)
            if ok then out[#out + 1] = { n = var, a = round(num(a)), b = round(num(b)) } end
        end
    end
    return out
end

local function remember(name)
    if originals[name] then return originals[name] end
    local o = {}
    for _, v in ipairs(readVars(name)) do o[v.n] = { v.a, v.b } end
    originals[name] = o
    return o
end

function TC.supported() return supported end

--- Every modifier the game has loaded right now (GTA's, the server's and the ones made here).
function TC.list()
    if not supported or type(GetTimecycleModifierCount) ~= 'function' then return {} end
    local out = {}
    for i = 0, (GetTimecycleModifierCount() or 0) - 1 do
        local n = GetTimecycleModifierNameByIndex(i)
        if n and n ~= '' then out[#out + 1] = n end
    end
    return out
end

--- Every variable a modifier can carry, with the game's default value.
function TC.vars()
    if varList then return varList end
    varList = {}
    if supported and type(GetTimecycleVarCount) == 'function' then
        for i = 0, (GetTimecycleVarCount() or 0) - 1 do
            local n = GetTimecycleVarNameByIndex(i)
            if n and n ~= '' then
                local d = type(GetTimecycleVarDefaultValueByIndex) == 'function' and GetTimecycleVarDefaultValueByIndex(i) or 0.0
                varList[#varList + 1] = { n = n, d = round(num(d)) }
            end
        end
    end
    return varList
end

--- One modifier: its variables now, what they were, and which ones were added here.
function TC.get(name)
    name = cleanName(name)
    if not supported then return { ok = false, unsupported = true } end
    if not name then return { ok = false, error = 'Give a timecycle name' } end
    if not exists(name) then return { ok = false, missing = true, name = name, error = ('No timecycle named %s is loaded'):format(name) } end
    local o = remember(name)
    local vars, changed, has = readVars(name), 0, {}
    for _, v in ipairs(vars) do
        has[v.n] = true
        local ov = o[v.n]
        if ov then v.oa, v.ob = ov[1], ov[2] else v.added = true end
        if v.added or v.a ~= v.oa or v.b ~= v.ob then changed = changed + 1 end
    end
    local removed = {}
    for var, ov in pairs(o) do
        if not has[var] then removed[#removed + 1] = { n = var, oa = ov[1], ob = ov[2] } changed = changed + 1 end
    end
    table.sort(vars, function(x, y) return x.n < y.n end)
    table.sort(removed, function(x, y) return x.n < y.n end)
    return { ok = true, name = name, vars = vars, removed = removed, changed = changed, created = created[name] == true,
        preview = preview and preview.name == name and preview.strength or nil }
end

function TC.set(name, var, a, b)
    name, var = cleanName(name), cleanName(var)
    if not supported or not name or not var then return { ok = false } end
    a, b = tonumber(a), tonumber(b)
    if not a or a ~= a or math.abs(a) > 1e6 then return { ok = false, error = 'Not a number' } end
    if not b or b ~= b or math.abs(b) > 1e6 then b = a end
    remember(name)
    SetTimecycleModifierVar(name, var, a + 0.0, b + 0.0)
    return { ok = true }
end

function TC.remove(name, var)
    name, var = cleanName(name), cleanName(var)
    if not supported or not name or not var then return { ok = false } end
    remember(name)
    RemoveTimecycleModifierVar(name, var)
    return { ok = true }
end

--- Back to what the modifier was when JDT first read it (one variable, or all of them).
function TC.reset(name, var)
    name = cleanName(name)
    local o = name and originals[name]
    if not supported or not o then return { ok = false } end
    var = var and cleanName(var) or nil
    local n = 0
    if var then
        local ov = o[var]
        if ov then SetTimecycleModifierVar(name, var, ov[1] + 0.0, ov[2] + 0.0) else RemoveTimecycleModifierVar(name, var) end
        n = 1
    else
        for _, v in ipairs(readVars(name)) do
            if not o[v.n] then RemoveTimecycleModifierVar(name, v.n) n = n + 1 end
        end
        for v, ov in pairs(o) do SetTimecycleModifierVar(name, v, ov[1] + 0.0, ov[2] + 0.0) n = n + 1 end
    end
    return { ok = true, count = n }
end

--- A copy of `source` under a new name (or an empty modifier when there is no source).
function TC.clone(source, name)
    name = cleanName(name)
    source = source and cleanName(source) or nil
    if not supported then return { ok = false, unsupported = true } end
    if not name then return { ok = false, error = 'Letters, numbers, _ and - only' } end
    if exists(name) then return { ok = false, error = ('%s already exists'):format(name) } end
    if source and not exists(source) then return { ok = false, error = ('No timecycle named %s is loaded'):format(source) } end
    if source and type(CloneTimecycleModifier) == 'function' then
        CloneTimecycleModifier(source, name)
    else
        if type(CreateTimecycleModifier) ~= 'function' then return { ok = false, error = 'This FiveM build cannot create timecycles' } end
        CreateTimecycleModifier(name)
        if source then
            for _, v in ipairs(readVars(source)) do SetTimecycleModifierVar(name, v.n, v.a + 0.0, v.b + 0.0) end
        end
    end
    created[name] = true
    originals[name] = nil  -- its starting point is what it holds right now
    remember(name)
    return { ok = true, name = name }
end

--- Remove a modifier that was made here.
function TC.delete(name)
    name = cleanName(name)
    if not supported or not name or not created[name] then return { ok = false, error = 'Only timecycles made in JDT can be deleted' } end
    if preview and preview.name == name then TC.preview(nil) end
    if type(RemoveTimecycleModifier) == 'function' then RemoveTimecycleModifier(name) end
    created[name], originals[name] = nil, nil
    return { ok = true }
end

--- Force a modifier on screen (anywhere, also outside), or stop with name = nil.
function TC.preview(name, strength)
    name = name and cleanName(name) or nil
    if not name then
        if preview then ClearTimecycleModifier() end
        preview = nil
        return { ok = true, on = false }
    end
    strength = Lib.clamp(tonumber(strength) or 1.0, 0.0, 2.0)
    SetTimecycleModifier(name)
    SetTimecycleModifierStrength(strength + 0.0)
    preview = { name = name, strength = strength }
    return { ok = true, on = true, name = name, strength = strength }
end

--- The modifier as it is in the game right now, as timecycle XML.
function TC.xml(name)
    name = cleanName(name)
    if not supported or not name or not exists(name) then return nil end
    local vars = readVars(name)
    table.sort(vars, function(x, y) return x.n < y.n end)
    local out = { '<?xml version="1.0" encoding="UTF-8"?>', '<timecycle_modifier_data version="1.000000">',
        ('  <modifier name="%s" numMods="%d" userFlags="0">'):format(name, #vars) }
    for _, v in ipairs(vars) do out[#out + 1] = ('    <%s>%.3f %.3f</%s>'):format(v.n, v.a, v.b, v.n) end
    out[#out + 1] = '  </modifier>'
    out[#out + 1] = '</timecycle_modifier_data>'
    return table.concat(out, '\n') .. '\n', #vars
end

--- Writes the XML into JDT's timecycles folder on the server; the manifest loads every file in it.
function TC.export(name)
    local xml, count = TC.xml(name)
    if not xml then return { ok = false, error = 'Open a timecycle first' } end
    name = cleanName(name)
    local r = JDT.Rpc.call('tcExport', name, xml)
    if type(r) ~= 'table' or not r.ok then
        return { ok = false, xml = xml, count = count, error = type(r) == 'table' and r.error or 'The server did not answer. Run refresh and ensure jdt.' }
    end
    return { ok = true, xml = xml, count = count, file = r.file, name = name }
end

-- ##### NUI ##### --

local function cb(name, fn)
    RegisterNUICallback('jdt:' .. name, function(data, respond)
        local ok, result = pcall(fn, data or {})
        if not ok then
            Lib.print.error('NUI %s failed: %s', name, tostring(result))
            return respond({ ok = false, error = tostring(result) })
        end
        respond(result == nil and { ok = true } or result)
    end)
end

cb('tc:info', function() return { supported = supported, list = TC.list(), vars = TC.vars(), preview = preview } end)
cb('tc:get', function(d) return TC.get(d.name) end)
cb('tc:set', function(d) return TC.set(d.name, d.var, d.a, d.b) end)
cb('tc:remove', function(d) TC.remove(d.name, d.var) return TC.get(d.name) end)
cb('tc:reset', function(d) TC.reset(d.name, d.var) return TC.get(d.name) end)
cb('tc:clone', function(d) return TC.clone(d.source, d.name) end)
cb('tc:delete', function(d) return TC.delete(d.name) end)
cb('tc:export', function(d) return TC.export(d.name) end)
cb('tc:preview', function(d) return TC.preview(d.on ~= false and d.name or nil, d.strength) end)

AddEventHandler('onResourceStop', function(res)
    if res ~= Lib.resourceName or not supported then return end
    if preview then ClearTimecycleModifier() end
    for name in pairs(originals) do
        if created[name] then
            if type(RemoveTimecycleModifier) == 'function' then RemoveTimecycleModifier(name) end
        else
            TC.reset(name)
        end
    end
end)

return TC
