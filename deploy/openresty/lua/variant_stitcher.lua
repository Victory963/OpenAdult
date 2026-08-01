-- ============================================================
-- OpenAdult SSAI Variant Playlist 广告拼接
-- 功能: 在具体码率的 index.m3u8 中插入广告 .ts 片段
-- 位置: /etc/openresty/lua/variant_stitcher.lua
-- ============================================================

local cjson = require "cjson"
local http = require "resty.http"

local ad_cache = ngx.shared.ad_cache
local m3u8_cache = ngx.shared.m3u8_cache

local video_id = ngx.var.video_id
local quality = ngx.var.quality
local uid = ngx.var.arg_uid or "anonymous"

-- === 获取原始 variant playlist ===
local function fetch_variant(vid, qual)
    local cache_key = "variant:" .. vid .. ":" .. qual
    local cached = m3u8_cache:get(cache_key)
    if cached then
        return cached
    end
    
    local httpc = http.new()
    httpc:set_timeout(5000)
    
    local s3_url = string.format(
        "https://s3.us-west-002.backblazeb2.com/openadult-media/videos/%s/%s/index.m3u8",
        vid, qual
    )
    
    local res, err = httpc:request_uri(s3_url, { ssl_verify = false })
    if not res or res.status ~= 200 then
        return nil
    end
    
    m3u8_cache:set(cache_key, res.body, 3600)
    return res.body
end

-- === 获取广告配置 ===
local function get_ad_placements(vid, uid_val)
    local cache_key = "adplace:" .. uid_val .. ":" .. vid
    local cached = ad_cache:get(cache_key)
    if cached then
        return cjson.decode(cached)
    end
    
    local httpc = http.new()
    httpc:set_timeout(3000)
    
    -- NOTE: 容器内用 docker-compose 服务名 app:3000（127.0.0.1 指向 openresty 容器自身，不可达）
    local res, err = httpc:request_uri("http://app:3000/api/trpc/adManagement.getAdsForVideo", {
        method = "POST",
        body = cjson.encode({ json = { videoId = vid, uid = uid_val } }),
        headers = { ["Content-Type"] = "application/json" }
    })
    
    if not res or res.status ~= 200 then
        return {}
    end
    
    local data = cjson.decode(res.body)
    local placements = data.result and data.result.data and data.result.data.json or {}
    ad_cache:set(cache_key, cjson.encode(placements), 300)
    return placements
end

-- === 解析 m3u8 为片段列表 ===
local function parse_segments(m3u8_content)
    local segments = {}
    local current_duration = 0
    local cumulative_time = 0
    
    for line in m3u8_content:gmatch("[^\r\n]+") do
        if line:match("^#EXTINF:") then
            current_duration = tonumber(line:match("#EXTINF:([%d%.]+)"))
        elseif not line:match("^#") and line:match("%.ts") then
            table.insert(segments, {
                uri = line,
                duration = current_duration,
                start_time = cumulative_time
            })
            cumulative_time = cumulative_time + current_duration
            current_duration = 0
        end
    end
    
    return segments, cumulative_time
end

