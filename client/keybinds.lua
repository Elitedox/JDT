--[[
    Keybinds players change live in Settings > Keybinds; saved per player on their own PC (resource KVP).

    FiveM key mappings can only be changed in GTA's settings, so JDT reads the keys itself:
    IS_RAW_KEY_PRESSED with Windows virtual-key codes (the same numbers the panel's
    KeyboardEvent.keyCode gives). Keys only count while no NUI has focus (chat, phone, this panel -
    the panel handles its own binds) and the pause menu is closed.

    Cost: one cheap per-frame check of the bound keys; nothing at all when no key is bound.
    Older FiveM builds without raw keys fall back to normal key mappings (changeable in GTA settings).
]]

local Lib = JDT.Lib
local K = {}
JDT.Keybinds = K

local KVP = 'jdt:keybinds'

-- key name <-> Windows virtual-key code
local VK = { BACKSPACE = 8, TAB = 9, ENTER = 13, PAUSE = 19, CAPSLOCK = 20, SPACE = 32, PAGEUP = 33, PAGEDOWN = 34, END = 35, HOME = 36,
    LEFT = 37, UP = 38, RIGHT = 39, DOWN = 40, INSERT = 45, DELETE = 46, MULTIPLY = 106, ADD = 107, SUBTRACT = 109, DECIMAL = 110, DIVIDE = 111 }
for i = 1, 12 do VK['F' .. i] = 111 + i end
for i = 0, 9 do VK[tostring(i)] = 48 + i VK['NUMPAD' .. i] = 96 + i end
for c = 65, 90 do VK[string.char(c)] = c end
local NAME = {}
for n, code in pairs(VK) do if not NAME[code] or #n < #NAME[code] then NAME[code] = n end end
for i = 0, 9 do NAME[96 + i] = 'NUM' .. i end
NAME[186], NAME[187], NAME[188], NAME[189], NAME[190], NAME[191], NAME[192], NAME[219], NAME[220], NAME[221], NAME[222] =
    ';', '=', ',', '-', '.', '/', '`', '[', '\\', ']', "'"

local function vkOf(name)
    if type(name) == 'number' then return math.floor(name) end
    if type(name) ~= 'string' or name == '' then return 0 end
    return VK[name:upper()] or 0
end

local player = Config.Player or {}
local playerOn = player.enabled ~= false

--- Every action a key can trigger: id, label, default key, what it does.
local ACTIONS = {
    { id = 'toggle', label = 'Open / close JDT', default = Config.Open and Config.Open.key or 'F5',
        run = function() if JDT.togglePanel then JDT.togglePanel() end end },
}
if playerOn then
    ACTIONS[#ACTIONS + 1] = { id = 'noclip', label = 'Noclip (free camera)', default = player.noclipKey or 'F11', run = function() JDT.PlayerTools.noclip() end }
    ACTIONS[#ACTIONS + 1] = { id = 'god', label = 'God mode', default = player.godKey or '', run = function() JDT.PlayerTools.godMode() end }
    ACTIONS[#ACTIONS + 1] = { id = 'repair', label = 'Repair my vehicle', default = player.repairKey or '', run = function() JDT.PlayerTools.repair() end }
    ACTIONS[#ACTIONS + 1] = { id = 'marker', label = 'Teleport to map marker', default = player.markerKey or 'F10', run = function() CreateThread(function() local r = JDT.PlayerTools.toMarker() if r and not r.ok and r.error then JDT.notify('error', r.error) end end) end }
end
local byId = {}
for _, a in ipairs(ACTIONS) do byId[a.id] = a end

local binds = {}      -- action id -> virtual-key code (0 = not bound)
local watch = {}      -- { vk, action } for the loop
local raw = type(IsRawKeyPressed) == 'function'

local function rebuild()
    watch = {}
    for _, a in ipairs(ACTIONS) do
        local vk = binds[a.id] or 0
        if vk > 0 then watch[#watch + 1] = { vk = vk, a = a } end
    end
end

local function load()
    for _, a in ipairs(ACTIONS) do binds[a.id] = vkOf(a.default) end
    local saved = GetResourceKvpString(KVP)
    local ok, t = pcall(json.decode, saved or '')
    if ok and type(t) == 'table' then
        for id, vk in pairs(t) do if byId[id] then binds[id] = math.floor(tonumber(vk) or 0) end end
    end
    rebuild()
end

function K.keyName(id)
    local vk = binds[id] or 0
    return vk > 0 and (NAME[vk] or ('#' .. vk)) or ''
end

function K.list()
    local out = {}
    for _, a in ipairs(ACTIONS) do
        local vk = binds[a.id] or 0
        out[#out + 1] = { id = a.id, label = a.label, vk = vk, key = K.keyName(a.id), default = vkOf(a.default), live = raw }
    end
    return out
end

--- binds = { action id -> vk (0 clears) }; one key per action, a key used twice keeps the newest action
function K.set(new)
    if type(new) ~= 'table' then return K.list() end
    for id, vk in pairs(new) do
        if byId[id] then
            vk = math.floor(tonumber(vk) or 0)
            if vk < 0 or vk > 254 or vk == 27 then vk = 0 end   -- Esc always closes, never binds
            if vk > 0 then for other, v in pairs(binds) do if other ~= id and v == vk then binds[other] = 0 end end end
            binds[id] = vk
        end
    end
    local save = {}
    for _, a in ipairs(ACTIONS) do save[a.id] = binds[a.id] or 0 end
    SetResourceKvp(KVP, json.encode(save))
    rebuild()
    return K.list()
end

function K.reset()
    DeleteResourceKvp(KVP)
    load()
    return K.list()
end

function K.run(id)
    local a = byId[id]
    if a then a.run() return true end
    return false
end

load()

if raw then
    CreateThread(function()
        local focusedAt = 0
        while true do
            if #watch == 0 then
                Wait(500)
            else
                -- keys typed into chat / a phone / this panel are not shortcuts; a short grace after a
                -- NUI closes stops the key that closed it from firing again in the game
                local now = GetGameTimer()
                if IsNuiFocused() or IsPauseMenuActive() then
                    focusedAt = now
                elseif now - focusedAt > 250 then
                    for i = 1, #watch do
                        local w = watch[i]
                        if IsRawKeyPressed(w.vk) then w.a.run() end
                    end
                end
                Wait(0)
            end
        end
    end)
else
    -- older FiveM build: normal key mappings (players change them in GTA Settings > Key Bindings > FiveM)
    for _, a in ipairs(ACTIONS) do
        local cmd = 'jdt_key_' .. a.id
        RegisterCommand(cmd, function() a.run() end, false)
        if a.default and a.default ~= '' then RegisterKeyMapping(cmd, 'JDT: ' .. a.label, 'keyboard', a.default) end
    end
end

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

cb('keys:get', function() return { list = K.list() } end)
cb('keys:set', function(d) return { list = K.set(d.binds) } end)
cb('keys:reset', function() return { list = K.reset() } end)
cb('keys:run', function(d) return { ok = K.run(d.id) } end)

return K
