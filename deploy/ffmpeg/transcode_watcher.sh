#!/bin/bash
# ============================================================
# OpenAdult 转码监控服务
# 用途: 监控上传目录，自动触发转码
# 部署: 作为 systemd 服务运行
# ============================================================

WATCH_DIR="${WATCH_DIR:-/data/uploads}"
TRANSCODE_SCRIPT="$(dirname "$0")/transcode_hls.sh"
LOG_FILE="/var/log/openadult/transcode.log"
API_BASE="${API_BASE:-http://localhost:3000}"
API_KEY="${ADMIN_API_KEY:-}"

mkdir -p "$WATCH_DIR" "$(dirname "$LOG_FILE")"

log() {
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_FILE"
}

# 通知API转码状态
notify_status() {
    local video_id="$1"
    local status="$2"
    curl -s -X POST "$API_BASE/api/trpc/hlsStream.updateTranscodeStatus" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $API_KEY" \
        -d "{\"json\":{\"videoId\":\"$video_id\",\"status\":\"$status\"}}" \
        > /dev/null 2>&1
}

log "=== OpenAdult 转码监控服务启动 ==="
log "监控目录: $WATCH_DIR"

# 使用 inotifywait 监控新文件
inotifywait -m -e close_write -e moved_to --format '%f' "$WATCH_DIR" | while read -r FILENAME; do
    # 只处理视频文件
    if [[ "$FILENAME" =~ \.(mp4|mkv|avi|mov|webm)$ ]]; then
        FILEPATH="$WATCH_DIR/$FILENAME"
        # 从文件名提取视频ID (格式: videoId_original.mp4)
        VIDEO_ID=$(echo "$FILENAME" | cut -d'_' -f1)
        
        if [ -z "$VIDEO_ID" ]; then
            VIDEO_ID=$(echo "$FILENAME" | sed 's/\.[^.]*$//')
        fi
        
        log "检测到新视频: $FILENAME (ID: $VIDEO_ID)"
        notify_status "$VIDEO_ID" "transcoding"
        
        # 执行转码
        if bash "$TRANSCODE_SCRIPT" "$FILEPATH" "$VIDEO_ID" 2>&1 | tee -a "$LOG_FILE"; then
            log "转码成功: $VIDEO_ID"
            notify_status "$VIDEO_ID" "ready"
            # 转码成功后删除原始文件
            rm -f "$FILEPATH"
        else
            log "转码失败: $VIDEO_ID"
            notify_status "$VIDEO_ID" "failed"
            # 移动到失败目录
            mkdir -p "$WATCH_DIR/failed"
            mv "$FILEPATH" "$WATCH_DIR/failed/"
        fi
    fi
done
