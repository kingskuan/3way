// Shared types + IExchange contract for Ondo Perps.
// See src/exchange/rs/types.js for the canonical documentation of the interface;
// Ondo mirrors the same shape so the GridBot core can drive it identically.
export const SIDE = { BUY: 0, SELL: 1 };
export const ORDER_TYPE = { MARKET: 0, LIMIT: 1 };
export const TIF = { GTC: 0, IOC: 1 };  // Ondo doesn't advertise FOK/GTT for perps
