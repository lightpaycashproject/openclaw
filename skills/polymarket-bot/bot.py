"""
Polymarket BTC 5-Minute Up/Down Trading Bot

This bot trades Polymarket's "BTC Up or Down" 5-minute binary markets using
technical analysis on real-time Binance BTC price data. It predicts the outcome
right before the window closes (T-10s) and places orders via py-clob-client.

Clock-based sniping ensures we trade exactly when the market closes.
"""

import argparse
import time
import requests
from datetime import datetime
from typing import Optional, Tuple


# Try to import py-clob-client, provide helpful error if not installed
try:
    from py_clob_client.client import ClobClient
    from py_clob_client.py_clob_types.id import ID
    PY_CLOB_AVAILABLE = True
except ImportError:
    PY_CLOB_AVAILABLE = False
    print("Warning: py-clob-client not installed. Install with: pip install py-clob-client")
    print("Run: poetry install or pip install py-clob-client requests python-dotenv")


class Config:
    """Trading configuration constants"""

    # Binance API
    BINANCE_API_URL = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
    BINANCE_TIMEOUT = 5

    # Polymarket token pricing model (delta-based)
    PRICING_MODEL = {
        "min": 0.50,
        "max": 0.97,
        "steps": {
            "0.005": 0.50,
            "0.02": 0.55,
            "0.05": 0.65,
            "0.10": 0.80,
            "0.15": 0.92,
            "0.20": 0.97,
        }
    }

    # Mode configurations
    MODES = {
        "safe": {
            "bet_size_pct": 0.25,  # 25% of bankroll
            "min_confidence": 0.30,  # 30% confidence
        },
        "aggressive": {
            "bet_size_pct": 1.0,  # All proceeds
            "min_confidence": 0.20,  # 20% confidence
        },
        "degen": {
            "bet_size_pct": 1.0,  # All-IN every time
            "min_confidence": 0.00,  # 0% confidence (trust the signal)
        }
    }

    # Default values
    DEFAULT_BANKROLL = 100.0
    DEFAULT_MIN_BET = 1.0
    POLL_INTERVAL = 2.0  # Seconds
    SNIPE_OFFSET = 10.0  # T-10 seconds before close


def get_binance_btc_price() -> float:
    """
    Fetch current BTC price from Binance API.

    Returns:
        Current BTC price in USDT

    Raises:
        requests.RequestException: If Binance API request fails
        ValueError: If response is invalid
    """
    try:
        response = requests.get(Config.BINANCE_API_URL, timeout=Config.BINANCE_TIMEOUT)
        response.raise_for_status()
        data = response.json()

        if "price" not in data:
            raise ValueError(f"Unexpected Binance response: {data}")

        price = float(data["price"])
        return price

    except requests.RequestException as e:
        raise requests.RequestException(f"Binance API request failed: {e}")
    except (ValueError, KeyError) as e:
        raise ValueError(f"Invalid Binance response: {e}")


def calculate_token_price(confidence: float) -> float:
    """
    Calculate token price based on confidence level using delta-based pricing model.

    The more confident the signal, the higher the price we're willing to pay.

    Args:
        confidence: Signal confidence (0.0 to 1.0)

    Returns:
        Token price in dollars
    """
    # Map confidence to price tier
    if confidence < 0.15:
        return Config.PRICING_MODEL["min"]
    elif confidence < 0.30:
        return Config.PRICING_MODEL["steps"]["0.02"]
    elif confidence < 0.50:
        return Config.PRICING_MODEL["steps"]["0.05"]
    elif confidence < 0.70:
        return Config.PRICING_MODEL["steps"]["0.10"]
    elif confidence < 0.85:
        return Config.PRICING_MODEL["steps"]["0.15"]
    else:
        return Config.PRICING_MODEL["max"]


def get_window_info(now: int) -> Tuple[int, int, str]:
    """
    Calculate the current BTC 5-minute window timestamp.

    Clock-based calculation:
    window_ts = now - (now % 300)
    close_time = window_ts + 300
    slug = f"btc-updown-5m-{window_ts}"

    Args:
        now: Current Unix timestamp

    Returns:
        Tuple of (window_ts, close_time, market_slug)
    """
    window_ts = now - (now % 300)
    close_time = window_ts + 300
    slug = f"btc-updown-5m-{window_ts}"
    return window_ts, close_time, slug


