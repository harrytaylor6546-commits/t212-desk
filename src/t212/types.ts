// Shapes from the Trading 212 public API v0 (beta). Fields are optional where
// the API has been observed to omit them.

export interface AccountCash {
  free: number;
  total: number;
  invested: number;
  ppl: number;
  result: number;
  pieCash?: number;
  blocked?: number | null;
}

export interface AccountInfo {
  id: number;
  currencyCode: string;
}

export interface Position {
  ticker: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  ppl: number;
  fxPpl?: number | null;
  initialFillDate?: string;
  frontend?: string;
  maxBuy?: number;
  maxSell?: number;
  pieQuantity?: number;
}

export interface Instrument {
  ticker: string;
  type: string;
  workingScheduleId?: number;
  isin?: string;
  currencyCode: string;
  name: string;
  shortName?: string;
  maxOpenQuantity?: number;
  addedOn?: string;
}

export type TimeValidity = "DAY" | "GOOD_TILL_CANCEL";

export interface Order {
  id: number;
  ticker: string;
  type: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT" | string;
  status: string;
  quantity?: number;
  filledQuantity?: number;
  value?: number;
  filledValue?: number;
  limitPrice?: number;
  stopPrice?: number;
  timeValidity?: TimeValidity;
  creationTime?: string;
  strategy?: string;
}

export interface MarketOrderRequest {
  ticker: string;
  quantity: number;
  extendedHours?: boolean;
}

export interface LimitOrderRequest {
  ticker: string;
  quantity: number;
  limitPrice: number;
  timeValidity: TimeValidity;
}

export interface StopOrderRequest {
  ticker: string;
  quantity: number;
  stopPrice: number;
  timeValidity: TimeValidity;
}

export interface StopLimitOrderRequest {
  ticker: string;
  quantity: number;
  limitPrice: number;
  stopPrice: number;
  timeValidity: TimeValidity;
}
