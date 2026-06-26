"""
通知管道。

目前只有 Telegram；未來要加入 Line Notify / Email 等其他管道時，
新增一個對應的 Notifier 類別（例如 LineNotifier），並在 main.py
依照 rule["notify"] 清單分派即可，不需要修改既有的 TelegramNotifier。
"""
import os

import requests


class TelegramNotifier:
    def __init__(self, token: str = None, chat_id: str = None):
        self.token = token or os.environ.get("TELEGRAM_BOT_TOKEN")
        self.chat_id = chat_id or os.environ.get("TELEGRAM_CHAT_ID")
        if not self.token or not self.chat_id:
            raise RuntimeError(
                "缺少 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID，"
                "請確認 GitHub Secrets 是否已設定"
            )

    def send(self, text: str) -> None:
        url = f"https://api.telegram.org/bot{self.token}/sendMessage"
        resp = requests.post(
            url,
            json={"chat_id": self.chat_id, "text": text, "parse_mode": "Markdown"},
            timeout=10,
        )
        resp.raise_for_status()
