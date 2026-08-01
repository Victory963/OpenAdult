#!/bin/bash
# ============================================================
# OpenAdult 广告素材 HLS 转码脚本
# 用途: 将广告视频转码为与正片相同规格的 HLS 片段
# 关键: 广告片段必须与正片使用相同编码参数，确保无缝拼接
# ============================================================

set -euo pipefail

INPUT_FILE="$1"
AD_ID="$2"
OUTPUT_BASE="${3:-/data/ads}"
S3_BUCKET="${S3_BUCKET:-openadult-media}"
S3_ENDPOINT="${S3_ENDPOINT:-https://s3.us-west-002.backblazeb2.com}"
SEGMENT_DURATION=6

if [ -z "$INPUT_FILE" ] || [ -z "$AD_ID" ]; then
    echo "用法: $0 <广告视频> <广告ID> [输出目录]"
    exit 1
fi

OUTPUT_DIR="$OUTPUT_BASE/$AD_ID"
mkdir -p "$OUTPUT_DIR"/{1080p,720p,480p,360p}

echo "=== 广告素材转码: $AD_ID ==="

# 广告不加密 (需要被CDN缓存)
# 多码率转码，参数与正片完全一致

# 1080p
ffmpeg -y -i "$INPUT_FILE" \
    -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" \
    -c:v libx264 -preset medium -b:v 5000k -maxrate 5500k -bufsize 10000k \
    -c:a aac -b:a 192k -ar 48000 \
    -hls_time $SEGMENT_DURATION \
    -hls_playlist_type vod \
    -hls_segment_filename "$OUTPUT_DIR/1080p/seg%04d.ts" \
    -hls_flags independent_segments \
    -f hls "$OUTPUT_DIR/1080p/index.m3u8" \
    2>/dev/null &

# 720p
ffmpeg -y -i "$INPUT_FILE" \
    -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2" \
    -c:v libx264 -preset medium -b:v 2800k -maxrate 3000k -bufsize 6000k \
    -c:a aac -b:a 128k -ar 48000 \
    -hls_time $SEGMENT_DURATION \
    -hls_playlist_type vod \
    -hls_segment_filename "$OUTPUT_DIR/720p/seg%04d.ts" \
    -hls_flags independent_segments \
    -f hls "$OUTPUT_DIR/720p/index.m3u8" \
    2>/dev/null &

# 480p
ffmpeg -y -i "$INPUT_FILE" \
    -vf "scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2" \
    -c:v libx264 -preset medium -b:v 1400k -maxrate 1500k -bufsize 3000k \
    -c:a aac -b:a 128k -ar 44100 \
    -hls_time $SEGMENT_DURATION \
    -hls_playlist_type vod \
    -hls_segment_filename "$OUTPUT_DIR/480p/seg%04d.ts" \
    -hls_flags independent_segments \
    -f hls "$OUTPUT_DIR/480p/index.m3u8" \
    2>/dev/null &

# 360p
ffmpeg -y -i "$INPUT_FILE" \
    -vf "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2" \
    -c:v libx264 -preset fast -b:v 800k -maxrate 900k -bufsize 1800k \
    -c:a aac -b:a 96k -ar 44100 \
    -hls_time $SEGMENT_DURATION \
    -hls_playlist_type vod \
    -hls_segment_filename "$OUTPUT_DIR/360p/seg%04d.ts" \
    -hls_flags independent_segments \
    -f hls "$OUTPUT_DIR/360p/index.m3u8" \
    2>/dev/null &

wait
echo "转码完成"

# 生成 master playlist
cat > "$OUTPUT_DIR/master.m3u8" << EOF
#EXTM3U
#EXT-X-VERSION:6
#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,NAME="1080p"
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2900000,RESOLUTION=1280x720,NAME="720p"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=854x480,NAME="480p"
480p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,NAME="360p"
360p/index.m3u8
EOF

# 上传到 S3
aws s3 sync "$OUTPUT_DIR" "s3://$S3_BUCKET/ads/$AD_ID/" \
    --endpoint-url "$S3_ENDPOINT" \
    --quiet

echo "广告素材已上传: s3://$S3_BUCKET/ads/$AD_ID/"
echo "广告时长: $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$INPUT_FILE")s"
