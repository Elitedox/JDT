--[[
    Minimal request/response over (latent) net events.
]]

local Lib = JDT.Lib

local Rpc = {}
JDT.Rpc = Rpc

local pending = {}
local nextId = 0

RegisterNetEvent('jdt:rpcResult', function(id, result)
    local p = pending[id]
    if p then
        pending[id] = nil
        p:resolve(result)
    end
end)

local function call(bps, method, ...)
    nextId = nextId + 1
    local id = nextId
    local p = promise.new()
    pending[id] = p

    TriggerLatentServerEvent('jdt:rpc', bps, id, method, ...)

    SetTimeout(60000, function()
        if pending[id] then
            pending[id] = nil
            p:resolve({ ok = false, error = 'timeout' })
        end
    end)

    local result = Citizen.Await(p)
    if not result or not result.ok then
        Lib.print.warn('rpc %s failed: %s', method, result and result.error or 'unknown')
        return nil, result and result.error
    end
    return result.value
end

--- Blocking call (must run inside a thread / NUI callback). Returns value or nil, error.
function Rpc.call(method, ...)
    return call(Config.Network.clientToServerBPS, method, ...)
end

--- Same, for big payloads (custom sound uploads).
function Rpc.callBulk(method, ...)
    return call(Config.Network.uploadBPS or 1000000, method, ...)
end

return Rpc
