--[[
    Door sounds: which vanilla door audio preset a door model uses (DoorAudioSettingsLink "dasl_<model hash>").
    Pure Lua 5.4.
]]

JDT = JDT or {}

local Doors = {}
JDT.Doors = Doors

--- Simple choices shown in the UI (any preset from catalog/door_presets.json also works).
Doors.SOUNDS = {
    { id = 'DEFAULT_DOOR_SWING_WOOD',               label = 'Wooden door',     kind = 'swing' },
    { id = 'DEFAULT_DOOR_SWING_METAL',              label = 'Metal door',      kind = 'swing' },
    { id = 'DEFAULT_DOOR_SWING_GLASS_AND_METAL',    label = 'Glass door',      kind = 'swing' },
    { id = 'DEFAULT_DOOR_METAL_BAR_DOOR_SWING',     label = 'Cell / bar door', kind = 'swing' },
    { id = 'DEFAULT_DOOR_SLIDING_POWERED_INTERIOR', label = 'Automatic sliding door', kind = 'sliding' },
    { id = 'DEFAULT_DOOR_SLIDING_METAL_GATE_BARS',  label = 'Sliding bar gate', kind = 'sliding' },
    { id = 'DEFAULT_DOOR_SLIDING_LIFT',             label = 'Elevator door',   kind = 'vertical' },
    { id = 'DEFAULT_DOOR_GARAGE',                   label = 'Garage door',     kind = 'garage' },
    { id = 'DEFAULT_DOOR_METAL_GATE_SWING_SMALL',   label = 'Metal swing gate', kind = 'gate' },
    { id = 'DEFAULT_DOOR_SWING_WOOD_FENCE_GATE',    label = 'Wooden fence gate', kind = 'gate' },
    { id = 'DEFAULT_DOOR_CHAINLINK_SWING',          label = 'Chain-link gate', kind = 'gate' },
    { id = 'D_PROP_SEC_BARRIER_LD_01A',             label = 'Barrier arm',     kind = 'barrier' },
}

--- Custom doors: a door sound set + a movement profile + how much sound gets through when closed.
--- Sound sets and tunings are vanilla names.
Doors.CUSTOM_SOUNDS = {
    { id = 'door_swing_exit_wood_no_mech',               label = 'Wooden push door' },
    { id = 'door_swing_glass_and_metal_shop_beep',       label = 'Shop door (beep)' },
    { id = 'door_swing_glass_and_metal_shop_beep_always', label = 'Shop door (always beeps)' },
    { id = 'door_swing_glass_and_metal_shop_bell',       label = 'Shop door (bell)' },
    { id = 'hash_0D2CD7D4',                              label = 'Jail door' },
    { id = 'hash_662E5B7D',                              label = 'Light metal door' },
    { id = 'hash_D5377A40',                              label = 'Hydraulic door' },
    { id = 'door_slide_manual',                          label = 'Sliding door (manual)' },
    { id = 'door_sliding_lift_fib',                      label = 'Elevator door' },
    { id = 'door_garage',                                label = 'Garage door' },
    { id = 'door_garage_ls_customs',                     label = 'Roller door (LS Customs)' },
    { id = 'door_garage_heavy_slider',                   label = 'Heavy sliding gate' },
    { id = 'door_sliding_metal_gate_bars',               label = 'Sliding bar gate' },
    { id = 'hash_B7E1088B',                              label = 'Metal fence 1' },
    { id = 'hash_C5F4BC63',                              label = 'Metal fence 2' },
    { id = 'door_barrier_fib_barrier',                   label = 'Turnstile / clicking slider' },
}

