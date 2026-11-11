--[[
    Custom sounds (pure Lua 5.4): WAV in, GTA V audio wave container (.awc) out.

    Wav  - reads RIFF/WAVE (PCM 8/16/24/32-bit, float 32/64, WAVE_FORMAT_EXTENSIBLE, any channel count),
           mixes down to mono, resamples, writes 16-bit mono WAV (for previews / the output folder).
    Adpcm - IMA ADPCM in 2048-byte blocks, as the game and CodeWalker use it.
    Awc  - single-channel, non-streamed .awc (peak + data + format chunks), laid out exactly like
           CodeWalker's AwcFile.Save() (dexyfex/CodeWalker, AwcFile.cs), so files match a CodeWalker build byte for byte.
]]

JDT = JDT or {}

local Hash = JDT.Hash
local pack, unpack = string.pack, string.unpack
local floor = math.floor

-- ##### WAV ##### --

local Wav = {}
JDT.Wav = Wav

local BATCH = 2048

--- Reads `count` little-endian values of `fmt` (a string.unpack code) starting at byte `pos`.
local function readBatch(data, pos, fmt, size, count, out, scale, bias)
    local n = #out
    local i = 0
    while i < count do
        local k = math.min(BATCH, count - i)
        local vals = { unpack('<' .. fmt:rep(k), data, pos + i * size) }
        for j = 1, k do
            n = n + 1
            out[n] = (vals[j] - bias) * scale
        end
        i = i + k
    end
end

