---
name: weekly-dashboard
description: Automated weekly business dashboard - pulls Meta Ads data, saves to Supabase, sends summary email via Gmail. Use when user says "weekly dashboard", "run dashboard", "weekly update", "business summary".
user-invocable: true
---

# Weekly Business Dashboard

Automated workflow that connects Meta Ads + Supabase + Gmail into one weekly report.

## Steps

1. **Pull Meta Ads Data**
   - Use Meta Ads MCP to get last 7 days performance
   - Get campaign-level metrics: spend, impressions, clicks, conversions, ROAS
   - Compare to previous 7 days

2. **Save to Supabase**
   - If Supabase MCP is connected:
   - Create/update a `weekly_reports` table with columns: date, total_spend, total_conversions, avg_roas, best_campaign, worst_campaign, raw_data (jsonb)
   - Insert this week's data
   - Query historical data for trend analysis

3. **Generate Summary**
   - Total spend this week vs last week
   - Total conversions and cost per conversion
   - Best performing campaign (highest ROAS)
   - Worst performing campaign (lowest ROAS or highest spend with low results)
   - Week-over-week trends (up/down arrows)
   - 3 actionable recommendations

4. **Send via Gmail**
   - If Gmail MCP is connected:
   - Create a draft email with the summary
   - Subject: "[Business Name] - Weekly Ads Report - [Date Range]"
   - Clean, formatted HTML email body
   - Include key metrics table + recommendations

## Output

Report in Hebrew. Numbers displayed LTR. Include comparison arrows for trends.
If any MCP is not connected, skip that step and note it in the output.
