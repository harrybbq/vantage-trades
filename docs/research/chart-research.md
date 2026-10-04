# Chart & dashboard research for Vantage: Trades

Researched 4 October 2026 in Chrome (Claude in Chrome extension), read-only. Screenshots are in `research/screens/`. Every observation below says which page it came from. Where a product's real logged-in screen wasn't reachable, I used the product's **own** published screenshots (help centre, blog, release notes) and say so.

---

## 1. Summary

Across the products I could see, the benchmark comparison is almost always drawn the same way: **both lines rebased to the same start (0 % or 10,000), the user's line in a strong colour, the benchmark in a quieter one, and the latest value printed at the right-hand end of each line** (Freetrade, Morningstar, Koyfin). **None of them draws the gap between the lines as its own series, and none says whether the gap could be luck.** Your mockup's middle panel (the lead in pp, with a luck band) goes further than anything I saw. The "bad case" thinking only appears in projections: the J.P. Morgan Personal Investing (ex-Nutmeg) fan chart has two shaded bands labelled "More likely" and "Less likely", with exact probabilities in a pop-up. The best beginner explainer I saw is Portfolio Visualizer's **plain-sentence summary above the charts** ("$10,000 invested … would be worth $25,792 … the benchmark would be worth $39,743"). Trading 212 and Koyfin **rebase the headline numbers to whatever time range is selected**. Your mockup deliberately doesn't (its verdict always uses the full record). That's defensible, but the screen has to say so loudly. On return types, Freetrade is the only product I saw that explains **TWRR vs MWRR side by side** and ties TWRR to the benchmark comparison. Trading 212's help centre describes "Unrealised result" and MWRR, **not** time-weighted return.

---

## 2. Product by product

### 2.1 Trading 212 *(public pages only; you weren't signed in)*

**Pages:** help centre article "Portfolio Charts" (helpcentre.trading212.com/hc/en-us/articles/22435640547613); community release post "Improved portfolio screen – Better return calculations (MWRR)…" (community.trading212.com/t/…/80132), which shows Trading 212's own example screenshots.

**Screens:** `trading212-portfolio-mwrr-net-deposits.png`, `trading212-net-deposits-toggle.png`, `trading212-helpcentre-portfolio-charts.png`

**What I saw (release-post screenshot, example data):**
- Header: the label "Value", then a large £ figure with smaller pence and an ⓘ icon. Under it, two small labelled figures side by side: "LAST YEAR +£…" and "RATE OF RETURN …%", both in green, with a + sign on the £ figure.
- A grey pill reads "£… NET DEPOSITS".
- Chart: a blue line of account value in **£** (y-axis in "k"), with the y-axis on the right. **Net deposits are a grey stepped line** under it: flat, stepping up when money went in. The gap between blue and grey is your profit, without needing a second scale.
- Range chips under the chart: 1D 1W 1M 3M 1Y MAX, plus a ⚙ gear. The gear opens a toggle, "Show net deposits".
- The post says: *"Your return metrics are now based on the time interval selected in the chart."* So **changing the range changes the headline return.**

**How they explain return types (help centre):**
- Two chart types, switched with an "Include cash" toggle under the gear: **Unrealised Result** (off) and **MWRR** (on).
- MWRR is explained in plain words: *"Older and larger investments have a greater impact on your rate of return than recent or smaller ones."*
- **No time-weighted return is described** on either page. There's also **no benchmark line** in any Trading 212 screenshot I saw.
- Short history: the YTD chart shows "Not enough data" until it has **8 data points**, and the help page says your balance stays visible meanwhile.

**Steal:** the stepped "money you put in" line under the value line. It handles deposits visually with no maths. Also: a hidden-by-default "Show net deposits" toggle, and a minimum-data rule with a friendly message.
**Avoid:** green for the rate of return with nothing else to signal gain or loss (the £ figure at least has a "+"). Also avoid one headline % that silently changes meaning with the range; it's easy to misread "4.9 %" as all-time.

---

### 2.2 Freetrade *(public blog only; you weren't signed in)*

**Pages:** blog "Introducing the time-weighted rate of return (TWRR)" (freetrade.io/blog/introducing-the-time-weighted-rate-of-return) with Freetrade's own app screenshot; blog "Money-weighted rate of return" (its image didn't load).

