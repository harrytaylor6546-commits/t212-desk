/**
 * Default scanning universe: FTSE 100 constituents plus the largest and most-traded US names.
 * Symbols are converted to Trading 212 ticker format. Any the broker does not recognise are
 * dropped at scan time, so a stale entry here is harmless.
 */

const LSE = [
  "AAL", "ABF", "ADM", "AHT", "ANTO", "AUTO", "AV", "AZN", "BA", "BARC", "BATS", "BEZ", "BKG", "BNZL", "BP", "BRBY",
  "BTA", "CCH", "CNA", "CPG", "CRDA", "CTEC", "DCC", "DGE", "DPLM", "EDV", "ENT", "EXPN", "EZJ", "FCIT", "FRAS",
  "FRES", "GAW", "GLEN", "GSK", "HIK", "HLMA", "HLN", "HSBA", "HWDN", "IAG", "ICG", "IHG", "III", "IMB", "IMI", "INF",
  "ITRK", "JD", "KGF", "LAND", "LGEN", "LLOY", "LMP", "LSEG", "MKS", "MNDI", "MNG", "MRO", "NG", "NWG", "NXT", "PHNX",
  "PRU", "PSH", "PSN", "PSON", "REL", "RIO", "RKT", "RMV", "RR", "RTO", "SBRY", "SDR", "SGE", "SGRO", "SHEL", "SMIN",
  "SMT", "SN", "SPX", "SSE", "STAN", "STJ", "SVT", "TSCO", "TW", "ULVR", "UTG", "UU", "VOD", "WEIR", "WPP", "WTB",
  // liquid mid caps
  "OCDO", "ITV", "BOO", "ASC", "CWK", "DARK", "GRG", "PETS", "SXS", "WIZZ", "IDS", "BYIT", "DLG", "SPT", "HBR", "ENOG",
];

const US = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "JPM", "LLY", "V", "MA", "UNH", "XOM", "COST",
  "JNJ", "PG", "HD", "ABBV", "WMT", "BAC", "NFLX", "KO", "CRM", "ORCL", "CVX", "MRK", "AMD", "PEP", "CSCO", "ADBE",
  "TMO", "ACN", "LIN", "MCD", "ABT", "WFC", "INTU", "TXN", "QCOM", "IBM", "GE", "CAT", "DHR", "PM", "AMGN", "ISRG",
  "NOW", "DIS", "VZ", "PFE", "CMCSA", "UBER", "GS", "RTX", "SPGI", "AMAT", "NEE", "LOW", "HON", "BKNG", "UNP", "T",
  "AXP", "MS", "BLK", "PLTR", "COIN", "SCHW", "ETN", "LMT", "DE", "SBUX", "NKE", "PYPL", "BA", "GILD", "MDT", "ADP",
  "TJX", "C", "MU", "LRCX", "PANW", "ANET", "KLAC", "INTC", "SHOP", "ARM", "SMCI", "MRNA", "SNOW", "CRWD", "ABNB",
  "RIVN", "HOOD", "SOFI", "MSTR", "DELL", "TGT", "F", "GM", "CVS", "MMM", "FDX", "UPS", "DAL", "UAL", "AAL", "CCL",
  "MARA", "AFRM", "DKNG", "ROKU", "SQ", "NET", "DDOG", "ZS", "OKTA", "TTD", "LULU", "CMG", "ORLY", "REGN", "VRTX",
];

export const DEFAULT_UNIVERSE: string[] = [
  ...LSE.map((s) => `${s}l_EQ`),
  ...US.map((s) => `${s}_US_EQ`),
];