Doors.TUNINGS = {
    'dtp_default_swing', 'dtp_swing_quick_shut', 'dtp_default_heavy', 'dtp_ranch_entry_doors', 'dtp_prologue_swing_doors_loud',
    'dtp_swing_door_biotech_lab', 'dtp_fib_big_glass_doors', 'dtp_sliding_door_interior', 'dtp_biolab_sliding_doors',
    'dtp_default_sliding_horizontal', 'dtp_default_sliding_vertical', 'dtp_fib_elevator_door', 'dtp_mp_garage_elevator_door',
    'dtp_default_garage', 'dtp_default_garage_slow', 'dtp_default_garage_ls_customs', 'dtp_mp_garage_door',
    'dtp_michael_house_garage', 'dtp_trevor_trailer_garage', 'dtp_garage_mex_gang_spray', 'dtp_sliding_gate_michael_house',
    'dtp_chainlink_slide', 'dtp_chainlink_slide_prison', 'dtp_chainlink_swing_big', 'dtp_chainlink_swing_tiny', 'dtp_lrggate',
    'dtp_big_score_heist_gate_police', 'dtp_default_barrier', 'dtp_level_crossing_barrier', 'dtp_fib_building_turnstile',
    'hash_001B152F', 'hash_8C484A48', 'hash_7AA46069', 'hash_C85140B1',
}

--- Name of the DoorAudioSettings item written for a custom door.
function Doors.settingsName(hash) return ('das_mas_%08x'):format(hash & 0xFFFFFFFF) end

local function has(s, ...)
    for _, p in ipairs({ ... }) do
        if s:find(p) then return true end
    end
    return false
end

--- size = { x, y, z } model dimensions (optional)
function Doors.guessKind(model, size)
    local m = tostring(model or ''):lower()
    if has(m, 'barrier', 'arm_', 'boom') then return 'barrier', 'name' end
    if has(m, 'garage', 'gar_door', 'roller', 'shutter') then return 'garage', 'name' end
    if has(m, 'slid', 'elev', 'lift', 'auto') then return 'sliding', 'name' end
    if has(m, 'gate', 'fence', 'fnc') then return 'gate', 'name' end
    if size then
        local w, h = math.max(size.x or 0, size.y or 0), size.z or 0
        if w > 3.5 and h < 1.2 then return 'barrier', 'size' end
        if w > 2.6 and h > 2.2 then return 'garage', 'size' end
    end
    return 'swing', 'name'
end

function Doors.presetFor(kind, model)
    local m = tostring(model or ''):lower()
    local glass = has(m, 'glass', 'shop', 'store', '247', 'window')
    local metal = has(m, 'metal', 'steel', 'sec', 'vault', 'fire', 'iron')
    local bars = has(m, 'cell', 'jail', 'bars', 'pris')
    local chain = has(m, 'chain', 'fnclink', 'fence')
    if kind == 'sliding' then
        if m:find('gate') then return 'DEFAULT_DOOR_SLIDING_METAL_GATE' end
        return bars and 'DEFAULT_DOOR_SLIDING_METAL_GATE_BARS' or 'DEFAULT_DOOR_SLIDING_POWERED_INTERIOR'
    elseif kind == 'vertical' then
        return has(m, 'lift', 'elev') and 'DEFAULT_DOOR_SLIDING_LIFT' or 'DEFAULT_DOOR_SLIDING_VERTICAL_METAL_SECURITY_FENCE'
    elseif kind == 'garage' then
        return 'DEFAULT_DOOR_GARAGE'
    elseif kind == 'barrier' then
        return 'D_PROP_SEC_BARRIER_LD_01A'
    elseif kind == 'gate' then
        if chain then return 'DEFAULT_DOOR_CHAINLINK_SWING' end
        return m:find('wood') and 'DEFAULT_DOOR_SWING_WOOD_FENCE_GATE' or 'DEFAULT_DOOR_METAL_GATE_SWING_SMALL'
    end
    if bars then return 'DEFAULT_DOOR_METAL_BAR_DOOR_SWING' end
    if glass then return 'DEFAULT_DOOR_SWING_GLASS_AND_METAL' end
    if metal then return 'DEFAULT_DOOR_SWING_METAL' end
    return 'DEFAULT_DOOR_SWING_WOOD'
end

--- New door entry for a model.
function Doors.guess(model, size)
    local kind, how = Doors.guessKind(model, size)
    return { model = model, kind = kind, how = how, preset = Doors.presetFor(kind, model) }
end

function Doors.isDoorName(name)
    name = tostring(name or ''):lower()
    return has(name, 'door', 'gate', 'shutter', 'barrier', 'turnstile')
end

--- Name of the dat151 link item for a model hash.
function Doors.linkName(modelHash)
    return ('dasl_%08x'):format(math.tointeger(modelHash) & 0xFFFFFFFF)
end

return Doors
