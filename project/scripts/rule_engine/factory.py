"""
Factory Pattern。

rules.json 裡每筆規則用一個字串 condition_type（例如 "rsi"）描述條件類型，
ConditionFactory 負責把這個字串對應到實際的 Condition 子類別並產生實例。

新增一種條件類型的標準流程（完全不用改這個檔案、不用改 main.py）：
  1. 在 conditions.py 新增一個繼承 Condition 的類別
  2. 在類別上方加 @ConditionFactory.register("你的condition_type名稱")
  3. 實作 calculate()
  4. 在 rules.json 裡就可以直接使用這個新的 condition_type
"""
from typing import Dict, List, Type

from .base import Condition


class ConditionFactory:
    _registry: Dict[str, Type[Condition]] = {}

    @classmethod
    def register(cls, type_name: str):
        def decorator(condition_cls: Type[Condition]):
            if type_name in cls._registry:
                raise ValueError(f"condition_type {type_name!r} 已經被註冊過了")
            condition_cls.type_name = type_name
            cls._registry[type_name] = condition_cls
            return condition_cls

        return decorator

    @classmethod
    def create(cls, rule: dict) -> Condition:
        type_name = rule["condition_type"]
        condition_cls = cls._registry.get(type_name)
        if condition_cls is None:
            raise ValueError(
                f"未知的 condition_type: {type_name!r}，"
                f"目前支援: {cls.available_types()}"
            )
        return condition_cls(
            operator=rule["operator"],
            threshold=rule["value"],
            params=rule.get("params", {}),
        )

    @classmethod
    def available_types(cls) -> List[str]:
        return sorted(cls._registry.keys())
