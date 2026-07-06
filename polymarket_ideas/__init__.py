"""Polymarket sports trade-idea generator.

Pulls markets from the Gamma API, order books from the CLOB API, and
recent trades (orderflow) from the Data API, then scores each market
across liquidity and orderflow signals to produce ranked trade ideas.
"""

__version__ = "0.1.0"