**Screen:** `freetrade-twrr-vs-vwrl-benchmark.png`

**What I saw (blog screenshot of the in-app Insights tab, 2020 example data):**
- The benchmark is **VWRL (FTSE All-World)**, the distributing sibling of your VWRP.
- Legend above the chart, one row per series, with the value in brackets: "● Your investment(s) (+11.75%)" in green, "● FTSE All World (£VWRL) (+6.44%)" in grey. Then "Last updated 05:09, 13 Oct".
- Chart in **%**, both lines starting at 0 %, with a **dotted 0 % baseline**. Your line is bright green. The benchmark is a grey line **with a pale grey area fill** beneath it.
- **End dots** on both lines, on the right edge. The y-axis is on the right (+12 %, +8 %, +4 %, 0 %, −4 %). The x-axis shows only the start and end dates.
- A short explainer sits above the legend (partly cropped): "…portfolio over time. It excludes the effects of deposits and withdrawals." Then a pink "Read more" link.
- The blog says ranges are **1W, 1M, 3M, Max**, from a toggle at the top right.

**How they explain it (blog text):**
- TWRR *"ignores your deposits and withdrawals, which makes it useful for comparing your results with benchmarks."*
- The warning: *"you can have a positive TWRR even if your total return is negative."*
- The rule of thumb: "Use TWRR to see how your stock picking performed, and MWRR to see how your timing and cash flows affected your results."

**Steal:** the legend-with-values format, a "last updated" timestamp, and the two-sentence TWRR/MWRR rule of thumb (almost word for word). Also the plain warning that % and £ can disagree.
**Avoid:** the gap isn't shown. You have to subtract 6.44 from 11.75 yourself. And green is the only cue for "your line".

---

### 2.3 Composer.trade — **not accessible**

Every app.composer.trade and www.composer.trade URL I tried ended on Chrome's own network-error page (`chrome-error://chromewebdata/`). Nothing rendered, so I have no observations. See section 4.

---

### 2.4 Portfolio Visualizer

**Page:** portfoliovisualizer.com/backtest-portfolio (its default "Sample Portfolio" vs the SPDR S&P 500 ETF). I accepted the site's User Agreement with your OK. Before that, its charts were hidden behind the modal.

**Screens:** `portfoliovisualizer-plain-language-summary.png`, `portfoliovisualizer-highlights-tiles.png`, `portfoliovisualizer-growth-chart.png`, `portfoliovisualizer-growth-tooltip.png`, `portfoliovisualizer-drawdowns.png`, `portfoliovisualizer-annual-active-return.png`, `portfoliovisualizer-rolling-3y.png`

**What I saw:**
- **Highlights tiles:** four coloured boxes: "Portfolio Return" in green, "**Benchmark Relative**" in red (a negative value), "Standard Deviation" in green, and "Drawdown" in grey (shown **without a minus sign**). A footnote names the benchmark.
- **Plain-language summary** next to the charts, in headed paragraphs:
  - *Portfolio Growth*: "$10,000 invested in January 1, 2017 would be worth $25,792 as of September 30, 2026 … Over the same period, the benchmark would be worth $39,743…"
  - *Return*: return per year, plus "81 out of 117 or 69.23% of months positive", best and worst year.
  - *Risk*: the worst drawdown with dates and "recovery time of 18 months", compared with the benchmark's. It also gives upside and downside capture in words.
- **Growth chart:** **$ balance from $10,000**, monthly points, with checkboxes for Logarithmic scale and Inflation adjusted. The benchmark is a bright mint line. It's visually **louder than the portfolio's** dark-blue line.
- **Tooltip** (hover): bold date, then one row per series, "● Sample Portfolio: $18,264" and "● State Street SPDR S&P 500 ETF: $23,229". **No difference row.** The hovered point gets a halo.
- **Drawdowns chart:** two **unfilled** lines from 0 % down to −30 %. They overlap heavily and are hard to tell apart. Below it is a "worst 10" table: start, end, length, "Recovery By", recovery time, "Underwater Period", depth.
- **Annualized Active Return:** one bar per year, **all the same blue whether positive or negative**.
- **Rolling 3-year return:** the line only **starts once three years of data exist** (Jan 2020 for a 2017 start). Short history is handled by not drawing at all, not by drawing a misleading partial value.
- The "Benchmark Relative" tile and an "Active Return" row are the only places the gap is a number.
- Note: after I accepted the terms, the page reloaded with a different default period (2017 instead of 2012), so the tile values changed between my two visits. That isn't a bug on their part, but nothing on the page flagged the change.

