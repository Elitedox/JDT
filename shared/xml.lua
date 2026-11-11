--[[
    Minimal ordered XML writer (pure Lua 5.4).

    Node format:
        { tag = 'Name', attrs = { { 'value', 1 }, ... }, text = 'x', children = { ... }, comment = '...' }
]]

JDT = JDT or {}

local Xml = {}
JDT.Xml = Xml

local ESCAPES = { ['&'] = '&amp;', ['<'] = '&lt;', ['>'] = '&gt;', ['"'] = '&quot;', ["'"] = '&apos;' }

function Xml.escape(s)
    return (tostring(s):gsub('[&<>"\']', ESCAPES))
end

--- Formats numbers without exponents / trailing noise.
function Xml.fmt(v)
    local t = type(v)
    if t == 'boolean' then return v and 'true' or 'false' end
    if t == 'number' then
        if math.type(v) == 'integer' then return ('%d'):format(v) end
        if v ~= v or v == math.huge or v == -math.huge then return '0' end
        local s = ('%.6f'):format(v):gsub('0+$', ''):gsub('%.$', '.0')
        if s == '-0.0' then s = '0.0' end
        return s
    end
    return Xml.escape(v)
end

local function write(out, node, depth, comments)
    local pad = ('  '):rep(depth)

    if comments and node.comment then
        out[#out + 1] = ('%s<!-- %s -->'):format(pad, tostring(node.comment):gsub('%-%-', '- -'))
    end

    local open = { pad, '<', node.tag }
    for _, kv in ipairs(node.attrs or {}) do
        open[#open + 1] = (' %s="%s"'):format(kv[1], Xml.fmt(kv[2]))
    end
    local head = table.concat(open)

    if node.text ~= nil then
        out[#out + 1] = ('%s>%s</%s>'):format(head, Xml.fmt(node.text), node.tag)
    elseif node.children and #node.children > 0 then
        out[#out + 1] = head .. '>'
        for _, child in ipairs(node.children) do write(out, child, depth + 1, comments) end
        out[#out + 1] = ('%s</%s>'):format(pad, node.tag)
    else
        out[#out + 1] = head .. ' />'
    end
end

---@param root table
---@param comments boolean?
---@return string
function Xml.render(root, comments)
    local out = { '<?xml version="1.0" encoding="UTF-8"?>' }
    write(out, root, 0, comments)
    return table.concat(out, '\n') .. '\n'
end

--- Helpers to build nodes tersely.
function Xml.val(tag, value) return { tag = tag, attrs = { { 'value', value } } } end
function Xml.text(tag, text) return { tag = tag, text = text } end
function Xml.node(tag, attrs, children, comment) return { tag = tag, attrs = attrs, children = children, comment = comment } end

return Xml
