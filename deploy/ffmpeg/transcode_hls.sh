#!/bin/bash
# ============================================================
# OpenAdult HLS 多码率自适应转码脚本
# 用途: 将上传的MP4视频转码为多码率HLS片段 + AES-128加密
# 依赖: FFmpeg 6.x+, openssl, aws-cli (或 s3cmd)
# ============================================================

set -euo pipefail

# === 配置 ===
INPUT_FILE="$1"                          # 输入视频文件路径
VIDEO_ID="$2"                            # 视频唯一ID
OUTPUT_BASE="${3:-/data/hls}"            # 输出根目录
S3_BUCKET="${S3_BUCKET:-openadult-media}" # S3 存储桶名
S3_ENDPOINT="${S3_ENDPOINT:-https://s3.us-west-002.backblazeb2.com}"
KEY_SERVER_URL="${KEY_SERVER_URL:-https://api.openadult.com/api/hls/key}"
SEGMENT_DURATION=6                       # 每个片段时长(秒)

# === 验证输入 ===
if [ -z "$INPUT_FILE" ] || [ -z "$VIDEO_ID" ]; then
    echo "用法: $0 <输入视频> <视频ID> [输出目录]"
    echo "示例: $0 /uploads/video.mp4 abc123 /data/hls"
    exit 1
fi

if [ ! -f "$INPUT_FILE" ]; then
    echo "错误: 输入文件不存在: $INPUT_FILE"
    exit 1
fi

# === 创建输出目录 ===
OUTPUT_DIR="$OUTPUT_BASE/$VIDEO_ID"
mkdir -p "$OUTPUT_DIR"/{1080p,720p,480p,360p}

echo "========================================="
echo "OpenAdult HLS 转码开始"
echo "输入: $INPUT_FILE"
echo "视频ID: $VIDEO_ID"
echo "输出: $OUTPUT_DIR"
echo "========================================="

# === 生成 AES-128 加密密钥 ===
KEY_FILE="$OUTPUT_DIR/enc.key"
KEY_INFO_FILE="$OUTPUT_DIR/enc.keyinfo"
openssl rand 16 > "$KEY_FILE"
KEY_HEX=$(xxd -p "$KEY_FILE" | tr -d '\n')

# 生成 IV (初始化向量)
IV=$(openssl rand -hex 16)

# 创建 keyinfo 文件 (FFmpeg 需要)
# 格式: 第1行=密钥URL, 第2行=本地密钥路径, 第3行=IV
cat > "$KEY_INFO_FILE" << EOF
${KEY_SERVER_URL}/${VIDEO_ID}
${KEY_FILE}
${IV}
EOF

echo "[1/5] AES-128 加密密钥已生成"

# === 获取视频信息 ===
DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$INPUT_FILE")
RESOLUTION=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$INPUT_FILE")
echo "[INFO] 视频时长: ${DURATION}s, 分辨率: $RESOLUTION"

# === 多码率转码 ===
echo "[2/5] 开始多码率转码..."

# 1080p (如果源分辨率 >= 1080p)
ffmpeg -y -i "$INPUT_FILE" \
    -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" \
    -c:v libx264 -preset medium -b:v 5000k -maxrate 5500k -bufsize 10000k \
    -c:a aac -b:a 192k -ar 48000 \
    -hls_time $SEGMENT_DURATION \
    -hls_playlist_type vod \
    -hls_segment_filename "$OUTPUT_DIR/1080p/seg%04d.ts" \
    -hls_key_info_file "$KEY_INFO_FILE" \
    -hls_flags independent_segments \
    -f hls "$OUTPUT_DIR/1080p/index.m3u8" \
    2>/dev/null &
PID_1080=$!

# 720p
ffmpeg -y -i "$INPUT_FILE" \
    -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2" \
    -c:v libx264 -preset medium -b:v 2800k -maxrate 3000k -bufsize 6000k \
    -c:a aac -b:a 128k -ar 48000 \
    -hls_time $SEGMENT_DURATION \
    -hls_playlist_type vod \
    -hls_segment_filename "$OUTPUT_DIR/720p/seg%04d.ts" \
    -hls_key_info_file "$KEY_INFO_FILE" \
    -hls_flags independent_segments \
    -f hls "$OUTPUT_DIR/720p/index.m3u8" \
    2>/dev/null &
PID_720=$!

