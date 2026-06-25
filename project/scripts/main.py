"""
主程式：被 GitHub Actions 每 10 分鐘呼叫一次。

流程：
  讀取 rules/rules.json
    -> 依 symbol 抓歷史價格（同一個 symbol 只抓一次，做快取）
    -> 用 Rule Engine 計算指標、判斷是否符合條件
    -> 比對 state/state.json，決定要不要發通知（邊緣觸發）
    -> 觸發就送 Telegram
    -> 寫回 state/state.json（由 GitHub Actions 負責 git commit）

單一規則執行失敗（例如代號打錯、資料不足）不會讓其他規則跟著失敗，
只會印出錯誤訊息並繼續處理下一筆規則。
"""
import json
import os
import sys
import traceback

from data_provider import YFinanceProvider
from notifier import TelegramNotifier
from rule_engine import ConditionFactory
from state_manager import StateManager

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RULES_PATH = os.path.join(BASE_DIR, "rules", "rules.json")
STATE_PATH = os.path.join(BASE_DIR, "state", "state.json")


def load_rules() -> list:
    with open(RULES_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("rules", [])


def build_message(rule: dict, result) -> str:
    name = rule.get("name", rule["id"])
    return (
        f"🚨 *警示觸發*\n"
        f"規則：{name}\n"
        f"標的：`{rule['symbol']}`\n"
        f"{result.message}"
    )


def main() -> int:
    rules = load_rules()
    provider = YFinanceProvider()
    state_mgr = StateManager(STATE_PATH)

    # Telegram 設定缺失時，先讓程式可以跑（方便本地測試/除錯），
    # 真正要送通知的那一刻才會丟錯，並印出清楚訊息。
    notifier = None
    notifier_error = None
    try:
        notifier = TelegramNotifier()
    except RuntimeError as e:
        notifier_error = str(e)

    history_cache: dict = {}
    had_error = False

    for rule in rules:
        if not rule.get("enabled", True):
            continue

        rule_id = rule["id"]
        symbol = rule["symbol"]

        try:
            if symbol not in history_cache:
                history_cache[symbol] = provider.get_history(symbol, period="5y")
            df = history_cache[symbol]

            condition = ConditionFactory.create(rule)
            result = condition.evaluate(df)

            need_notify = state_mgr.should_notify(rule_id, result.triggered, result.current_value)

            if need_notify:
                text = build_message(rule, result)
                if "telegram" in rule.get("notify", ["telegram"]):
                    if notifier is None:
                        raise RuntimeError(notifier_error)
                    notifier.send(text)
                print(f"[NOTIFY] {rule_id} {symbol} -> {result.message}")
            else:
                status = "triggered" if result.triggered else "idle"
                print(f"[{status.upper()}] {rule_id} {symbol} -> {result.message}")

        except Exception as e:  # noqa: BLE001
            had_error = True
            print(f"[ERROR] 規則 {rule_id} ({symbol}) 執行失敗: {e}", file=sys.stderr)
            traceback.print_exc()
            continue

    state_mgr.save()
    # 單筆規則失敗不讓整個 workflow 標記失敗（避免代號打錯就一直收到 GitHub 的失敗信），
    # 但仍把錯誤印到 stderr 方便之後在 Actions log 裡查。
    return 0 if not had_error else 0


if __name__ == "__main__":
    sys.exit(main())