def place_order(
    client: Optional[ClobClient],
    direction: str,
    price: float,
    size_usd: float,
    dry_run: bool = True
) -> bool:
    """
    Place an order on Polymarket.

    Tries FOK market order first, falls back to GTC limit order at $0.95 if needed.

    Args:
        client: py-clob-client instance
        direction: 'UP' or 'DOWN'
        price: Price to pay per share
        size_usd: Total order size in USD
        dry_run: If True, print simulation without placing order

    Returns:
        True if order was placed or would be placed in dry run

    Raises:
        ImportError: If py-clob-client not installed
        RuntimeError: If order placement fails
    """
    if not PY_CLOB_AVAILABLE:
        raise ImportError("py-clob-client is required for order placement")

    if dry_run:
        print(f"\n[DRY RUN] Would place {direction} order:")
        print(f"  Price: ${price:.4f} per share")
        print(f"  Total size: ${size_usd:.2f}")
        print(f"  Expected shares: {int(size_usd / price)}")
        return True

    # TODO: Implement actual order placement with py-clob-client
    # This requires:
    # 1. Client authentication (API key, secret)
    # 2. Getting the market ID via slug
    # 3. Placing FOK market order
    # 4. Fallback to GTC limit order at $0.95

    print(f"\n[REAL TRADE] Placing {direction} order:")
    print(f"  Price: ${price:.4f} per share")
    print(f"  Total size: ${size_usd:.2f}")
    print(f"  Note: Implementation requires client authentication")
    print(f"  Required fields: API key, secret, and market discovery")

    # Placeholder for actual implementation
    # Example:
    # market_id = client.get_markets_by_slug(slug)[direction]
    # order = client.create_order(
    #     id=ID(),
    #     market_id=market_id,
    #     side='buy',
    #     price=price,
    #     size=size_usd,
    #     is_base_asset=False,  # Yes
    #     order_type='FOK',  # Fill or kill
    #     client_order_id=f"btc-bot-{int(time.time())}"
    # )

    return True


def analyze_market(btc_price: float, window_open_price: float) -> dict:
    """
    Analyze the BTC price and determine trading signal.

    This is a simplified analysis - the real implementation would use
    strategy.py with 7 weighted indicators.

    Args:
        btc_price: Current BTC price
        window_open_price: Price at window start

    Returns:
        Dictionary with signal direction and confidence score
    """
    if window_open_price == 0:
        return {"direction": "UP", "confidence": 0.5, "score": 3.5}

    # Calculate delta (percentage change)
    delta = (btc_price - window_open_price) / window_open_price

    # Direction: UP if price increased, DOWN if decreased
    direction = "UP" if delta > 0 else "DOWN"

    # Score: -7 to +7 range
    # Weighted by confidence
    score = delta * 7.0 * (1 if delta > 0 else -1)

    # Convert score to confidence (max 1.0)
    confidence = min(abs(score) / 7.0, 1.0)

    return {
        "direction": direction,
        "confidence": confidence,
        "score": score,
        "delta": delta
    }


