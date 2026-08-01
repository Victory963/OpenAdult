-- ============================================================
-- OpenAdult SSAI 广告拼接引擎 (Master Playlist)
-- 功能: 根据用户画像动态选择广告，生成带广告的 master.m3u8
-- 位置: /etc/openresty/lua/ad_stitcher.lua
-- ============================================================

local cjson = require "cjson"
local http = require "resty.http"

-- 共享内存缓存
local ad_cache = ngx.shared.ad_cache

-- === 获取用户信息 ===
local function get_user_context()
    return {
        ip = ngx.var.remote_addr,
        geo = ngx.req.get_headers()["CF-IPCountry"] or "XX",
        device = ngx.req.get_headers()["CF-Device-Type"] or "desktop",
        user_agent = ngx.req.get_headers()["User-Agent"] or "",
        video_id = ngx.var.video_id,
        -- 用户ID (从cookie或header)
        uid = ngx.var.cookie_session_id or "anonymous"
    }
end

-- === 从广告决策服务获取广告 ===
local function fetch_ads(ctx)
    -- 先检查缓存 (同一用户+视频 缓存5分钟)
    local cache_key = ctx.uid .. ":" .. ctx.video_id
    local cached = ad_cache:get(cache_key)
    if cached then
        return cjson.decode(cached)
    end
    
    -- 请求广告决策服务
    local httpc = http.new()
    httpc:set_timeout(3000) -- 3秒超时
    
    -- NOTE: 容器内用 docker-compose 服务名 app:3000（127.0.0.1 指向 openresty 容器自身，不可达）
    local res, err = httpc:request_uri("http://app:3000/api/trpc/adManagement.getAdsForVideo", {
        method = "POST",
        body = cjson.encode({
            json = {
                videoId = ctx.video_id,
                geo = ctx.geo,
                device = ctx.device,
                uid = ctx.uid
            }
        }),
        headers = {
            ["Content-Type"] = "application/json",
        }
    })
    
    if not res or res.status ~= 200 then
        -- 广告服务不可用时，返回无广告版本
        ngx.log(ngx.WARN, "广告服务不可用: ", err or res.status)
        return nil
    end
    
    local data = cjson.decode(res.body)
    local ads = data.result and data.result.data and data.result.data.json
    
    if ads then
        -- 缓存5分钟
        ad_cache:set(cache_key, cjson.encode(ads), 300)
    end
    
    return ads
end

-- === 获取原始 master.m3u8 ===
local function fetch_original_manifest(video_id)
    local cache_key = "manifest:" .. video_id
    local cached = ad_cache:get(cache_key)
    if cached then
        return cached
    end
    
    local httpc = http.new()
    httpc:set_timeout(5000)
    
    -- 从 S3 获取原始播放列表
    local s3_url = "https://s3.us-west-002.backblazeb2.com/openadult-media/videos/" 
                   .. video_id .. "/master.m3u8"
    
    local res, err = httpc:request_uri(s3_url, {
        method = "GET",
        ssl_verify = false
    })
    
    if not res or res.status ~= 200 then
        ngx.log(ngx.ERR, "获取原始m3u8失败: ", err or res.status)
        return nil
    end
    
    -- 缓存1小时 (视频内容不变)
    ad_cache:set(cache_key, res.body, 3600)
    return res.body
end

-- === 主逻辑 ===
local ctx = get_user_context()
local ads = fetch_ads(ctx)

-- 如果没有广告，直接代理原始 master.m3u8
if not ads or #ads == 0 then
    local manifest = fetch_original_manifest(ctx.video_id)
    if not manifest then
        ngx.status = 502
        ngx.say("Failed to fetch manifest")
        return
    end
    ngx.header["Content-Type"] = "application/vnd.apple.mpegurl"
    ngx.say(manifest)
    return
end

-- 有广告时，重写 master.m3u8 指向带广告的 variant playlist
-- 注意: master playlist 本身不包含广告，广告在 variant level 拼接
local manifest = "#EXTM3U\n#EXT-X-VERSION:6\n\n"

-- 添加各码率流 (指向我们的动态 variant endpoint)
local qualities = {
    { name = "1080p", bw = 5200000, res = "1920x1080", codecs = "avc1.640028,mp4a.40.2" },
    { name = "720p",  bw = 2900000, res = "1280x720",  codecs = "avc1.64001f,mp4a.40.2" },
    { name = "480p",  bw = 1500000, res = "854x480",   codecs = "avc1.4d401e,mp4a.40.2" },
    { name = "360p",  bw = 900000,  res = "640x360",   codecs = "avc1.42e015,mp4a.40.2" },
}

for _, q in ipairs(qualities) do
    manifest = manifest .. string.format(
        '#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%s,CODECS="%s",NAME="%s"\n',
        q.bw, q.res, q.codecs, q.name
    )
    -- 指向动态 variant playlist (会在 variant_stitcher.lua 中拼接广告)
    manifest = manifest .. string.format(
        "/videos/%s/%s/index.m3u8?uid=%s\n",
        ctx.video_id, q.name, ngx.escape_uri(ctx.uid)
    )
end

ngx.header["Content-Type"] = "application/vnd.apple.mpegurl"
ngx.header["X-Ad-Count"] = tostring(#ads)
ngx.print(manifest)
