"""
條件類型實作。

每一個 Condition 都是獨立、互不影響的類別，這是刻意的設計：
新增/修改一種條件類型，絕對不會動到其他條件類型的程式碼。

目前 4 種條件類型剛好可以組合出題目要求的全部 5 個範例：

  ① TAIEX 60日均線乖離率 > 18%
     -> ma_deviation, ma_period=60, operator=">", value=18

  ② 某股票從指定價格開始已上漲 200%
     -> price_change_from_base, base_price=<指定價格>, operator=">=", value=200

  ③ 某股票從歷史高點回檔超過 20%
     -> drawdown_from_high, operator=">", value=20

  ④ 某 ETF 跌破 120 日均線
     -> ma_deviation, ma_period=120, operator="<", value=0
        (乖離率 < 0 就代表現價已經跌破均線，不需要另外做一個 ma_break 條件)

  ⑤ RSI > 80 / RSI < 20
     -> rsi, operator=">", value=80   或   rsi, operator="<", value=20
"""
import pandas as pd

from .base import Condition
from .factory import ConditionFactory


@ConditionFactory.register("ma_deviation")
class MaDeviationCondition(Condition):
    """
    N 日均線乖離率 (%)：(收盤價 - MA) / MA * 100

    一個條件類型同時涵蓋兩種使用情境：
      - 乖離率過大/過小（例如 60MA乖離率 > 18，代表股價過度偏離均線）
      - 跌破/站上均線（例如 ma_period=120, operator="<", value=0）

    params:
      ma_period (int): 均線天數，預設 60
    """

    min_history_days = 250  # 預留足夠資料計算 120MA 等較長週期的均線

    def calculate(self, df: pd.DataFrame) -> float:
        period = int(self.params.get("ma_period", 60))
        closes = df["Close"]
        if len(closes) < period:
            raise ValueError(f"歷史資料不足，計算 {period} 日均線需要至少 {period} 筆")
        ma = closes.rolling(window=period).mean().iloc[-1]
        latest = closes.iloc[-1]
        return (latest - ma) / ma * 100


@ConditionFactory.register("price_change_from_base")
class PriceChangeFromBaseCondition(Condition):
    """
    相對於「自訂基準價」的漲跌幅 (%)：(現價 - base_price) / base_price * 100

    用 operator + value 的正負號決定方向：
      - 漲幅 200%： operator=">=", value=200
      - 跌幅 20%：  operator="<=", value=-20

    params:
      base_price (float): 基準價，必填
    """

    min_history_days = 1

    def calculate(self, df: pd.DataFrame) -> float:
        if "base_price" not in self.params:
            raise ValueError("price_change_from_base 需要 params.base_price")
        base_price = float(self.params["base_price"])
        latest = df["Close"].iloc[-1]
        return (latest - base_price) / base_price * 100


@ConditionFactory.register("drawdown_from_high")
class DrawdownFromHighCondition(Condition):
    """
    從區間最高點回檔的幅度 (%)：(區間最高價 - 現價) / 區間最高價 * 100

    params:
      lookback_days (int): 回看天數，預設 1260（約 5 年交易日）。
                           設定一個夠大的數字（例如 99999）就近似「歷史最高」。
    """

    min_history_days = 30

    def calculate(self, df: pd.DataFrame) -> float:
        lookback = int(self.params.get("lookback_days", 1260))
        window = df["Close"].tail(lookback)
        high = window.max()
        latest = df["Close"].iloc[-1]
        return (high - latest) / high * 100


@ConditionFactory.register("rsi")
class RsiCondition(Condition):
    """
    RSI 相對強弱指標（Wilder's smoothing，與一般看盤軟體算法一致）

    params:
      rsi_period (int): 預設 14
    """

    min_history_days = 60

    def calculate(self, df: pd.DataFrame) -> float:
        period = int(self.params.get("rsi_period", 14))
        closes = df["Close"]
        delta = closes.diff()
        gain = delta.clip(lower=0)
        loss = -delta.clip(upper=0)
        avg_gain = gain.ewm(alpha=1 / period, min_periods=period).mean()
        avg_loss = loss.ewm(alpha=1 / period, min_periods=period).mean()
        rs = avg_gain / avg_loss
        rsi = 100 - (100 / (1 + rs))
        return rsi.iloc[-1]


# --------------------------------------------------------------------------
# 未來新增 MACD 的範例（示意擴充方式用，先註解掉，不影響現有功能）
#
# @ConditionFactory.register("macd_cross")
# class MacdCrossCondition(Condition):
#     """MACD 柱狀體數值。params: fast=12, slow=26, signal=9"""
#     min_history_days = 60
#
#     def calculate(self, df: pd.DataFrame) -> float:
#         fast = int(self.params.get("fast", 12))
#         slow = int(self.params.get("slow", 26))
#         signal = int(self.params.get("signal", 9))
#         ema_fast = df["Close"].ewm(span=fast).mean()
#         ema_slow = df["Close"].ewm(span=slow).mean()
#         macd_line = ema_fast - ema_slow
#         signal_line = macd_line.ewm(span=signal).mean()
#         return (macd_line - signal_line).iloc[-1]
# --------------------------------------------------------------------------