-- === 构建带广告的 m3u8 ===
local function build_stitched_playlist(original, placements, qual)
    local segments, total_duration = parse_segments(original)
    
    if #segments == 0 then
        return original
    end
    
    -- 分类广告: pre-roll, mid-roll, post-roll
    local pre_rolls = {}
    local mid_rolls = {}  -- { time_offset = X, ad_id = Y }
    local post_rolls = {}
    
    for _, p in ipairs(placements) do
        if p.position == "pre-roll" then
            table.insert(pre_rolls, p)
        elseif p.position == "post-roll" then
            table.insert(post_rolls, p)
        else
            -- mid-roll: position 格式为 "mid-roll@600" (600秒处)
            local offset = tonumber(p.position:match("@(%d+)")) or (total_duration / 2)
            table.insert(mid_rolls, { offset = offset, ad = p })
        end
    end
    
    -- 按时间排序 mid-rolls
    table.sort(mid_rolls, function(a, b) return a.offset < b.offset end)
    
    -- 开始构建新的 m3u8
    local output = {}
    table.insert(output, "#EXTM3U")
    table.insert(output, "#EXT-X-VERSION:6")
    table.insert(output, "#EXT-X-TARGETDURATION:6")
    table.insert(output, "#EXT-X-PLAYLIST-TYPE:VOD")
    table.insert(output, "#EXT-X-MEDIA-SEQUENCE:0")
    table.insert(output, "")
    
    -- 插入 pre-roll 广告
    for _, ad in ipairs(pre_rolls) do
        table.insert(output, "#EXT-X-DISCONTINUITY")
        table.insert(output, string.format("## Ad: %s (pre-roll)", ad.adId or "unknown"))
        -- 广告片段 (假设每个广告已转码为相同格式的 .ts)
        local ad_id = ad.adId or ad.ad_id
        local ad_segments = ad.segments or 1
        local ad_seg_duration = (ad.duration or 5) / ad_segments
        for i = 0, ad_segments - 1 do
            table.insert(output, string.format("#EXTINF:%.3f,", ad_seg_duration))
            table.insert(output, string.format("/ads/%s/%s/seg%04d.ts", ad_id, qual, i))
        end
        table.insert(output, "#EXT-X-DISCONTINUITY")
        table.insert(output, "")
    end
    
    -- 插入正片片段 + mid-roll 广告
    local mid_roll_idx = 1
    for _, seg in ipairs(segments) do
        -- 检查是否需要在此处插入 mid-roll
        while mid_roll_idx <= #mid_rolls do
            local mr = mid_rolls[mid_roll_idx]
            if seg.start_time >= mr.offset then
                -- 插入 mid-roll 广告
                table.insert(output, "")
                table.insert(output, "#EXT-X-DISCONTINUITY")
                table.insert(output, string.format("## Ad: %s (mid-roll@%ds)", 
                    mr.ad.adId or "unknown", mr.offset))
                local ad_id = mr.ad.adId or mr.ad.ad_id
                local ad_segments = mr.ad.segments or 3
                local ad_seg_duration = (mr.ad.duration or 15) / ad_segments
                for i = 0, ad_segments - 1 do
                    table.insert(output, string.format("#EXTINF:%.3f,", ad_seg_duration))
                    table.insert(output, string.format("/ads/%s/%s/seg%04d.ts", ad_id, qual, i))
                end
                table.insert(output, "#EXT-X-DISCONTINUITY")
                table.insert(output, "")
                mid_roll_idx = mid_roll_idx + 1
            else
                break
            end
        end
        
        -- 正片片段
        table.insert(output, string.format("#EXTINF:%.3f,", seg.duration))
        table.insert(output, string.format("/videos/%s/%s/%s", video_id, qual, seg.uri))
    end
    
    -- 插入 post-roll 广告
    for _, ad in ipairs(post_rolls) do
        table.insert(output, "")
        table.insert(output, "#EXT-X-DISCONTINUITY")
        table.insert(output, string.format("## Ad: %s (post-roll)", ad.adId or "unknown"))
        local ad_id = ad.adId or ad.ad_id
        local ad_segments = ad.segments or 1
        local ad_seg_duration = (ad.duration or 5) / ad_segments
        for i = 0, ad_segments - 1 do
            table.insert(output, string.format("#EXTINF:%.3f,", ad_seg_duration))
            table.insert(output, string.format("/ads/%s/%s/seg%04d.ts", ad_id, qual, i))
        end
        table.insert(output, "#EXT-X-DISCONTINUITY")
    end
    
    table.insert(output, "")
    table.insert(output, "#EXT-X-ENDLIST")
    
    return table.concat(output, "\n")
end

-- === 主逻辑 ===
local original = fetch_variant(video_id, quality)
if not original then
    ngx.status = 502
    ngx.say("Failed to fetch variant playlist")
    return
end

local placements = get_ad_placements(video_id, uid)

if #placements == 0 then
    -- 无广告，直接返回原始 (但重写路径为绝对路径)
    local rewritten = original:gsub("(seg%d+%.ts)", 
        "/videos/" .. video_id .. "/" .. quality .. "/%1")
    ngx.header["Content-Type"] = "application/vnd.apple.mpegurl"
    ngx.print(rewritten)
    return
end

-- 拼接广告
local stitched = build_stitched_playlist(original, placements, quality)

ngx.header["Content-Type"] = "application/vnd.apple.mpegurl"
ngx.header["X-Ad-Placements"] = tostring(#placements)
ngx.print(stitched)
