#!/usr/bin/env python3
"""
OpenAdult 域名轮换系统 (Domain Rotator)
========================================
功能:
  1. 定期检测所有域名的可访问性 (多地区探测)
  2. 检测到封锁时自动切换到备用域名
  3. 通过 Cloudflare API 更新 DNS 记录
  4. 通过 Telegram Bot 通知用户新域名
  5. 更新前端配置中的 API 端点

部署: 作为 systemd 服务或 cron 任务运行
依赖: pip install requests cloudflare python-telegram-bot
"""

import os
import sys
import json
import time
import logging
import hashlib
import requests
from datetime import datetime, timezone
from typing import Optional

# === 配置 ===
CONFIG = {
    # Cloudflare
    "cf_api_token": os.environ.get("CF_API_TOKEN", ""),
    "cf_zone_id": os.environ.get("CF_ZONE_ID", ""),
    
    # Telegram 通知
    "tg_bot_token": os.environ.get("TG_BOT_TOKEN", ""),
    "tg_channel_id": os.environ.get("TG_CHANNEL_ID", ""),  # @openadult_updates
    
    # 源站 IP (Cloudflare 代理后面)
    "origin_ip": os.environ.get("ORIGIN_IP", ""),
    
    # 域名池
    "domains": json.loads(os.environ.get("DOMAIN_POOL", '[]')) or [
        "openadult.com",
        "openadult.net",
        "openadult.org",
        "oa-video.com",
        "oa-stream.net",
        "adult-open.com",
        "open-av.net",
        "oa-cdn.com",
        "stream-oa.net",
        "video-oa.org",
    ],
    
    # 当前活跃域名索引
    "active_index": int(os.environ.get("ACTIVE_DOMAIN_INDEX", "0")),
    
    # 探测节点 (分布在不同地区)
    "probe_endpoints": json.loads(os.environ.get("PROBE_ENDPOINTS", '[]')) or [
        {"name": "JP-Tokyo", "url": "http://probe-jp.openadult.internal/check"},
        {"name": "US-LA", "url": "http://probe-us.openadult.internal/check"},
        {"name": "EU-Frankfurt", "url": "http://probe-eu.openadult.internal/check"},
        {"name": "SG-Singapore", "url": "http://probe-sg.openadult.internal/check"},
    ],
    
    # 检测间隔 (秒)
    "check_interval": 60,
    
    # 封锁阈值 (超过此比例的探测节点报告不可访问则判定为封锁)
    "block_threshold": 0.5,
    
    # 状态文件
    "state_file": "/var/lib/openadult/rotator_state.json",
    
    # API 端点更新
    "api_config_url": os.environ.get("API_CONFIG_URL", ""),
    "api_config_key": os.environ.get("API_CONFIG_KEY", ""),
}

# === 日志配置 ===
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s: %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler('/var/log/openadult/domain_rotator.log')
    ]
)
logger = logging.getLogger(__name__)


