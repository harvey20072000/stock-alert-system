"""
state.json 讀寫，負責「避免重複通知」的邊緣觸發（edge-trigger）邏輯：

    第一次成立  -> 通知，記錄 is_triggered=True
    持續成立    -> 不再通知
    解除成立    -> 重置 is_triggered=False
    再次成立    -> 再通知一次

這支檔案只負責「狀態」本身，完全不知道 Telegram、不知道 Rule Engine，
保持單一職責，方便未來替換成其他儲存方式（例如真的換成資料庫）時，
只需要替換這個類別的實作。
"""
import json
import os
from datetime import datetime, timedelta, timezone

TAIPEI_TZ = timezone(timedelta(hours=8))


class StateManager:
    def __init__(self, path: str):
        self.path = path
        self._state: dict = self._load()

    def _load(self) -> dict:
        if not os.path.exists(self.path):
            return {}
        with open(self.path, "r", encoding="utf-8") as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                # state.json 損毀時不要讓整個排程掛掉，從空狀態重新開始即可
                return {}

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self._state, f, ensure_ascii=False, indent=2)

    def should_notify(self, rule_id: str, triggered: bool, current_value: float) -> bool:
        """
        判斷這次執行「是否需要發送通知」，同時更新內部狀態（呼叫後記得呼叫 save()）。
        """
        prev = self._state.get(rule_id, {"is_triggered": False})
        prev_triggered = bool(prev.get("is_triggered", False))

        need_notify = (not prev_triggered) and triggered
        now_str = datetime.now(TAIPEI_TZ).isoformat()

        self._state[rule_id] = {
            "is_triggered": triggered,
            "last_value": current_value,
            "last_checked_at": now_str,
            "last_triggered_at": now_str if need_notify else prev.get("last_triggered_at"),
        }
        return need_notify