**Steal:** the sentence summary ("£X in Momentum would be worth…; the same £X in VWRP would be worth…"). Also recovery time in words, the worst-drawdowns table, and not drawing a rolling metric until the window is full.
**Avoid:** a benchmark line brighter than the subject, a drawdown chart with two unfilled lines, same-colour bars for gains and losses, and a drawdown % without a sign.

---

### 2.5 TradingView

**Page:** tradingview.com/chart/?symbol=LSE:VWRP (not signed in).

**Screen:** `tradingview-vwrp-crosshair-legend.png`

**What I saw:**
- **Compare mode needs an account.** Clicking "+" (Compare symbols) opened a search with recent indices. Picking one showed a "Compare to your heart's content … Join for free" sign-up modal. So **I could not see two symbols in % mode.**
- Single-symbol chart: candlesticks (teal up, red down), with volume bars along the bottom.
- **Hover:** no floating tooltip. A dashed crosshair appears, with a **date pill on the x-axis** ("Wed 29 Apr '26") and a **price pill on the y-axis**. The **legend line at the top rewrites itself** with that day's O/H/L/C and change, e.g. "+0.16 (+0.12%)".
- Range chips along the bottom: 1D 5D 1M 3M 6M YTD 1Y 5Y All, plus a calendar icon and "ADJ".
- The last price is a filled tag on the right axis, with a dotted line across the chart.
- Side panel: watchlist rows show the change in green or red **with a sign** ("−1.08", "−6.59%").

**Steal:** the "legend becomes the readout" pattern. It suits a three-panel chart: the numbers stay in one fixed place while you move the cursor, instead of a tooltip covering the lines. Also the axis pills for the hovered date and value.
**Avoid:** nothing beginner-hostile beyond density. This is a pro tool with no explanations.
**Side effect to know:** changing the range left that tab with a "Leave site?" dialog when I tried to navigate away. I couldn't close the tab (see section 4).

---

### 2.6 Morningstar UK

**Page:** global.morningstar.com/en-gb/investments/etfs/0P0001I3RZ/chart (Vanguard FTSE All-World UCITS ETF USD Accumulation, **VWRP**). I chose "I am an Individual Investor" on the role prompt and rejected optional cookies.

**Screens:** `morningstar-vwrp-growth-of-10000.png`, `morningstar-vwrp-tooltip.png`, `morningstar-vwrp-vs-vuag-compare.png`

**What I saw:**
- Toolbar: Compare search, then Data Type, Events, Indicators, Fundamentals, Display. Below that: TIME PERIOD (1Y), start and end date boxes, and FREQUENCY (Daily).
- The **Data Type** menu has toggles for Price, Price With Dividend, NAV, NAV With Dividend and Post-Tax NAV, and a **"% Change on [10000]" field you can edit**. The starting amount is user-settable.
- Default chart: **"growth of 10,000"** in GBP, as a blue line with a filled area. **Alternating grey and white vertical bands** mark every other two-month block. The latest value sits in a **filled label at the line's end**.
- Legend row: "VWRP NAV **+1,803.504 | +18.035%**". It shows the **£ change and the % change together**, in green, both with a "+".
- **Tooltip:** date, then "10,000 Growth", then VWRP, "● NAV 10,486.109" (the indexed value), then "NAV 129.11" (the real price). The tooltip is semi-transparent, so the lines show through it.
- **Compare (I added VUAG):** both series are rebased to 10,000. The second line is crimson, **with no area fill** (only the primary is filled). The legend gives both series the same "+£ | +%" format. The tooltip lists both indexed values. **No difference figure anywhere.**
- Before I added the compare series, the y-axis ticks sat at odd values (9,811.01, 10,311.01, …, anchored to the start value). After, they became round numbers.

