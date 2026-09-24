# Pulse — Quick Trade prototype

An IQ Option–style trade room built with TypeScript, Vite and PixiJS (WebGL).
Live crypto prices from Binance's public feed; practice money only.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5199.

## What's in it

- GPU-drawn chart (area or candlesticks) with mouse-wheel zoom
- Higher / Lower trades, Turbo (whole-minute) and Blitz (5–30s) expiries
- Stake bubble and P&L labels on the chart, positions summary bar, Sell / Sell All
- Asset tabs and picker with live prices, sentiment bar, trades drawer and history
- Practice balance with win/lose feedback and sound

## Notes

Trades settle in the browser. A real product must settle on the server
against its own recorded price. Fixed-payout trades with real money are
regulated as binary options in most jurisdictions.