class DomainRotator:
    def __init__(self, config: dict):
        self.config = config
        self.state = self._load_state()
    
    def _load_state(self) -> dict:
        """加载持久化状态"""
        try:
            with open(self.config["state_file"], 'r') as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return {
                "active_domain": self.config["domains"][self.config["active_index"]],
                "blocked_domains": [],
                "last_rotation": None,
                "rotation_count": 0,
                "history": []
            }
    
    def _save_state(self):
        """保存状态到磁盘"""
        os.makedirs(os.path.dirname(self.config["state_file"]), exist_ok=True)
        with open(self.config["state_file"], 'w') as f:
            json.dump(self.state, f, indent=2, default=str)
    
    def check_domain_health(self, domain: str) -> dict:
        """
        通过多个探测节点检测域名可访问性
        返回: {"accessible": bool, "details": [...]}
        """
        results = []
        
        for probe in self.config["probe_endpoints"]:
            try:
                resp = requests.post(
                    probe["url"],
                    json={"domain": domain, "path": "/health"},
                    timeout=10
                )
                data = resp.json()
                results.append({
                    "probe": probe["name"],
                    "accessible": data.get("accessible", False),
                    "status_code": data.get("status_code"),
                    "latency_ms": data.get("latency_ms"),
                    "error": data.get("error")
                })
            except Exception as e:
                results.append({
                    "probe": probe["name"],
                    "accessible": False,
                    "error": str(e)
                })
        
        # 如果没有探测节点可用，直接检测
        if not results:
            try:
                resp = requests.get(
                    f"https://{domain}/health",
                    timeout=10,
                    allow_redirects=False
                )
                results.append({
                    "probe": "self",
                    "accessible": resp.status_code == 200,
                    "status_code": resp.status_code
                })
            except Exception as e:
                results.append({
                    "probe": "self",
                    "accessible": False,
                    "error": str(e)
                })
        
        accessible_count = sum(1 for r in results if r["accessible"])
        total_count = len(results)
        
        return {
            "domain": domain,
            "accessible": (accessible_count / total_count) > (1 - self.config["block_threshold"]),
            "accessible_ratio": f"{accessible_count}/{total_count}",
            "details": results
        }
    
    def rotate_domain(self, blocked_domain: str) -> Optional[str]:
        """
        轮换到下一个可用域名
        返回: 新的活跃域名 或 None (无可用域名)
        """
        # 将当前域名标记为已封锁
        if blocked_domain not in self.state["blocked_domains"]:
            self.state["blocked_domains"].append(blocked_domain)
        
        # 寻找下一个未封锁的域名
        available = [d for d in self.config["domains"] 
                     if d not in self.state["blocked_domains"]]
        
        if not available:
            logger.critical("所有域名已被封锁! 需要补充新域名!")
            self._notify_telegram("🚨 紧急: 所有域名已被封锁!\n请立即补充新域名到域名池。")
            return None
        
        new_domain = available[0]
        logger.info(f"轮换域名: {blocked_domain} -> {new_domain}")
        
        # 更新 Cloudflare DNS
        self._update_cloudflare_dns(new_domain)
        
        # 更新前端 API 配置
        self._update_api_config(new_domain)
        
        # 通知 Telegram 频道
        self._notify_telegram(
            f"🔄 域名已切换\n\n"
            f"旧域名: {blocked_domain} (已封锁)\n"
            f"新域名: https://{new_domain}\n"
            f"剩余备用: {len(available) - 1} 个\n\n"
            f"请使用新域名访问。"
        )
        
        # 更新状态
        self.state["active_domain"] = new_domain
        self.state["last_rotation"] = datetime.now(timezone.utc).isoformat()
        self.state["rotation_count"] += 1
        self.state["history"].append({
            "time": datetime.now(timezone.utc).isoformat(),
            "from": blocked_domain,
            "to": new_domain,
            "reason": "blocked"
        })
        self._save_state()
        
        return new_domain
    
    def _update_cloudflare_dns(self, domain: str):
        """更新 Cloudflare DNS A 记录"""
        if not self.config["cf_api_token"]:
            logger.warning("Cloudflare API Token 未配置，跳过 DNS 更新")
            return
        
        headers = {
            "Authorization": f"Bearer {self.config['cf_api_token']}",
            "Content-Type": "application/json"
        }
        
        # 获取现有 DNS 记录
        zone_id = self.config["cf_zone_id"]
        resp = requests.get(
            f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records?type=A&name={domain}",
            headers=headers
        )
        
        if resp.status_code == 200:
            records = resp.json().get("result", [])
            if records:
                # 更新现有记录
                record_id = records[0]["id"]
                requests.put(
                    f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{record_id}",
                    headers=headers,
                    json={
                        "type": "A",
                        "name": domain,
                        "content": self.config["origin_ip"],
                        "proxied": True,  # 开启 Cloudflare 代理
                        "ttl": 1  # Auto TTL
                    }
                )
            else:
                # 创建新记录
                requests.post(
                    f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records",
                    headers=headers,
                    json={
                        "type": "A",
                        "name": domain,
                        "content": self.config["origin_ip"],
                        "proxied": True,
                        "ttl": 1
                    }
                )
        
        logger.info(f"Cloudflare DNS 已更新: {domain} -> {self.config['origin_ip']} (proxied)")
    
    def _update_api_config(self, new_domain: str):
        """更新前端 API 配置 (通知应用服务器)"""
        if not self.config["api_config_url"]:
            return
        
        try:
            requests.post(
                self.config["api_config_url"],
                json={
                    "activeDomain": new_domain,
                    "apiBase": f"https://{new_domain}/api",
                    "cdnBase": f"https://cdn-{new_domain.split('.')[0]}.openadult.com"
                },
                headers={"Authorization": f"Bearer {self.config['api_config_key']}"},
                timeout=10
            )
        except Exception as e:
            logger.error(f"API 配置更新失败: {e}")
    
    def _notify_telegram(self, message: str):
        """发送 Telegram 通知"""
        if not self.config["tg_bot_token"]:
            logger.info(f"[TG通知] {message}")
            return
        
        try:
            requests.post(
                f"https://api.telegram.org/bot{self.config['tg_bot_token']}/sendMessage",
                json={
                    "chat_id": self.config["tg_channel_id"],
                    "text": message,
                    "parse_mode": "HTML"
                },
                timeout=10
            )
        except Exception as e:
            logger.error(f"Telegram 通知失败: {e}")
    
    def run(self):
        """主循环"""
        logger.info(f"域名轮换服务启动 | 活跃域名: {self.state['active_domain']}")
        logger.info(f"域名池: {len(self.config['domains'])} 个 | 已封锁: {len(self.state['blocked_domains'])} 个")
        
        while True:
            try:
                current_domain = self.state["active_domain"]
                health = self.check_domain_health(current_domain)
                
                if health["accessible"]:
                    logger.debug(f"域名正常: {current_domain} ({health['accessible_ratio']})")
                else:
                    logger.warning(f"域名异常: {current_domain} ({health['accessible_ratio']})")
                    logger.warning(f"详情: {json.dumps(health['details'], ensure_ascii=False)}")
                    
                    # 二次确认 (等待30秒再检测一次)
                    time.sleep(30)
                    health2 = self.check_domain_health(current_domain)
                    
                    if not health2["accessible"]:
                        logger.error(f"确认封锁: {current_domain}")
                        new_domain = self.rotate_domain(current_domain)
                        if not new_domain:
                            # 所有域名耗尽，等待更长时间
                            time.sleep(300)
                
            except Exception as e:
                logger.error(f"检测循环异常: {e}", exc_info=True)
            
            time.sleep(self.config["check_interval"])


if __name__ == "__main__":
    # 确保日志目录存在
    os.makedirs('/var/log/openadult', exist_ok=True)
    os.makedirs('/var/lib/openadult', exist_ok=True)
    
    rotator = DomainRotator(CONFIG)
    rotator.run()