**Steal:** a user-editable "growth of £X" base, and £ and % in one legend line. Showing the **real price under the indexed value** in the tooltip is a good idea for you: the agent's £ equity under its % return.
**Avoid:** odd y-axis ticks, a see-through tooltip over busy lines, and filling only one series (it reads as "this one matters more" by accident).

---

### 2.7 Nutmeg → now J.P. Morgan Personal Investing

nutmeg.com now redirects to personalinvesting.jpmorgan.com. The "Wealth planner" page says it's for clients only.

**Pages:** /isa-calculator (fan chart), /compound-interest-calculator (table only). I did **not** type anything into or submit either calculator. The fan chart was already drawn with default inputs (£500 start, £500/month, risk 8/10).

**Screen:** `nutmeg-jpm-isa-fan-chart.png`

**What I saw:**
- A **fan chart** in £ from 2026 to 2046. A dark-blue inner band is labelled "**More Likely**". A light-grey outer band is labelled "**Less Likely**". A brown straight line shows "**Contributions**" (the money you put in).
- Above the chart are four readouts: "Projected Value", "High Projection", "Low Projection" and "Date". Before you press Calculate, **all four read £0 / 0, even though the fan is already drawn**. Hovering didn't fill them in for me.
- The "About this projection" pop-up explains each band **in probabilities**: "More likely: A 60% chance the outcome will be in this range." "Less likely: A 15% chance … top fan section and a 15% chance … bottom." High and low projections are the 5 % tails. A heading reads "**Your investments may lose value**". It also says the projections include fees, fund costs and market spread.
- The same pop-up says they show returns "on the lower side (30%) of the range", which they call a cautious estimate. It then says "50% of all outcomes fall below the projected value". The two statements read as inconsistent.

**Steal:** **named bands with plain-English odds** ("a 60 % chance it lands in here"), and a contributions line so you can see when the fan dips below what you put in. A heading that says money can be lost, in plain words.
**Avoid:** headline boxes that read £0 next to a drawn chart. For you, the equivalent is never showing £0.00 when the real answer is "unknown". Your mockup already handles this with "—, needs a BARC price".

---

### 2.8 Koyfin *(the free home screen loads without an account)*

**Page:** app.koyfin.com home ("Today's Markets"). I closed the trial pop-up and rejected cookies.

**Screens:** `koyfin-home-normalized-performance.png`, `koyfin-normalized-performance-tooltips.png`, `koyfin-normalized-performance-3m-rebased.png`

**What I saw:**
- A **"Normalized Performance"** panel: range chips (1D 5D 1M 3M 6M YTD 1Y 3Y 5Y 10Y), then removable series chips (Dow Jones ×, S&P 500 ×, Nasdaq 100 ×). Each chip has a coloured left edge matching its line.
- All lines start at 0 % on a dotted baseline.
- **Coloured end labels** on the right edge, filled in each series' colour: "NDX 23.76%", "SPX 15.00%", "INDU 10.01%".
- **Changing the range rebases everything.** On 3M the labels became 5.04 %, 3.20 % and −3.26 %.
- **Tooltip:** **one small card per series**, each with a border in that series' colour, showing date, cumulative %, and **CAGR**. Example: "Tue Apr 14 · 3.75% · 7.18% CAGR" for a period of about six months.
- Elsewhere on the home screen, % changes are green or red. Negatives carry a "−". **Positives have no "+"**: "1.3%", "0.7%".
- The checkboxes in the left lists take the series colour when ticked, so the list doubles as the legend.

**Steal:** **end labels coloured like their line, with the value**. Your mockup already does this; Koyfin confirms it reads well. Also: removable series chips with a colour key, and the list doubling as the legend.
**Avoid:** **annualising short periods.** A "7.18 % CAGR" from a few months of data is exactly what a beginner over-reads. Also avoid unsigned positive numbers, and colouring a negative end label in the series colour, so "−3.26 %" doesn't look like a loss at a glance.

---

### 2.9 TradeZella (trading-journal P/L calendar)

**Page:** tradezella.com home (the hero product screenshot). The Tradervue features URL I tried was a 404, so I skipped it.

**Screens:** `tradezella-hero-dashboard.png`, `tradezella-pl-calendar.png`