--[[
    Parses a WAV file. Returns { rate, channels, bits, float, frames, samples = { mono floats -1..1 } } or nil, err.
]]
function Wav.read(data)
    if type(data) ~= 'string' or #data < 44 then return nil, 'not a WAV file' end
    if data:sub(1, 4) ~= 'RIFF' or data:sub(9, 12) ~= 'WAVE' then return nil, 'not a WAV file (only .wav can be read here; the panel converts mp3 / ogg / flac for you)' end
    local pos, fmt, body = 13, nil, nil
    while pos + 8 <= #data + 1 do
        local id, size = data:sub(pos, pos + 3), unpack('<I4', data, pos + 4)
        local start = pos + 8
        if id == 'fmt ' then
            local tag, ch, rate, _, align, bits = unpack('<I2I2I4I4I2I2', data, start)
            if tag == 0xFFFE and size >= 40 then tag = unpack('<I2', data, start + 24) end
            fmt = { tag = tag, channels = ch, rate = rate, align = align, bits = bits }
        elseif id == 'data' then
            body = { start = start, size = math.min(size, #data - start + 1) }
            if fmt then break end
        end
        pos = start + size + (size % 2)
    end
    if not fmt then return nil, 'WAV has no format chunk' end
    if not body then return nil, 'WAV has no data chunk' end
    if fmt.channels < 1 or fmt.channels > 16 then return nil, 'unsupported channel count' end
    if fmt.rate < 1000 or fmt.rate > 192000 then return nil, 'unsupported sample rate' end

    local codes
    if fmt.tag == 1 then
        codes = ({ [8] = { 'B', 1, 1 / 128, 128 }, [16] = { 'i2', 2, 1 / 32768, 0 }, [24] = { 'i3', 3, 1 / 8388608, 0 }, [32] = { 'i4', 4, 1 / 2147483648, 0 } })[fmt.bits]
    elseif fmt.tag == 3 then
        codes = ({ [32] = { 'f', 4, 1, 0 }, [64] = { 'd', 8, 1, 0 } })[fmt.bits]
    end
    if not codes then return nil, ('unsupported WAV encoding (format %d, %d bit)'):format(fmt.tag, fmt.bits) end

    local frameSize = codes[2] * fmt.channels
    local frames = floor(body.size / frameSize)
    local raw = {}
    readBatch(data, body.start, codes[1], codes[2], frames * fmt.channels, raw, codes[3], codes[4])

    local samples = raw
    if fmt.channels > 1 then
        samples = {}
        local ch = fmt.channels
        for f = 0, frames - 1 do
            local s, base = 0.0, f * ch
            for c = 1, ch do s = s + raw[base + c] end
            samples[f + 1] = s / ch
        end
    end
    return { rate = fmt.rate, channels = fmt.channels, bits = fmt.bits, float = fmt.tag == 3, frames = frames, samples = samples }
end

--- Linear resampling of a float sample table.
function Wav.resample(samples, from, to)
    if from == to or #samples == 0 then return samples end
    local out, n = {}, #samples
    local count = floor(n * to / from)
    local step = from / to
    for i = 0, count - 1 do
        local p = i * step
        local a = floor(p)
        local t = p - a
        local s0 = samples[a + 1] or 0.0
        local s1 = samples[a + 2] or s0
        out[i + 1] = s0 + (s1 - s0) * t
    end
    return out
end

--- Float samples (-1..1) -> 16-bit little-endian PCM string. gain is linear.
function Wav.toPcm16(samples, gain)
    gain = gain or 1.0
    local parts, n = {}, #samples
    local i = 1
    while i <= n do
        local k = math.min(BATCH, n - i + 1)
        local vals = {}
        for j = 0, k - 1 do
            local v = floor(samples[i + j] * gain * 32767 + 0.5)
            if v > 32767 then v = 32767 elseif v < -32768 then v = -32768 end
            vals[j + 1] = v
        end
        parts[#parts + 1] = pack('<' .. ('i2'):rep(k), table.unpack(vals))
        i = i + k
    end
    return table.concat(parts)
end

function Wav.peak(samples)
    local p = 0.0
    for i = 1, #samples do
        local v = samples[i]
        if v < 0 then v = -v end
        if v > p then p = v end
    end
    return p
end

--- 16-bit mono PCM -> WAV file bytes.
function Wav.write(pcm, rate)
    return 'RIFF' .. pack('<I4', 36 + #pcm) .. 'WAVE'
        .. 'fmt ' .. pack('<I4I2I2I4I4I2I2', 16, 1, 1, rate, rate * 2, 2, 16)
        .. 'data' .. pack('<I4', #pcm) .. pcm
end

--[[
    Full conversion used by the server: any WAV -> mono 16-bit at `rate` (nil = keep, capped at 48000).
    opts = { rate, normalize (bool), gainDb }
    returns { pcm, rate, samples, seconds, peak, sourceRate, sourceChannels } or nil, err
]]
function Wav.convert(data, opts)
    opts = opts or {}
    local w, err = Wav.read(data)
    if not w then return nil, err end
    local rate = tonumber(opts.rate) or w.rate
    if rate > 48000 then rate = 48000 end
    if rate < 8000 then rate = 8000 end
    rate = floor(rate)
    local samples = Wav.resample(w.samples, w.rate, rate)
    local gain = 10 ^ ((tonumber(opts.gainDb) or 0) / 20)
    if opts.normalize then
        local p = Wav.peak(samples)
        if p > 0.0001 then gain = gain * (0.98 / p) end
    end
    local pcm = Wav.toPcm16(samples, gain)
    return {
        pcm = pcm, rate = rate, samples = #pcm // 2, seconds = (#pcm // 2) / rate,
        peak = math.min(1.0, Wav.peak(samples) * gain), sourceRate = w.rate, sourceChannels = w.channels,
    }
end

-- ##### IMA ADPCM (CodeWalker's ADPCMCodec) ##### --

local Adpcm = {}
JDT.Adpcm = Adpcm

local INDEX = { [0] = -1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8 }
local STEP = {
    [0] = 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
    337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
    15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
}

local function clip(v, lo, hi) if v < lo then return lo elseif v > hi then return hi end return v end

--- 16-bit PCM string -> ADPCM string (length #pcm // 4, as CodeWalker).
function Adpcm.encode(pcm)
    local outLen = #pcm // 4
    local out = {}
    local predictor, stepIndex = 0, 0
    local written, inBlock = 0, 0
    local nSamples = #pcm // 2
    -- pre-read all samples in batches
    local smp = {}
    do
        local i = 0
        while i < nSamples do
            local k = math.min(BATCH, nSamples - i)
            local vals = { unpack('<' .. ('i2'):rep(k), pcm, 1 + i * 2) }
            for j = 1, k do smp[i + j] = vals[j] end
            i = i + k
        end
    end
    local si = 1
    local function nib(s)
        local delta = s - predictor
        local value = 0
        if delta < 0 then value = 8; delta = -delta end
        local step = STEP[stepIndex]
        local diff = step >> 3
        if delta > step then value = value | 4; delta = delta - step; diff = diff + step end
        step = step >> 1
        if delta > step then value = value | 2; delta = delta - step; diff = diff + step end
        step = step >> 1
        if delta > step then value = value | 1; diff = diff + step end
        if value & 8 ~= 0 then predictor = predictor - diff else predictor = predictor + diff end
        predictor = clip(predictor, -32768, 32767)
        stepIndex = clip(stepIndex + INDEX[value & 7], 0, 88)
        return value
    end
    local bytes, nb = {}, 0
    while written < outLen do
        if inBlock == 0 then
            nb = nb + 1; bytes[nb] = pack('<i2i2', stepIndex, predictor)
            written = written + 4
            inBlock = 2044
        else
            local b0 = nib(smp[si] or 0)
            local b1 = nib(smp[si + 1] or 0)
            si = si + 2
            nb = nb + 1; bytes[nb] = string.char((b0 & 0x0F) | ((b1 & 0x0F) << 4))
            written = written + 1
            inBlock = inBlock - 1
        end
        if nb >= 4096 then out[#out + 1] = table.concat(bytes, '', 1, nb); bytes, nb = {}, 0 end
    end
    if nb > 0 then out[#out + 1] = table.concat(bytes, '', 1, nb) end
    local s = table.concat(out)
    if #s > outLen then s = s:sub(1, outLen) end -- a header can overshoot on tiny inputs
    return s
end

--- ADPCM string -> table of 16-bit sample ints (length #data * 2, zero-padded after sampleCount).
function Adpcm.decode(data, sampleCount)
    local out, n = {}, 0
    local predictor, stepIndex, inBlock = 0, 0, 0
    local pos, len = 1, #data
    local function nib(v)
        local step = STEP[stepIndex]
        local diff = ((((v & 7) << 1) + 1) * step) >> 3
        if v & 8 ~= 0 then diff = -diff end
        predictor = predictor + diff
        stepIndex = clip(stepIndex + INDEX[v], 0, 88)
        n = n + 1
        out[n] = clip(predictor, -32768, 32767)
    end
    while pos <= len and sampleCount > 0 do
        if inBlock == 0 then
            stepIndex = clip(data:byte(pos), 0, 88)
            predictor = unpack('<i2', data, pos + 2)
            inBlock = 2044
            pos = pos + 4
        else
            local b = data:byte(pos)
            nib(b & 0x0F)
            nib((b >> 4) & 0x0F)
            inBlock = inBlock - 1
            sampleCount = sampleCount - 2
            pos = pos + 1
        end
    end
    local total = len * 2
    for i = n + 1, total do out[i] = 0 end
    return out
end

-- ##### AWC ##### --

local Awc = {}
JDT.Awc = Awc

local CH_DATA, CH_FORMAT, CH_PEAK = 0x55, 0xFA, 0x36
local SORT = { [CH_DATA] = 3, [CH_FORMAT] = 0, [CH_PEAK] = 0 }
local ALIGN = { [CH_DATA] = 16 }

--- CodeWalker's peak values: max(|s| * 2) over 4096-sample windows (the last sample of the data is never read).
local function peaks(smp, total)
    local function get(i)
        if (i * 2 + 2) >= total * 2 then return 0 end
        local s = smp[i + 1] or 0
        if s < 0 then s = -s end
        return math.min(s * 2, 65535)
    end
    local function window(w)
        local o, p = w * 4096, 0
        for i = 0, 4095 do
            local s = get(i + o)
            if s > p then p = s end
        end
        return p
    end
    return window, get
end

--[[
    streams = { { name = 'sound01', pcm = '<16-bit mono pcm>', rate = 32000, codec = 'adpcm'|'pcm',
                  headroom = -100, loop = false } }
    Returns the .awc bytes.
]]
function Awc.build(streams)
    local list = {}
    for _, s in ipairs(streams) do
        local id = Hash.joaatU(s.name) & 0x1FFFFFFF
        local samples = #s.pcm // 2
        local adpcm = (s.codec or 'adpcm') == 'adpcm'
        local data = adpcm and Adpcm.encode(s.pcm) or s.pcm

        -- peak values come from the decoded data, like CodeWalker
        local smp
        if adpcm then
            smp = Adpcm.decode(data, samples)
        else
            smp = {}
            local i = 0
            while i < samples do
                local k = math.min(BATCH, samples - i)
                local vals = { unpack('<' .. ('i2'):rep(k), s.pcm, 1 + i * 2) }
                for j = 1, k do smp[i + j] = vals[j] end
                i = i + k
            end
        end
        local pcmLen = adpcm and (#data * 4) or (#s.pcm)
        local window = peaks(smp, pcmLen // 2)
        local peak0 = window(0)
        local peakCount = (samples - 4096) // 4096
        if samples < 4096 then peakCount = 0 end -- C# integer division truncates toward zero
        local peakVals = {}
        for n = 1, peakCount do peakVals[n] = window(n) end

        local chunks = {}
        if peakCount > 0 then
            local b = {}
            for n = 1, peakCount do b[n] = pack('<I2', peakVals[n]) end
            chunks[#chunks + 1] = { type = CH_PEAK, bytes = table.concat(b) }
        end
        chunks[#chunks + 1] = { type = CH_DATA, bytes = data }
        chunks[#chunks + 1] = {
            type = CH_FORMAT,
            bytes = pack('<I4i4I2i2I2I2I2BBI4',
                samples,
                s.loop and 0 or -1,                    -- LoopPoint: -1 plays once, 0 loops from the start
                s.rate,
                math.tointeger(s.headroom or -100) or -100,
                0, 0, 0, 0,                            -- LoopBegin, LoopEnd, PlayEnd, PlayBegin
                adpcm and 4 or 0,                      -- codec
                peak0 & 0xFFFF),                       -- Peak (low 16 bits = first window)
        }
        list[#list + 1] = { id = id, chunks = chunks }
    end
    table.sort(list, function(a, b) return a.id < b.id end)

    local count = #list
    local infoStart = 16 + count * 2
    local dataOffset = infoStart + count * 4
    for _, s in ipairs(list) do dataOffset = dataOffset + #s.chunks * 8 end

    -- chunk order in the file: CodeWalker sorts descending (stable) then reverses
    local all = {}
    for _, s in ipairs(list) do for _, c in ipairs(s.chunks) do all[#all + 1] = c end end
    local idx = {}
    for i, c in ipairs(all) do idx[c] = i end
    table.sort(all, function(a, b)
        local sa, sb = SORT[a.type], SORT[b.type]
        if sa ~= sb then return sa > sb end
        return idx[a] < idx[b]
    end)
    local ordered = {}
    for i = #all, 1, -1 do ordered[#ordered + 1] = all[i] end

    local off = dataOffset
    for _, c in ipairs(ordered) do
        local a = ALIGN[c.type]
        if a then off = off + (a - off % a) % a end
        c.offset = off
        off = off + #c.bytes
    end

    local out = { pack('<I4I2I2i4i4', 0x54414441, 1, 0xFF01, count, dataOffset) }
    local first = 0
    for _, s in ipairs(list) do out[#out + 1] = pack('<I2', first); first = first + #s.chunks end
    for _, s in ipairs(list) do out[#out + 1] = pack('<I4', (s.id & 0x1FFFFFFF) | (#s.chunks << 29)) end
    for _, s in ipairs(list) do
        for _, c in ipairs(s.chunks) do
            out[#out + 1] = pack('<I8', (c.offset & 0x0FFFFFFF) | ((#c.bytes & 0x0FFFFFFF) << 28) | (c.type << 56))
        end
    end
    local pos = dataOffset
    for _, c in ipairs(ordered) do
        if c.offset > pos then out[#out + 1] = ('\0'):rep(c.offset - pos) end
        out[#out + 1] = c.bytes
        pos = c.offset + #c.bytes
    end
    return table.concat(out)
end

--- Minimal reader (tests / inspection): { streams = { { id, chunks = { { type, offset, size } }, format = {...} } } }
function Awc.read(data)
    if #data < 16 then return nil, 'too small' end
    local magic, _, flags, count, dataOffset = unpack('<I4I2I2i4i4', data)
    if magic ~= 0x54414441 then return nil, 'not an awc' end
    local pos = 17 + ((flags & 1) == 1 and count * 2 or 0)
    local streams = {}
    for i = 1, count do
        local v = unpack('<I4', data, pos); pos = pos + 4
        streams[i] = { id = v & 0x1FFFFFFF, n = v >> 29, chunks = {} }
    end
    for _, s in ipairs(streams) do
        for _ = 1, s.n do
            local v = unpack('<I8', data, pos); pos = pos + 8
            local c = { type = (v >> 56) & 0xFF, size = (v >> 28) & 0x0FFFFFFF, offset = v & 0x0FFFFFFF }
            s.chunks[#s.chunks + 1] = c
            if c.type == CH_FORMAT then
                local smp, loop, rate, head, _, _, _, _, codec = unpack('<I4i4I2i2I2I2I2BB', data, c.offset + 1)
                s.format = { samples = smp, loop = loop, rate = rate, headroom = head, codec = codec }
            end
        end
    end
    return { flags = flags, dataOffset = dataOffset, streams = streams }
end

return Awc
