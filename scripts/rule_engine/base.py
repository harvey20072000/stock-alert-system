"""
Rule Engine 核心基礎類別。

設計原則：
  - Condition 是所有「條件類型」的共同介面，子類別只需要實作 calculate()，
    回傳「目前的指標數值」即可；和 operator/threshold 比較、組訊息的邏輯都
    寫在這個基礎類別裡，不用每個條件重複寫。
  - 新增條件類型（例如 MACD）時，完全不需要修改這個檔案。
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional

import pandas as pd


@dataclass
class RuleResult:
    """單次評估的結果"""
    triggered: bool
    current_value: float
    message: str
    extra: dict = field(default_factory=dict)


# 運算子對照表，rules.json 裡的 operator 欄位只能是這四種之一
OPERATORS = {
    ">": lambda a, b: a > b,
    "<": lambda a, b: a < b,
    ">=": lambda a, b: a >= b,
    "<=": lambda a, b: a <= b,
}


class Condition(ABC):
    """
    所有條件類型的基礎抽象類別。

    子類別只需要：
      1. 設定 type_name（對應 rules.json 的 condition_type）
      2. 實作 calculate(df) -> float
    """

    type_name: str = "base"
    # 子類別可覆寫：計算這個指標至少需要多少天的歷史資料
    min_history_days: int = 30

    def __init__(self, operator: str, threshold: float, params: Optional[dict] = None):
        if operator not in OPERATORS:
            raise ValueError(f"不支援的運算子: {operator!r}，只能是 {list(OPERATORS)}")
        self.operator = operator
        self.threshold = float(threshold)
        self.params = params or {}

    @abstractmethod
    def calculate(self, df: pd.DataFrame) -> float:
        """
        根據價格資料 df 計算「目前的指標數值」。
        df 需含 Close 欄位，依日期由舊到新排序（yfinance 回傳的格式即是如此）。
        """
        raise NotImplementedError

    def compare(self, value: float) -> bool:
        return OPERATORS[self.operator](value, self.threshold)

    def evaluate(self, df: pd.DataFrame) -> RuleResult:
        if len(df) < self.min_history_days:
            raise ValueError(
                f"{self.type_name} 需要至少 {self.min_history_days} 筆歷史資料，"
                f"目前只有 {len(df)} 筆"
            )
        value = self.calculate(df)
        triggered = bool(self.compare(value))
        return RuleResult(
            triggered=triggered,
            current_value=round(float(value), 4),
            message=self.format_message(value),
        )

    def format_message(self, value: float) -> str:
        return f"{self.type_name} 目前值={value:.2f}，條件: {self.operator} {self.threshold}"