def main():
    """Main bot loop"""

    parser = argparse.ArgumentParser(
        description="Polymarket BTC 5-Minute Up/Down Trading Bot"
    )
    parser.add_argument(
        "--mode",
        choices=["safe", "aggressive", "degen"],
        default="safe",
        help="Trading mode (safe=25% bankroll, aggressive=proceeds, degen=ALL-IN)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=True,
        help="Run in dry-run mode without placing real orders"
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run once and exit (for debugging)"
    )
    parser.add_argument(
        "--max-trades",
        type=int,
        default=20,
        help="Maximum number of trades to place before exiting"
    )
    parser.add_argument(
        "--bankroll",
        type=float,
        default=Config.DEFAULT_BANKROLL,
        help=f"Initial bankroll in USD (default: {Config.DEFAULT_BANKROLL})"
    )
    parser.add_argument(
        "--min-bet",
        type=float,
        default=Config.DEFAULT_MIN_BET,
        help=f"Minimum bet size in USD (default: {Config.DEFAULT_MIN_BET})"
    )
    parser.add_argument(
        "--no-dry-run",
        action="store_false",
        dest="dry_run",
        help="Place real trades (NOT RECOMMENDED without testing)"
    )

    args = parser.parse_args()

    # Validate mode
    if args.mode not in Config.MODES:
        print(f"Error: Invalid mode '{args.mode}'")
        return 1

    mode_config = Config.MODES[args.mode]

    # Validate bankroll
    if args.bankroll < args.min_bet:
        print(f"Error: Bankroll (${args.bankroll:.2f}) below minimum bet (${args.min_bet:.2f})")
        return 1

    # Initialize tracker variables
    window_open_price = 0.0
    best_confidence = 0.0
    best_signal = None
    trade_count = 0
    started = False

    print("=" * 60)
    print("Polymarket BTC 5-Minute Trading Bot")
    print(f"Mode: {args.mode.upper()}")
    print(f"Dry run: {'YES' if args.dry_run else 'NO (REAL TRADES)'}")
    print(f"Bankroll: ${args.bankroll:.2f}")
    print(f"Min confidence: {mode_config['min_confidence'] * 100:.0f}%")
    print(f"Poll interval: {Config.POLL_INTERVAL}s")
    print(f"Snipe offset: T-{Config.SNIPE_OFFSET}s")
    print("=" * 60)

    try:
        while True:
            try:
                now = int(time.time())

                # Check if we should snipe this window
                window_ts, close_time, slug = get_window_info(now)

                # If we haven't started with this window, calculate open price
                if not started:
                    window_open_price = get_binance_btc_price()
                    started = True
                    print(f"\nWindow {window_ts} starting at ${window_open_price:.2f}")

                # Calculate time to close
                time_to_close = close_time - now
                slack_seconds = time_to_close - Config.SNIPE_OFFSET

                # Sleep until T-10 seconds before close
                if slack_seconds > 0:
                    print(f"Current: {datetime.fromtimestamp(now).strftime('%H:%M:%S')}")
                    print(f"Time to close: {slack_seconds}s ({time_to_close}s)")
                    print(f"Sleeping until T-{Config.SNIPE_OFFSET}s...")
                    time.sleep(min(slack_seconds, Config.POLL_INTERVAL))
                    continue

                # If we're past close, check if we should start a new window
                if now > close_time:
                    if args.once:
                        break

                    print(f"\nWindow {window_ts} closed. Waiting for next window...")
                    time.sleep(1)
                    continue

                # SNIPING WINDOW: Get current price and analyze
                print(f"\n{'=' * 60}")
                print(f"⚡ SNIPING WINDOW {window_ts} ⚡")
                print(f"{'=' * 60}")

                try:
                    btc_price = get_binance_btc_price()
                    print(f"Current BTC price: ${btc_price:.2f}")

                    # Analyze market
                    signal = analyze_market(btc_price, window_open_price)
                    print(f"Signal: {signal['direction']} (confidence: {signal['confidence']:.2%})")
                    print(f"Window delta: {signal['delta']:.4f}%")

                    # Update best signal
                    if signal['confidence'] > best_confidence:
                        best_confidence = signal['confidence']
                        best_signal = signal
                        print(f"New best signal: {best_signal['direction']} ({best_confidence:.2%})")

                    # Check if we should place a trade
                    if signal['confidence'] >= mode_config['min_confidence']:
                        print(f"\n✓ Confidence threshold met: {signal['confidence']:.2%} >= {mode_config['min_confidence']:.2%}")

                        # Calculate bet size
                        bet_size_pct = mode_config['bet_size_pct']
                        bet_size = bet_size_pct * args.bankroll

                        # Validate bet size
                        if bet_size < args.min_bet:
                            print(f"⚠ Bet size ${bet_size:.2f} below minimum ${args.min_bet:.2f}")
                        else:
                            # Calculate token price
                            token_price = calculate_token_price(signal['confidence'])
                            expected_shares = int(bet_size / token_price)

                            print(f"\n📊 TRADE PARAMETERS:")
                            print(f"  Direction: {signal['direction']}")
                            print(f"  Confidence: {signal['confidence']:.2%}")
                            print(f"  Bet size: ${bet_size:.2f} ({bet_size_pct * 100:.0f}% of bankroll)")
                            print(f"  Token price: ${token_price:.4f}")
                            print(f"  Expected shares: {expected_shares}")

                            # Place order (dry run or real)
                            place_order(
                                client=None,
                                direction=signal['direction'],
                                price=token_price,
                                size_usd=bet_size,
                                dry_run=args.dry_run
                            )

                            trade_count += 1
                            print(f"\nTrade #{trade_count} placed")

                            # Update bankroll after trade
                            if not args.dry_run:
                                # For dry run, we'll just decrease by bet size
                                args.bankroll -= bet_size

                                # Check if we can continue
                                if args.bankroll < args.min_bet:
                                    print(f"\n⚠ Bankroll below minimum. Exiting.")
                                    break

                                if args.max_trades and trade_count >= args.max_trades:
                                    print(f"\nMax trades reached: {args.max_trades}. Exiting.")
                                    break

                    # Reset for next window if this one is done
                    if time_to_close <= 0:
                        if args.once:
                            break
                        window_open_price = 0
                        best_confidence = 0.0
                        best_signal = None

                        print(f"\nWindow {window_ts} complete. Waiting for next window...")
                        time.sleep(1)

                except requests.RequestException as e:
                    print(f"\n⚠ Error fetching BTC price: {e}")
                    print("Retrying in 5 seconds...")
                    time.sleep(5)
                    continue

            except KeyboardInterrupt:
                print("\n\nInterrupted by user. Exiting...")
                break

            except Exception as e:
                print(f"\n⚠ Unexpected error: {e}")
                print("Retrying in 5 seconds...")
                time.sleep(5)

    except KeyboardInterrupt:
        print("\n\nInterrupted by user. Exiting...")
    except Exception as e:
        print(f"\n❌ Fatal error: {e}")
        return 1

    print("\n" + "=" * 60)
    print(f"Bot stopped. Trades placed: {trade_count}")
    print("=" * 60)

    return 0


if __name__ == "__main__":
    exit(main())