**What I saw (marketing image, example data):**
- A month grid ("June 2024", with ◀ ▶ arrows and a "This month" button). Each trading day is a tinted cell: **green for a gain, red/pink for a loss**.
- Each cell shows the date (top right), then **P/L in $** in bold ("$1.15K", "−$350"), then "2 trades", then the win rate ("50.0%").
- Losses carry a "−". **Gains have no "+"**. Colour plus sign is the only gain/loss cue.
- Next to the grid: "Net P&L" and an account value, plus an AI chat bubble summarising performance.

**Steal:** a **per-agent calendar of daily P/L**, with trade count in each cell. It's an honest way to show "lots of small days" vs "one big day" without a chart. It would fit in each agent card or the activity section.
**Avoid:** no "+" on gains. Also, abbreviations like "$1.15K" are fine for a journal, but your sums are small (£ tens), so show full pence.

---

### 2.10 Hargreaves Lansdown, Vanguard UK — **not accessible**

You weren't signed in to either. Vanguard's public product URL for the USD Acc ETF redirected to a generic "Vanguard funds" listing, so no public chart was visible. See section 4.

---

## 3. Ten changes to the mockup, ranked

Each one is marked **CONFIRMS** (the mockup already does it and I saw it work), **CONTRADICTS** (the mockup does the opposite of what the products do), or **NEW** (something the mockup lacks).

1. **Add a one-sentence "same money" summary above every chart, in £. (CONFIRMS + EXTEND)**
   The mockup already says "Momentum has £2,038.72. The same money in VWRP would have about £…". Portfolio Visualizer's growth/return/risk paragraphs (2.4) show how far this can go. Add a second sentence for risk ("Its worst fall was £X (−Y %) on [date]; it hasn't recovered yet"), and print the gap in £ as well as pp.

2. **Draw "money you put in" as a stepped line on any £ view. (NEW)**
   Trading 212's grey net-deposits step line (2.1) handles deposits and capital top-ups with no jargon. On the Whole-fund view (and on an agent view after a "+£500 capital" event), a step line under equity makes it obvious that equity rose because money went in. Today the ◆ markers carry this alone.

3. **Make the range-vs-headline rule impossible to miss. (CONTRADICTS the norm, keep it but label it)**
   Trading 212 and Koyfin both rebase the headline when the range changes (2.1, 2.8). Your mockup keeps the verdict and lead on the full record and only adds a small grey note. Users trained by those apps will assume the big "Lead over VWRP" number belongs to the selected window. Put the period inside the headline itself ("Lead since 21 Aug: +0.6 pp"). Alternatively, show both, with the window figure smaller and clearly labelled.

4. **Use the legend as the hover readout instead of a floating tooltip. (CONTRADICTS)**
   The mockup uses a floating tooltip pinned near the middle panel. TradingView (2.5) rewrites a fixed legend line on hover, and the Morningstar tooltip (2.6) shows how a see-through box over lines gets messy. With three stacked panels, a fixed readout row above panel 1 is steadier, and better on phones. Keep the same order the mockup uses: date → agent % → VWRP % → lead → luck range → event. Add axis pills for the date and value.

5. **Show £ and % together in the legend and tooltip. (NEW)**
   Morningstar's "+1,803.504 | +18.035%" (2.6), and its tooltip showing the indexed value with the real price underneath, fit your audience well. A beginner thinks in pounds. Suggested format: "Momentum +£38.72 | +1.9 %", "VWRP (same cash) +£26.00 | +1.3 %".

6. **Keep the gap as its own panel. Nobody else draws it, and that's exactly the problem. (CONFIRMS)**
   Freetrade, Morningstar, Koyfin and PV all leave the subtraction to the user (2.2, 2.4, 2.6, 2.8). PV only has a "Benchmark Relative" tile and yearly bars that are blue whether positive or negative. Your lead-in-pp panel with blue-ahead/orange-behind fills answers the app's core question directly. Keep it, and keep the fill colours diverging. PV's same-colour bars are the thing to avoid.

