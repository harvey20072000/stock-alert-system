"""
市場資料來源抽象層。

MVP 預設使用 yfinance，因為它是唯一能同時涵蓋以下三種標的的免費來源：
  - 台股個股 / ETF：2330.TW, 0050.TW
  - 大盤指數：^TWII
  - 美股 ETF：SPY, QQQ

未來若要加入 TWSE OpenData（更準確的台股資料）或 FinMind 作為備援，
只需要新增一個繼承 DataProvider 的子類別，main.py 不需要修改。
"""
import time
from abc import ABC, abstractmethod

import pandas as pd
import yfinance as yf


class DataProvider(ABC):
    @abstractmethod
    def get_history(self, symbol: str, period: str = "5y") -> pd.DataFrame:
        """回傳依日期排序（舊->新）、至少含 Close 欄位的 DataFrame"""
        raise NotImplementedError


class YFinanceProvider(DataProvider):
    """
    使用 yfinance 抓取歷史日線資料。

    yfinance 是非官方爬蟲套件，偶爾會因為 Yahoo 端的變動或限流而失敗，
    因此這裡加上重試機制（線性退避），避免單次網路抖動就讓整次排程失敗。
    """

    def __init__(self, max_retries: int = 3, retry_delay: float = 5.0):
        self.max_retries = max_retries
        self.retry_delay = retry_delay

    def get_history(self, symbol: str, period: str = "5y") -> pd.DataFrame:
        last_err = None
        for attempt in range(1, self.max_retries + 1):
            try:
                ticker = yf.Ticker(symbol)
                df = ticker.history(period=period, interval="1d", auto_adjust=False)
                if df is None or df.empty:
                    raise ValueError(f"{symbol} 取得的資料為空，可能是代號錯誤或暫時無資料")
                df = df.dropna(subset=["Close"])
                return df
            except Exception as e:  # noqa: BLE001
                last_err = e
                if attempt < self.max_retries:
                    time.sleep(self.retry_delay * attempt)
        raise RuntimeError(f"無法取得 {symbol} 的歷史資料（已重試 {self.max_retries} 次): {last_err}")