# 480p
ffmpeg -y -i "$INPUT_FILE" \
    -vf "scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2" \
    -c:v libx264 -preset medium -b:v 1400k -maxrate 1500k -bufsize 3000k \
    -c:a aac -b:a 128k -ar 44100 \
    -hls_time $SEGMENT_DURATION \
    -hls_playlist_type vod \
    -hls_segment_filename "$OUTPUT_DIR/480p/seg%04d.ts" \
    -hls_key_info_file "$KEY_INFO_FILE" \
    -hls_flags independent_segments \
    -f hls "$OUTPUT_DIR/480p/index.m3u8" \
    2>/dev/null &
PID_480=$!

# 360p (移动端低带宽)
ffmpeg -y -i "$INPUT_FILE" \
    -vf "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2" \
    -c:v libx264 -preset fast -b:v 800k -maxrate 900k -bufsize 1800k \
    -c:a aac -b:a 96k -ar 44100 \
    -hls_time $SEGMENT_DURATION \
    -hls_playlist_type vod \
    -hls_segment_filename "$OUTPUT_DIR/360p/seg%04d.ts" \
    -hls_key_info_file "$KEY_INFO_FILE" \
    -hls_flags independent_segments \
    -f hls "$OUTPUT_DIR/360p/index.m3u8" \
    2>/dev/null &
PID_360=$!

# 等待所有转码完成
wait $PID_1080 $PID_720 $PID_480 $PID_360
echo "[2/5] 多码率转码完成"

# === 生成 Master Playlist ===
echo "[3/5] 生成 Master Playlist..."

cat > "$OUTPUT_DIR/master.m3u8" << EOF
#EXTM3U
#EXT-X-VERSION:6

#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",NAME="1080p"
1080p/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=2900000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",NAME="720p"
720p/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=854x480,CODECS="avc1.4d401e,mp4a.40.2",NAME="480p"
480p/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.42e015,mp4a.40.2",NAME="360p"
360p/index.m3u8
EOF

echo "[3/5] Master Playlist 已生成"

# === 生成缩略图 (每30秒一张) ===
echo "[4/5] 生成缩略图..."
THUMB_DIR="$OUTPUT_DIR/thumbnails"
mkdir -p "$THUMB_DIR"
ffmpeg -y -i "$INPUT_FILE" \
    -vf "fps=1/30,scale=320:180" \
    -q:v 5 \
    "$THUMB_DIR/thumb_%04d.jpg" \
    2>/dev/null
echo "[4/5] 缩略图已生成"

# === 上传到 S3 ===
echo "[5/5] 上传到 S3..."

# 上传所有 .ts 片段和 .m3u8 文件
aws s3 sync "$OUTPUT_DIR" "s3://$S3_BUCKET/videos/$VIDEO_ID/" \
    --endpoint-url "$S3_ENDPOINT" \
    --exclude "enc.key" \
    --exclude "enc.keyinfo" \
    --content-type "application/vnd.apple.mpegurl" \
    --include "*.m3u8" \
    --quiet

# 单独上传 .ts 文件 (设置正确的 Content-Type)
aws s3 sync "$OUTPUT_DIR" "s3://$S3_BUCKET/videos/$VIDEO_ID/" \
    --endpoint-url "$S3_ENDPOINT" \
    --exclude "*" \
    --include "*.ts" \
    --content-type "video/MP2T" \
    --quiet

# 上传缩略图
aws s3 sync "$THUMB_DIR" "s3://$S3_BUCKET/videos/$VIDEO_ID/thumbnails/" \
    --endpoint-url "$S3_ENDPOINT" \
    --content-type "image/jpeg" \
    --quiet

echo "[5/5] S3 上传完成"

# === 将加密密钥存储到密钥服务 ===
# 注意: 密钥不上传到 S3，而是存储在数据库中，通过密钥服务 API 提供
curl -s -X POST "${KEY_SERVER_URL}/register" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${ADMIN_API_KEY:-}" \
    -d "{\"videoId\":\"$VIDEO_ID\",\"keyHex\":\"$KEY_HEX\",\"iv\":\"$IV\"}" \
    > /dev/null 2>&1 || echo "[WARN] 密钥注册失败，请手动注册"

# === 清理本地临时文件 (可选) ===
# rm -rf "$OUTPUT_DIR"  # 取消注释以清理本地文件

echo "========================================="
echo "转码完成!"
echo "Master Playlist: s3://$S3_BUCKET/videos/$VIDEO_ID/master.m3u8"
echo "播放地址: https://cdn.openadult.com/videos/$VIDEO_ID/master.m3u8"
echo "片段数量: $(find "$OUTPUT_DIR" -name "*.ts" | wc -l)"
echo "总大小: $(du -sh "$OUTPUT_DIR" | cut -f1)"
echo "========================================="