7. **Describe the luck band in odds, the way J.P. Morgan describes its fan. (CONFIRMS the band, EXTEND the wording)**
   The J.P. Morgan/Nutmeg pop-up (2.7) names its bands with probabilities: "a 60 % chance…", "a 15 % chance…". Your band is currently "range luck alone produces". Rename the legend and explainer to say what it means in plain numbers: "If the agent had no skill at all, its lead would stay inside this grey band about 19 days in 20." If you show nested bands (the CSS has 50/80/95 tokens), label each one in words.

8. **Never annualise, and don't draw rolling stats before their window fills. (CONFIRMS the approach, add an explicit rule)**
   Koyfin's "7.18 % CAGR" on a short window (2.8) is the trap to avoid. PV's rolling-3-year line, which simply starts after three years (2.4), is the pattern to copy. The mockup shows cumulative % and talks in trading days, which is right. Write it down as a rule for the next session: no "per year" figures under 1 year of record, and any rolling metric hidden until its window is full. Trading 212's "Not enough data" below 8 points (2.1) is a good empty state.

9. **Fill the drawdown panel and add a recovery line in words. (CONFIRMS the panel, EXTEND)**
   PV's drawdown chart, with two unfilled overlapping lines (2.4), is hard to read. Its worst-10 table, with "Recovery By" and "Underwater Period", is easy. Keep your single agent drawdown area, draw VWRP's drawdown as a thin dashed outline only, and add "Below its best for N trading days" under the panel. Always print drawdown with a "−" (PV's grey "23.6 %" tile has none).

10. **Add a small daily P/L calendar per agent. (NEW)**
    TradeZella's calendar (2.9), with tinted cells, £ P/L, trade count and win rate, shows a beginner whether gains came from one lucky day or many small ones. Put it inside each agent card, or as a tab in Activity. Show "+" and "−" signs and full pence, and mark no-price days with your "—" treatment, not as £0.

Also confirmed by what I saw, so no change needed:
- **Colour is never the only signal.** Your blue/orange plus sign plus ▲▼ is stricter than Freetrade, Koyfin and TradeZella, which all drop the "+" on gains.
- **The benchmark is quieter than the subject** (dashed grey). Freetrade does this too; PV's louder benchmark shows why it matters.
- **Gaps are left as gaps, not zero.** No product I saw showed a missing-price state at all, so your "◐ Partial" treatment has no precedent to copy, and nothing contradicts it.
- **Freetrade's TWRR/MWRR wording** can go straight into your "Guide on" explainer: TWRR = how the picks did, ignoring when money went in; MWRR = what your money actually did; the two can disagree in sign.

---

## 4. What I couldn't access, and why

| Product / page | Why |
|---|---|
| Trading 212 app (portfolio, pies, return chart) | Not signed in. Login page shown, so I stopped. Used the help-centre and community release-post screenshots instead. |
| Freetrade app (Insights, benchmark) | Not signed in. Used Freetrade's own blog screenshot (2020) instead; the current in-app design may differ. |
| Hargreaves Lansdown portfolio | Not signed in (login page). |
| Vanguard UK portfolio | Not signed in (login page). The public VWRP product URL redirected to a generic funds list, so I saw no public chart. |
| Composer.trade (app and public symphony pages) | Every URL ended on Chrome's network-error page (`chrome-error://chromewebdata/`). It never loaded, possibly blocked on your network or by the site. |
| TradingView compare mode (two symbols, % mode) | Compare needs a free account; a "Join for free" modal appeared. Only the single-symbol chart was observed. |
| Nutmeg / J.P. Morgan wealth planner | Client-only. I used the public ISA-calculator fan chart and didn't enter or submit values. |
| Moneybox | Not visited, for time. Nutmeg/J.P. Morgan covered the projection/fan-chart question. |
| Tradervue | The features URL I tried returned a 404; TradeZella covered the calendar question. |
| Portfolio Visualizer | Accessible after accepting its User Agreement, with your approval. |

**Browser notes for whoever continues this:**
- My research tab ran in the background, so canvas charts (TradingView, Morningstar, Koyfin) didn't paint at first. I worked around it by patching `requestAnimationFrame` on each page from the console. Nothing about the sites was changed.
- The first TradingView tab ("VWRP 145.62 ▲ +0.94%") got stuck on a "Leave site?" dialog and wouldn't close from my side. You'll need to close it yourself; there's nothing to save.
