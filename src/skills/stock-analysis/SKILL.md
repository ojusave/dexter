---
name: stock-analysis
description: Comprehensive stock research for investment analysis. Triggers when asked about a stock's outlook, recent developments, earnings analysis, insider activity, analyst consensus, risk assessment, or "what's happening with [TICKER]". Gathers fundamentals, SEC filings, insider trades, analyst estimates, and news to produce a structured research brief.
---

# Stock Analysis Skill

Perform deep research on a stock using all available financial tools.

## Workflow Checklist

```
Stock Analysis Progress:
- [ ] Step 1: Gather fundamental data
- [ ] Step 2: Check insider activity
- [ ] Step 3: Get analyst estimates and consensus
- [ ] Step 4: Review recent SEC filings
- [ ] Step 5: Search for recent news and catalysts
- [ ] Step 6: Synthesize findings
```

## Step 1: Gather Fundamental Data

Call `financial_search` with these queries:

### 1.1 Financial Statements
**Query:** `"[TICKER] income statement and cash flow for the last 4 quarters"`

**Extract:** Revenue trend, net income, EPS, free cash flow, operating margins.

### 1.2 Key Ratios
**Query:** `"[TICKER] key financial ratios"`

**Extract:** P/E, EV/EBITDA, ROE, ROA, gross margin, operating margin, net margin, dividend yield, debt-to-equity.

### 1.3 Revenue Segments
**Query:** `"[TICKER] revenue by segment"`

**Extract:** Revenue breakdown by business line or geography. Identify fastest/slowest growing segments.

## Step 2: Check Insider Activity

Call `financial_search`:

**Query:** `"[TICKER] insider trades last 90 days"`

**Look for:**
- Cluster buying (multiple insiders buying = strong signal)
- Large sales by CEO/CFO (potential concern)
- Form 4 filing dates and transaction sizes
- Net insider sentiment (more buying or selling?)

## Step 3: Get Analyst Estimates and Consensus

Call `financial_search`:

**Query:** `"[TICKER] analyst estimates"`

**Extract:**
- Consensus EPS estimates for next 2 fiscal years
- Revenue estimates
- Estimate revision trend (up/down over last 90 days)
- Number of analysts covering

Also search for recent analyst actions:

**Query (web_search):** `"[TICKER] analyst upgrade downgrade price target [current month] [current year]"`

**Extract:** Recent rating changes, price target adjustments, notable analyst commentary.

## Step 4: Review Recent SEC Filings

Call `read_filings`:

**Query:** `"Read [TICKER] recent 8-K filings and the latest 10-Q"`

**Focus on:**
- 8-K material events (leadership changes, acquisitions, guidance updates, restructuring)
- 10-Q MD&A section (management's view on business trends, risks)
- Risk factors (new or changed risks vs. prior filing)

## Step 5: Search for Recent News and Catalysts

Call `web_search` for:

**Query 1:** `"[TICKER] stock news catalyst [current month] [current year]"`

**Query 2:** `"[TICKER] earnings guidance outlook [current year]"`

**Identify:**
- Upcoming catalysts (earnings date, product launches, regulatory decisions)
- Recent price-moving events
- Sector/macro headwinds or tailwinds
- Competitive developments

## Step 6: Synthesize Findings

Combine all research into a structured brief:

### Output Format

**1. Company Overview** (1-2 sentences): What they do, market cap tier, sector.

**2. Financial Health:**
- Revenue/earnings trend (growing, declining, inflecting?)
- Margin trajectory
- Balance sheet strength (cash vs. debt)
- Free cash flow generation

**3. Key Signals:**
- Insider activity verdict (bullish/bearish/neutral)
- Analyst consensus and recent revisions
- Material SEC filings
- Upcoming catalysts

**4. Risk Assessment:**
- Top 3 risks from SEC filings and analysis
- Sector/macro risks
- Valuation risk (stretched vs. reasonable)

**5. Bottom Line:** 2-3 sentence summary of the stock's current setup, highlighting the most important signal(s) an investor should focus on.
