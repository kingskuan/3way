// Shared types + IExchange contract for Perpl (perpl.xyz on Monad L1).
// See src/exchange/rs/types.js for the canonical documentation of the interface;
// Perpl mirrors the same shape so the GridBot core can drive it identically.
export const SIDE = { BUY: 0, SELL: 1 };
export const ORDER_TYPE = { MARKET: 0, LIMIT: 1 };
export const TIF = { GTC: 0, IOC: 1 };
